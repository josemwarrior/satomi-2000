import { describe, expect, it } from "vitest";
import { buildPlatformThread, countPlatformText, platformChunkFits, splitThread } from "./threads.js";
import type { PlatformName, ResolvedConfig } from "./types.js";
import { linkedText } from "./text.js";

const config = {
  platforms: {
    x: { max_characters: 280 }, bluesky: { max_characters: 300 },
    mastodon: { max_characters: 500 }, telegram: { max_characters: 4096 },
  },
} as ResolvedConfig;

function words(parts: string[]): string[] {
  return parts.flatMap((part, i) => {
    if (i > 0) part = part.slice(3);
    if (i < parts.length - 1) part = part.slice(0, -3);
    return part.split(/\s+/u);
  });
}
const split = (text: string, limit: number) => splitThread(text, (part) => part.length <= limit, "test");

describe("word-boundary threads", () => {
  it.each(["x", "bluesky", "mastodon", "telegram"] as PlatformName[])(
    "forces ## boundaries on %s even below its limit, without empty posts", platform => {
      expect(buildPlatformThread(platform, "## First ## ## Second ##", config)).toEqual(["First...", "...Second"]);
    },
  );

  it("combines manual breaks and automatic cuts with a smaller first media caption", () => {
    const parts = buildPlatformThread("telegram", `${"word ".repeat(260)}## Last`, config, "png");
    expect(parts).toHaveLength(3);
    expect(parts[0]!.length).toBeLessThanOrEqual(1024);
    expect(parts.at(-1)).toBe("...Last");
    expect(parts.every((part, i) => platformChunkFits("telegram", part, config, i === 0 ? "png" : undefined))).toBe(true);
  });

  it("counts native link labels and fallback URLs, keeping each link whole", () => {
    const link = `[A labelled link](https://example.com/${"long".repeat(100)})`;
    expect(countPlatformText("bluesky", link)).toBe(15);
    expect(countPlatformText("telegram", link)).toBe(15);
    expect(countPlatformText("x", link)).toBe(47);
    expect(countPlatformText("mastodon", link)).toBe(47);
    const small = { platforms: { ...config.platforms, bluesky: { max_characters: 24 } } } as ResolvedConfig;
    const parts = buildPlatformThread("bluesky", `hello there ${link}! goodbye`, small);
    expect(parts.filter(part => part.includes("https://"))).toHaveLength(1);
    expect(parts.some(part => part.includes(`${link}!`))).toBe(true);
    expect(parts.every(part => platformChunkFits("bluesky", part, small))).toBe(true);
    expect(parts.map(part => linkedText(part).links.length).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("reports a link whose label cannot fit with continuation dots", () => {
    const small = { platforms: { ...config.platforms, bluesky: { max_characters: 12 } } } as ResolvedConfig;
    expect(() => buildPlatformThread("bluesky", "[A long link label](https://example.com) ## Next", small)).toThrow(/word or URL/);
  });

  it.each(["mastodon", "x"] as const)("keeps global reference numbers and a single footer in %s threads", platform => {
    const source = `Antes [Defold](https://defold.com) ${"word ".repeat(20)}## Después [God of War](https://example.org/god-of-war) y [Defold otra vez](https://defold.com).`;
    const small = { platforms: { ...config.platforms, [platform]: { max_characters: 65 } } } as ResolvedConfig;
    const parts = buildPlatformThread(platform, source, small);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every(part => platformChunkFits(platform, part, small))).toBe(true);
    const joined = parts.join("\n");
    expect(joined).toContain("Defold [0]");
    expect(joined).toContain("War [1]");
    expect(joined).toContain("vez [0].");
    expect(joined.match(/\[0\]https:\/\/defold.com/g)).toHaveLength(1);
    expect(joined.match(/\[1\]https:\/\/example.org\/god-of-war/g)).toHaveLength(1);
    expect(joined.indexOf("[0]https:")).toBeGreaterThan(joined.indexOf("vez [0]."));
    expect(parts.every(part => !/^\.\.\.\[\d+\](?!https?:)/u.test(part))).toBe(true);
    expect(joined).not.toContain("##");
  });

  it("counts the reference list at the configured Mastodon URL weight", () => {
    expect(countPlatformText("mastodon", "[One](https://example.com) [Two](https://example.org)", 30)).toBe(84);
  });

  it("preserves a post that fits exactly without markers", () => {
    expect(split("a bb c", 6)).toEqual(["a bb c"]);
    expect(split("", 5)).toEqual([""]);
  });

  it("moves a whole word to reserve space for both continuation markers", () => {
    expect(split("one two three four five six", 13)).toEqual([
      "one two...", "...three...", "...four...", "...five six",
    ]);
  });

  it("retains paragraphs and spacing inside a chunk", () => {
    expect(split("one  two\n\nthree four five", 21)).toEqual([
      "one  two\n\nthree...", "...four five",
    ]);
  });

  it("explains impossible unbroken words rather than cutting or looping", () => {
    expect(() => split("a abcdefghijklmnop", 10)).toThrow(/word or URL/);
    expect(() => split("a b c", 3)).toThrow(/words are never cut/);
  });

  it.each(["x", "bluesky", "mastodon", "telegram"] as PlatformName[])(
    "preserves every word in order with valid %s limits", (platform) => {
      const text = Array.from({ length: 1600 }, (_, i) => `word${i}`).join(" ");
      const parts = buildPlatformThread(platform, text, config);
      expect(parts.length).toBeGreaterThan(1);
      expect(words(parts)).toEqual(text.split(" "));
      for (const [i, part] of parts.entries()) {
        expect(platformChunkFits(platform, part, config)).toBe(true);
        expect(part.startsWith("...")).toBe(i > 0);
        expect(part.endsWith("...")).toBe(i < parts.length - 1);
        expect(part).not.toMatch(/\(\d+\/\d+\)/);
      }
    },
  );

  it("builds independent plans for each platform", () => {
    const text = "hello ".repeat(170).trim();
    expect(buildPlatformThread("mastodon", text, config)).toHaveLength(3);
    expect(buildPlatformThread("bluesky", text, config)).toHaveLength(4);
    expect(buildPlatformThread("x", text, config)).toHaveLength(4);
    expect(buildPlatformThread("telegram", text, config)).toHaveLength(1);
    expect(buildPlatformThread("x", text, config)).not.toEqual(buildPlatformThread("bluesky", text, config));
  });

  it("uses short URL budgets for X and Mastodon without breaking the URL", () => {
    const url = `https://example.com/${"long".repeat(100)}`;
    expect(countPlatformText("x", url)).toBe(23);
    expect(countPlatformText("mastodon", url, 30)).toBe(30);
    for (const platform of ["x", "mastodon"] as const) {
      const text = `hello ${url} ${"tail ".repeat(110)}`.trim();
      const parts = buildPlatformThread(platform, text, config);
      expect(words(parts)).toEqual(text.split(" "));
      expect(parts[0]).toContain(url);
    }
  });

  it("honors grapheme, weighted, code-point and UTF-8 limits for emoji", () => {
    const emoji = "👨‍👩‍👧‍👦";
    expect(countPlatformText("bluesky", emoji)).toBe(1);
    expect(countPlatformText("x", emoji)).toBe(2);
    expect(countPlatformText("telegram", emoji)).toBe(7);
    const text = `${emoji} `.repeat(250).trim();
    const parts = buildPlatformThread("bluesky", text, config);
    expect(words(parts)).toEqual(text.split(" "));
    expect(parts.every((part) => Buffer.byteLength(part) <= 3000)).toBe(true);
    expect(parts.some((part) => part.includes(emoji))).toBe(true);
  });

  it("uses the media caption limit only on the first Telegram part", () => {
    const text = "word ".repeat(1500).trim();
    const parts = buildPlatformThread("telegram", text, config, "png");
    expect(Array.from(parts[0]!).length).toBeLessThanOrEqual(1024);
    expect(parts[1]!.length).toBeGreaterThan(1024);
    expect(parts.every((part) => Array.from(part).length <= 4096)).toBe(true);
    expect(words(parts)).toEqual(text.split(" "));
  });

  it("respects instance and configured limits without raising native limits", () => {
    const text = "word ".repeat(120).trim();
    expect(buildPlatformThread("mastodon", text, config, undefined, 100).every((p) => p.length <= 100)).toBe(true);
    const raised = { platforms: { ...config.platforms, bluesky: { max_characters: 9000 } } } as ResolvedConfig;
    expect(buildPlatformThread("bluesky", text, raised).every((p) => p.length <= 300)).toBe(true);
  });
});
