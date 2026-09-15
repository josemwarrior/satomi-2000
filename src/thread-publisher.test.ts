import { describe, expect, it, vi } from "vitest";
import { AmbiguousPublishError } from "./errors.js";
import { publishThread } from "./thread-publisher.js";
import { makeEntryState } from "./state.js";
import type { PlatformName, PlatformResult, PreparedEntry, ResolvedConfig, ThreadReply } from "./types.js";

const config = {
  destinations: { mastodon: true, bluesky: true, x: true, telegram: true, org_social: false },
  site: { media_directory: "media" },
} as ResolvedConfig;
const texts = ["First...", "...middle...", "...last"];
function draft(platform: PlatformName): PreparedEntry {
  return {
    slug: "test-thread", text: "First middle last", platformPayloads: { [platform]: "First middle last" },
    platformChunks: { [platform]: texts }, payloadSha256: {}, tags: [],
    media: { type: "png", fileName: "image.png" }, alt: "An image",
  } as PreparedEntry;
}
function result(index: number): PlatformResult {
  return { id: `${index}`, url: `https://example.com/${index}`, uri: `at://did/post/${index}`, cid: `cid${index}` };
}

describe("resumable thread publication", () => {
  it.each(["mastodon", "bluesky", "x", "telegram"] as PlatformName[])(
    "chains %s replies, attaches media once and keeps the root URL", async (platform) => {
      const entry = draft(platform);
      const state = makeEntryState(entry, config);
      const snapshots: typeof state[] = [];
      const publish = vi.fn(async (_part: PreparedEntry, _key?: string, _reply?: ThreadReply) => result(publish.mock.calls.length));
      await publishThread(platform, entry, state, publish, async () => { snapshots.push(structuredClone(state)); });
      expect(publish).toHaveBeenCalledTimes(3);
      expect(publish.mock.calls[0]![0].media).toBe(entry.media);
      expect(publish.mock.calls[0]![2]).toBeUndefined();
      expect(publish.mock.calls[1]![0].media).toBeUndefined();
      expect(publish.mock.calls[1]![0].alt).toBeUndefined();
      expect(publish.mock.calls[2]![2]).toMatchObject({ root: result(1), parent: result(2) });
      expect(new Set(publish.mock.calls.map(([part]) => part.slug)).size).toBe(3);
      if (platform === "bluesky") expect(new Set(publish.mock.calls.map(([, key]) => key)).size).toBe(3);
      expect(state.platforms[platform]).toMatchObject({ status: "published", url: result(1).url });
      expect(snapshots[0]!.platforms[platform].chunks![0]!.status).toBe("pending");
      expect(snapshots[1]!.platforms[platform].chunks![0]!.status).toBe("published");
    },
  );

  it("resumes a failed middle part with its saved record key and parent", async () => {
    const entry = draft("bluesky");
    const state = makeEntryState(entry, config);
    const publish = vi.fn().mockResolvedValueOnce(result(1)).mockRejectedValueOnce(new Error("rate limited"));
    const persist = vi.fn(async () => {});
    await publishThread("bluesky", entry, state, publish, persist);
    expect(state.platforms.bluesky).toMatchObject({ status: "failed", url: result(1).url });
    const retryKey = state.platforms.bluesky.chunks![1]!.rkey;
    const resume = vi.fn().mockResolvedValueOnce(result(2)).mockResolvedValueOnce(result(3));
    await publishThread("bluesky", entry, state, resume, persist);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume.mock.calls[0]![0].platformPayloads.bluesky).toBe(texts[1]);
    expect(resume.mock.calls[0]![1]).toBe(retryKey);
    expect(resume.mock.calls[0]![2]).toMatchObject({ root: result(1), parent: result(1) });
    expect(state.platforms.bluesky.status).toBe("published");
  });

  it("stops on an ambiguous write and blocks a blind retry", async () => {
    const entry = draft("x");
    const state = makeEntryState(entry, config);
    const publish = vi.fn().mockResolvedValueOnce(result(1)).mockRejectedValueOnce(new AmbiguousPublishError("timeout"));
    const persist = vi.fn(async () => {});
    await publishThread("x", entry, state, publish, persist);
    expect(state.platforms.x.chunks!.map((c) => c.status)).toEqual(["published", "unknown", "not_started"]);
    await expect(publishThread("x", entry, state, publish, persist)).rejects.toThrow(/reconcile/);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("does not mark a confirmed remote write as retryable if saving its result fails", async () => {
    const entry = draft("telegram");
    const state = makeEntryState(entry, config);
    const publish = vi.fn().mockResolvedValue(result(1));
    const persist = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disk full"));
    await expect(publishThread("telegram", entry, state, publish, persist)).rejects.toThrow("disk full");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(state.platforms.telegram.status).toBe("pending");
    expect(state.platforms.telegram.chunks![0]!.status).toBe("published");
  });

  it("refuses a changed segmentation on retry", async () => {
    const entry = draft("mastodon");
    const state = makeEntryState(entry, config);
    entry.platformChunks!.mastodon = ["different"];
    const publish = vi.fn();
    await expect(publishThread("mastodon", entry, state, publish, vi.fn())).rejects.toThrow(/saved thread changed/);
    expect(publish).not.toHaveBeenCalled();
  });
});
