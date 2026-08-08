import { readFile } from "node:fs/promises";
import { AmbiguousPublishError, SatomiError } from "../errors.js";
import type { PlatformResult, PreparedEntry, ResolvedConfig } from "../types.js";
import { sleep } from "../utils.js";
import { authorization, responseJson } from "./http.js";

interface XCredentials {
  accessToken: string;
}

interface MediaData {
  data: {
    id: string;
    processing_info?: {
      state?: string;
      check_after_secs?: number;
      error?: { message?: string };
    };
  };
}

async function uploadMedia(entry: PreparedEntry, token: string): Promise<string> {
  if (!entry.media) throw new SatomiError("X media upload requires an image attachment.");
  const headers = { ...authorization(token), "User-Agent": "satomi/0.1" };
  const init = new FormData();
  init.append("command", "INIT");
  init.append("media_type", entry.media.mimeType);
  init.append("total_bytes", String(entry.media.bytes));
  init.append("media_category", entry.media.type === "gif" ? "tweet_gif" : "tweet_image");
  const initResponse = await fetch("https://api.x.com/2/media/upload", {
    method: "POST",
    headers,
    body: init,
    signal: AbortSignal.timeout(30_000),
  });
  const initialized = await responseJson<MediaData>(initResponse, "X media initialization");
  const mediaId = initialized.data.id;

  const image = new Uint8Array(await readFile(entry.media.sourcePath));
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0, segment = 0; offset < image.length; offset += chunkSize, segment += 1) {
    const append = new FormData();
    append.append("command", "APPEND");
    append.append("media_id", mediaId);
    append.append("segment_index", String(segment));
    append.append(
      "media",
      new Blob([image.slice(offset, offset + chunkSize)], { type: "application/octet-stream" }),
      `${entry.slug}.${segment}.part`,
    );
    const appendResponse = await fetch("https://api.x.com/2/media/upload", {
      method: "POST",
      headers,
      body: append,
      signal: AbortSignal.timeout(60_000),
    });
    if (!appendResponse.ok) await responseJson(appendResponse, `X media segment ${segment}`);
  }

  const finalize = new FormData();
  finalize.append("command", "FINALIZE");
  finalize.append("media_id", mediaId);
  const finalizeResponse = await fetch("https://api.x.com/2/media/upload", {
    method: "POST",
    headers,
    body: finalize,
    signal: AbortSignal.timeout(30_000),
  });
  let finalized = await responseJson<MediaData>(finalizeResponse, "X media finalization");
  while (["pending", "in_progress"].includes(finalized.data.processing_info?.state ?? "")) {
    await sleep((finalized.data.processing_info?.check_after_secs ?? 1) * 1_000);
    const statusUrl = new URL("https://api.x.com/2/media/upload");
    statusUrl.searchParams.set("command", "STATUS");
    statusUrl.searchParams.set("media_id", mediaId);
    const statusResponse = await fetch(statusUrl, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    finalized = await responseJson<MediaData>(statusResponse, "X media processing");
  }
  if (finalized.data.processing_info?.state === "failed") {
    throw new SatomiError(
      `X media processing failed: ${finalized.data.processing_info.error?.message ?? "unknown error"}`,
    );
  }

  if (entry.media.type !== "gif" && entry.alt) {
    const metadataResponse = await fetch("https://api.x.com/2/media/metadata", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ id: mediaId, metadata: { alt_text: { text: entry.alt } } }),
      signal: AbortSignal.timeout(30_000),
    });
    await responseJson(metadataResponse, "X media alternative text");
  }
  return mediaId;
}

export async function publishX(
  entry: PreparedEntry,
  config: ResolvedConfig,
  credentials: XCredentials,
): Promise<PlatformResult> {
  const mediaId = entry.media ? await uploadMedia(entry, credentials.accessToken) : undefined;
  const body: Record<string, unknown> = { text: entry.platformPayloads.x };
  if (mediaId) body.media = { media_ids: [mediaId] };
  let response: Response;
  try {
    response = await fetch("https://api.x.com/2/tweets", {
      method: "POST",
      headers: {
        ...authorization(credentials.accessToken),
        "Content-Type": "application/json",
        "User-Agent": "satomi/0.1",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new AmbiguousPublishError(
      `X did not return a response after the create request was sent: ${String(error)}`,
    );
  }
  if (response.status >= 500) {
    throw new AmbiguousPublishError(
      `X returned ${response.status} after the create request; reconcile the account before retrying.`,
    );
  }
  const created = await responseJson<{ data: { id: string } }>(response, "X post creation");
  const id = created.data.id;
  return {
    id,
    url: `https://x.com/${encodeURIComponent(config.platforms.x.username)}/status/${id}`,
  };
}
