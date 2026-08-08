import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPlatformPayload, countPlatformText, effectiveLimits, prepareEntry } from "./messages.js";
import type { ResolvedConfig } from "./types.js";

const config = {
  site: {
    public_url: "https://example.com/microblog",
    media_url: "https://example.com/media",
  },
  content: {
    language: "en",
    timezone: "Europe/Madrid",
    default_tags: ["indiedev"],
  },
  validation: {
    reject_empty_text: true,
    reject_control_characters: true,
    require_matching_image_extension: true,
    require_animated_gif: true,
  },
  destinations: {
    jekyll: true,
    org_social: true,
    mastodon: true,
    bluesky: true,
    x: true,
  },
  platforms: {
    mastodon: {
      max_characters: 500,
      max_gif_mb: 16,
      max_png_mb: 16,
      append_canonical_url: true,
      include_tags: true,
    },
    bluesky: {
      max_characters: 300,
      max_gif_mb: 50,
      max_png_mb: 2,
      append_canonical_url: true,
      include_tags: false,
    },
    x: {
      max_characters: 280,
      max_gif_mb: 15,
      max_png_mb: 5,
      append_canonical_url: false,
      include_tags: true,
    },
  },
} as ResolvedConfig;

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

describe("platform messages", () => {
  it("uses the minimum enabled limits", () => {
    expect(effectiveLimits(config, "gif")).toEqual({ characters: 280, mediaMb: 15 });
    expect(effectiveLimits(config, "png")).toEqual({ characters: 280, mediaMb: 2 });
    expect(effectiveLimits(config, "jpeg")).toEqual({ characters: 280, mediaMb: 2 });
    expect(effectiveLimits(config, "webp")).toEqual({ characters: 280, mediaMb: 2 });
  });

  it("allows a Jekyll-only publication when every optional destination is unchecked", () => {
    const jekyllOnly = {
      ...config,
      destinations: {
        jekyll: true,
        org_social: false,
        mastodon: false,
        bluesky: false,
        x: false,
      },
    } as ResolvedConfig;
    expect(effectiveLimits(jekyllOnly)).toEqual({ characters: Infinity, mediaMb: Infinity });
  });

  it("builds each platform payload from configuration", () => {
    expect(
      buildPlatformPayload("mastodon", "Hello", ["indiedev"], "https://example.com/post", config),
    ).toBe("Hello\n\n#indiedev\n\nhttps://example.com/post");
    expect(
      buildPlatformPayload("bluesky", "Hello", ["indiedev"], "https://example.com/post", config),
    ).toBe("Hello\n\nhttps://example.com/post");
  });

  it("uses X weighted URL length instead of JavaScript string length", () => {
    const longUrl = `https://example.com/${"a".repeat(200)}`;
    expect(countPlatformText("x", longUrl)).toBeLessThan(longUrl.length);
  });

  it("prepares a text-only entry without media or alternative text", async () => {
    const entry = await prepareEntry(
      { text: "A text-only update." },
      config,
      new Date("2026-08-08T17:30:00Z"),
    );
    expect(entry.media).toBeUndefined();
    expect(entry.alt).toBeUndefined();
    expect(entry.slug).toBe("2026-08-08-a-text-only-update");
  });

  it("prepares PNG media with optional alternative text", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "satomi-message-"));
    temporaryPaths.push(directory);
    const imagePath = path.join(directory, "title.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const entry = await prepareEntry(
      { text: "A PNG update.", imagePath, alt: "A title screen." },
      config,
      new Date("2026-08-08T17:30:00Z"),
    );
    expect(entry.media?.type).toBe("png");
    expect(entry.media?.mimeType).toBe("image/png");
    expect(entry.media?.publicUrl).toBe("https://example.com/media/title.png");
    const entryWithoutAlt = await prepareEntry(
      { text: "No alternative text.", imagePath },
      config,
      new Date("2026-08-08T17:30:00Z"),
    );
    expect(entryWithoutAlt.media?.type).toBe("png");
    expect(entryWithoutAlt.alt).toBeUndefined();
  });
});
