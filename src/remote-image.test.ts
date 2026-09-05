import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, expect, it, vi } from "vitest";
import { configSchema } from "./config.js";
import { inspectRemoteImage, normalizeImageUrl } from "./image.js";
import { prepareEntry } from "./messages.js";
import { stageSite, cleanupStagedSite } from "./jekyll.js";
import { emptyState, makeEntryState, saveState } from "./state.js";
import { retry } from "./pipeline.js";
import { publishMastodon } from "./adapters/mastodon.js";
import { publishX } from "./adapters/x.js";
import { publishTelegram } from "./adapters/telegram.js";
import { publishBluesky } from "./adapters/bluesky.js";
import type { ResolvedConfig } from "./types.js";

const bsky = vi.hoisted(() => ({ upload: vi.fn(), create: vi.fn() }));
vi.mock("@atproto/api", () => ({
  AtpAgent: class {
    session = { did: "did:plc:test" };
    login = vi.fn();
    uploadBlob = bsky.upload;
    com = { atproto: { repo: { createRecord: bsky.create } } };
  },
  RichText: class {
    text: string;
    facets = [];
    constructor({ text }: { text: string }) { this.text = text; }
    async detectFacets() {}
  },
}));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const url = "https://images.example/photo.png?size=full&v=1";
const directories: string[] = [];
async function temp() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "satomi-remote-test-"));
  directories.push(directory);
  return directory;
}
function imageResponse(body = png, headers = {}) {
  return new Response(new Uint8Array(body), { headers: { "Content-Type": "image/png", ...headers } });
}
function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}
async function fixture() {
  const root = await temp();
  const parsed = configSchema.parse(YAML.parse(await readFile(new URL("../satomi.config.example.yml", import.meta.url), "utf8")));
  const config: ResolvedConfig = { ...parsed, repositoryPath: path.join(root, "blog"), statePath: path.join(root, "state.json"), lockPath: path.join(root, "lock"), configPath: "unused", configDirectory: root, envPath: "unused" };
  await mkdir(config.repositoryPath);
  vi.stubGlobal("fetch", vi.fn(async () => imageResponse()));
  const entry = await prepareEntry({ text: "A photo", imagePath: url, alt: "Description" }, config, new Date("2026-09-05T12:00:00Z"), root);
  return { root, config, entry };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it.each(["http://example.com/a.png", "https://user:pass@example.com/a.png", "https://example.com/a.png#fragment"])("rejects unsupported image URL %s", value => {
  expect(() => normalizeImageUrl(value)).toThrow(/HTTPS/);
});

it("follows HTTPS redirects while preserving the original URL", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/actual.png" } })).mockResolvedValueOnce(imageResponse());
  vi.stubGlobal("fetch", fetchMock);
  const result = await inspectRemoteImage(url, await temp(), 10000);
  expect(result.publicUrl).toBe(url);
  expect(await readFile(result.sourcePath)).toEqual(png);
  expect(fetchMock.mock.calls[1]?.[0]).toBe("https://images.example/actual.png");
});

it("rejects redirects to HTTP", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://images.example/a.png" } })));
  await expect(inspectRemoteImage(url, await temp(), 10000)).rejects.toThrow(/HTTPS/);
});

it.each([true, false])("enforces download limits with declared content length: %s", async declared => {
  vi.stubGlobal("fetch", vi.fn(async () => imageResponse(png, declared ? { "Content-Length": String(png.length) } : {})));
  await expect(inspectRemoteImage(url, await temp(), 10)).rejects.toThrow(/size limit/);
});

it("rejects gallery HTML and invalid image contents", async () => {
  const root = await temp();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>gallery</html>", { headers: { "Content-Type": "text/html" } })));
  await expect(inspectRemoteImage(url, root, 10000)).rejects.toThrow(/Content-Type/);
  vi.stubGlobal("fetch", vi.fn(async () => imageResponse(Buffer.from("not an image"))));
  await expect(inspectRemoteImage(url, root, 10000)).rejects.toThrow(/valid PNG/);
  expect(await readdir(root)).toEqual([]);
});

it("preserves external media in Jekyll, feeds and state without copying assets", async () => {
  const { config, entry } = await fixture();
  expect(entry.media).toMatchObject({ external: true, publicUrl: url, type: "png" });
  const saved = makeEntryState(entry, config);
  expect(saved.media_url).toBe(url);
  expect(saved.repository_media_path).toBeUndefined();
  const staged = await stageSite(entry, config);
  try {
    expect(staged.generatedPaths.some(p => p.startsWith(config.site.media_directory + path.sep))).toBe(false);
    const post = await readFile(path.join(staged.repository, config.site.posts_directory, `${entry.slug}.md`), "utf8");
    expect(post).toContain(url);
    const feedRoot = path.join(staged.repository, config.site.public_files_directory);
    expect(JSON.parse(await readFile(path.join(feedRoot, "feed.json"), "utf8")).items[0].image).toBe(url);
    expect(await readFile(path.join(feedRoot, "feed.xml"), "utf8")).toContain(url.replaceAll("&", "&amp;").replaceAll("&amp;", "&amp;amp;"));
    expect(await readFile(path.join(feedRoot, "social.org"), "utf8")).toContain(url);
  } finally { await cleanupStagedSite(staged); }
});

it("retries using the original external URL and refuses changed content", async () => {
  const { config, entry } = await fixture();
  const state = emptyState();
  state.entries[entry.slug] = makeEntryState(entry, config);
  state.entries[entry.slug]!.platforms.mastodon.status = "failed";
  await saveState(config, state);
  const changed = Buffer.from(png);
  changed.writeUInt32BE(2, 16);
  const fetchMock = vi.fn(async () => imageResponse(changed));
  vi.stubGlobal("fetch", fetchMock);
  await expect(retry(entry.slug, "mastodon", config)).rejects.toThrow(/Media content changed/);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(url);
});

it("uses the downloaded bytes in Mastodon, Bluesky and X and the external URL in Telegram", async () => {
  const { entry, config } = await fixture();
  const mastodonFetch = vi.fn().mockResolvedValueOnce(json({ id: "media", url: "https://mastodon.example/media" })).mockResolvedValueOnce(json({ id: "post", url: "https://mastodon.example/post" }));
  vi.stubGlobal("fetch", mastodonFetch);
  await publishMastodon(entry, { url: "https://mastodon.example", token: "test" });
  const form = mastodonFetch.mock.calls[0]?.[1].body as FormData;
  expect(Buffer.from(await (form.get("file") as Blob).arrayBuffer())).toEqual(png);
  bsky.upload.mockResolvedValue({ data: { blob: { ref: "image" } } });
  bsky.create.mockResolvedValue({ data: { uri: "at://post", cid: "cid" } });
  await publishBluesky(entry, undefined, config, { handle: "test", appPassword: "test" }, "key");
  expect(Buffer.from(bsky.upload.mock.calls[0]?.[0])).toEqual(png);
  expect(bsky.create.mock.calls[0]?.[0].record.embed.$type).toBe("app.bsky.embed.images");
  const xFetch = vi.fn().mockResolvedValueOnce(json({ data: { id: "media" } })).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ data: { id: "post" } }));
  vi.stubGlobal("fetch", xFetch);
  await publishX(entry, config, { accessToken: "test" });
  expect(JSON.parse(xFetch.mock.calls[0]?.[1].body).media).toBe(png.toString("base64"));
  const telegramFetch = vi.fn(async () => json({ ok: true, result: { messageId: 1, url: "https://t.me/test/1" } }));
  vi.stubGlobal("fetch", telegramFetch);
  await publishTelegram(entry, config, { workerToken: "test" });
  expect(JSON.parse(telegramFetch.mock.calls[0]?.[1].body).media.url).toBe(url);
});

it("accepts a JPEG served from an extensionless HTTPS URL", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
  vi.stubGlobal("fetch", vi.fn(async () => imageResponse(jpeg, { "Content-Type": "image/jpeg" })));
  const result = await inspectRemoteImage("https://images.example/download?id=1", await temp(), 10000);
  expect(result).toMatchObject({ type: "jpeg", mimeType: "image/jpeg", width: 3, height: 2, extension: ".jpg" });
});

it("rejects a MIME type that disagrees with the actual image", async () => {
  const root = await temp();
  vi.stubGlobal("fetch", vi.fn(async () => imageResponse(png, { "Content-Type": "image/jpeg" })));
  await expect(inspectRemoteImage(url, root, 10000)).rejects.toThrow(/does not match/);
  expect(await readdir(root)).toEqual([]);
});
