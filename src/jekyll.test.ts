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
        nick: "Game",
        description: "Updates",
        avatar_url: "https://example.com/avatar.png",
        language: "en",
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
      ).not.toContain("\nimage:");
      expect(stagedWithoutOrgSocial.generatedPaths).not.toContain("custom/media/capture.png");
    } finally {
      await cleanupStagedSite(stagedWithoutOrgSocial);
    }
  });
});
