import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishX } from "./x.js";
import type { MediaType, PreparedEntry, ResolvedConfig } from "../types.js";

const temporaryPaths: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryPaths.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function mediaEntry(type: MediaType): Promise<PreparedEntry> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "satomi-x-"));
  temporaryPaths.push(directory);
  const mediaDetails = {
    gif: { extension: ".gif", mimeType: "image/gif" },
    png: { extension: ".png", mimeType: "image/png" },
    jpeg: { extension: ".jpg", mimeType: "image/jpeg" },
    webp: { extension: ".webp", mimeType: "image/webp" },
  } as const;
  const { extension, mimeType } = mediaDetails[type];
  const sourcePath = path.join(directory, `capture${extension}`);
  await writeFile(sourcePath, Buffer.from("test-media"));
  return {
    slug: "2026-08-08-capture",
    alt: "Accessible description",
    platformPayloads: { x: "An update" },
    media: {
      sourcePath,
      fileName: `capture${extension}`,
      type,
      mimeType,
      bytes: 10,
      width: 1,
      height: 1,
      sha256: "test",
      publicUrl: `https://example.com/capture${extension}`,
    },
  } as PreparedEntry;
}

const config = { platforms: { x: { username: "satomi" } } } as ResolvedConfig;
const credentials = { accessToken: "test-token" };

describe("X media capabilities", () => {
  it("skips every media endpoint for a text-only post", async () => {
    const fetchMock = vi.fn(async () => json({ data: { id: "123" } }));
    vi.stubGlobal("fetch", fetchMock);
    await publishX(
      { slug: "text-only", platformPayloads: { x: "Text only" } } as PreparedEntry,
      config,
      credentials,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.x.com/2/tweets");
  });

  it.each(["png", "jpeg", "webp"] as const)("uses alt metadata for %s images", async (type) => {
    const responses = [
      json({ data: { id: "media-1" } }),
      new Response(null, { status: 204 }),
      json({ data: { id: "media-1" } }),
      json({ data: { id: "media-1" } }),
      json({ data: { id: "post-1" } }),
    ];
    const fetchMock = vi.fn(async () => responses.shift() ?? json({}));
    vi.stubGlobal("fetch", fetchMock);
    await publishX(await mediaEntry(type), config, credentials);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain("https://api.x.com/2/media/metadata");
  });

  it("does not send image-only alt metadata for an animated GIF", async () => {
    const responses = [
      json({ data: { id: "media-2" } }),
      new Response(null, { status: 204 }),
      json({ data: { id: "media-2" } }),
      json({ data: { id: "post-2" } }),
    ];
    const fetchMock = vi.fn(async () => responses.shift() ?? json({}));
    vi.stubGlobal("fetch", fetchMock);
    await publishX(await mediaEntry("gif"), config, credentials);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).not.toContain("https://api.x.com/2/media/metadata");
  });
});
