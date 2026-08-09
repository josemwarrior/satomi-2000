import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { TID } from "@atproto/common-web";
import { SatomiError, ValidationError } from "./errors.js";
import type {
  DraftInput,
  EntryState,
  PlatformName,
  PlatformState,
  PublicationAttempt,
  PublicationAttemptPhase,
  PreparedEntry,
  PublicationState,
  ResolvedConfig,
} from "./types.js";
import { pathExists, sanitizeError, writeTextAtomic } from "./utils.js";

export function emptyState(): PublicationState {
  return { version: 1, entries: {}, attempts: {} };
}

export async function loadState(config: ResolvedConfig): Promise<PublicationState> {
  if (!(await pathExists(config.statePath))) return emptyState();
  let state: PublicationState;
  try {
    state = JSON.parse(await readFile(config.statePath, "utf8")) as PublicationState;
  } catch (error) {
    throw new ValidationError(`Cannot read publication state: ${String(error)}`);
  }
  if (state.version !== 1 || typeof state.entries !== "object" || state.entries === null) {
    throw new ValidationError(`Unsupported or malformed state file: ${config.statePath}`);
  }
  state.attempts ??= {};
  return state;
}

export function createPublicationAttempt(
  state: PublicationState,
  draft: DraftInput,
  now = new Date(),
): PublicationAttempt {
  state.attempts ??= {};
  const highest = Object.keys(state.attempts).reduce((maximum, id) => {
    const match = /^A(\d{6})$/.exec(id);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  const id = `A${String(highest + 1).padStart(6, "0")}`;
  const timestamp = now.toISOString();
  const attempt: PublicationAttempt = {
    id,
    created_at: timestamp,
    updated_at: timestamp,
    status: "running",
    phase: "input",
    draft,
    retryable: false,
  };
  state.attempts[id] = attempt;
  return attempt;
}

export function restartPublicationAttempt(attempt: PublicationAttempt): void {
  attempt.updated_at = new Date().toISOString();
  attempt.status = "running";
  attempt.phase = "input";
  attempt.retryable = false;
  delete attempt.error;
  delete attempt.worktree_files;
}

export function updatePublicationAttempt(
  attempt: PublicationAttempt,
  phase: PublicationAttemptPhase,
): void {
  attempt.phase = phase;
  attempt.updated_at = new Date().toISOString();
}

export async function saveState(
  config: ResolvedConfig,
  state: PublicationState,
): Promise<void> {
  await mkdir(path.dirname(config.statePath), { recursive: true, mode: 0o700 });
  await writeTextAtomic(config.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function makeEntryState(entry: PreparedEntry, config: ResolvedConfig): EntryState {
  const platforms = {} as Record<PlatformName, PlatformState>;
  for (const name of ["mastodon", "bluesky", "x"] as const) {
    platforms[name] = {
      status: config.destinations[name] ? "pending" : "not_started",
    };
  }
  const result: EntryState = {
    content_sha256: entry.contentSha256,
    canonical_url: entry.canonicalUrl,
    text: entry.text,
    tags: entry.tags,
    language: entry.language,
    published_at: entry.publishedAt,
    payload_sha256: entry.payloadSha256,
    platforms,
  };
  if (entry.alt) result.alt = entry.alt;
  if (entry.media) {
    result.media_sha256 = entry.media.sha256;
    result.media_url = entry.media.publicUrl;
    result.repository_media_path = path.join(config.site.media_directory, entry.media.fileName);
  }
  if (config.destinations.org_social) {
    result.org_social_url = `${config.site.public_url}/social.org`;
  }
  return result;
}

export function assertNotDuplicate(
  state: PublicationState,
  entry: PreparedEntry,
): void {
  if (state.entries[entry.slug]) {
    throw new ValidationError(`Slug already exists in publication state: ${entry.slug}`);
  }
  const duplicate = Object.entries(state.entries).find(
    ([, candidate]) =>
      candidate.content_sha256 === entry.contentSha256 &&
      (candidate.media_sha256 ?? candidate.gif_sha256) === entry.media?.sha256,
  );
  if (duplicate) {
    throw new ValidationError(`The same content was already published as ${duplicate[0]}.`);
  }
}

export function markAttempt(entry: EntryState, platform: PlatformName): void {
  const { error: _error, ...previous } = entry.platforms[platform];
  entry.platforms[platform] = {
    ...previous,
    status: "pending",
    attempted_at: new Date().toISOString(),
  };
}

export function ensureBlueskyRecordKey(entry: EntryState): string {
  const existing = entry.platforms.bluesky.rkey;
  if (existing) return existing;
  const recordKey = TID.nextStr();
  entry.platforms.bluesky.rkey = recordKey;
  return recordKey;
}

export function markFailed(
  entry: EntryState,
  platform: PlatformName,
  error: unknown,
  ambiguous = false,
): void {
  const previous = entry.platforms[platform];
  entry.platforms[platform] = {
    ...previous,
    status: ambiguous ? "unknown" : "failed",
    error: sanitizeError(error),
  };
}

export class PublishLock {
  private acquired = false;

  constructor(private readonly lockPath: string) {}

  private processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private async existingOwner(): Promise<number | undefined> {
    try {
      const data = JSON.parse(
        await readFile(path.join(this.lockPath, "owner.json"), "utf8"),
      ) as { pid?: unknown };
      return typeof data.pid === "number" && Number.isInteger(data.pid) && data.pid > 0
        ? data.pid
        : undefined;
    } catch {
      // A lock can exist briefly before its owner file is written.
      return undefined;
    }
  }

  async acquire(): Promise<void> {
    await mkdir(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(this.lockPath, { recursive: false, mode: 0o700 });
        this.acquired = true;
        await writeFile(
          path.join(this.lockPath, "owner.json"),
          `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`,
          { mode: 0o600 },
        );
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const ownerPid = await this.existingOwner();
        if (attempt === 0 && ownerPid && !this.processIsAlive(ownerPid)) {
          await rm(this.lockPath, { recursive: true, force: true });
          continue;
        }
        const owner = ownerPid ? `process ${ownerPid}` : "another process";
        throw new SatomiError(`Another Satomi publication is already running (${owner}).`);
      }
    }
  }

  async release(): Promise<void> {
    if (!this.acquired) return;
    await rm(this.lockPath, { recursive: true, force: true });
    try {
      await rmdir(path.dirname(this.lockPath));
    } catch {
      // Keep the state directory when it contains state or other files.
    }
    this.acquired = false;
  }
}
