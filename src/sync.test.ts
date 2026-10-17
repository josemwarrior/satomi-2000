import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, expect, it } from "vitest";
import { configSchema, loadConfig } from "./config.js";
import { synchronizeRepository } from "./git.js";
import { publish } from "./pipeline.js";
import { loadState } from "./state.js";
import { runCommand } from "./utils.js";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function setup() {
  root = await mkdtemp(path.join(os.tmpdir(), "satomi-sync-"));
  const repository = path.join(root, "blog");
  const remote = path.join(root, "remote.git");
  const mobile = path.join(root, "mobile");
  await mkdir(path.join(repository, "microblog"), { recursive: true });
  await writeFile(path.join(repository, "microblog/social.org"), "#+TITLE: Test\n\n** Initial post\n");
  for (const args of [
    ["init", "-b", "journal"], ["config", "user.name", "Satomi Test"],
    ["config", "user.email", "satomi@example.invalid"], ["add", "."], ["commit", "-m", "initial"],
  ]) await runCommand("git", args, { cwd: repository });
  await runCommand("git", ["init", "--bare", remote]);
  await runCommand("git", ["remote", "add", "origin", remote], { cwd: repository });
  await runCommand("git", ["push", "origin", "journal"], { cwd: repository });
  await runCommand("git", ["clone", "-b", "journal", remote, mobile]);
  await runCommand("git", ["config", "user.name", "Mobile Test"], { cwd: mobile });
  await runCommand("git", ["config", "user.email", "mobile@example.invalid"], { cwd: mobile });
  const settings = configSchema.parse(YAML.parse(await readFile("satomi.config.example.yml", "utf8")));
  settings.site.repository_path = repository;
  settings.site.branch = "journal";
  settings.destinations = { jekyll: true, org_social: true, mastodon: false, bluesky: false, x: false, telegram: false };
  settings.git.push = true;
  settings.state.publish_syndication_data = false;
  settings.deployment.wait_for_public_url = false;
  settings.credentials.provider = "env";
  settings.jekyll.build_command = [process.execPath, "-e", "require('fs').mkdirSync('_site', { recursive: true })"];
  const configPath = path.join(root, "satomi.yml");
  await writeFile(configPath, YAML.stringify(settings));
  const config = await loadConfig(configPath);
  const mobileText = "#+TITLE: Test\n\n** Initial post\n\n** Mobile post\n\nWritten in another app.\n";
  await writeFile(path.join(mobile, "microblog/social.org"), mobileText);
  await runCommand("git", ["add", "."], { cwd: mobile });
  await runCommand("git", ["commit", "-m", "mobile post"], { cwd: mobile });
  await runCommand("git", ["push", "origin", "journal"], { cwd: mobile });
  return { config, repository, mobile, mobileText };
}

it("updates local files before appending and publishing a new post on the configured branch", async () => {
  const { config, repository, mobileText } = await setup();
  const summary = await publish(async () => ({ text: "Written with Satomi" }), config);
  const social = await readFile(path.join(repository, "microblog/social.org"), "utf8");
  expect(social.startsWith(mobileText)).toBe(true);
  expect(social).toContain("Written with Satomi");
  expect(social.match(/Written with Satomi/g)).toHaveLength(1);
  expect((await runCommand("git", ["show", "origin/journal:microblog/social.org"], { cwd: repository })).stdout).toBe(social);
  expect((await loadState(config)).attempts![summary.attemptId!]!.status).toBe("published");
}, 20_000);

it("stops before generating files when the branches diverge", async () => {
  const { config, repository } = await setup();
  await writeFile(path.join(repository, "local.md"), "local commit\n");
  await runCommand("git", ["add", "local.md"], { cwd: repository });
  await runCommand("git", ["commit", "-m", "local work"], { cwd: repository });
  const before = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
  await expect(publish(async () => ({ text: "Blocked post" }), config)).rejects.toThrow(/have diverged/);
  expect((await runCommand("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout).toBe(before);
  expect((await runCommand("git", ["status", "--porcelain"], { cwd: repository })).stdout).toBe("");
  expect((await loadState(config)).attempts!.A000001).toMatchObject({ phase: "preflight", retryable: true });
  expect(await readFile(path.join(repository, "microblog/social.org"), "utf8")).not.toContain("Mobile post");
}, 20_000);

it("preserves uncommitted local files and does not autostash them", async () => {
  const { config, repository } = await setup();
  await writeFile(path.join(repository, "notes.md"), "unsaved work\n");
  await expect(synchronizeRepository(config)).rejects.toThrow(/has local changes/);
  expect(await readFile(path.join(repository, "notes.md"), "utf8")).toBe("unsaved work\n");
  expect((await runCommand("git", ["stash", "list"], { cwd: repository })).stdout).toBe("");
}, 20_000);

it("keeps local commits when the remote is already included", async () => {
  const { config, repository } = await setup();
  await synchronizeRepository(config);
  await writeFile(path.join(repository, "local.md"), "local commit\n");
  await runCommand("git", ["add", "local.md"], { cwd: repository });
  await runCommand("git", ["commit", "-m", "local work"], { cwd: repository });
  const before = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
  await synchronizeRepository(config);
  expect((await runCommand("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout).toBe(before);
}, 20_000);

it("does not synchronize installations with git.push disabled", async () => {
  const { config, repository } = await setup();
  config.git.push = false;
  await runCommand("git", ["remote", "remove", "origin"], { cwd: repository });
  await synchronizeRepository(config);
  expect(await readFile(path.join(repository, "microblog/social.org"), "utf8")).not.toContain("Mobile post");
}, 20_000);

it("stops before creating a publication commit when the remote cannot be fetched", async () => {
  const { config, repository } = await setup();
  await runCommand("git", ["remote", "set-url", "origin", path.join(root!, "missing.git")], { cwd: repository });
  const before = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
  await expect(publish(async () => ({ text: "Blocked post" }), config)).rejects.toThrow(/git failed/);
  expect((await runCommand("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout).toBe(before);
  expect((await runCommand("git", ["status", "--porcelain"], { cwd: repository })).stdout).toBe("");
  expect((await loadState(config)).attempts!.A000001).toMatchObject({ phase: "preflight", retryable: true });
}, 20_000);
