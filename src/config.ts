import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ValidationError } from "./errors.js";
import type { ResolvedConfig } from "./types.js";
import { pathExists, safeRelativePath } from "./utils.js";

export const DEFAULT_CONFIG_FILE = "satomi.config.yml";

const relativePath = z.string().min(1);
const languageCode = z
  .string()
  .regex(
    /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/,
    "must be a language code such as en, es, or pt-BR",
  );

const basePlatformSchema = z.object({
  max_characters: z.number().int().positive(),
  max_gif_mb: z.number().positive(),
  max_png_mb: z.number().positive(),
  append_canonical_url: z.boolean().default(true),
  include_tags: z.boolean().default(true),
  upload_native_media: z.literal(true).default(true),
  max_width: z.number().int().positive().optional(),
  max_height: z.number().int().positive().optional(),
});

export const configSchema = z
  .object({
    version: z.literal(1),
    site: z.object({
      public_url: z.url().refine((value) => !value.endsWith("/"), {
        message: "site.public_url must not end with a slash",
      }),
      media_url: z.url().refine((value) => !value.endsWith("/"), {
        message: "site.media_url must not end with a slash",
      }),
      repository_path: z.string().min(1),
      posts_directory: relativePath.default("_posts"),
      media_directory: relativePath.default("assets/microblog/media"),
      public_files_directory: relativePath.default("."),
      syndication_data_file: relativePath.default("_data/microblog-syndication.json"),
      branch: z.string().min(1).default("main"),
    }),
    destinations: z
      .object({
        jekyll: z.literal(true),
        org_social: z.boolean(),
        mastodon: z.boolean(),
        bluesky: z.boolean(),
        x: z.boolean(),
      })
      .strict(),
    content: z.object({
      language: languageCode.default("en"),
      timezone: z.string().min(1).default("UTC"),
      title: z.string().min(1),
      description: z.string().min(1),
      default_tags: z.array(z.string().min(1)).default([]),
    }),
    org_social: z
      .object({
        title: z.string().min(1),
        nick: z.string().min(1).regex(/^\S+$/, "must not contain spaces"),
        description: z.string().min(1),
        avatar_url: z.url(),
        links: z.array(z.url()).default([]),
        languages: z.array(languageCode).min(1),
        default_language: languageCode,
      })
      .superRefine((value, context) => {
        if (!value.languages.includes(value.default_language)) {
          context.addIssue({
            code: "custom",
            path: ["default_language"],
            message: "must also appear in org_social.languages",
          });
        }
      }),
    validation: z.object({
      require_matching_image_extension: z.boolean().default(true),
      require_animated_gif: z.boolean().default(true),
      reject_empty_text: z.boolean().default(true),
      reject_control_characters: z.boolean().default(true),
    }),
    jekyll: z.object({
      build_command: z.array(z.string().min(1)).min(1),
      output_directory: relativePath.default("_site"),
    }),
    platforms: z.object({
      mastodon: basePlatformSchema.extend({
        check_instance_limits: z.boolean().default(true),
      }),
      bluesky: basePlatformSchema.extend({
        convert_gif_to_mp4: z.literal(true).default(true),
        video_timeout_seconds: z.number().int().positive().default(300),
      }),
      x: basePlatformSchema.extend({
        username: z.string().min(1),
        max_posts_per_run: z.literal(1).default(1),
        max_posts_per_day: z.number().int().positive(),
        max_estimated_cost_usd_per_run: z.number().nonnegative(),
        estimated_cost_without_url_usd: z.number().nonnegative(),
        estimated_cost_with_url_usd: z.number().nonnegative(),
        automatic_retry: z.literal(false).default(false),
      }),
    }),
    git: z.object({
      commit_message_template: z.string().includes("{slug}"),
      push: z.boolean().default(true),
      stage_only_generated_files: z.literal(true).default(true),
    }),
    deployment: z.object({
      wait_for_public_url: z.boolean().default(true),
      timeout_seconds: z.number().int().positive().default(180),
      poll_interval_seconds: z.number().int().positive().default(5),
    }),
    state: z.object({
      file: z.string().min(1).default(".satomi/state.json"),
      lock_directory: z.string().min(1).default(".satomi/publish.lock"),
      publish_syndication_data: z.boolean().default(false),
    }),
    credentials: z.object({
      provider: z.enum(["env", "env_and_keychain"]).default("env_and_keychain"),
      env_file: z.string().min(1).default(".env"),
      keychain_service_prefix: z.string().min(1).default("satomi"),
    }),
  })
  .strict();

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
    .join("\n");
}

function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
  } catch {
    throw new ValidationError(`Invalid content.timezone: ${timeZone}`);
  }
}

export async function loadConfig(configFile: string): Promise<ResolvedConfig> {
  const configPath = path.resolve(configFile);
  if (!(await pathExists(configPath))) {
    throw new ValidationError(
      `Configuration file not found: ${configPath}\nCopy satomi.config.example.yml to satomi.config.yml and edit it.`,
    );
  }

  let raw: unknown;
  try {
    raw = YAML.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new ValidationError(`Cannot parse ${configPath}: ${String(error)}`);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(`Invalid configuration:\n${formatZodError(parsed.error)}`);
  }

  const config = parsed.data;
  validateTimeZone(config.content.timezone);
  safeRelativePath(config.site.posts_directory, "site.posts_directory");
  safeRelativePath(config.site.media_directory, "site.media_directory");
  safeRelativePath(config.site.public_files_directory, "site.public_files_directory");
  safeRelativePath(config.site.syndication_data_file, "site.syndication_data_file");
  safeRelativePath(config.jekyll.output_directory, "jekyll.output_directory");

  const enabledPlatforms = (["mastodon", "bluesky", "x"] as const).filter(
    (name) => config.destinations[name],
  );
  if (
    enabledPlatforms.some((name) => config.platforms[name].append_canonical_url) &&
    !config.git.push
  ) {
    throw new ValidationError(
      "git.push must be true when an enabled platform appends the canonical URL.",
    );
  }

  const configDirectory = path.dirname(configPath);
  const repositoryPath = path.resolve(configDirectory, config.site.repository_path);
  if (!(await pathExists(repositoryPath)) || !(await stat(repositoryPath)).isDirectory()) {
    throw new ValidationError(`Jekyll repository is not a directory: ${repositoryPath}`);
  }

  const statePath = path.resolve(configDirectory, config.state.file);
  const lockPath = path.resolve(configDirectory, config.state.lock_directory);
  if (
    lockPath === path.parse(lockPath).root ||
    lockPath === configDirectory ||
    lockPath === repositoryPath
  ) {
    throw new ValidationError("state.lock_directory must identify a dedicated lock subdirectory.");
  }

  return {
    ...config,
    configPath,
    configDirectory,
    repositoryPath,
    statePath,
    lockPath,
    envPath: path.resolve(configDirectory, config.credentials.env_file),
  };
}
