import { describe, expect, it, vi } from "vitest";
import { requiredCommands, validateXGuardrails } from "./pipeline.js";
import { emptyState } from "./state.js";
import type { PreparedEntry, ResolvedConfig } from "./types.js";

const config = {
  destinations: { x: true },
  platforms: {
    x: {
      estimated_cost_with_url_usd: 0.2,
      estimated_cost_without_url_usd: 0.015,
      max_estimated_cost_usd_per_run: 0.25,
      max_posts_per_day: 2,
    },
  },
  content: { timezone: "Europe/Madrid" },
} as ResolvedConfig;

describe("X URL cost authorization", () => {
  it("rejects a URL unless the specific force flag was supplied", () => {
    const entry = {
      platformPayloads: { x: "A costly link example.com" },
      forceXUrl: false,
    } as PreparedEntry;
    expect(() => validateXGuardrails(entry, emptyState(), config)).toThrow(/--force-x-url/);
  });

  it("allows the URL with the specific force flag while retaining cost limits", () => {
    const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const entry = {
      platformPayloads: { x: "A costly link https://example.com" },
      forceXUrl: true,
    } as PreparedEntry;
    expect(() => validateXGuardrails(entry, emptyState(), config)).not.toThrow();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("higher configured cost"));
    warning.mockRestore();
  });
});

describe("conditional FFmpeg requirement", () => {
  const toolConfig = { jekyll: { build_command: ["bundle", "exec", "jekyll", "build"] } } as ResolvedConfig;

  it("does not require FFmpeg for PNG or text-only Bluesky posts", () => {
    const png = { media: { type: "png" } } as PreparedEntry;
    expect(requiredCommands(png, toolConfig, ["bluesky"])).not.toContain("ffmpeg");
    expect(requiredCommands({} as PreparedEntry, toolConfig, ["bluesky"])).not.toContain("ffmpeg");
  });

  it("requires FFmpeg only for an animated GIF sent to Bluesky", () => {
    const gif = { media: { type: "gif" } } as PreparedEntry;
    expect(requiredCommands(gif, toolConfig, ["bluesky"])).toContain("ffmpeg");
    expect(requiredCommands(gif, toolConfig, ["mastodon"])).not.toContain("ffmpeg");
  });
});
