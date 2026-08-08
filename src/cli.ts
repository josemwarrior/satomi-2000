#!/usr/bin/env node
import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";
import { DEFAULT_CONFIG_FILE, loadConfig } from "./config.js";
import { SatomiError, ValidationError } from "./errors.js";
import {
  preview,
  publicationStatus,
  publish,
  retry,
  validateDraft,
} from "./pipeline.js";
import type { DraftInput, PlatformName, PublishSummary, ResolvedConfig } from "./types.js";

interface DraftOptions {
  text?: string;
  image?: string;
  alt?: string;
  title?: string;
  slug?: string;
  tags?: string;
  forceXUrl?: boolean;
}

const program = new Command();
program
  .name("satomi-2000")
  .description("Publish a Jekyll microblog entry and cross-post it safely.")
  .version("0.1.0")
  .option(
    "-c, --config <file>",
    "private configuration file",
    process.env.SATOMI_CONFIG ?? DEFAULT_CONFIG_FILE,
  );

function addDraftOptions(command: Command): Command {
  return command
    .option("--text <text>", "post text")
    .option("--image <file>", "optional PNG, JPEG, WebP, or animated GIF path")
    .option("--alt <text>", "optional alternative text for an attached image")
    .option("--title <title>", "Jekyll entry title; derived from text when omitted")
    .option("--slug <slug>", "deterministic slug override")
    .option("--tags <tags>", "comma-separated tags")
    .option(
      "--force-x-url",
      "authorize one higher-cost X post whose final payload contains a URL",
    );
}

async function config(): Promise<ResolvedConfig> {
  return await loadConfig(program.opts<{ config: string }>().config);
}

async function obtainDraft(options: DraftOptions): Promise<DraftInput> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const text = options.text ?? (await terminal.question("Post text:\n> "));
    const imagePath =
      options.image ??
      (options.text === undefined
        ? (await terminal.question("Image (optional PNG, JPEG, WebP, or GIF; press Enter to skip):\n> ")).trim() ||
          undefined
        : undefined);
    if (imagePath) {
      const resolvedImagePath = path.resolve(imagePath);
      let imageStats;
      try {
        imageStats = await stat(resolvedImagePath);
      } catch {
        throw new ValidationError(`Image does not exist: ${resolvedImagePath}`);
      }
      if (!imageStats.isFile()) {
        throw new ValidationError(`Image is not a regular file: ${resolvedImagePath}`);
      }
    }
    const alt = options.alt;
    if (!imagePath && alt !== undefined) {
      throw new ValidationError("--alt can only be used with an image.");
    }
    const draft: DraftInput = { text, forceXUrl: options.forceXUrl ?? false };
    if (imagePath) draft.imagePath = imagePath;
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
  console.log("Publication completed.");
  console.log(`Web:      ${summary.web}`);
  if (summary.orgSocial) console.log(`Org Social: ${summary.orgSocial}`);
  let failed = false;
  for (const name of ["mastodon", "bluesky", "x"] as const) {
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

addDraftOptions(program.command("publish").description("Publish one new entry")).action(
  async (options: DraftOptions) => {
    const resolved = await config();
    const summary = await publish(() => obtainDraft(options), resolved);
    printSummary(summary);
  },
);

addDraftOptions(
  program.command("validate").description("Run preflight and a temporary Jekyll build without publishing"),
).action(async (options: DraftOptions) => {
  const resolved = await config();
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
  .description("Retry exactly one failed platform")
  .argument("<slug>", "published entry slug")
  .addOption(
    new Option("--platform <platform>", "platform to retry")
      .choices(["mastodon", "bluesky", "x"])
      .makeOptionMandatory(),
  )
  .option(
    "--force-x-url",
    "authorize one higher-cost X retry whose final payload contains a URL",
  )
  .action(async (slug: string, options: { platform: PlatformName; forceXUrl?: boolean }) => {
    printSummary(
      await retry(slug, options.platform, await config(), {
        forceXUrl: options.forceXUrl ?? false,
      }),
    );
  });

program
  .command("status")
  .description("Show local state without calling social APIs")
  .argument("<slug>", "published entry slug")
  .action(async (slug: string) => {
    console.log(JSON.stringify(await publicationStatus(slug, await config()), null, 2));
  });

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
