import path from "node:path";
import twitterText from "twitter-text";
import { ValidationError } from "./errors.js";
import { inspectImage } from "./image.js";
import { inspectRemoteVideo } from "./video.js";
import type {
  DraftInput,
  MediaType,
  PlatformName,
  PreparedMedia,
  PreparedEntry,
  ResolvedConfig,
} from "./types.js";
import {
  graphemeCount,
  joinUrl,
  localDate,
  sha256,
  slugify,
  truncateGraphemes,
} from "./utils.js";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, "").replace(/\s+/g, "");
}

export function buildPlatformPayload(
  platform: PlatformName,
  text: string,
  tags: string[],
  canonicalUrl: string,
  config: ResolvedConfig,
): string {
  const platformConfig = config.platforms[platform];
  const sections: string[] = [];
  if (text.trim()) sections.push(text.trim());
  if (platformConfig.include_tags && tags.length > 0) {
    sections.push(tags.map((tag) => `#${normalizeTag(tag)}`).join(" "));
  }
  if (platformConfig.append_canonical_url) sections.push(canonicalUrl);
  return sections.join("\n\n");
}

export function countPlatformText(platform: PlatformName, payload: string): number {
  if (platform === "x") return twitterText.parseTweet(payload).weightedLength;
  return graphemeCount(payload);
}

export function xPayloadContainsUrl(payload: string): boolean {
  return twitterText.extractUrls(payload, { extractUrlsWithoutProtocol: true }).length > 0;
}

export function effectiveLimits(config: ResolvedConfig, mediaType?: MediaType): {
  characters: number;
  mediaMb: number;
} {
  const platforms = (Object.keys(config.platforms) as PlatformName[])
    .filter((name) => config.destinations[name])
    .map((name) => config.platforms[name]);
  return {
    characters: Math.min(...platforms.map((platform) => platform.max_characters)),
    mediaMb:
      mediaType === "mp4"
        ? Math.min(...platforms.map((platform) => platform.max_video_mb))
        : mediaType === undefined || mediaType === "gif"
        ? Math.min(...platforms.map((platform) => platform.max_gif_mb))
        : Math.min(...platforms.map((platform) => platform.max_png_mb)),
  };
}

function deriveTitle(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() || "Microblog update";
  const sentence = firstLine.split(/(?<=[.!?])\s/u, 1)[0] ?? firstLine;
  return truncateGraphemes(sentence, 72).trim();
}

export async function prepareEntry(
  input: DraftInput,
  config: ResolvedConfig,
  now = new Date(),
  temporaryDirectory?: string,
): Promise<PreparedEntry> {
  const text = input.text.trim();
  if (input.imagePath && input.videoUrl) {
    throw new ValidationError("--image and --video cannot be used together.");
  }
  if (
    config.validation.reject_empty_text &&
    text.length === 0 &&
    !input.imagePath &&
    !input.videoUrl
  ) {
    throw new ValidationError("The post text cannot be empty without an image or video.");
  }
  if (config.validation.reject_control_characters && CONTROL_CHARACTERS.test(text)) {
    throw new ValidationError("The post text contains unsupported control characters.");
  }

  const limits = effectiveLimits(config);
  const inputCharacters = graphemeCount(text);
  if (inputCharacters > limits.characters) {
    throw new ValidationError(
      `The text contains ${inputCharacters} graphemes; the common limit is ${limits.characters}.`,
    );
  }

  let media: PreparedMedia | undefined;
  let alt: string | undefined;
  let baseName: string;
  if (input.imagePath) {
    const imagePath = path.resolve(input.imagePath);
    const image = await inspectImage(
      imagePath,
      config.validation.require_matching_image_extension,
    );
    if (
      image.type === "gif" &&
      config.validation.require_animated_gif &&
      (image.frames ?? 0) < 2
    ) {
      throw new ValidationError("The GIF is not animated.");
    }
    const imageLimits = effectiveLimits(config, image.type);
    const imageMb = image.bytes / 1_000_000;
    if (imageMb > imageLimits.mediaMb) {
      throw new ValidationError(
        `The ${image.type.toUpperCase()} is ${imageMb.toFixed(2)} MB; the common limit is ${imageLimits.mediaMb} MB.`,
      );
    }
    alt = input.alt?.trim();
    if (alt && CONTROL_CHARACTERS.test(alt)) {
      throw new ValidationError("Alternative text contains unsupported control characters.");
    }
    if (
      alt &&
      image.type !== "gif" &&
      config.destinations.x &&
      graphemeCount(alt) > 1_000
    ) {
      throw new ValidationError("X alternative text for an image cannot exceed 1000 characters.");
    }
    baseName = slugify(path.basename(imagePath, path.extname(imagePath)));
    const fileName = `${baseName}${image.extension}`;
    media = {
      sourcePath: imagePath,
      fileName,
      type: image.type,
      mimeType: image.mimeType,
      bytes: image.bytes,
      width: image.width,
      height: image.height,
      sha256: sha256(image.buffer),
      publicUrl: joinUrl(config.site.media_url, fileName),
    };
    if (image.frames !== undefined) media.frames = image.frames;
  } else if (input.videoUrl) {
    if (!temporaryDirectory) {
      throw new ValidationError("A temporary directory is required to inspect a remote video.");
    }
    const videoLimits = effectiveLimits(config, "mp4");
    const video = await inspectRemoteVideo(
      input.videoUrl,
      temporaryDirectory,
      videoLimits.mediaMb * 1_000_000,
      config,
    );
    alt = input.alt?.trim();
    if (alt && CONTROL_CHARACTERS.test(alt)) {
      throw new ValidationError("Alternative text contains unsupported control characters.");
    }
    const remoteName = path.posix.basename(new URL(video.publicUrl).pathname, ".mp4");
    baseName = slugify(remoteName || deriveTitle(text));
    media = {
      sourcePath: video.sourcePath,
      fileName: `${baseName}.mp4`,
      type: "mp4",
      mimeType: "video/mp4",
      bytes: video.bytes,
      width: video.width,
      height: video.height,
      durationSeconds: video.durationSeconds,
      frameRate: video.frameRate,
      sha256: video.sha256,
      publicUrl: video.publicUrl,
    };
  } else {
    if (input.alt?.trim()) {
      throw new ValidationError("Alternative text cannot be used without an image or video.");
    }
    baseName = slugify(deriveTitle(text));
  }

  const publishedAt = now.toISOString();
  const date = localDate(publishedAt, config.content.timezone);
  const slug = input.slug?.trim() || `${date}-${baseName}`;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new ValidationError("The slug must contain lowercase letters, digits, and hyphens only.");
  }

  const tags = [...new Set((input.tags ?? config.content.default_tags).map(normalizeTag).filter(Boolean))];
  const canonicalUrl = `${joinUrl(config.site.public_url, slug)}/`;
  const platformPayloads: PreparedEntry["platformPayloads"] = {};
  const payloadSha256: PreparedEntry["payloadSha256"] = {};

  for (const platform of Object.keys(config.platforms) as PlatformName[]) {
    const platformConfig = config.platforms[platform];
    if (!config.destinations[platform]) continue;
    if (media && platformConfig.max_width && media.width > platformConfig.max_width) {
      throw new ValidationError(
        `${platform} accepts at most ${platformConfig.max_width}px width; the media is ${media.width}px.`,
      );
    }
    if (media && platformConfig.max_height && media.height > platformConfig.max_height) {
      throw new ValidationError(
        `${platform} accepts at most ${platformConfig.max_height}px height; the media is ${media.height}px.`,
      );
    }
    const payload = buildPlatformPayload(platform, text, tags, canonicalUrl, config);
    const count = countPlatformText(platform, payload);
    if (count > platformConfig.max_characters) {
      throw new ValidationError(
        `${platform} payload contains ${count} weighted characters; its limit is ${platformConfig.max_characters}.`,
      );
    }
    platformPayloads[platform] = payload;
    payloadSha256[platform] = sha256(payload);
  }

  const contentSha256 = sha256(
    JSON.stringify({ text, alt, tags, language: config.content.language }),
  );
  const entry: PreparedEntry = {
    slug,
    title: input.title?.trim() || deriveTitle(text),
    text,
    tags,
    language: config.content.language,
    publishedAt,
    contentSha256,
    canonicalUrl,
    forceXUrl: input.forceXUrl ?? false,
    platformPayloads,
    payloadSha256,
  };
  if (alt !== undefined) entry.alt = alt;
  if (media !== undefined) entry.media = media;
  return entry;
}
