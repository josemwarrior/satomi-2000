import { afterEach, describe, expect, it, vi } from "vitest";
import { AmbiguousPublishError } from "../errors.js";
import type { PreparedEntry, ResolvedConfig } from "../types.js";
import { publishTelegram, validateTelegramWorker } from "./telegram.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const config = {
  platforms: {
    telegram: {
      worker_url: "https://satomi-telegram.example.workers.dev",
      timeout_seconds: 30,
    },
  },
} as ResolvedConfig;

const credentials = { workerToken: "test-worker-token" };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Telegram Worker adapter", () => {
  it("validates the configured channel without publishing", async () => {
    const fetchMock = vi.fn(async () => json({
      ok: true,
      result: { channelType: "channel", canPostMessages: true },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateTelegramWorker(config, credentials)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://satomi-telegram.example.workers.dev/validate",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer test-worker-token" },
    });
  });

  it("publishes the final Telegram payload and public media URL", async () => {
    const fetchMock = vi.fn(async () => json({
      ok: true,
      result: {
        messageId: 42,
        url: "https://t.me/satomi_channel/42",
        method: "sendAnimation",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const entry = {
      slug: "2026-08-09-animation",
      text: "Raw text",
      platformPayloads: { telegram: "Final text\n\nhttps://example.com/post/" },
      media: {
        type: "gif",
        publicUrl: "https://example.com/media/animation.gif",
      },
    } as PreparedEntry;

    await expect(publishTelegram(entry, config, credentials)).resolves.toEqual({
      id: "42",
      url: "https://t.me/satomi_channel/42",
    });
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      slug: "2026-08-09-animation",
      text: "Final text\n\nhttps://example.com/post/",
      media: {
        url: "https://example.com/media/animation.gif",
        type: "gif",
      },
    });
    expect(request?.headers).toMatchObject({
      Authorization: "Bearer test-worker-token",
      "Content-Type": "application/json",
    });
  });

  it("keeps a definite Worker rejection retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: false,
      error: { code: "invalid_request", message: "text is too long", ambiguous: false },
    }, 400)));

    await expect(publishTelegram({
      slug: "2026-08-09-update",
      text: "Update",
      platformPayloads: { telegram: "Update" },
    } as PreparedEntry, config, credentials)).rejects.not.toBeInstanceOf(AmbiguousPublishError);
  });

  it("preserves an ambiguous Worker outcome to prevent duplicate retries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: false,
      error: { code: "telegram_timeout", message: "Telegram timed out", ambiguous: true },
    }, 504)));

    await expect(publishTelegram({
      slug: "2026-08-09-update",
      text: "Update",
      platformPayloads: { telegram: "Update" },
    } as PreparedEntry, config, credentials)).rejects.toBeInstanceOf(AmbiguousPublishError);
  });

  it("treats a lost Worker response after a publish request as ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("Timed out", "TimeoutError");
    }));

    await expect(publishTelegram({
      slug: "2026-08-09-update",
      text: "Update",
      platformPayloads: { telegram: "Update" },
    } as PreparedEntry, config, credentials)).rejects.toBeInstanceOf(AmbiguousPublishError);
  });

  it("treats a response body lost after publication as ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => {
        throw new DOMException("Connection closed", "NetworkError");
      },
    } as Response)));

    await expect(publishTelegram({
      slug: "2026-08-09-update",
      text: "Update",
      platformPayloads: { telegram: "Update" },
    } as PreparedEntry, config, credentials)).rejects.toBeInstanceOf(AmbiguousPublishError);
  });

  it("rejects a null Worker response without leaking a runtime TypeError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(null)));

    await expect(validateTelegramWorker(config, credentials)).rejects.toThrow(
      "Telegram validation failed (200)",
    );
  });
});
