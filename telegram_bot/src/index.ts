export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHANNEL_ID: string;
  TELEGRAM_GATEWAY_TOKEN: string;
}

type MediaType = "gif" | "png" | "jpeg" | "webp";

interface PublishRequest {
  slug: string;
  text: string;
  media?: {
    url: string;
    type: MediaType;
  };
}

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

interface TelegramChatMember {
  status: string;
  can_post_messages?: boolean;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly ambiguous = false,
  ) {
    super(message);
  }
}

class TelegramApiError extends Error {
  constructor(
    readonly telegramStatus: number,
    message: string,
  ) {
    super(message);
  }
}

const SERVICE = "satomi-telegram";
const VERSION = "0.1.0";
const MAX_BODY_BYTES = 32_768;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const MEDIA_TYPES = new Set<MediaType>(["gif", "png", "jpeg", "webp"]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(error: HttpError): Response {
  return jsonResponse(
    {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ambiguous: error.ambiguous,
      },
    },
    error.status,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new HttpError(
      400,
      "invalid_request",
      `${field} contains unsupported field(s): ${unexpected.join(", ")}.`,
    );
  }
}

function parseMedia(value: unknown): PublishRequest["media"] {
  if (!isRecord(value)) {
    throw new HttpError(400, "invalid_request", "media must be an object.");
  }
  assertOnlyKeys(value, ["url", "type"], "media");
  if (typeof value.url !== "string" || value.url.length > 2_048) {
    throw new HttpError(
      400,
      "invalid_request",
      "media.url must be a valid HTTPS URL.",
    );
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new HttpError(
      400,
      "invalid_request",
      "media.url must be a valid HTTPS URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "media.url must be a valid HTTPS URL.",
    );
  }
  if (
    typeof value.type !== "string" ||
    !MEDIA_TYPES.has(value.type as MediaType)
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "media.type must be one of: gif, png, jpeg, webp.",
    );
  }
  return { url: url.toString(), type: value.type as MediaType };
}

function parsePublishRequest(value: unknown): PublishRequest {
  if (!isRecord(value)) {
    throw new HttpError(
      400,
      "invalid_request",
      "The request body must be a JSON object.",
    );
  }
  assertOnlyKeys(value, ["slug", "text", "media"], "request body");
  if (
    typeof value.slug !== "string" ||
    value.slug.length > 200 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug)
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "slug must contain lowercase letters, digits, and single hyphens only.",
    );
  }
  if (typeof value.text !== "string") {
    throw new HttpError(400, "invalid_request", "text must be a string.");
  }
  const text = value.text.trim();
  if (!text)
    throw new HttpError(400, "invalid_request", "text cannot be empty.");
  if (CONTROL_CHARACTERS.test(text)) {
    throw new HttpError(
      400,
      "invalid_request",
      "text contains unsupported control characters.",
    );
  }
  const media = value.media === undefined ? undefined : parseMedia(value.media);
  const maximumCharacters = media ? 1_024 : 4_096;
  if (Array.from(text).length > maximumCharacters) {
    throw new HttpError(
      400,
      "invalid_request",
      `text cannot exceed ${maximumCharacters} characters${media ? " when used as a media caption" : ""}.`,
    );
  }
  return media ? { slug: value.slug, text, media } : { slug: value.slug, text };
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json.",
    );
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(
      413,
      "request_too_large",
      "The request body is too large.",
    );
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(
      413,
      "request_too_large",
      "The request body is too large.",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(
      400,
      "invalid_json",
      "The request body is not valid JSON.",
    );
  }
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

function assertConfigured(env: Env): void {
  if (
    !env.TELEGRAM_BOT_TOKEN ||
    /[\s/?#]/u.test(env.TELEGRAM_BOT_TOKEN) ||
    !env.TELEGRAM_CHANNEL_ID ||
    !env.TELEGRAM_GATEWAY_TOKEN ||
    env.TELEGRAM_GATEWAY_TOKEN.length < 32
  ) {
    throw new HttpError(
      500,
      "configuration_error",
      "The Worker is not configured correctly.",
    );
  }
}

async function assertAuthorized(request: Request, env: Env): Promise<void> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  if (!match || !(await secureEqual(match[1]!, env.TELEGRAM_GATEWAY_TOKEN))) {
    throw new HttpError(
      401,
      "unauthorized",
      "Valid bearer authentication is required.",
    );
  }
}

function cleanTelegramDescription(value: unknown): string {
  if (typeof value !== "string")
    return "Telegram returned an unspecified error.";
  return value
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .trim()
    .slice(0, 300);
}

async function telegramCall<T>(
  env: Env,
  method: string,
  parameters: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parameters),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      ["AbortError", "TimeoutError"].includes(error.name)
    ) {
      throw new HttpError(
        504,
        "telegram_timeout",
        "Telegram did not respond in time.",
        true,
      );
    }
    throw new HttpError(
      502,
      "telegram_unavailable",
      "Telegram could not be reached.",
      true,
    );
  }

  let envelope: TelegramEnvelope<T>;
  try {
    envelope = (await response.json()) as TelegramEnvelope<T>;
  } catch {
    throw new HttpError(
      502,
      "telegram_invalid_response",
      "Telegram returned an invalid response.",
      response.status >= 500,
    );
  }
  if (!response.ok || envelope.ok !== true || envelope.result === undefined) {
    throw new TelegramApiError(
      envelope.error_code ?? response.status,
      cleanTelegramDescription(envelope.description),
    );
  }
  return envelope.result;
}

async function validateTelegram(env: Env): Promise<Response> {
  const bot = await telegramCall<TelegramUser>(env, "getMe", {});
  if (!bot.is_bot) {
    throw new HttpError(
      409,
      "telegram_preflight_failed",
      "The configured account is not a bot.",
    );
  }
  const chat = await telegramCall<TelegramChat>(env, "getChat", {
    chat_id: env.TELEGRAM_CHANNEL_ID,
  });
  if (chat.type !== "channel") {
    throw new HttpError(
      409,
      "telegram_preflight_failed",
      "TELEGRAM_CHANNEL_ID does not identify a Telegram channel.",
    );
  }
  const membership = await telegramCall<TelegramChatMember>(
    env,
    "getChatMember",
    {
      chat_id: env.TELEGRAM_CHANNEL_ID,
      user_id: bot.id,
    },
  );
  const canPost =
    membership.status === "creator" ||
    (membership.status === "administrator" &&
      membership.can_post_messages === true);
  if (!canPost) {
    throw new HttpError(
      409,
      "telegram_preflight_failed",
      "The bot is not a channel administrator with permission to post messages.",
    );
  }
  return jsonResponse({
    ok: true,
    result: {
      botUsername: bot.username ?? null,
      channelTitle: chat.title ?? null,
      channelUsername: chat.username ?? null,
      channelType: chat.type,
      canPostMessages: true,
    },
  });
}

function messageUrl(chat: TelegramChat, messageId: number): string | null {
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  const channelId = String(chat.id);
  if (channelId.startsWith("-100") && channelId.length > 4) {
    return `https://t.me/c/${channelId.slice(4)}/${messageId}`;
  }
  return null;
}

async function publishTelegram(
  env: Env,
  publication: PublishRequest,
): Promise<Response> {
  let method: "sendMessage" | "sendPhoto" | "sendAnimation" | "sendDocument";
  let parameters: Record<string, unknown>;
  if (!publication.media) {
    method = "sendMessage";
    parameters = { chat_id: env.TELEGRAM_CHANNEL_ID, text: publication.text };
  } else if (publication.media.type === "gif") {
    method = "sendAnimation";
    parameters = {
      chat_id: env.TELEGRAM_CHANNEL_ID,
      animation: publication.media.url,
      caption: publication.text,
    };
  } else if (publication.media.type === "webp") {
    method = "sendDocument";
    parameters = {
      chat_id: env.TELEGRAM_CHANNEL_ID,
      document: publication.media.url,
      caption: publication.text,
    };
  } else {
    method = "sendPhoto";
    parameters = {
      chat_id: env.TELEGRAM_CHANNEL_ID,
      photo: publication.media.url,
      caption: publication.text,
    };
  }
  const message = await telegramCall<TelegramMessage>(env, method, parameters);
  if (!Number.isInteger(message.message_id) || !message.chat) {
    throw new HttpError(
      502,
      "telegram_invalid_response",
      "Telegram returned an invalid message.",
      true,
    );
  }
  return jsonResponse({
    ok: true,
    result: {
      slug: publication.slug,
      messageId: message.message_id,
      url: messageUrl(message.chat, message.message_id),
      method,
    },
  });
}

function normalizeError(error: unknown, publishing: boolean): HttpError {
  if (error instanceof HttpError) {
    return publishing && error.code.startsWith("telegram_") && !error.ambiguous
      ? new HttpError(
          error.status,
          error.code,
          error.message,
          error.status >= 500,
        )
      : error;
  }
  if (error instanceof TelegramApiError) {
    const ambiguous = publishing && error.telegramStatus >= 500;
    return new HttpError(
      error.telegramStatus === 429 ? 503 : 502,
      "telegram_api_error",
      error.message,
      ambiguous,
    );
  }
  return new HttpError(
    500,
    "internal_error",
    "The Worker could not complete the request.",
    publishing,
  );
}

export const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: SERVICE, version: VERSION });
    }
    const isValidate =
      request.method === "POST" && url.pathname === "/validate";
    const isPublish = request.method === "POST" && url.pathname === "/publish";
    if (!isValidate && !isPublish) {
      return errorResponse(new HttpError(404, "not_found", "Route not found."));
    }
    try {
      assertConfigured(env);
      await assertAuthorized(request, env);
      if (isValidate) return await validateTelegram(env);
      const publication = parsePublishRequest(await readJson(request));
      return await publishTelegram(env, publication);
    } catch (error) {
      return errorResponse(normalizeError(error, isPublish));
    }
  },
} satisfies ExportedHandler<Env>;

export default worker;
