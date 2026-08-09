import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicationHistory, publish, requiredCommands, validateXGuardrails } from "./pipeline.js";
import { createPublicationAttempt, emptyState, loadState, saveState } from "./state.js";
import type { PreparedEntry, ResolvedConfig } from "./types.js";
import { runCommand } from "./utils.js";

const config = {
  destinations: { x: true },
  platforms: {
    x: {
      estimated_cost_with_url_usd: 0.2,
      estimated_cost_without_url_usd: 0.015,
      max_estimated_cost_usd_per_run: 0.25,
      max_posts_per_day: 2,
    },
  },
  content: { timezone: "Europe/Madrid" },
} as ResolvedConfig;

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

describe("X URL cost authorization", () => {
  it("rejects a URL unless the specific force flag was supplied", () => {
    const entry = {
      platformPayloads: { x: "A costly link example.com" },
      forceXUrl: false,
    } as PreparedEntry;
    expect(() => validateXGuardrails(entry, emptyState(), config)).toThrow(/--force-x/);
  });

  it("allows the URL with the specific force flag while retaining cost limits", () => {
    const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const entry = {
      platformPayloads: { x: "A costly link https://example.com" },
      forceXUrl: true,
    } as PreparedEntry;
    expect(() => validateXGuardrails(entry, emptyState(), config)).not.toThrow();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("higher configured cost"));
    warning.mockRestore();
  });
});

describe("conditional FFmpeg requirement", () => {
  const toolConfig = { jekyll: { build_command: ["bundle", "exec", "jekyll", "build"] } } as ResolvedConfig;

  it("does not require FFmpeg for PNG or text-only Bluesky posts", () => {
    const png = { media: { type: "png" } } as PreparedEntry;
    expect(requiredCommands(png, toolConfig, ["bluesky"])).not.toContain("ffmpeg");
    expect(requiredCommands({} as PreparedEntry, toolConfig, ["bluesky"])).not.toContain("ffmpeg");
  });

  it("requires FFmpeg only for an animated GIF sent to Bluesky", () => {
    const gif = { media: { type: "gif" } } as PreparedEntry;
    expect(requiredCommands(gif, toolConfig, ["bluesky"])).toContain("ffmpeg");
    expect(requiredCommands(gif, toolConfig, ["mastodon"])).not.toContain("ffmpeg");
  });
});

describe("publication history", () => {
  it("shows a pre-publication failure with its recovery ID and command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "satomi-history-"));
    temporaryPaths.push(root);
    const historyConfig = { statePath: path.join(root, "state.json") } as ResolvedConfig;
    const state = emptyState();
    const attempt = createPublicationAttempt(
      state,
      { text: "Blocked post", imagePath: "/tmp/image.jpg" },
      new Date("2026-08-09T00:00:00.000Z"),
    );
    attempt.slug = "2026-08-09-blocked-post";
    attempt.status = "failed";
    attempt.phase = "staging";
    attempt.error = "Generated target files have local changes";
    attempt.retryable = true;
    attempt.worktree_files = ["microblog/feed.json"];
    await saveState(historyConfig, state);

    const rows = await publicationHistory(historyConfig);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "A000001",
      status: "failed",
      phase: "staging",
      nextCommand: "resolve A000001",
    });
  });

  it("records a draft that is blocked by a dirty generated feed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "satomi-publish-history-"));
    temporaryPaths.push(root);
    const repository = path.join(root, "blog");
    await mkdir(path.join(repository, "_posts"), { recursive: true });
    await mkdir(path.join(repository, "microblog"), { recursive: true });
    await writeFile(path.join(repository, "microblog/feed.json"), "committed\n");
    await runCommand("git", ["init", "-b", "main"], { cwd: repository });
    await runCommand("git", ["config", "user.name", "Satomi Test"], { cwd: repository });
    await runCommand("git", ["config", "user.email", "satomi@example.invalid"], { cwd: repository });
    await runCommand("git", ["add", "."], { cwd: repository });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: repository });
    await writeFile(path.join(repository, "microblog/feed.json"), "local change\n");

    const statePath = path.join(root, ".satomi/state.json");
    const publishConfig = {
      repositoryPath: repository,
      configDirectory: root,
      statePath,
      lockPath: path.join(root, ".satomi/publish.lock"),
      envPath: path.join(root, ".env"),
      site: {
        branch: "main",
        posts_directory: "_posts",
        media_directory: "assets/media",
        public_files_directory: "microblog",
        syndication_data_file: "_data/syndication.json",
        public_url: "https://example.com/microblog",
        media_url: "https://example.com/media",
      },
      content: {
        title: "Test",
        description: "Test",
        language: "en",
        timezone: "UTC",
        default_tags: [],
      },
      org_social: {
        title: "Test on Org Social",
        nick: "Test",
        description: "Test",
        avatar_url: "https://example.com/avatar.png",
        links: ["https://example.com/microblog/"],
        languages: ["en"],
        default_language: "en",
      },
      validation: {
        reject_empty_text: true,
        reject_control_characters: true,
        require_matching_image_extension: true,
        require_animated_gif: true,
      },
      destinations: {
        jekyll: true,
        org_social: false,
        mastodon: false,
        bluesky: false,
        x: false,
      },
      platforms: {
        mastodon: { max_characters: 500, max_gif_mb: 16, max_png_mb: 16 },
        bluesky: { max_characters: 300, max_gif_mb: 50, max_png_mb: 2 },
        x: { max_characters: 280, max_gif_mb: 15, max_png_mb: 5 },
      },
      credentials: { provider: "env", keychain_service_prefix: "satomi" },
      jekyll: {
        build_command: [process.execPath, "-e", "require('fs').mkdirSync('_site')"],
        output_directory: "_site",
      },
      git: {
        push: false,
        commit_message_template: "microblog: {slug}",
      },
      state: { publish_syndication_data: false },
    } as ResolvedConfig;

    await expect(
      publish(async () => ({ text: "A blocked post" }), publishConfig),
    ).rejects.toThrow(/Attempt ID: A000001/);
    const state = await loadState(publishConfig);
    expect(state.attempts?.A000001).toMatchObject({
      status: "failed",
      phase: "staging",
      retryable: true,
      worktree_files: ["microblog/feed.json"],
      destinations: {
        jekyll: true,
        org_social: false,
        mastodon: false,
        bluesky: false,
        x: false,
      },
    });
  });
});
