import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { isRemoteImage } from "./image.js";
import path from "node:path";
import { AmbiguousPublishError, SatomiError, ValidationError } from "./errors.js";
import { loadCredentials } from "./credentials.js";
import { waitForDeployment } from "./deployment.js";
import {
  applyStagedFiles,
  cleanupStagedSite,
  runJekyllBuild,
  stageSite,
  type StagedSite,
} from "./jekyll.js";
import {
  assertGeneratedTargetsClean,
  commitLocalChanges,
  commitGeneratedFiles,
  commitMetadataFile,
  listWorktreeChanges,
  pushBranch,
  synchronizeRepository,
  validateGitRepository,
} from "./git.js";
import { convertGifToMp4 } from "./media.js";
import { prepareEntry, xPayloadContainsUrl } from "./messages.js";
import { platformChunkFits } from "./threads.js";
import { linkedText } from "./text.js";
import { publishThread } from "./thread-publisher.js";
import {
  assertNotDuplicate,
  createPublicationAttempt,
  loadState,
  makeEntryState,
  PublishLock,
  restartPublicationAttempt,
  saveState,
  updatePublicationAttempt,
} from "./state.js";
import { renderSyndicationData } from "./templates.js";
import {
  PLATFORM_NAMES,
  type Credentials,
  type DraftInput,
  type EntryState,
  type PlatformName,
  type PlatformResult,
  type PlatformState,
  type PreparedEntry,
  type PublicationAttempt,
  type PublicationHistoryRow,
  type PublicationState,
  type PublishSummary,
  type ResolvedConfig,
  type ThreadReply,
} from "./types.js";
import {
  commandExists,
  errorMessage,
  localDate,
  pathExists,
  sanitizeError,
  writeTextAtomic,
} from "./utils.js";
import { publishBluesky, type BlueskySession } from "./adapters/bluesky.js";
import { publishMastodon, validateMastodonInstance } from "./adapters/mastodon.js";
import { publishTelegram, validateTelegramWorker } from "./adapters/telegram.js";
import { publishX } from "./adapters/x.js";

async function validateTools(
  entry: PreparedEntry,
  config: ResolvedConfig,
  platforms: PlatformName[],
): Promise<void> {
  for (const command of requiredCommands(entry, config, platforms)) {
    if (!command || !(await commandExists(command))) {
      throw new ValidationError(`Required command is not available: ${command ?? "unknown"}`);
    }
  }
}

export function requiredCommands(
  entry: PreparedEntry,
  config: ResolvedConfig,
  platforms: PlatformName[],
): string[] {
  const required = new Set(["git", config.jekyll.build_command[0]]);
  if (platforms.includes("bluesky") && entry.media?.type === "gif") required.add("ffmpeg");
  if (entry.media?.type === "mp4") required.add("ffprobe");
  return [...required].filter((command): command is string => Boolean(command));
}

export function validateXGuardrails(
  entry: PreparedEntry,
  state: PublicationState,
  config: ResolvedConfig,
): void {
  if (!config.destinations.x) return;
  const x = config.platforms.x;
  const xPayload = entry.platformPayloads.x;
  if (xPayload === undefined) throw new ValidationError("X payload was not prepared.");
  const savedChunks = state.entries[entry.slug]?.platforms.x.chunks;
  const chunks = (entry.platformChunks?.x ?? [xPayload]).filter(
    (_, index) => savedChunks?.[index]?.status !== "published",
  );
  const containsUrl = chunks.some(xPayloadContainsUrl);
  if (containsUrl && !entry.forceXUrl) {
    throw new ValidationError(
      "The X payload contains a URL, which has a considerably higher configured cost. Re-run with --force-x to authorize this specific X post.",
    );
  }
  if (containsUrl) {
    process.stderr.write(
      "WARNING: --force-x accepted; the X post contains a URL and uses the higher configured cost estimate.\n",
    );
  }
  const estimatedCost = chunks.reduce((cost, text) => cost + (xPayloadContainsUrl(text)
    ? x.estimated_cost_with_url_usd
    : x.estimated_cost_without_url_usd), 0);
  if (estimatedCost > x.max_estimated_cost_usd_per_run) {
    throw new ValidationError(
      `Estimated X cost $${estimatedCost.toFixed(3)} exceeds the per-run guardrail $${x.max_estimated_cost_usd_per_run.toFixed(3)}.`,
    );
  }
  const today = localDate(new Date().toISOString(), config.content.timezone);
  const attemptsToday = Object.values(state.entries).reduce((total, candidate) => {
    const xState = candidate.platforms.x;
    return total + (xState.chunks ?? [xState]).filter((part) =>
      part.status !== "failed" && part.status !== "not_started" &&
      part.attempted_at !== undefined &&
      localDate(part.attempted_at, config.content.timezone) === today,
    ).length;
  }, 0);
  if (attemptsToday + chunks.length > x.max_posts_per_day) {
    if (!entry.forceXUrl) {
      throw new ValidationError(
        `The local X limit of ${x.max_posts_per_day} posts per day was reached. Re-run with --force-x to bypass it.`,
      );
    }
    process.stderr.write(
      `WARNING: --force-x accepted; bypassing the local X limit of ${x.max_posts_per_day} posts per day.\n`,
    );
  }
}

async function preflight(
  entry: PreparedEntry,
  config: ResolvedConfig,
  state: PublicationState,
  platforms?: PlatformName[],
  preserveChunks = false,
): Promise<Credentials> {
  const selected = platforms ?? PLATFORM_NAMES.filter(
    (name) => config.destinations[name],
  );
  if (
    selected.some((name) => config.platforms[name].append_canonical_url) &&
    !config.git.push
  ) {
    throw new ValidationError(
      "git.push must be true when an enabled platform appends the canonical URL.",
    );
  }
  await validateTools(entry, config, selected);
  await validateGitRepository(config);
  if (selected.includes("x")) validateXGuardrails(entry, state, config);
  const credentials = await loadCredentials(config, selected);
  if (selected.includes("mastodon") && credentials.mastodon) {
    await validateMastodonInstance(entry, config, credentials.mastodon, preserveChunks);
  }
  if (selected.includes("telegram") && credentials.telegram) {
    await validateTelegramWorker(config, credentials.telegram, (entry.platformChunks?.telegram?.length ?? 1) > 1,
      linkedText(entry.platformPayloads.telegram ?? entry.text).links.length > 0);
  }
  return credentials;
}

async function publishOne(
  platform: PlatformName,
  entry: PreparedEntry,
  config: ResolvedConfig,
  credentials: Credentials,
  temporaryDirectory: string,
  blueskyRecordKey?: string,
  reply?: ThreadReply,
  blueskySession?: BlueskySession,
): Promise<PlatformResult> {
  if (platform === "mastodon") {
    if (!credentials.mastodon) throw new ValidationError("Mastodon credentials were not loaded.");
    return await publishMastodon(entry, credentials.mastodon, reply);
  }
  if (platform === "bluesky") {
    if (!credentials.bluesky) throw new ValidationError("Bluesky credentials were not loaded.");
    if (!blueskyRecordKey) throw new ValidationError("Bluesky record key was not prepared.");
    const mp4 = entry.media?.type === "gif"
      ? await convertGifToMp4(entry, temporaryDirectory)
      : entry.media?.type === "mp4"
        ? entry.media.sourcePath
        : undefined;
    return await publishBluesky(entry, mp4, config, credentials.bluesky, blueskyRecordKey, reply, blueskySession);
  }
  if (platform === "x") {
    if (!credentials.x) throw new ValidationError("X credentials were not loaded.");
    return await publishX(entry, config, credentials.x, reply);
  }
  if (!credentials.telegram) {
    throw new ValidationError("Telegram credentials were not loaded.");
  }
  return await publishTelegram(entry, config, credentials.telegram, reply);
}

async function publishPlatforms(
  entry: PreparedEntry,
  entryState: EntryState,
  state: PublicationState,
  config: ResolvedConfig,
  credentials: Credentials,
  platforms: PlatformName[],
  temporaryDirectory: string,
): Promise<void> {
  for (const platform of platforms) {
    const blueskySession: BlueskySession = {};
    await publishThread(platform, entry, entryState,
      (part, recordKey, reply) => publishOne(
        platform, part, config, credentials, temporaryDirectory, recordKey, reply, blueskySession,
      ),
      () => saveState(config, state),
    );
  }
}

async function updatePublicSyndication(
  slug: string,
  state: PublicationState,
  config: ResolvedConfig,
): Promise<void> {
  if (!config.state.publish_syndication_data) return;
  const relativePath = config.site.syndication_data_file;
  await assertGeneratedTargetsClean([relativePath], config);
  await writeTextAtomic(path.join(config.repositoryPath, relativePath), renderSyndicationData(state));
  await commitMetadataFile(relativePath, slug, config);
  await pushBranch(config);
}

export async function validateDraft(input: DraftInput, config: ResolvedConfig): Promise<PreparedEntry> {
  let staged: StagedSite | undefined;
  let temporaryMediaDirectory: string | undefined;
  try {
    if (input.videoUrl || (input.imagePath && isRemoteImage(input.imagePath))) {
      temporaryMediaDirectory = await mkdtemp(path.join(os.tmpdir(), "satomi-media-"));
    }
    const entry = await prepareEntry(input, config, new Date(), temporaryMediaDirectory);
    const state = await loadState(config);
    assertNotDuplicate(state, entry);
    const credentials = await preflight(entry, config, state);
    void credentials;
    staged = await stageSite(entry, config);
    await assertGeneratedTargetsClean(
      config.state.publish_syndication_data
        ? [...staged.generatedPaths, config.site.syndication_data_file]
        : staged.generatedPaths,
      config,
    );
    await runJekyllBuild(staged.repository, config);
    return entry;
  } finally {
    await cleanupStagedSite(staged);
    if (temporaryMediaDirectory) {
      await rm(temporaryMediaDirectory, { recursive: true, force: true });
    }
  }
}

export async function publish(
  obtainInput: () => Promise<DraftInput>,
  config: ResolvedConfig,
  options: { attemptId?: string } = {},
): Promise<PublishSummary> {
  const lock = new PublishLock(config.lockPath);
  await lock.acquire();
  let staged: StagedSite | undefined;
  let state: PublicationState | undefined;
  let publicationAttempt: PublicationAttempt | undefined;
  let temporaryMediaDirectory: string | undefined;
  let canonicalCommitted = false;
  try {
    const suppliedInput = await obtainInput();
    const input: DraftInput = { ...suppliedInput };
    if (suppliedInput.imagePath && !isRemoteImage(suppliedInput.imagePath)) {
      input.imagePath = path.resolve(suppliedInput.imagePath);
    }
    state = await loadState(config);
    if (options.attemptId) {
      publicationAttempt = state.attempts?.[options.attemptId];
      if (!publicationAttempt) {
        throw new ValidationError(`No publication attempt exists for ID: ${options.attemptId}`);
      }
      publicationAttempt.draft = input;
      restartPublicationAttempt(publicationAttempt);
    } else {
      publicationAttempt = createPublicationAttempt(state, input);
    }
    publicationAttempt.destinations = { ...config.destinations };
    await saveState(config, state);

    updatePublicationAttempt(publicationAttempt, "prepare");
    await saveState(config, state);
    if (input.videoUrl || (input.imagePath && isRemoteImage(input.imagePath))) {
      temporaryMediaDirectory = await mkdtemp(path.join(os.tmpdir(), "satomi-media-"));
    }
    const entry = await prepareEntry(input, config, new Date(), temporaryMediaDirectory);
    publicationAttempt.slug = entry.slug;
    publicationAttempt.draft = {
      ...input,
      slug: entry.slug,
      title: entry.title,
      tags: entry.tags,
    };
    await saveState(config, state);
    assertNotDuplicate(state, entry);

    updatePublicationAttempt(publicationAttempt, "preflight");
    await saveState(config, state);
    await synchronizeRepository(config);
    const credentials = await preflight(entry, config, state);

    updatePublicationAttempt(publicationAttempt, "staging");
    await saveState(config, state);
    staged = await stageSite(entry, config);
    await assertGeneratedTargetsClean(
      config.state.publish_syndication_data
        ? [...staged.generatedPaths, config.site.syndication_data_file]
        : staged.generatedPaths,
      config,
    );
    await runJekyllBuild(staged.repository, config);

    updatePublicationAttempt(publicationAttempt, "commit");
    await saveState(config, state);
    await applyStagedFiles(staged, config);
    await commitGeneratedFiles(staged.generatedPaths, entry.slug, config);
    canonicalCommitted = true;

    const entryState = makeEntryState(entry, config);
    state.entries[entry.slug] = entryState;
    updatePublicationAttempt(publicationAttempt, "push");
    await saveState(config, state);
    await pushBranch(config);
    if (config.git.push) {
      updatePublicationAttempt(publicationAttempt, "deployment");
      await saveState(config, state);
      await waitForDeployment(entry, config);
    }

    const platforms = PLATFORM_NAMES.filter(
      (name) => config.destinations[name],
    );
    updatePublicationAttempt(publicationAttempt, "platforms");
    await saveState(config, state);
    await publishPlatforms(entry, entryState, state, config, credentials, platforms, staged.root);
    updatePublicationAttempt(publicationAttempt, "syndication");
    await saveState(config, state);
    await updatePublicSyndication(entry.slug, state, config);

    const platformStates = platforms.map((platform) => entryState.platforms[platform].status);
    publicationAttempt.status = platformStates.includes("unknown")
      ? "unknown"
      : platformStates.includes("failed")
        ? "partial"
        : "published";
    publicationAttempt.retryable = platformStates.includes("failed");
    updatePublicationAttempt(publicationAttempt, "complete");
    await saveState(config, state);
    const summary: PublishSummary = {
      attemptId: publicationAttempt.id,
      slug: entry.slug,
      web: entry.canonicalUrl,
      platforms: entryState.platforms,
    };
    if (config.destinations.org_social) {
      summary.orgSocial = `${config.site.public_url}/social.org`;
    }
    return summary;
  } catch (error) {
    if (state && publicationAttempt) {
      publicationAttempt.status = "failed";
      publicationAttempt.error = sanitizeError(error);
      publicationAttempt.retryable =
        !canonicalCommitted &&
        ["input", "prepare", "preflight", "staging"].includes(publicationAttempt.phase) &&
        !(publicationAttempt.slug && state.entries[publicationAttempt.slug]) &&
        !errorMessage(error).includes("already published");
      if (
        publicationAttempt.phase === "staging" &&
        errorMessage(error).includes("Generated target files have local changes")
      ) {
        try {
          publicationAttempt.worktree_files = await listWorktreeChanges(config);
        } catch {
          // Preserve the original publication error if Git status also fails.
        }
      }
      publicationAttempt.updated_at = new Date().toISOString();
      try {
        await saveState(config, state);
      } catch {
        // Preserve the original publication error if history persistence also fails.
      }
    }
    if (publicationAttempt) {
      const message = `${errorMessage(error)}\nAttempt ID: ${publicationAttempt.id}. Run satomi history for recovery.`;
      if (error instanceof ValidationError) throw new ValidationError(message);
      if (error instanceof AmbiguousPublishError) throw new AmbiguousPublishError(message);
      if (error instanceof SatomiError) throw new SatomiError(message);
      throw new Error(message, { cause: error });
    }
    throw error;
  } finally {
    await cleanupStagedSite(staged);
    if (temporaryMediaDirectory) {
      await rm(temporaryMediaDirectory, { recursive: true, force: true });
    }
    await lock.release();
  }
}

function rebuildEntryForRetry(
  slug: string,
  entryState: EntryState,
  imagePath: string | undefined,
  videoUrl: string | undefined,
  config: ResolvedConfig,
  forceXUrl: boolean,
  temporaryDirectory: string,
): Promise<PreparedEntry> {
  const input: DraftInput = {
    text: entryState.text,
    slug,
    tags: entryState.tags,
    forceXUrl,
  };
  if (imagePath) input.imagePath = imagePath;
  if (videoUrl) input.videoUrl = videoUrl;
  if (entryState.alt) input.alt = entryState.alt;
  return prepareEntry(input, config, new Date(entryState.published_at), temporaryDirectory);
}

async function prepareSavedEntry(
  slug: string,
  entryState: EntryState,
  platforms: PlatformName[],
  config: ResolvedConfig,
  forceXUrl: boolean,
  temporaryDirectory: string,
): Promise<PreparedEntry> {
  const videoUrl = entryState.media_type === "mp4" ? entryState.media_url : undefined;
  if (entryState.media_type === "mp4" && !videoUrl) {
    throw new ValidationError(`Stored video URL not found for: ${slug}`);
  }
  const imagePath = entryState.media_type !== "mp4" && entryState.repository_media_path
    ? path.join(config.repositoryPath, entryState.repository_media_path)
    : entryState.media_type !== "mp4" ? entryState.media_url : undefined;
  if (imagePath && !isRemoteImage(imagePath) && !(await pathExists(imagePath))) {
    throw new ValidationError(`Stored image not found: ${imagePath}`);
  }
  const entry = await rebuildEntryForRetry(
    slug,
    entryState,
    imagePath,
    videoUrl,
    config,
    forceXUrl,
    temporaryDirectory,
  );
  if (entry.media?.sha256 !== (entryState.media_sha256 ?? entryState.gif_sha256)) {
    throw new ValidationError(
      "Media content changed since the original publication; refusing an unsafe retry.",
    );
  }
  for (const platform of platforms) {
    if (entry.payloadSha256[platform] !== entryState.payload_sha256[platform]) {
      throw new ValidationError(
        `${platform} payload changed since the original publication. Restore the original configuration before retrying.`,
      );
    }
    const savedChunks = entryState.platforms[platform].chunks;
    if (savedChunks) {
      entry.platformChunks ??= {};
      entry.platformChunks[platform] = savedChunks.map((chunk) => chunk.text);
      if (savedChunks.some((chunk, index) => !platformChunkFits(
        platform, chunk.text, config, index === 0 ? entry.media?.type : undefined,
      ))) {
        throw new ValidationError(`${platform}: the saved thread exceeds the current limits. Restore the original configuration.`);
      }
    }
  }
  return entry;
}

export async function retry(
  slug: string,
  platform: PlatformName,
  config: ResolvedConfig,
  options: { forceXUrl?: boolean; attemptId?: string } = {},
): Promise<PublishSummary> {
  const lock = new PublishLock(config.lockPath);
  await lock.acquire();
  let temporaryDirectory: string | undefined;
  try {
    const state = await loadState(config);
    const entryState = state.entries[slug];
    if (!entryState) throw new ValidationError(`No state exists for slug: ${slug}`);
    const platformState = entryState.platforms[platform];
    if (platformState.status !== "failed") {
      const guidance = platformState.status === "unknown" || platformState.status === "pending"
        ? " Reconcile the account manually before retrying."
        : "";
      throw new ValidationError(
        `${platform} has status ${platformState.status}; only failed platforms can be retried.${guidance}`,
      );
    }
    await synchronizeRepository(config);
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "satomi-retry-"));
    const entry = await prepareSavedEntry(
      slug, entryState, [platform], config, options.forceXUrl ?? false, temporaryDirectory,
    );
    const credentials = await preflight(entry, config, state, [platform], true);
    const deploymentTarget: { canonicalUrl: string; mediaUrl?: string } = {
      canonicalUrl: entryState.canonical_url,
    };
    if (entryState.media_url) deploymentTarget.mediaUrl = entryState.media_url;
    await waitForDeployment(deploymentTarget, config);
    await publishPlatforms(entry, entryState, state, config, credentials, [platform], temporaryDirectory);
    await updatePublicSyndication(slug, state, config);
    const linkedAttempt = options.attemptId
      ? state.attempts?.[options.attemptId]
      : Object.values(state.attempts ?? {})
          .filter((attempt) => attempt.slug === slug)
          .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
    if (linkedAttempt) {
      const platformStates = Object.values(entryState.platforms).map((candidate) => candidate.status);
      linkedAttempt.status = platformStates.includes("unknown")
        ? "unknown"
        : platformStates.includes("failed")
          ? "partial"
          : "published";
      linkedAttempt.retryable = platformStates.includes("failed");
      linkedAttempt.phase = "complete";
      linkedAttempt.updated_at = new Date().toISOString();
      delete linkedAttempt.error;
      await saveState(config, state);
    }
    const summary: PublishSummary = {
      ...(linkedAttempt ? { attemptId: linkedAttempt.id } : {}),
      slug,
      web: entryState.canonical_url,
      platforms: entryState.platforms,
    };
    if (entryState.org_social_url) summary.orgSocial = entryState.org_social_url;
    return summary;
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    await lock.release();
  }
}

function canResumeBeforePlatforms(attempt: PublicationAttempt, entry: EntryState | undefined): boolean {
  if (!entry || attempt.status !== "failed" || !["push", "deployment"].includes(attempt.phase)) return false;
  const untouched = (part: PlatformState): boolean =>
    !part.attempted_at && !part.id && !part.uri && !part.cid && !part.url && !part.rkey &&
    !part.error;
  return PLATFORM_NAMES.every((platform) => {
    const saved = entry.platforms[platform];
    return ["pending", "not_started"].includes(saved.status) && untouched(saved) &&
      (saved.chunks ?? []).every((chunk) => chunk.status === "not_started" && untouched(chunk));
  });
}

async function resumeBeforePlatforms(
  identifier: string,
  config: ResolvedConfig,
  forceXUrl: boolean,
): Promise<PublishSummary> {
  const lock = new PublishLock(config.lockPath);
  await lock.acquire();
  let temporaryDirectory: string | undefined;
  let state: PublicationState | undefined;
  let attempt: PublicationAttempt | undefined;
  let resumed = false;
  try {
    state = await loadState(config);
    attempt = state.attempts?.[identifier];
    const slug = attempt?.slug;
    const entryState = slug ? state.entries[slug] : undefined;
    if (!attempt || !slug || !entryState || !canResumeBeforePlatforms(attempt, entryState)) {
      throw new ValidationError(`Attempt ${identifier} cannot safely resume before social publishing.`);
    }
    const originalDestinations = attempt.destinations;
    const recoveryConfig = originalDestinations
      ? { ...config, destinations: { ...originalDestinations } }
      : config;
    // Older attempts may lack destination snapshots; only resume their prepared networks.
    const platforms = PLATFORM_NAMES.filter((platform) => originalDestinations
      ? originalDestinations[platform]
      : recoveryConfig.destinations[platform] && entryState.payload_sha256[platform] !== undefined,
    );
    await synchronizeRepository(recoveryConfig);
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "satomi-resume-"));
    const entry = await prepareSavedEntry(
      slug, entryState, platforms, recoveryConfig, forceXUrl, temporaryDirectory,
    );
    const credentials = await preflight(entry, recoveryConfig, state, platforms, true);
    attempt.status = "running";
    attempt.retryable = false;
    delete attempt.error;
    resumed = true;
    // Repeat the push safely, then verify the existing page before any social write.
    updatePublicationAttempt(attempt, "push");
    await saveState(config, state);
    await pushBranch(recoveryConfig);
    updatePublicationAttempt(attempt, "deployment");
    await saveState(config, state);
    await waitForDeployment({
      canonicalUrl: entryState.canonical_url,
      ...(entryState.media_url ? { mediaUrl: entryState.media_url } : {}),
    }, recoveryConfig);
    updatePublicationAttempt(attempt, "platforms");
    await saveState(config, state);
    await publishPlatforms(entry, entryState, state, recoveryConfig, credentials, platforms, temporaryDirectory);
    updatePublicationAttempt(attempt, "syndication");
    await saveState(config, state);
    await updatePublicSyndication(slug, state, recoveryConfig);
    const statuses = platforms.map((platform) => entryState.platforms[platform].status);
    attempt.status = statuses.includes("unknown")
      ? "unknown"
      : statuses.includes("failed") ? "partial" : "published";
    attempt.retryable = statuses.includes("failed");
    updatePublicationAttempt(attempt, "complete");
    await saveState(config, state);
    return {
      attemptId: identifier, slug, web: entryState.canonical_url, platforms: entryState.platforms,
      ...(entryState.org_social_url ? { orgSocial: entryState.org_social_url } : {}),
    };
  } catch (error) {
    if (state && attempt && resumed) {
      attempt.status = "failed";
      attempt.error = sanitizeError(error);
      attempt.updated_at = new Date().toISOString();
      try {
        await saveState(config, state);
      } catch {
        // Preserve the original error if recovery persistence also fails.
      }
    }
    throw error;
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    await lock.release();
  }
}

function historyPlatformStatuses(entry: EntryState | undefined): Record<PlatformName, PlatformState["status"]> {
  return {
    mastodon: entry?.platforms.mastodon.status ?? "not_started",
    bluesky: entry?.platforms.bluesky.status ?? "not_started",
    x: entry?.platforms.x.status ?? "not_started",
    telegram: entry?.platforms.telegram.status ?? "not_started",
  };
}

function retryablePlatforms(entry: EntryState | undefined): PlatformName[] {
  if (!entry) return [];
  return PLATFORM_NAMES.filter(
    (platform) => entry.platforms[platform].status === "failed",
  );
}

function overallEntryStatus(entry: EntryState): string {
  const statuses = Object.values(entry.platforms).map((platform) => platform.status);
  if (statuses.includes("unknown")) return "unknown";
  if (statuses.includes("failed")) return "partial";
  if (statuses.some((status) => status === "pending")) return "pending";
  return "published";
}

export async function publicationHistory(
  config: ResolvedConfig,
  limit = 10,
): Promise<PublicationHistoryRow[]> {
  const state = await loadState(config);
  const rows: PublicationHistoryRow[] = [];
  const representedSlugs = new Set<string>();

  for (const attempt of Object.values(state.attempts ?? {})) {
    const entry = attempt.slug ? state.entries[attempt.slug] : undefined;
    if (attempt.slug && entry) representedSlugs.add(attempt.slug);
    const failedPlatforms = retryablePlatforms(entry);
    let nextCommand = "-";
    if (canResumeBeforePlatforms(attempt, entry)) {
      nextCommand = `retry ${attempt.id}`;
    } else if (attempt.status === "failed" && attempt.retryable) {
      nextCommand = attempt.worktree_files?.length ? `resolve ${attempt.id}` : `retry ${attempt.id}`;
    } else if (failedPlatforms.length === 1) {
      nextCommand = `retry ${attempt.id} --platform ${failedPlatforms[0]}`;
    } else if (failedPlatforms.length > 1) {
      nextCommand = `retry ${attempt.id} --platform <platform>`;
    } else if (attempt.status === "unknown") {
      nextCommand = "manual-check";
    } else if (attempt.status === "failed") {
      nextCommand = "manual-check";
    }
    const row: PublicationHistoryRow = {
      id: attempt.id,
      createdAt: attempt.created_at,
      slug: attempt.slug ?? "-",
      status: attempt.status,
      phase: attempt.phase,
      platforms: historyPlatformStatuses(entry),
      nextCommand,
    };
    if (attempt.error) row.error = attempt.error;
    rows.push(row);
  }

  for (const [slug, entry] of Object.entries(state.entries)) {
    if (representedSlugs.has(slug)) continue;
    const failedPlatforms = retryablePlatforms(entry);
    const nextCommand = failedPlatforms.length === 1
      ? `retry ${slug} --platform ${failedPlatforms[0]}`
      : failedPlatforms.length > 1
        ? `retry ${slug} --platform <platform>`
        : "-";
    rows.push({
      id: slug,
      createdAt: entry.published_at,
      slug,
      status: overallEntryStatus(entry),
      phase: "legacy",
      platforms: historyPlatformStatuses(entry),
      nextCommand,
    });
  }

  return rows
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}

export async function retryPublication(
  identifier: string,
  platform: PlatformName | undefined,
  config: ResolvedConfig,
  options: { forceXUrl?: boolean } = {},
): Promise<PublishSummary> {
  const state = await loadState(config);
  const attempt = state.attempts?.[identifier];
  if (!attempt) {
    if (!platform) {
      throw new ValidationError(
        `Retrying a legacy slug requires --platform. No attempt exists for ID: ${identifier}`,
      );
    }
    return await retry(identifier, platform, config, options);
  }

  const entry = attempt.slug ? state.entries[attempt.slug] : undefined;
  if (canResumeBeforePlatforms(attempt, entry)) {
    if (platform) {
      throw new ValidationError(`Run satomi retry ${identifier} without --platform to resume the interrupted publication.`);
    }
    return await resumeBeforePlatforms(identifier, config, options.forceXUrl ?? false);
  }
  if (entry) {
    const failedPlatforms = retryablePlatforms(entry);
    const selectedPlatform = platform ?? (failedPlatforms.length === 1 ? failedPlatforms[0] : undefined);
    if (!selectedPlatform) {
      throw new ValidationError(
        failedPlatforms.length > 1
          ? `Attempt ${identifier} has multiple failed platforms; add --platform.`
          : `Attempt ${identifier} has no failed platform to retry.`,
      );
    }
    return await retry(attempt.slug ?? identifier, selectedPlatform, config, {
      ...options,
      attemptId: identifier,
    });
  }

  if (!attempt.retryable || attempt.status !== "failed") {
    throw new ValidationError(`Attempt ${identifier} is not safely retryable.`);
  }
  if (attempt.worktree_files?.length) {
    throw new ValidationError(
      `Attempt ${identifier} is blocked by local Jekyll changes. Run satomi resolve ${identifier} first.`,
    );
  }
  const retryConfig = attempt.destinations
    ? { ...config, destinations: { ...attempt.destinations } }
    : config;
  return await publish(
    async () => ({
      ...attempt.draft,
      forceXUrl: options.forceXUrl ?? false,
    }),
    retryConfig,
    { attemptId: identifier },
  );
}

export interface AttemptResolution {
  id: string;
  repository: string;
  files: string[];
  committed?: string;
  nextCommand: string;
}

export async function resolvePublicationAttempt(
  identifier: string,
  config: ResolvedConfig,
  keepLocalChanges = false,
): Promise<AttemptResolution> {
  const lock = new PublishLock(config.lockPath);
  await lock.acquire();
  try {
    const state = await loadState(config);
    const attempt = state.attempts?.[identifier];
    if (!attempt) throw new ValidationError(`No publication attempt exists for ID: ${identifier}`);
    const recorded = attempt.worktree_files ?? [];
    const current = new Set(await listWorktreeChanges(config));
    const files = recorded.filter((file) => current.has(file));
    if (files.length === 0) {
      delete attempt.worktree_files;
      attempt.updated_at = new Date().toISOString();
      await saveState(config, state);
      return {
        id: identifier,
        repository: config.repositoryPath,
        files: [],
        nextCommand: `satomi retry ${identifier}`,
      };
    }
    if (!keepLocalChanges) {
      return {
        id: identifier,
        repository: config.repositoryPath,
        files,
        nextCommand: `satomi resolve ${identifier} --keep-local-changes`,
      };
    }
    const committed = await commitLocalChanges(files, identifier, config);
    delete attempt.worktree_files;
    attempt.updated_at = new Date().toISOString();
    await saveState(config, state);
    return {
      id: identifier,
      repository: config.repositoryPath,
      files,
      committed,
      nextCommand: `satomi retry ${identifier}`,
    };
  } finally {
    await lock.release();
  }
}

export async function preview(config: ResolvedConfig): Promise<void> {
  const [command] = config.jekyll.build_command;
  if (!command || !(await commandExists(command))) {
    throw new ValidationError(`Required Jekyll command is not available: ${command ?? "unknown"}`);
  }
  await runJekyllBuild(config.repositoryPath, config);
}

export async function publicationStatus(slug: string, config: ResolvedConfig): Promise<EntryState> {
  const state = await loadState(config);
  const entry = state.entries[slug];
  if (!entry) throw new ValidationError(`No state exists for slug: ${slug}`);
  return entry;
}
