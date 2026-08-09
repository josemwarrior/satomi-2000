import { readFile } from "node:fs/promises";
import { SatomiError, ValidationError } from "../errors.js";
import type { PlatformResult, PreparedEntry, ResolvedConfig } from "../types.js";
import { graphemeCount, sleep } from "../utils.js";
import { authorization, responseJson } from "./http.js";

interface MastodonCredentials {
  url: string;
  token: string;
}

interface MediaResponse {
  id: string;
  url?: string | null;
}

export async function validateMastodonInstance(
  entry: PreparedEntry,
  config: ResolvedConfig,
  credentials: MastodonCredentials,
): Promise<void> {
  if (!config.platforms.mastodon.check_instance_limits) return;
  const response = await fetch(`${credentials.url}/api/v2/instance`, {
    headers: { ...authorization(credentials.token), "User-Agent": "satomi/0.1" },
    signal: AbortSignal.timeout(10_000),
  });
  const instance = await responseJson<{
    configuration?: {
      statuses?: { max_characters?: number };
      media_attachments?: {
        image_size_limit?: number;
        video_size_limit?: number;
        video_frame_rate_limit?: number;
        video_matrix_limit?: number;
        supported_mime_types?: string[];
      };
    };
  }>(response, "Mastodon instance validation");
  const configuredCharacters = config.platforms.mastodon.max_characters;
  const instanceCharacters = instance.configuration?.statuses?.max_characters;
  const maximumCharacters = instanceCharacters
    ? Math.min(configuredCharacters, instanceCharacters)
    : configuredCharacters;
  const payload = entry.platformPayloads.mastodon ?? "";
  const count = graphemeCount(payload);
  if (count > maximumCharacters) {
    throw new ValidationError(
      `Mastodon payload contains ${count} graphemes; the instance limit is ${maximumCharacters}.`,
    );
  }
  const mediaConfiguration = instance.configuration?.media_attachments;
  const instanceBytes = entry.media?.type === "mp4"
    ? mediaConfiguration?.video_size_limit
    : mediaConfiguration?.image_size_limit;
  if (instanceBytes && entry.media && entry.media.bytes > instanceBytes) {
    throw new ValidationError(
      `The media is ${(entry.media.bytes / 1_000_000).toFixed(2)} MB; the Mastodon instance limit is ${(instanceBytes / 1_000_000).toFixed(2)} MB.`,
    );
  }
  if (
    entry.media?.type === "mp4" &&
    mediaConfiguration?.video_frame_rate_limit &&
    (entry.media.frameRate ?? 0) > mediaConfiguration.video_frame_rate_limit
  ) {
    throw new ValidationError(
      `The video frame rate exceeds the Mastodon instance limit of ${mediaConfiguration.video_frame_rate_limit} fps.`,
    );
  }
  if (
    entry.media?.type === "mp4" &&
    mediaConfiguration?.video_matrix_limit &&
    entry.media.width * entry.media.height > mediaConfiguration.video_matrix_limit
  ) {
    throw new ValidationError("The video dimensions exceed the Mastodon instance pixel limit.");
  }
  const supportedMimeTypes = mediaConfiguration?.supported_mime_types;
  if (entry.media && supportedMimeTypes && !supportedMimeTypes.includes(entry.media.mimeType)) {
    throw new ValidationError(
      `The Mastodon instance does not support ${entry.media.mimeType} uploads.`,
    );
  }
}

export async function publishMastodon(
  entry: PreparedEntry,
  credentials: MastodonCredentials,
): Promise<PlatformResult> {
  let mediaId: string | undefined;
  if (entry.media) {
    const form = new FormData();
    const mediaBytes = new Uint8Array(await readFile(entry.media.sourcePath));
    form.append(
      "file",
      new Blob([mediaBytes], { type: entry.media.mimeType }),
      entry.media.fileName,
    );
    if (entry.alt) form.append("description", entry.alt);
    const mediaResponse = await fetch(`${credentials.url}/api/v2/media`, {
      method: "POST",
      headers: { ...authorization(credentials.token), "User-Agent": "satomi/0.1" },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    let media = await responseJson<MediaResponse>(mediaResponse, "Mastodon media upload");
    const mediaDeadline = Date.now() + 120_000;
    while (!media.url && Date.now() < mediaDeadline) {
      await sleep(2_000);
      const response = await fetch(`${credentials.url}/api/v1/media/${media.id}`, {
        headers: { ...authorization(credentials.token), "User-Agent": "satomi/0.1" },
        signal: AbortSignal.timeout(10_000),
      });
      media = await responseJson<MediaResponse>(response, "Mastodon media processing");
    }
    if (!media.url) throw new SatomiError("Mastodon did not finish processing the media in time.");
    mediaId = media.id;
  }

  const body: Record<string, unknown> = {
    status: entry.platformPayloads.mastodon,
    language: entry.language,
  };
  if (mediaId) body.media_ids = [mediaId];
  const statusResponse = await fetch(`${credentials.url}/api/v1/statuses`, {
    method: "POST",
    headers: {
      ...authorization(credentials.token),
      "Content-Type": "application/json",
      "Idempotency-Key": entry.slug,
      "User-Agent": "satomi/0.1",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const status = await responseJson<{ id: string; url: string }>(
    statusResponse,
    "Mastodon status creation",
  );
  return { id: status.id, url: status.url };
}
