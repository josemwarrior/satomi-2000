import { AmbiguousPublishError, SatomiError, ValidationError } from "../errors.js";
import type { PlatformResult, PreparedEntry, ResolvedConfig } from "../types.js";

interface TelegramWorkerCredentials {
  workerToken: string;
}

interface WorkerErrorBody {
  ok: false;
  error?: {
    code?: unknown;
    message?: unknown;
    ambiguous?: unknown;
  };
}

interface WorkerSuccessBody<T> {
  ok: true;
  result: T;
}

interface ValidationResult {
  channelType?: unknown;
  canPostMessages?: unknown;
}

interface PublishResult {
  messageId?: unknown;
  url?: unknown;
}

function workerOrigin(config: ResolvedConfig): string {
  const configured = config.platforms.telegram.worker_url;
  if (!configured) {
    throw new ValidationError(
      "platforms.telegram.worker_url is required when Telegram is selected.",
    );
  }
  return configured.replace(/\/+$/, "");
}

function workerError(body: unknown): {
  message?: string;
  ambiguous?: boolean;
} {
  if (!body || typeof body !== "object") return {};
  const candidate = body as WorkerErrorBody;
  if (!candidate.error || typeof candidate.error !== "object") return {};
  return {
    ...(typeof candidate.error.message === "string"
      ? { message: candidate.error.message.slice(0, 300) }
      : {}),
    ...(typeof candidate.error.ambiguous === "boolean"
      ? { ambiguous: candidate.error.ambiguous }
      : {}),
  };
}

async function callWorker<T>(
  endpoint: "/validate" | "/publish",
  config: ResolvedConfig,
  credentials: TelegramWorkerCredentials,
  body?: Record<string, unknown>,
): Promise<T> {
  const publishing = endpoint === "/publish";
  const action = publishing ? "Telegram publication" : "Telegram validation";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.workerToken}`,
  };
  const init: RequestInit = {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(config.platforms.telegram.timeout_seconds * 1_000),
  };
  if (body) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(`${workerOrigin(config)}${endpoint}`, init);
  } catch (error) {
    const message = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
      ? `${action} timed out.`
      : `${action} could not reach the Worker.`;
    if (publishing) throw new AmbiguousPublishError(message);
    throw new SatomiError(message);
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    const message = `${action} response could not be read (${response.status}).`;
    if (publishing) throw new AmbiguousPublishError(message);
    throw new SatomiError(message);
  }
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    const message = `${action} returned an invalid response (${response.status}).`;
    if (publishing && response.status >= 200) throw new AmbiguousPublishError(message);
    throw new SatomiError(message);
  }

  const responseBody = parsed && typeof parsed === "object"
    ? parsed as Partial<WorkerSuccessBody<T>>
    : undefined;
  const error = workerError(parsed);
  if (!response.ok || responseBody?.ok !== true) {
    const message = `${action} failed (${response.status}): ${error.message ?? response.statusText}`;
    const ambiguous = publishing && (error.ambiguous ?? response.status >= 500);
    if (ambiguous) throw new AmbiguousPublishError(message);
    throw new SatomiError(message);
  }
  const result = (responseBody as WorkerSuccessBody<T>).result;
  if (!result || typeof result !== "object") {
    const message = `${action} returned no result.`;
    if (publishing) throw new AmbiguousPublishError(message);
    throw new SatomiError(message);
  }
  return result;
}

export async function validateTelegramWorker(
  config: ResolvedConfig,
  credentials: TelegramWorkerCredentials,
): Promise<void> {
  const result = await callWorker<ValidationResult>("/validate", config, credentials);
  if (result.channelType !== "channel" || result.canPostMessages !== true) {
    throw new ValidationError(
      "The Telegram Worker did not confirm a channel with posting permission.",
    );
  }
}

export async function publishTelegram(
  entry: PreparedEntry,
  config: ResolvedConfig,
  credentials: TelegramWorkerCredentials,
): Promise<PlatformResult> {
  const body: Record<string, unknown> = {
    slug: entry.slug,
    text: entry.platformPayloads.telegram ?? entry.text,
  };
  if (entry.media) {
    body.media = {
      url: entry.media.publicUrl,
      type: entry.media.type,
    };
  }
  const result = await callWorker<PublishResult>("/publish", config, credentials, body);
  if (!Number.isInteger(result.messageId) || typeof result.url !== "string" || !result.url) {
    throw new AmbiguousPublishError("Telegram publication returned an invalid message result.");
  }
  return { id: String(result.messageId), url: result.url };
}
