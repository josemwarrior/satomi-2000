import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreparedEntry, ResolvedConfig } from "./types.js";
import { cleanupStagedSite, runJekyllBuild, stageSite } from "./jekyll.js";

function pngImage(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
}

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

describe("Jekyll staging", () => {
  it("builds the entire change in a temporary copy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "satomi-test-"));
    temporaryPaths.push(root);
    const repository = path.join(root, "blog");
    await mkdir(repository);
    await writeFile(path.join(repository, "_config.yml"), "title: Test\n");
    await mkdir(path.join(repository, "_posts"));
    await writeFile(
      path.join(repository, "_posts/2026-08-07-unrelated.md"),
      "---\ntitle: Unrelated\ndate: 2026-08-07\n---\nThis is not a Satomi post.\n",
    );
    await writeFile(
      path.join(repository, "_posts/2026-08-07-reply.md"),
      [
        "---",
        "satomi: true",
        "title: A reply",
        "date: '2026-08-07T12:00:00.000Z'",
        "slug: 2026-08-07-reply",
        "lang: es",
        "tags: []",
        "syndicate:",
        "  org_social: true",
        "  org_social_language: es",
        "  org_social_client: iOS",
        "  org_social_reply_to: 'https://example.com/alice/social.org#2026-08-07T11:00:00+0000'",
        "org_social_text: '[[org-social:https://example.com/alice/social.org][alice]] Reply.'",
        "---",
        "[alice](https://example.com/alice/social.org) Reply.",
        "",
      ].join("\n"),
    );
    const imagePath = path.join(root, "capture.png");
    const image = pngImage();
    await writeFile(imagePath, image);
    const config = {
      repositoryPath: repository,
      site: {
        posts_directory: "_posts",
        media_directory: "custom/media",
        public_files_directory: "published/microblog",
        public_url: "https://example.com/microblog",
        media_url: "https://example.com/media",
      },
      content: {
        title: "Devlog",
        description: "Updates",
        language: "en",
      },
      org_social: {
        title: "Game on Org Social",
        nick: "Game",
        description: "Org Social updates",
        avatar_url: "https://example.com/avatar.png",
        links: ["https://example.com/microblog/"],
        languages: ["es", "en"],
        default_language: "es",
      },
      destinations: {
        jekyll: true,
        org_social: true,
        mastodon: true,
        bluesky: false,
        x: false,
      },
      jekyll: {
        build_command: [
          process.execPath,
          "-e",
          "require('fs').mkdirSync('_site', { recursive: true })",
        ],
        output_directory: "_site",
      },
    } as ResolvedConfig;
    const entry = {
      slug: "2026-08-08-capture",
      title: "Capture",
      text: "An update.",
      alt: "A test capture.",
      tags: ["indiedev"],
      language: "en",
      publishedAt: "2026-08-08T17:30:00.000Z",
      forceXUrl: false,
      media: {
        sourcePath: imagePath,
        fileName: "capture.png",
        type: "png",
        mimeType: "image/png",
        bytes: image.length,
        width: 1,
        height: 1,
        sha256: "test",
        publicUrl: "https://example.com/media/capture.png",
      },
    } as PreparedEntry;

    const staged = await stageSite(entry, config);
    try {
      await runJekyllBuild(staged.repository, config);
      expect(staged.generatedPaths).toContain("custom/media/capture.png");
      const social = await readFile(
        path.join(staged.repository, "published/microblog/social.org"),
        "utf8",
      );
      expect(social).toContain("An update.");
      expect(social).toContain("#+TITLE: Game on Org Social");
      expect(social).toContain("#+LANGUAGE: es en");
      expect(social).toContain(":LANG: es");
      expect(social).toContain(":CLIENT: iOS");
      expect(social).toContain(
        ":REPLY_TO: https://example.com/alice/social.org#2026-08-07T11:00:00+0000",
      );
      expect(social).toContain(
        "[[org-social:https://example.com/alice/social.org][alice]] Reply.",
      );
      expect(social).not.toContain("This is not a Satomi post.");
      expect(await readFile(path.join(staged.repository, "_config.yml"), "utf8")).toBe(
        "title: Test\n",
      );
    } finally {
      await cleanupStagedSite(staged);
    }

    const withoutOrgSocial = {
      ...config,
      destinations: { ...config.destinations, org_social: false },
    } as ResolvedConfig;
    const textOnlyEntry = {
      ...entry,
      slug: "2026-08-08-text-only",
      media: undefined,
      alt: undefined,
    } as unknown as PreparedEntry;
    const stagedWithoutOrgSocial = await stageSite(textOnlyEntry, withoutOrgSocial);
    try {
      expect(stagedWithoutOrgSocial.generatedPaths).not.toContain(
        "published/microblog/social.org",
      );
      expect(
        await readFile(
          path.join(
            stagedWithoutOrgSocial.repository,
            "_posts/2026-08-08-text-only.md",
          ),
          "utf8",
        ),
      ).toContain("org_social: false");
      expect(
        await readFile(
          path.join(
            stagedWithoutOrgSocial.repository,
            "_posts/2026-08-08-text-only.md",
          ),
          "utf8",
        ),
      ).toContain("org_social_language: es");
      expect(
        await readFile(
          path.join(
            stagedWithoutOrgSocial.repository,
            "_posts/2026-08-08-text-only.md",
          ),
          "utf8",
        ),
      ).not.toContain("\nimage:");
      expect(stagedWithoutOrgSocial.generatedPaths).not.toContain("custom/media/capture.png");
    } finally {
      await cleanupStagedSite(stagedWithoutOrgSocial);
    }

    const videoEntry = {
      ...entry,
      slug: "2026-08-08-video",
      media: {
        ...entry.media!,
        fileName: "remote-video.mp4",
        type: "mp4",
        mimeType: "video/mp4",
        bytes: 1_000,
        width: 1280,
        height: 720,
        durationSeconds: 7,
        publicUrl: "https://files.example/remote-video.mp4",
      },
    } as PreparedEntry;
    const stagedVideo = await stageSite(videoEntry, config);
    try {
      expect(stagedVideo.generatedPaths).not.toContain("custom/media/remote-video.mp4");
      const post = await readFile(
        path.join(stagedVideo.repository, "_posts/2026-08-08-video.md"),
        "utf8",
      );
      expect(post).toContain("video: 'https://files.example/remote-video.mp4'");
      expect(post).toContain("video_type: video/mp4");
      expect(post).toContain("video_duration: 7");
    } finally {
      await cleanupStagedSite(stagedVideo);
    }
  });
});
