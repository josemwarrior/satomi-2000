import { afterEach, describe, expect, it, vi } from "vitest";
import { validateMastodonInstance } from "./mastodon.js";
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
