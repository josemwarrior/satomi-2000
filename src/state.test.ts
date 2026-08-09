import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPublicationAttempt,
  emptyState,
  ensureBlueskyRecordKey,
  loadState,
  saveState,
} from "./state.js";
import type { EntryState, ResolvedConfig } from "./types.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

describe("publication attempt persistence", () => {
  it("assigns stable sequential retry IDs", () => {
    const state = emptyState();
    const first = createPublicationAttempt(
      state,
      { text: "First" },
      new Date("2026-08-09T00:00:00.000Z"),
    );
    const second = createPublicationAttempt(
      state,
      { text: "Second" },
      new Date("2026-08-09T00:01:00.000Z"),
    );
    expect(first.id).toBe("A000001");
    expect(second.id).toBe("A000002");
  });

  it("migrates a version-one state without an attempts object", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "satomi-state-"));
    temporaryPaths.push(root);
    const config = { statePath: path.join(root, "state.json") } as ResolvedConfig;
    const legacy = { version: 1 as const, entries: {} };
    await saveState(config, legacy);
    expect((await loadState(config)).attempts).toEqual({});
  });
});

describe("Bluesky record key persistence", () => {
  it("assigns one valid TID and reuses it for retries", () => {
    const entry = {
      platforms: {
        mastodon: { status: "not_started" },
        bluesky: { status: "failed" },
        x: { status: "not_started" },
      },
    } as EntryState;

    const first = ensureBlueskyRecordKey(entry);
    const second = ensureBlueskyRecordKey(entry);

    expect(first).toMatch(/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/);
    expect(second).toBe(first);
    expect(entry.platforms.bluesky.rkey).toBe(first);
  });
});
