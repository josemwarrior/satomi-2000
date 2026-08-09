import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG_FILE, loadConfig } from "./config.js";

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

describe("private configuration", () => {
  it("uses satomi.config.yml as the CLI default filename", () => {
    expect(DEFAULT_CONFIG_FILE).toBe("satomi.config.yml");
  });

  it("resolves an external Jekyll repository relative to the config file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "satomi-config-"));
    temporaryPaths.push(root);
    const repository = path.join(root, "external-blog");
    await mkdir(repository);
    const example = YAML.parse(
      await readFile(path.resolve("satomi.config.example.yml"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
    if (!example.site) throw new Error("Invalid test fixture");
    example.site.repository_path = "external-blog";
    const configPath = path.join(root, "satomi.config.yml");
    await writeFile(configPath, YAML.stringify(example), { mode: 0o600 });

    const config = await loadConfig(configPath);
    expect(config.repositoryPath).toBe(repository);
    expect(config.site.posts_directory).toBe("_posts");
    expect(config.site.media_directory).toBe("assets/microblog/media");
    expect(config.site.public_url).toBe("https://example.github.io/microblog");
    expect(config.statePath).toBe(path.join(root, ".satomi/state.json"));
    expect(config.destinations).toEqual({
      jekyll: true,
      org_social: true,
      mastodon: true,
      bluesky: true,
      x: true,
      telegram: true,
    });
    expect(config.platforms.x.oauth_callback_url).toBe("http://127.0.0.1:3000/callback");
    expect(config.platforms.x.oauth_timeout_seconds).toBe(180);
    expect(config.platforms.telegram.worker_url).toBe(
      "https://satomi-telegram.example.workers.dev",
    );
    expect(config.platforms.telegram.timeout_seconds).toBe(30);
    expect(config.org_social).toEqual({
      title: "GameName on Org Social",
      nick: "GameName",
      description: "Development notes from an independent game",
      avatar_url: "https://example.github.io/assets/microblog/avatar.png",
      links: ["https://example.github.io/microblog/"],
      languages: ["en"],
      default_language: "en",
    });
  });

  it("keeps legacy configurations valid with Telegram disabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "satomi-config-legacy-"));
    temporaryPaths.push(root);
    const repository = path.join(root, "external-blog");
    await mkdir(repository);
    const example = YAML.parse(
      await readFile(path.resolve("satomi.config.example.yml"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
    if (!example.site || !example.destinations || !example.platforms) {
      throw new Error("Invalid test fixture");
    }
    example.site.repository_path = "external-blog";
    delete example.destinations.telegram;
    delete example.platforms.telegram;
    const configPath = path.join(root, "satomi.config.yml");
    await writeFile(configPath, YAML.stringify(example), { mode: 0o600 });

    const config = await loadConfig(configPath);
    expect(config.destinations.telegram).toBe(false);
    expect(config.platforms.telegram.worker_url).toBeUndefined();
    expect(config.platforms.telegram.max_characters).toBe(1_024);
  });

  it("requires a Worker URL when Telegram is enabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "satomi-config-telegram-"));
    temporaryPaths.push(root);
    const repository = path.join(root, "external-blog");
    await mkdir(repository);
    const example = YAML.parse(
      await readFile(path.resolve("satomi.config.example.yml"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
    if (!example.site || !example.platforms) throw new Error("Invalid test fixture");
    example.site.repository_path = "external-blog";
    const telegram = example.platforms.telegram as Record<string, unknown>;
    delete telegram.worker_url;
    const configPath = path.join(root, "satomi.config.yml");
    await writeFile(configPath, YAML.stringify(example), { mode: 0o600 });

    await expect(loadConfig(configPath)).rejects.toThrow(
      /platforms\.telegram\.worker_url: is required/,
    );
  });
});
