import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { worker, type Env } from "../src/index.js";

const env: Env = {
  TELEGRAM_BOT_TOKEN: "123456789:test_bot_token",
  TELEGRAM_CHANNEL_ID: "@satomi_test_channel",
  TELEGRAM_GATEWAY_TOKEN: "g".repeat(32),
};

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://worker.example${path}`, init);
}

function authorizedPost(path: string, body?: unknown): Request {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.TELEGRAM_GATEWAY_TOKEN}`,
  };
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return request(path, init);
}

function telegramResponse<T>(result: T, status = 200): Response {
  return new Response(JSON.stringify({ ok: status >= 200 && status < 300, result }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function responseBody(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

describe("satomi Telegram Worker", () => {
  const telegramFetch = vi.fn<typeof fetch>();

  beforeEach(() => {
    telegramFetch.mockReset();
    vi.stubGlobal("fetch", telegramFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes a public health endpoint without disclosing configuration", async () => {
    const response = await worker.fetch(request("/health"), env);
    expect(response.status).toBe(200);
    expect(await responseBody(response)).toEqual({
      ok: true,
      service: "satomi-telegram",
      version: "0.1.0",
    });
    expect(telegramFetch).not.toHaveBeenCalled();
  });

  it("rejects unknown routes", async () => {
    const response = await worker.fetch(request("/unknown"), env);
    expect(response.status).toBe(404);
    expect((await responseBody(response)).error.code).toBe("not_found");
  });

  it("requires bearer authentication for protected endpoints", async () => {
    const response = await worker.fetch(
      request("/validate", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(401);
    expect((await responseBody(response)).error.code).toBe("unauthorized");
    expect(telegramFetch).not.toHaveBeenCalled();
  });

  it("validates the bot, channel, and posting permission", async () => {
    telegramFetch
      .mockResolvedValueOnce(
        telegramResponse({ id: 42, is_bot: true, username: "satomi_bot" }),
      )
      .mockResolvedValueOnce(
        telegramResponse({
          id: -100123456,
          type: "channel",
          title: "Satomi",
          username: "satomi_channel",
        }),
      )
      .mockResolvedValueOnce(
        telegramResponse({ status: "administrator", can_post_messages: true }),
      );

    const response = await worker.fetch(authorizedPost("/validate"), env);
    expect(response.status).toBe(200);
    expect(await responseBody(response)).toEqual({
      ok: true,
      result: {
        botUsername: "satomi_bot",
        channelTitle: "Satomi",
        channelUsername: "satomi_channel",
        channelType: "channel",
        canPostMessages: true,
      },
    });
    expect(telegramFetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(telegramFetch.mock.calls[2]![1]?.body))).toEqual({
      chat_id: "@satomi_test_channel",
      user_id: 42,
    });
  });

  it("rejects a bot without channel posting permission", async () => {
    telegramFetch
      .mockResolvedValueOnce(telegramResponse({ id: 42, is_bot: true }))
      .mockResolvedValueOnce(telegramResponse({ id: -100123456, type: "channel" }))
      .mockResolvedValueOnce(
        telegramResponse({ status: "administrator", can_post_messages: false }),
      );

    const response = await worker.fetch(authorizedPost("/validate"), env);
    expect(response.status).toBe(409);
    expect((await responseBody(response)).error.code).toBe("telegram_preflight_failed");
  });

  it("publishes text through sendMessage", async () => {
    telegramFetch.mockResolvedValueOnce(
      telegramResponse({
        message_id: 17,
        chat: { id: -100123456, type: "channel", username: "satomi_channel" },
      }),
    );

    const response = await worker.fetch(
      authorizedPost("/publish", { slug: "2026-08-09-update", text: "Hello channel" }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await responseBody(response)).toEqual({
      ok: true,
      result: {
        slug: "2026-08-09-update",
        messageId: 17,
        url: "https://t.me/satomi_channel/17",
        method: "sendMessage",
      },
    });
    expect(String(telegramFetch.mock.calls[0]![0])).toContain("/sendMessage");
    expect(JSON.parse(String(telegramFetch.mock.calls[0]![1]?.body))).toEqual({
      chat_id: "@satomi_test_channel",
      text: "Hello channel",
    });
  });

  it.each([
    ["png", "sendPhoto", "photo"],
    ["jpeg", "sendPhoto", "photo"],
    ["gif", "sendAnimation", "animation"],
    ["webp", "sendDocument", "document"],
    ["mp4", "sendVideo", "video"],
  ] as const)("publishes %s media through %s", async (type, method, mediaField) => {
    telegramFetch.mockResolvedValueOnce(
      telegramResponse({
        message_id: 18,
        chat: { id: -100123456, type: "channel" },
      }),
    );

    const response = await worker.fetch(
      authorizedPost("/publish", {
        slug: `2026-08-09-${type}`,
        text: "Media caption",
        media: { url: `https://media.example/image.${type}`, type },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect((await responseBody(response)).result).toMatchObject({
      messageId: 18,
      method,
      url: "https://t.me/c/123456/18",
    });
    const parameters = JSON.parse(String(telegramFetch.mock.calls[0]![1]?.body));
    expect(parameters).toMatchObject({
      chat_id: "@satomi_test_channel",
      caption: "Media caption",
      [mediaField]: `https://media.example/image.${type}`,
    });
    if (type === "mp4") expect(parameters.supports_streaming).toBe(true);
  });

  it("publishes media without requiring or sending a caption", async () => {
    telegramFetch.mockResolvedValueOnce(
      telegramResponse({
        message_id: 19,
        chat: { id: -100123456, type: "channel" },
      }),
    );

    const response = await worker.fetch(
      authorizedPost("/publish", {
        slug: "2026-08-09-media-only",
        text: "",
        media: { url: "https://media.example/image.png", type: "png" },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(String(telegramFetch.mock.calls[0]![1]?.body))).toEqual({
      chat_id: "@satomi_test_channel",
      photo: "https://media.example/image.png",
    });
  });

  it("strictly validates publication payloads before contacting Telegram", async () => {
    const response = await worker.fetch(
      authorizedPost("/publish", {
        slug: "invalid slug",
        text: "Hello",
        extra: true,
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect((await responseBody(response)).error.code).toBe("invalid_request");
    expect(telegramFetch).not.toHaveBeenCalled();
  });

  it("enforces Telegram's shorter media caption limit", async () => {
    const response = await worker.fetch(
      authorizedPost("/publish", {
        slug: "2026-08-09-too-long",
        text: "a".repeat(1_025),
        media: { url: "https://media.example/image.png", type: "png" },
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect((await responseBody(response)).error.message).toContain("1024");
    expect(telegramFetch).not.toHaveBeenCalled();
  });

  it("does not expose the bot token in Telegram API failures", async () => {
    telegramFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    const response = await worker.fetch(
      authorizedPost("/publish", { slug: "2026-08-09-update", text: "Hello" }),
      env,
    );
    const serialized = JSON.stringify(await responseBody(response));
    expect(response.status).toBe(502);
    expect(serialized).toContain("chat not found");
    expect(serialized).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });
});
