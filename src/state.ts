import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SatomiError, ValidationError } from "./errors.js";
import type {
  EntryState,
  PlatformName,
  PlatformState,
  PreparedEntry,
  PublicationState,
  ResolvedConfig,
} from "./types.js";
import { pathExists, sanitizeError, writeTextAtomic } from "./utils.js";

export function emptyState(): PublicationState {
  return { version: 1, entries: {} };
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
  return state;
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

  async acquire(): Promise<void> {
    await mkdir(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
    try {
      await mkdir(this.lockPath, { recursive: false, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = "another process";
      try {
        const data = JSON.parse(
          await readFile(path.join(this.lockPath, "owner.json"), "utf8"),
        ) as { pid?: number };
        if (data.pid) owner = `process ${data.pid}`;
      } catch {
        // A lock can exist before its owner file is written.
      }
      throw new SatomiError(`Another Satomi publication is already running (${owner}).`);
    }
    this.acquired = true;
    await writeFile(
      path.join(this.lockPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
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
