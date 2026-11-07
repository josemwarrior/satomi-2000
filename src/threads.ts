import twitterText from "twitter-text";
import { ValidationError } from "./errors.js";
import type { MediaType, PlatformName, ResolvedConfig } from "./types.js";
import { graphemeCount } from "./graphemes.js";
import { linkedText, referencedText, textSections, threadSource, tokenizeText } from "./text.js";

export function countPlatformText(platform: PlatformName, text: string, reservedUrlLength = 23): number {
  text = platform === "mastodon" || platform === "x" ? referencedText(text) : linkedText(text).text;
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

/** Keep words and Markdown links intact; ## forces a cut even when the text fits. */
export function splitThread(
  text: string,
  fits: (text: string, index: number) => boolean,
  platform: string,
): string[] {
  const sections = textSections(text);
  if (!sections.length) return [""];
  const parts: string[] = [];
  for (const [sectionIndex, section] of sections.entries()) {
    text = section;
    // Treat a labelled link as one unit so its URL cannot end up on another post.
    const words: Array<{ index: number; length: number }> = [];
    let offset = 0;
    for (const token of tokenizeText(text)) {
      if (token.kind === "link") words.push({ index: offset, length: token.source.length });
      else for (const word of token.source.matchAll(/\S+/gu)) {
        words.push({ index: offset + word.index, length: word[0].length });
      }
      offset += token.source.length;
    }
    // Keep punctuation and numbered references attached to their preceding word.
    for (let i = words.length - 1; i > 0; i--) {
      const left = words[i - 1]!;
      const right = words[i]!;
      const gap = text.slice(left.index + left.length, right.index);
      const reference = /^\[\d+\][.,!?;:]*$/u.test(text.slice(right.index, right.index + right.length));
      if (!gap || (reference && /^[^\S\r\n]+$/u.test(gap))) {
        left.length = right.index + right.length - left.index;
        words.splice(i, 1);
      }
    }
    let start = 0;
    while (start < words.length) {
      const prefix = parts.length ? "..." : "";
      const begin = words[start]!.index;
      const candidate = (end: number) => prefix + text.slice(
        begin, words[end]!.index + words[end]!.length,
      );
      const suffix = sectionIndex < sections.length - 1 ? "..." : "";
      if (fits(candidate(words.length - 1) + suffix, parts.length)) {
        parts.push(candidate(words.length - 1) + suffix);
        break;
      }
      let end = start;
      while (end < words.length && fits(candidate(end), parts.length)) end += 1;
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
    (platform !== "bluesky" || new TextEncoder().encode(linkedText(text).text).byteLength <= 3_000);
}

export function buildPlatformThread(
  platform: PlatformName,
  payload: string,
  config: ResolvedConfig,
  mediaType?: MediaType,
  instanceLimit?: number,
  reservedUrlLength?: number,
): string[] {
  const source = platform === "mastodon" || platform === "x"
    ? referencedText(payload, true) : threadSource(payload, true);
  return splitThread(source, (text, index) => platformChunkFits(
    platform, text, config, index === 0 ? mediaType : undefined, instanceLimit, reservedUrlLength,
  ), platform);
}
