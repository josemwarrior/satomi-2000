#!/usr/bin/env node
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";
import { DEFAULT_CONFIG_FILE, loadConfig } from "./config.js";
import { applyDestinationExclusions, EXCLUSION_CODES_HELP } from "./destinations.js";
import { SatomiError, ValidationError } from "./errors.js";
import { publicationCompletionMessage } from "./summary.js";
import {
  preview,
  publicationHistory,
  publicationStatus,
  publish,
  resolvePublicationAttempt,
  retryPublication,
  validateDraft,
} from "./pipeline.js";
import {
  PLATFORM_NAMES,
  type DraftInput,
  type PlatformName,
  type PlatformStatus,
  type PublicationHistoryRow,
  type PublishSummary,
  type ResolvedConfig,
} from "./types.js";

interface DraftOptions {
  text?: string;
  image?: string;
  video?: string;
  alt?: string;
  title?: string;
  slug?: string;
  tags?: string;
  exclude?: string;
  forceX?: boolean;
}

const program = new Command();
program
  .name("satomi")
  .description("Publish a Jekyll microblog entry and cross-post it safely.")
  .version("0.1.0")
  .showHelpAfterError()
  .option(
    "-c, --config <file>",
    "private configuration file",
    process.env.SATOMI_CONFIG ?? DEFAULT_CONFIG_FILE,
  );

function addDraftOptions(command: Command): Command {
  return command
    .option("-t, --text <text>", "post text")
    .addOption(
      new Option("-i, --image <file>", "optional PNG, JPEG, WebP, or animated GIF path")
        .conflicts("video"),
    )
    .addOption(
      new Option("-v, --video <url>", "optional direct HTTPS URL of an MP4 video")
        .conflicts("image"),
    )
    .option("-a, --alt <text>", "optional alternative text for attached media")
    .option("--title <title>", "Jekyll entry title; derived from text when omitted")
    .option("--slug <slug>", "deterministic slug override")
    .option("--tags <tags>", "comma-separated tags")
    .option("-e, --exclude <codes>", `exclude destinations for this run (${EXCLUSION_CODES_HELP})`)
    .option(
      "--force-x",
      "authorize one higher-cost X post whose final payload contains a URL",
    );
}

async function config(exclude?: string): Promise<ResolvedConfig> {
  const resolved = await loadConfig(program.opts<{ config: string }>().config);
  return applyDestinationExclusions(resolved, exclude);
}

async function obtainDraft(options: DraftOptions): Promise<DraftInput> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const text = options.text ?? (await terminal.question("Post text:\n> "));
    const imagePath =
      options.image ??
      (options.text === undefined && options.video === undefined
        ? (await terminal.question("Image (optional PNG, JPEG, WebP, or GIF; press Enter to skip):\n> ")).trim() ||
          undefined
        : undefined);
    const videoUrl =
      options.video ??
      (options.text === undefined && !imagePath
        ? (await terminal.question("Video (optional direct HTTPS MP4 URL; press Enter to skip):\n> ")).trim() ||
          undefined
        : undefined);
    const alt = options.alt;
    const draft: DraftInput = { text, forceXUrl: options.forceX ?? false };
    if (imagePath) draft.imagePath = imagePath;
    if (videoUrl) draft.videoUrl = videoUrl;
    if (alt !== undefined) draft.alt = alt;
    if (options.title !== undefined) draft.title = options.title;
    if (options.slug !== undefined) draft.slug = options.slug;
    if (options.tags !== undefined) {
      draft.tags = options.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    }
    return draft;
  } finally {
    terminal.close();
  }
}

function printSummary(summary: PublishSummary): void {
  console.log(publicationCompletionMessage(summary));
  if (summary.attemptId) console.log(`Attempt:  ${summary.attemptId}`);
  console.log(`Web:      ${summary.web}`);
  if (summary.orgSocial) console.log(`Org Social: ${summary.orgSocial}`);
  let failed = false;
  for (const name of PLATFORM_NAMES) {
    const state = summary.platforms[name];
    if (!state || state.status === "not_started") continue;
    const label = name === "x" ? "X" : `${name[0]?.toUpperCase()}${name.slice(1)}`;
    if (state.status === "published") {
      console.log(`${`${label}:`.padEnd(10)}${state.url ?? state.uri ?? state.id ?? "published"}`);
    } else {
      failed = true;
      console.log(`${`${label}:`.padEnd(10)}${state.status}: ${state.error ?? "no details"}`);
    }
  }
  if (failed) process.exitCode = 2;
}

function shortPlatformStatus(status: PlatformStatus): string {
  return {
    not_started: "-",
    pending: "...",
    published: "ok",
    failed: "fail",
    unknown: "?",
  }[status];
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function historyDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function printHistory(rows: PublicationHistoryRow[], timeZone: string): void {
  if (rows.length === 0) {
    console.log("No publication history recorded.");
    return;
  }
  const table = rows.map((row) => ({
    ID: row.id,
    WHEN: historyDate(row.createdAt, timeZone),
    STATUS: row.status,
    PHASE: row.phase,
    SLUG: row.slug,
    NETWORKS: `M:${shortPlatformStatus(row.platforms.mastodon)} B:${shortPlatformStatus(row.platforms.bluesky)} X:${shortPlatformStatus(row.platforms.x)} T:${shortPlatformStatus(row.platforms.telegram)}`,
    NEXT: row.nextCommand === "-" ? "-" : `satomi ${row.nextCommand}`,
  }));
  const maximums: Record<keyof (typeof table)[number], number> = {
    ID: 12,
    WHEN: 16,
    STATUS: 9,
    PHASE: 11,
    SLUG: 34,
    NETWORKS: 24,
    NEXT: 48,
  };
  const headers = Object.keys(table[0] ?? {}) as Array<keyof (typeof table)[number]>;
  const widths = Object.fromEntries(
    headers.map((header) => [
      header,
      Math.min(maximums[header], Math.max(header.length, ...table.map((row) => row[header].length))),
    ]),
  ) as Record<keyof (typeof table)[number], number>;
  const line = (row: Record<string, string>) =>
    headers.map((header) => truncate(row[header] ?? "", widths[header]).padEnd(widths[header])).join("  ");
  console.log(line(Object.fromEntries(headers.map((header) => [header, header]))));
  console.log(line(Object.fromEntries(headers.map((header) => [header, "-".repeat(widths[header])]))));
  for (const row of table) console.log(line(row));

  const errors = rows.filter((row) => row.error);
  if (errors.length > 0) {
    console.log("\nDetails:");
    for (const row of errors) console.log(`${row.id}: ${row.error?.replace(/\s+/g, " ")}`);
  }
}

addDraftOptions(program.command("post").description("Publish one new entry"))
  .addHelpText(
    "after",
    `
Destination exclusion codes:
  o  Org Social (social.org)
  x  X
  m  Mastodon
  b  Bluesky
  t  Telegram

Examples:
  $ satomi post -t "A text-only update."
  $ satomi post -t "Animation update." -i game.gif -a "The player running"
  $ satomi post -t "Video update." -v https://files.example/video.mp4 -a "Gameplay footage"
  $ satomi post -t "Jekyll and Bluesky only." -e omxt
  $ satomi post -t "Notes: https://example.com" --force-x
`,
  )
  .action(
    async (options: DraftOptions) => {
      const resolved = await config(options.exclude);
      const summary = await publish(() => obtainDraft(options), resolved);
      printSummary(summary);
    },
  );

addDraftOptions(
  program.command("validate").description("Run preflight and a temporary Jekyll build without publishing"),
).action(async (options: DraftOptions) => {
  const resolved = await config(options.exclude);
  const draft = await obtainDraft(options);
  const entry = await validateDraft(draft, resolved);
  console.log(`Validation passed: ${entry.slug}`);
});

program
  .command("preview")
  .description("Build the configured Jekyll site locally without publishing")
  .action(async () => {
    await preview(await config());
    console.log("Jekyll preview build completed.");
  });

program
  .command("retry")
  .description("Retry a failed publication attempt or platform")
  .argument("<id-or-slug>", "attempt ID from history, or a legacy published slug")
  .addOption(
    new Option("--platform <platform>", "platform to retry")
      .choices([...PLATFORM_NAMES])
  )
  .option(
    "--force-x",
    "authorize one higher-cost X retry whose final payload contains a URL",
  )
  .action(async (identifier: string, options: { platform?: PlatformName; forceX?: boolean }) => {
    printSummary(
      await retryPublication(identifier, options.platform, await config(), {
        forceXUrl: options.forceX ?? false,
      }),
    );
  });

program
  .command("history")
  .description("Show the 10 most recent publication attempts and their recovery command")
  .option("--limit <count>", "number of attempts to show", "10")
  .action(async (options: { limit: string }) => {
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ValidationError("--limit must be an integer between 1 and 100.");
    }
    const resolved = await config();
    printHistory(await publicationHistory(resolved, limit), resolved.content.timezone);
  });

program
  .command("resolve")
  .description("Inspect local files blocking a failed attempt, or commit them explicitly")
  .argument("<attempt-id>", "attempt ID from history")
  .option(
    "--keep-local-changes",
    "commit the recorded local Jekyll changes so the attempt can be retried",
  )
  .action(async (identifier: string, options: { keepLocalChanges?: boolean }) => {
    const result = await resolvePublicationAttempt(
      identifier,
      await config(),
      options.keepLocalChanges ?? false,
    );
    console.log(`Attempt:    ${result.id}`);
    console.log(`Repository: ${result.repository}`);
    if (result.files.length > 0) {
      console.log("Local changes:");
      for (const file of result.files) console.log(`  ${file}`);
    } else {
      console.log("No recorded blocking changes remain.");
    }
    if (result.committed) console.log(`Committed:  ${result.committed}`);
    console.log(`Next:       ${result.nextCommand}`);
  });

program
  .command("status")
  .description("Show local state without calling social APIs")
  .argument("<slug>", "published entry slug")
  .action(async (slug: string) => {
    console.log(JSON.stringify(await publicationStatus(slug, await config()), null, 2));
  });

program.addHelpText(
  "after",
  `
Post options:
  -t, --text <text>      Post text
  -i, --image <file>     Optional PNG, JPEG, WebP, or animated GIF
  -v, --video <url>      Optional direct HTTPS URL of an MP4 video
  -a, --alt <text>       Optional alternative text for attached media
  -e, --exclude <codes>  Exclude destinations for this run
  --force-x              Authorize an X payload containing a URL

Examples:
  $ satomi post -t "A text-only update."
  $ satomi post -t "Animation update." -i game.gif
  $ satomi post -t "Animation update." -i game.gif -a "The player running"
  $ satomi post -t "Video update." -v https://files.example/video.mp4
  $ satomi post -t "Skip Telegram and X." -e tx
  $ satomi history
  $ satomi post --help

Use --force-x with post or retry to authorize an X payload containing a URL.
Use post --help for media options and destination exclusion codes.
`,
);

program.action(async () => {
  const resolved = await config();
  const summary = await publish(() => obtainDraft({}), resolved);
  printSummary(summary);
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${message}`);
  if (error instanceof ValidationError) {
    console.error("Nothing was created or published.");
  } else if (!(error instanceof SatomiError)) {
    console.error("Unexpected failure. No credentials were printed.");
  }
  process.exitCode = 1;
}
