import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { configSchema } from "./config.js";
import type { PreparedEntry, ResolvedConfig } from "./types.js";
import { applyStagedFiles, cleanupStagedSite, runJekyllBuild, stageSite } from "./jekyll.js";
import { contentEntryFromPrepared, renderPost } from "./templates.js";

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

async function socialFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "satomi-append-test-"));
  temporaryPaths.push(root);
  const parsed = configSchema.parse(YAML.parse(
    await readFile(new URL("../satomi.config.example.yml", import.meta.url), "utf8"),
  ));
  const config: ResolvedConfig = {
    ...parsed,
    repositoryPath: path.join(root, "blog"),
    configPath: "unused",
    configDirectory: root,
    statePath: path.join(root, "state.json"),
    lockPath: path.join(root, "lock"),
    envPath: "unused",
  };
  const entry: PreparedEntry = {
    slug: "2026-08-08-new",
    title: "New post",
    text: "A new update: https://example.com/new",
    tags: ["indiedev"],
    language: "en",
    publishedAt: "2026-08-08T17:30:00.000Z",
    contentSha256: "unused",
    canonicalUrl: `${config.site.public_url}/2026-08-08-new/`,
    forceXUrl: false,
    platformPayloads: {},
    payloadSha256: {},
  };
  const posts = path.join(config.repositoryPath, config.site.posts_directory);
  const socialPath = path.join(config.site.public_files_directory, "social.org");
  await mkdir(posts, { recursive: true });
  await mkdir(path.dirname(path.join(config.repositoryPath, socialPath)), { recursive: true });
  const oldEntry = {
    ...contentEntryFromPrepared(entry, config),
    slug: "2026-08-07-old",
    date: "2026-08-07T17:30:00.000Z",
    text: "An old post edited in Jekyll.",
  };
  await writeFile(path.join(posts, `${oldEntry.slug}.md`), renderPost(oldEntry, config));
  const optedOut = { ...oldEntry, slug: "2026-08-07-private", orgSocial: false, text: "Opted out." };
  await writeFile(path.join(posts, `${optedOut.slug}.md`), renderPost(optedOut, config));
  return { config, entry, socialPath };
}

const existingSocial = [
  "#+TITLE: My manually edited profile",
  "#+NICK: alice",
  "#+FOLLOW: https://example.com/bob/social.org",
  "",
  "* Posts",
  "",
  "** 2026-08-07T19:30:00+0200",
  ":PROPERTIES:",
  ":LANG: es",
  ":CLIENT: iOS",
  ":REPLY_TO: https://example.com/bob/social.org#2026-08-07T11:00:00+0000",
  ":END:",
  "",
  "Una respuesta editada a mano. ❤️  ",
  "",
  "** 2026-08-08T10:00:00+0200",
  ":PROPERTIES:",
  ":MOOD: 👍",
  ":END:",
  "",
  "Only in Org Social, with no matching Jekyll entry.",
].join("\n");

describe("Org Social append staging", () => {
  it.each(["", "\n", "\n\n", "\n\n\n", "\r\n"])(
    "preserves the existing bytes and appends one post with ending %j",
    async (ending) => {
      const { config, entry, socialPath } = await socialFixture();
      const original = Buffer.from(`${existingSocial}${ending}`);
      const target = path.join(config.repositoryPath, socialPath);
      await writeFile(target, original);
      const staged = await stageSite(entry, config);
      try {
        const social = await readFile(path.join(staged.repository, socialPath));
        expect(social.subarray(0, original.length)).toEqual(original);
        const appended = social.subarray(original.length).toString();
        expect(appended).toMatch(/^\n{0,2}\*\* 2026-08-08T17:30:00\+0000\n/);
        expect(appended.match(/^\*\* /gm)).toHaveLength(1);
        expect(appended).toContain(":LANG: en\n:TAGS: indiedev");
        expect(appended).toContain("A new update: [[https://example.com/new][https://example.com/new]]");
        expect(social.toString()).not.toContain("An old post edited in Jekyll.");
        expect(social.toString()).not.toContain("Opted out.");
        expect(staged.generatedPaths.filter(file => file === socialPath)).toHaveLength(1);
        expect(await readFile(target)).toEqual(original);
        const feed = JSON.parse(await readFile(
          path.join(staged.repository, config.site.public_files_directory, "feed.json"), "utf8",
        ));
        expect(feed.items[0].content_text).toBe(entry.text);
        expect(feed.items.map((item: { content_text: string }) => item.content_text))
          .toContain("An old post edited in Jekyll.");
      } finally {
        await cleanupStagedSite(staged);
      }
    },
  );

  it("keeps previous publications when applying successive staged changes", async () => {
    const { config, entry, socialPath } = await socialFixture();
    const target = path.join(config.repositoryPath, socialPath);
    await writeFile(target, `${existingSocial}\n`);
    const first = await stageSite(entry, config);
    try {
      await applyStagedFiles(first, config);
      const afterFirst = await readFile(target, "utf8");
      await applyStagedFiles(first, config);
      expect(await readFile(target, "utf8")).toBe(afterFirst);
      const second = await stageSite({
        ...entry,
        slug: "2026-08-09-second",
        publishedAt: "2026-08-09T17:30:00.000Z",
        text: "Second publication.",
      }, config);
      try {
        await applyStagedFiles(second, config);
        const afterSecond = await readFile(target, "utf8");
        expect(afterSecond.startsWith(afterFirst)).toBe(true);
        expect(afterSecond.match(/^\*\* /gm)).toHaveLength(4);
        expect(afterSecond).toMatch(/\*\* 2026-08-09T17:30:00\+0000[\s\S]*Second publication\.\n$/);
      } finally {
        await cleanupStagedSite(second);
      }
    } finally {
      await cleanupStagedSite(first);
    }
  });

  it("leaves an existing feed untouched when Org Social is deselected", async () => {
    const { config, entry, socialPath } = await socialFixture();
    config.destinations.org_social = false;
    await writeFile(path.join(config.repositoryPath, socialPath), existingSocial);
    const staged = await stageSite(entry, config);
    try {
      expect(staged.generatedPaths).not.toContain(socialPath);
      expect(await readFile(path.join(staged.repository, socialPath), "utf8")).toBe(existingSocial);
    } finally {
      await cleanupStagedSite(staged);
    }
  });

  it("initializes a missing feed from opted-in history, oldest first", async () => {
    const { config, entry, socialPath } = await socialFixture();
    const staged = await stageSite(entry, config);
    try {
      const social = await readFile(path.join(staged.repository, socialPath), "utf8");
      expect(social).toContain(`#+TITLE: ${config.org_social.title}`);
      expect(social.match(/^\* Posts$/gm)).toHaveLength(1);
      expect(social.match(/^\*\* /gm)).toHaveLength(2);
      expect(social.indexOf("An old post edited in Jekyll.")).toBeLessThan(social.indexOf("A new update:"));
      expect(social).not.toContain("Opted out.");
    } finally {
      await cleanupStagedSite(staged);
    }
  });
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
