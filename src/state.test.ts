import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPublicationAttempt,
  emptyState,
  ensureBlueskyRecordKey,
  loadState,
  PublishLock,
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

describe("publication lock", () => {
  it("recovers a lock owned by a process that no longer exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "satomi-stale-lock-"));
    temporaryPaths.push(root);
    const lockPath = path.join(root, ".satomi", "publish.lock");
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: 999_999_999, started_at: "2026-08-09T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );

    const lock = new PublishLock(lockPath);
    await lock.acquire();
    const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as {
      pid: number;
    };
    expect(owner.pid).toBe(process.pid);
    await lock.release();
  });

  it("does not replace a lock owned by a live process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "satomi-live-lock-"));
    temporaryPaths.push(root);
    const lockPath = path.join(root, ".satomi", "publish.lock");
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );

    await expect(new PublishLock(lockPath).acquire()).rejects.toThrow(
      `Another Satomi publication is already running (process ${process.pid}).`,
    );
  });
});
