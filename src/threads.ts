import twitterText from "twitter-text";
import { ValidationError } from "./errors.js";
import type { MediaType, PlatformName, ResolvedConfig } from "./types.js";
import { graphemeCount } from "./graphemes.js";

export function countPlatformText(platform: PlatformName, text: string, reservedUrlLength = 23): number {
  if (platform === "x") return twitterText.parseTweet(text).weightedLength;
  // Telegram's limits count Unicode code points, including each member of a composed emoji.
  if (platform === "telegram") return Array.from(text).length;
  if (platform === "mastodon") {
    let count = graphemeCount(text);
    for (const { url } of twitterText.extractUrlsWithIndices(text, { extractUrlsWithoutProtocol: false })) {
      count += reservedUrlLength - graphemeCount(url);
    }
    return count;
  }
  return graphemeCount(text);
}

/** Keep words intact, preserving whitespace within each part and trimming only at a cut. */
export function splitThread(
  text: string,
  fits: (text: string, index: number) => boolean,
  platform: string,
): string[] {
  text = text.trim();
  if (fits(text, 0)) return [text];
  const words = [...text.matchAll(/\S+/gu)];
  const parts: string[] = [];
  let start = 0;
  while (start < words.length) {
    const prefix = parts.length ? "..." : "";
    const begin = words[start]!.index;
    const candidate = (end: number) => prefix + text.slice(
      begin, words[end]!.index + words[end]![0].length,
    );
    let end = start;
    while (end < words.length && fits(candidate(end), parts.length)) end += 1;
    if (end === words.length) {
      parts.push(candidate(end - 1));
      break;
    }
    end -= 1;
    while (end >= start && !fits(`${candidate(end)}...`, parts.length)) end -= 1;
    if (end < start) {
      throw new ValidationError(
        `${platform}: a word or URL cannot fit in one post with the continuation markers. Shorten that word or exclude this destination; words are never cut.`,
      );
    }
    parts.push(`${candidate(end)}...`);
    start = end + 1;
  }
  return parts;
}

export function platformChunkFits(
  platform: PlatformName,
  text: string,
  config: ResolvedConfig,
  mediaType?: MediaType,
  instanceLimit?: number,
  reservedUrlLength?: number,
): boolean {
  const nativeLimit = platform === "x" ? 280 : platform === "bluesky" ? 300
    : platform === "telegram" ? (mediaType ? 1_024 : 4_096) : Infinity;
  const limit = Math.min(config.platforms[platform].max_characters, nativeLimit, instanceLimit ?? Infinity);
  return countPlatformText(platform, text, reservedUrlLength) <= limit &&
    (platform !== "bluesky" || new TextEncoder().encode(text).byteLength <= 3_000);
}

export function buildPlatformThread(
  platform: PlatformName,
  payload: string,
  config: ResolvedConfig,
  mediaType?: MediaType,
  instanceLimit?: number,
  reservedUrlLength?: number,
): string[] {
  return splitThread(payload, (text, index) => platformChunkFits(
    platform, text, config, index === 0 ? mediaType : undefined, instanceLimit, reservedUrlLength,
  ), platform);
}
