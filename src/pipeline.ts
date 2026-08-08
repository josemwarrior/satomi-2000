import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { AmbiguousPublishError, ValidationError } from "./errors.js";
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
  commitGeneratedFiles,
  commitMetadataFile,
  pushBranch,
  validateGitRepository,
} from "./git.js";
import { convertGifToMp4 } from "./media.js";
import { prepareEntry, xPayloadContainsUrl } from "./messages.js";
import {
  assertNotDuplicate,
  loadState,
  makeEntryState,
  markAttempt,
  markFailed,
  PublishLock,
  saveState,
} from "./state.js";
import { renderSyndicationData } from "./templates.js";
import type {
  Credentials,
  DraftInput,
  EntryState,
  PlatformName,
  PlatformResult,
  PreparedEntry,
  PublicationState,
  PublishSummary,
  ResolvedConfig,
} from "./types.js";
import {
  commandExists,
  localDate,
  pathExists,
  writeTextAtomic,
} from "./utils.js";
import { publishBluesky } from "./adapters/bluesky.js";
import { publishMastodon, validateMastodonInstance } from "./adapters/mastodon.js";
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
  return [...required].filter((command): command is string => Boolean(command));
}

export function validateXGuardrails(
  entry: PreparedEntry,
  state: PublicationState,
  config: ResolvedConfig,
): void {
  if (!config.destinations.x) return;
  const x = config.platforms.x;
  const containsUrl = xPayloadContainsUrl(entry.platformPayloads.x ?? "");
  if (containsUrl && !entry.forceXUrl) {
    throw new ValidationError(
      "The X payload contains a URL, which has a considerably higher configured cost. Re-run with --force-x-url to authorize this specific X post.",
    );
  }
  if (containsUrl) {
    process.stderr.write(
      "WARNING: --force-x-url accepted; the X post contains a URL and uses the higher configured cost estimate.\n",
    );
  }
  const estimatedCost = containsUrl
    ? x.estimated_cost_with_url_usd
    : x.estimated_cost_without_url_usd;
  if (estimatedCost > x.max_estimated_cost_usd_per_run) {
    throw new ValidationError(
      `Estimated X cost $${estimatedCost.toFixed(3)} exceeds the per-run guardrail $${x.max_estimated_cost_usd_per_run.toFixed(3)}.`,
    );
  }
  const today = localDate(new Date().toISOString(), config.content.timezone);
  const attemptsToday = Object.values(state.entries).filter((candidate) => {
    const attempt = candidate.platforms.x.attempted_at;
    return attempt && localDate(attempt, config.content.timezone) === today;
  }).length;
  if (attemptsToday >= x.max_posts_per_day) {
    throw new ValidationError(`The local X limit of ${x.max_posts_per_day} posts per day was reached.`);
  }
  if (!entry.platformPayloads.x) throw new ValidationError("X payload was not prepared.");
}

async function preflight(
  entry: PreparedEntry,
  config: ResolvedConfig,
  state: PublicationState,
  platforms?: PlatformName[],
): Promise<Credentials> {
  const selected = platforms ?? (["mastodon", "bluesky", "x"] as PlatformName[]).filter(
    (name) => config.destinations[name],
  );
  await validateTools(entry, config, selected);
  await validateGitRepository(config);
  if (selected.includes("x")) validateXGuardrails(entry, state, config);
  const credentials = await loadCredentials(config, selected);
  if (selected.includes("mastodon") && credentials.mastodon) {
    await validateMastodonInstance(entry, config, credentials.mastodon);
  }
  return credentials;
}

async function publishOne(
  platform: PlatformName,
  entry: PreparedEntry,
  config: ResolvedConfig,
  credentials: Credentials,
  temporaryDirectory: string,
): Promise<PlatformResult> {
  if (platform === "mastodon") {
    if (!credentials.mastodon) throw new ValidationError("Mastodon credentials were not loaded.");
    return await publishMastodon(entry, credentials.mastodon);
  }
  if (platform === "bluesky") {
    if (!credentials.bluesky) throw new ValidationError("Bluesky credentials were not loaded.");
    const mp4 = entry.media?.type === "gif"
      ? await convertGifToMp4(entry, temporaryDirectory)
      : undefined;
    return await publishBluesky(entry, mp4, config, credentials.bluesky);
  }
  if (!credentials.x) throw new ValidationError("X credentials were not loaded.");
  return await publishX(entry, config, credentials.x);
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
    markAttempt(entryState, platform);
    await saveState(config, state);
    try {
      const result = await publishOne(platform, entry, config, credentials, temporaryDirectory);
      entryState.platforms[platform] = {
        status: "published",
        attempted_at: entryState.platforms[platform].attempted_at ?? new Date().toISOString(),
        ...result,
      };
    } catch (error) {
      markFailed(entryState, platform, error, error instanceof AmbiguousPublishError);
    }
    await saveState(config, state);
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
  const entry = await prepareEntry(input, config);
  const state = await loadState(config);
  assertNotDuplicate(state, entry);
  const credentials = await preflight(entry, config, state);
  void credentials;
  let staged: StagedSite | undefined;
  try {
    staged = await stageSite(entry, config);
    await assertGeneratedTargetsClean(
      config.state.publish_syndication_data
        ? [...staged.generatedPaths, config.site.syndication_data_file]
        : staged.generatedPaths,
      config,
    );
    await runJekyllBuild(staged.repository, config);
  } finally {
    await cleanupStagedSite(staged);
  }
  return entry;
}

export async function publish(
  obtainInput: () => Promise<DraftInput>,
  config: ResolvedConfig,
): Promise<PublishSummary> {
  const lock = new PublishLock(config.lockPath);
  await lock.acquire();
  let staged: StagedSite | undefined;
  try {
    const input = await obtainInput();
    const entry = await prepareEntry(input, config);
    const state = await loadState(config);
    assertNotDuplicate(state, entry);
    const credentials = await preflight(entry, config, state);

    staged = await stageSite(entry, config);
    await assertGeneratedTargetsClean(
      config.state.publish_syndication_data
        ? [...staged.generatedPaths, config.site.syndication_data_file]
        : staged.generatedPaths,
      config,
    );
    await runJekyllBuild(staged.repository, config);
    await applyStagedFiles(staged, config);
    await commitGeneratedFiles(staged.generatedPaths, entry.slug, config);

    const entryState = makeEntryState(entry, config);
    state.entries[entry.slug] = entryState;
    await saveState(config, state);
    await pushBranch(config);
    if (config.git.push) await waitForDeployment(entry, config);

    const platforms = (["mastodon", "bluesky", "x"] as PlatformName[]).filter(
      (name) => config.destinations[name],
    );
    await publishPlatforms(entry, entryState, state, config, credentials, platforms, staged.root);
    await updatePublicSyndication(entry.slug, state, config);
    const summary: PublishSummary = {
      slug: entry.slug,
      web: entry.canonicalUrl,
      platforms: entryState.platforms,
    };
    if (config.destinations.org_social) {
      summary.orgSocial = `${config.site.public_url}/social.org`;
    }
    return summary;
  } finally {
    await cleanupStagedSite(staged);
    await lock.release();
  }
}

function rebuildEntryForRetry(
  slug: string,
  entryState: EntryState,
  imagePath: string | undefined,
  config: ResolvedConfig,
  forceXUrl: boolean,
): Promise<PreparedEntry> {
  const input: DraftInput = {
    text: entryState.text,
    slug,
    tags: entryState.tags,
    forceXUrl,
  };
  if (imagePath) input.imagePath = imagePath;
  if (entryState.alt) input.alt = entryState.alt;
  return prepareEntry(input, config, new Date(entryState.published_at));
}

export async function retry(
  slug: string,
  platform: PlatformName,
  config: ResolvedConfig,
  options: { forceXUrl?: boolean } = {},
): Promise<PublishSummary> {
  const lock = new PublishLock(config.lockPath);
  await lock.acquire();
  let temporaryDirectory: string | undefined;
  try {
    const state = await loadState(config);
    const entryState = state.entries[slug];
    if (!entryState) throw new ValidationError(`No state exists for slug: ${slug}`);
    const platformState = entryState.platforms[platform];
    if (platformState.status === "published") {
      throw new ValidationError(`${platform} is already published for ${slug}.`);
    }
    if (platformState.status === "unknown") {
      throw new ValidationError(
        `${platform} has unknown status. Reconcile the account manually before changing the state.`,
      );
    }
    if (platformState.status === "pending" && platformState.attempted_at) {
      throw new ValidationError(
        `${platform} has a pending recorded attempt. Reconcile it before retrying.`,
      );
    }
    const imagePath = entryState.repository_media_path
      ? path.join(config.repositoryPath, entryState.repository_media_path)
      : undefined;
    if (imagePath && !(await pathExists(imagePath))) {
      throw new ValidationError(`Stored image not found: ${imagePath}`);
    }
    const entry = await rebuildEntryForRetry(
      slug,
      entryState,
      imagePath,
      config,
      options.forceXUrl ?? false,
    );
    if (entry.payloadSha256[platform] !== entryState.payload_sha256[platform]) {
      throw new ValidationError(
        `${platform} payload changed since the original publication. Restore the original configuration before retrying.`,
      );
    }
    const credentials = await preflight(entry, config, state, [platform]);
    const deploymentTarget: { canonicalUrl: string; mediaUrl?: string } = {
      canonicalUrl: entryState.canonical_url,
    };
    if (entryState.media_url) deploymentTarget.mediaUrl = entryState.media_url;
    await waitForDeployment(deploymentTarget, config);
    temporaryDirectory = path.join(config.configDirectory, ".satomi", `retry-${process.pid}`);
    await mkdir(temporaryDirectory, { recursive: false, mode: 0o700 });
    await publishPlatforms(entry, entryState, state, config, credentials, [platform], temporaryDirectory);
    await updatePublicSyndication(slug, state, config);
    const summary: PublishSummary = {
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
