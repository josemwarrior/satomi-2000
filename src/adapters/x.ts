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

const MEDIA_UPLOAD_URL = "https://api.x.com/2/media/upload";

async function waitForMediaProcessing(
  initial: MediaData,
  mediaId: string,
  headers: Record<string, string>,
): Promise<void> {
  let media = initial;
  while (["pending", "in_progress"].includes(media.data.processing_info?.state ?? "")) {
    await sleep((media.data.processing_info?.check_after_secs ?? 1) * 1_000);
    const statusUrl = new URL(MEDIA_UPLOAD_URL);
    statusUrl.searchParams.set("media_id", mediaId);
    const statusResponse = await fetch(statusUrl, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    media = await responseJson<MediaData>(statusResponse, "X media processing status");
  }
  if (media.data.processing_info?.state === "failed") {
    throw new SatomiError(
      `X media processing failed: ${media.data.processing_info.error?.message ?? "unknown error"}`,
    );
  }
}

async function uploadStaticImage(entry: PreparedEntry, token: string): Promise<string> {
  if (!entry.media) throw new SatomiError("X media upload requires an image attachment.");
  const headers = { ...authorization(token), "User-Agent": "satomi/0.1" };
  const image = await readFile(entry.media.sourcePath);
  const uploadResponse = await fetch(MEDIA_UPLOAD_URL, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      media: image.toString("base64"),
      media_category: "tweet_image",
      media_type: entry.media.mimeType,
      shared: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const uploaded = await responseJson<MediaData>(uploadResponse, "X image upload");
  await waitForMediaProcessing(uploaded, uploaded.data.id, headers);
  return uploaded.data.id;
}

async function uploadChunkedMedia(
  entry: PreparedEntry,
  token: string,
  mediaCategory: "tweet_gif" | "tweet_video",
): Promise<string> {
  if (!entry.media) throw new SatomiError("X media upload requires an attachment.");
  const headers = { ...authorization(token), "User-Agent": "satomi/0.1" };
  const initResponse = await fetch(`${MEDIA_UPLOAD_URL}/initialize`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      media_type: entry.media.mimeType,
      total_bytes: entry.media.bytes,
      media_category: mediaCategory,
      shared: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const initialized = await responseJson<MediaData>(initResponse, "X media initialization");
  const mediaId = initialized.data.id;

  const image = await readFile(entry.media.sourcePath);
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0, segment = 0; offset < image.length; offset += chunkSize, segment += 1) {
    const append = new FormData();
    append.append("segment_index", String(segment));
    append.append(
      "media",
      new Blob([image.subarray(offset, offset + chunkSize)], { type: "application/octet-stream" }),
      `${entry.slug}.${segment}.part`,
    );
    const appendResponse = await fetch(
      `${MEDIA_UPLOAD_URL}/${encodeURIComponent(mediaId)}/append`,
      {
        method: "POST",
        headers,
        body: append,
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!appendResponse.ok) await responseJson(appendResponse, `X media segment ${segment}`);
  }

  const finalizeResponse = await fetch(
    `${MEDIA_UPLOAD_URL}/${encodeURIComponent(mediaId)}/finalize`,
    {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(30_000),
    },
  );
  const finalized = await responseJson<MediaData>(finalizeResponse, "X media finalization");
  await waitForMediaProcessing(finalized, mediaId, headers);
  return mediaId;
}

async function uploadMedia(entry: PreparedEntry, token: string): Promise<string> {
  if (!entry.media) throw new SatomiError("X media upload requires an attachment.");
  const mediaId = entry.media.type === "gif"
    ? await uploadChunkedMedia(entry, token, "tweet_gif")
    : entry.media.type === "mp4"
      ? await uploadChunkedMedia(entry, token, "tweet_video")
      : await uploadStaticImage(entry, token);
  if (entry.media.type !== "gif" && entry.media.type !== "mp4" && entry.alt) {
    const headers = { ...authorization(token), "User-Agent": "satomi/0.1" };
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
  const body: Record<string, unknown> = {};
  const text = entry.platformPayloads.x ?? entry.text;
  if (text || !mediaId) body.text = text;
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
