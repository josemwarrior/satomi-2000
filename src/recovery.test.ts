import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, expect, it, vi } from "vitest";
import { configSchema, loadConfig } from "./config.js";
import { publicationHistory, publish, retryPublication } from "./pipeline.js";
import { loadState, saveState } from "./state.js";
import { runCommand } from "./utils.js";

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

async function interruptedPublication() {
  root = await mkdtemp(path.join(os.tmpdir(), "satomi-recovery-"));
  const repository = path.join(root, "blog");
  await mkdir(repository);
  await writeFile(path.join(repository, "README.md"), "Test blog\n");
  for (const args of [
    ["init", "-b", "main"], ["config", "user.name", "Satomi Test"],
    ["config", "user.email", "satomi@example.invalid"], ["add", "."], ["commit", "-m", "initial"],
  ]) await runCommand("git", args, { cwd: repository });
  const settings = configSchema.parse(YAML.parse(await readFile("satomi.config.example.yml", "utf8")));
  settings.site.repository_path = repository;
  settings.destinations = { jekyll: true, org_social: true, mastodon: true, bluesky: false, x: false, telegram: false };
  settings.platforms.mastodon.append_canonical_url = false;
  settings.platforms.mastodon.include_tags = false;
  settings.git.push = true;
  settings.state.publish_syndication_data = false;
  settings.deployment.wait_for_public_url = false;
  settings.credentials.provider = "env";
  settings.jekyll.build_command = [process.execPath, "-e", "require('fs').mkdirSync('_site', { recursive: true })"];
  const configPath = path.join(root, "satomi.yml");
  await writeFile(configPath, YAML.stringify(settings));
  const config = await loadConfig(configPath);
  vi.stubEnv("MASTODON_URL", "https://mastodon.example.com");
  vi.stubEnv("MASTODON_TOKEN", "test-token");
  const writes: string[] = [];
  const events: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/v2/instance")) {
      return new Response(JSON.stringify({ configuration: { statuses: { max_characters: 500 } } }));
    }
    if (url.includes("/microblog/")) {
      events.push("deployment");
      return new Response("page");
    }
    expect(url).toBe("https://mastodon.example.com/api/v1/statuses");
    events.push("publish");
    writes.push(JSON.parse(String(init!.body)).status);
    return new Response(JSON.stringify({ id: "1", url: "https://mastodon.example.com/1" }));
  }));
  await expect(publish(async () => ({ text: "Recover this post" }), config)).rejects.toThrow(/Attempt ID: A000001/);
  const state = await loadState(config);
  const attempt = state.attempts!.A000001!;
  expect(attempt).toMatchObject({ status: "failed", phase: "push", retryable: false });
  expect(writes).toEqual([]);
  const remote = path.join(root, "remote.git");
  await runCommand("git", ["init", "--bare", remote]);
  await runCommand("git", ["remote", "add", "origin", remote], { cwd: repository });
  return { config, state, attempt, writes, events, repository };
}

it.each(["push", "deployment"] as const)("resumes a %s failure without regenerating the blog or publishing twice", async (phase) => {
  const { config, state, attempt, writes, events, repository } = await interruptedPublication();
  attempt.phase = phase;
  await saveState(config, state);
  expect((await publicationHistory(config))[0]!.nextCommand).toBe("retry A000001");
  const before = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
  const orgBefore = await readFile(path.join(repository, "microblog/social.org"), "utf8");
  // Recovery uses the original destination selection, even if current settings changed.
  config.destinations.mastodon = false;
  config.destinations.telegram = true;
  config.deployment.wait_for_public_url = true;
  const result = await retryPublication(attempt.id, undefined, config);
  expect(result.platforms.mastodon.status).toBe("published");
  expect(result.platforms.telegram.status).toBe("not_started");
  expect(writes).toEqual(["Recover this post"]);
  expect(events).toEqual(["deployment", "publish"]);
  expect((await runCommand("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout).toBe(before);
  expect(await readFile(path.join(repository, "microblog/social.org"), "utf8")).toBe(orgBefore);
  expect((await loadState(config)).attempts!.A000001).toMatchObject({ status: "published", phase: "complete" });
  await expect(retryPublication(attempt.id, undefined, config)).rejects.toThrow(/no failed platform/);
  expect(writes).toHaveLength(1);
}, 20_000);

it("keeps an unresolved push recoverable and sends no social requests", async () => {
  const { config, writes, repository } = await interruptedPublication();
  await runCommand("git", ["remote", "remove", "origin"], { cwd: repository });
  await expect(retryPublication("A000001", undefined, config)).rejects.toThrow(/git failed/);
  expect(writes).toEqual([]);
  expect((await publicationHistory(config))[0]).toMatchObject({ phase: "push", nextCommand: "retry A000001" });
}, 20_000);

it.each(["platforms", "pending-chunk", "attempted", "unknown", "changed-payload"])("blocks unsafe recovery: %s", async (scenario) => {
  const { config, state, attempt, writes } = await interruptedPublication();
  const entry = state.entries[attempt.slug!]!;
  if (scenario === "platforms") attempt.phase = "platforms";
  if (scenario === "pending-chunk") entry.platforms.mastodon.chunks![0]!.status = "pending";
  if (scenario === "attempted") entry.platforms.mastodon.attempted_at = new Date().toISOString();
  if (scenario === "unknown") entry.platforms.mastodon.status = "unknown";
  if (scenario === "changed-payload") config.platforms.mastodon.include_tags = true;
  // A payload mismatch must fail before either push or social publication.
  if (scenario === "changed-payload") entry.payload_sha256.mastodon = "changed";
  await saveState(config, state);
  await expect(retryPublication(attempt.id, undefined, config)).rejects.toThrow();
  expect(writes).toEqual([]);
}, 20_000);

it("leaves a deployment failure recoverable without starting social publishing", async () => {
  const { config, writes } = await interruptedPublication();
  config.deployment.wait_for_public_url = true;
  config.deployment.timeout_seconds = 0;
  await expect(retryPublication("A000001", undefined, config)).rejects.toThrow(/Deployment was not available/);
  expect(writes).toEqual([]);
  expect((await publicationHistory(config))[0]).toMatchObject({ phase: "deployment", nextCommand: "retry A000001" });
  config.deployment.wait_for_public_url = false;
  expect((await retryPublication("A000001", undefined, config)).platforms.mastodon.status).toBe("published");
  expect(writes).toEqual(["Recover this post"]);
}, 20_000);
