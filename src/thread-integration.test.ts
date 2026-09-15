import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, expect, it, vi } from "vitest";
import { configSchema, loadConfig } from "./config.js";
import { publish, retry } from "./pipeline.js";
import { loadState } from "./state.js";
import { runCommand } from "./utils.js";

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it("publishes a long canonical post, saves a partial thread and resumes its original cuts", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "satomi-thread-integration-"));
  const repository = path.join(root, "blog");
  await mkdir(repository);
  await writeFile(path.join(repository, "README.md"), "Test blog\n");
  await runCommand("git", ["init", "-b", "main"], { cwd: repository });
  await runCommand("git", ["config", "user.name", "Satomi Test"], { cwd: repository });
  await runCommand("git", ["config", "user.email", "satomi@example.invalid"], { cwd: repository });
  await runCommand("git", ["add", "."], { cwd: repository });
  await runCommand("git", ["commit", "-m", "initial"], { cwd: repository });
  const settings = configSchema.parse(YAML.parse(await readFile("satomi.config.example.yml", "utf8")));
  settings.site.repository_path = repository;
  settings.destinations = { jekyll: true, org_social: true, mastodon: true, bluesky: false, x: false, telegram: false };
  settings.platforms.mastodon.max_characters = 60;
  settings.platforms.mastodon.append_canonical_url = false;
  settings.platforms.mastodon.include_tags = false;
  settings.git.push = false;
  settings.deployment.wait_for_public_url = false;
  settings.credentials.provider = "env";
  settings.jekyll.build_command = [process.execPath, "-e", "require('fs').mkdirSync('_site', { recursive: true })"];
  const configPath = path.join(root, "satomi.yml");
  await writeFile(configPath, YAML.stringify(settings));
  const config = await loadConfig(configPath);
  vi.stubEnv("MASTODON_URL", "https://mastodon.example.com");
  vi.stubEnv("MASTODON_TOKEN", "test-token");
  let instanceLimit = 50;
  const writes: Array<{ status: string; in_reply_to_id?: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/api/v2/instance")) {
      return new Response(JSON.stringify({ configuration: { statuses: { max_characters: instanceLimit } } }));
    }
    expect(url).toBe("https://mastodon.example.com/api/v1/statuses");
    writes.push(JSON.parse(String(init.body)));
    if (writes.length === 2) return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
    return new Response(JSON.stringify({ id: String(writes.length), url: `https://mastodon.example.com/${writes.length}` }));
  }));
  const text = "A complete sentence with several words. ".repeat(8).trim();
  const summary = await publish(async () => ({ text }), config);
  expect(summary.platforms.mastodon).toMatchObject({ status: "failed", id: "1" });
  const saved = (await loadState(config)).entries[summary.slug]!;
  const cuts = saved.platforms.mastodon.chunks!.map((part) => part.text);
  expect(cuts.length).toBeGreaterThan(2);
  expect(saved.platforms.mastodon.chunks!.map((part) => part.status).slice(0, 3)).toEqual(["published", "failed", "not_started"]);
  const org = await readFile(path.join(repository, "microblog/social.org"), "utf8");
  expect(org).toContain(text);
  expect(org.match(/^\*\* /gm)).toHaveLength(1);

  // A larger limit must not repartition a partially published thread.
  instanceLimit = 100;
  config.platforms.mastodon.max_characters = 100;
  const beforeRetry = writes.length;
  const resumed = await retry(summary.slug, "mastodon", config);
  expect(resumed.platforms.mastodon).toMatchObject({ status: "published", id: "1", url: "https://mastodon.example.com/1" });
  expect(writes.slice(beforeRetry).map((body) => body.status)).toEqual(cuts.slice(1));
  expect(writes[beforeRetry]!.in_reply_to_id).toBe("1");
  expect(writes[beforeRetry + 1]!.in_reply_to_id).toBe("3");
  const completed = (await loadState(config)).entries[summary.slug]!.platforms.mastodon;
  expect(completed.chunks!.every((part) => part.status === "published")).toBe(true);
  expect(await readFile(path.join(repository, "microblog/social.org"), "utf8")).toBe(org);
}, 15_000);
