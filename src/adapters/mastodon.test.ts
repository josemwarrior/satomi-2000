import { afterEach, describe, expect, it, vi } from "vitest";
import { publishMastodon, validateMastodonInstance } from "./mastodon.js";
import { AmbiguousPublishError } from "../errors.js";
import type { PreparedEntry, ResolvedConfig } from "../types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const entry = {
  platformPayloads: { mastodon: "An update" },
  media: {
    mimeType: "image/jpeg",
    bytes: 100,
  },
} as PreparedEntry;

const config = {
  platforms: {
    mastodon: {
      check_instance_limits: true,
      max_characters: 500,
    },
  },
} as ResolvedConfig;

const credentials = { url: "https://mastodon.example", token: "test-token" };

function instanceResponse(supportedMimeTypes: string[]): Response {
  return new Response(
    JSON.stringify({
      configuration: {
        media_attachments: {
          image_size_limit: 1_000,
          supported_mime_types: supportedMimeTypes,
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("Mastodon instance media capabilities", () => {
  it("rebuilds the thread using the instance limit and preserves saved cuts on retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      configuration: { statuses: { max_characters: 80, characters_reserved_per_url: 23 } },
    }))));
    const longEntry = { platformPayloads: { mastodon: "word ".repeat(80).trim() } } as PreparedEntry;
    await validateMastodonInstance(longEntry, config, credentials);
    expect(longEntry.platformChunks!.mastodon!.every((part) => part.length <= 80)).toBe(true);
    const saved = longEntry.platformChunks!.mastodon;
    await validateMastodonInstance(longEntry, config, credentials, true);
    expect(longEntry.platformChunks!.mastodon).toBe(saved);
    longEntry.platformChunks!.mastodon = ["x".repeat(81)];
    await expect(validateMastodonInstance(longEntry, config, credentials, true)).rejects.toThrow(/saved Mastodon thread/);
  });

  it("sends a native reply and a distinct idempotency key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "2", url: "https://m.example/2" })));
    vi.stubGlobal("fetch", fetchMock);
    await publishMastodon({ slug: "part-two", platformPayloads: { mastodon: "...rest" }, language: "es" } as PreparedEntry,
      credentials, { root: { id: "1", url: "root" }, parent: { id: "1", url: "root" } });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ status: "...rest", language: "es", in_reply_to_id: "1" });
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ "Idempotency-Key": "part-two" });
  });

  it("marks a lost creation response as ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection lost")));
    await expect(publishMastodon({ slug: "lost", platformPayloads: { mastodon: "text" } } as PreparedEntry, credentials))
      .rejects.toBeInstanceOf(AmbiguousPublishError);
  });

  it("accepts an image MIME type advertised by the instance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => instanceResponse(["image/png", "image/jpeg"])));
    await expect(
      validateMastodonInstance(entry, config, credentials),
    ).resolves.toBeUndefined();
  });

  it("rejects an image MIME type not advertised by the instance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => instanceResponse(["image/png"])));
    await expect(validateMastodonInstance(entry, config, credentials)).rejects.toThrow(
      /does not support image\/jpeg uploads/,
    );
  });
});
