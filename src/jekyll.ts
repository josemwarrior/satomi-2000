import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { SatomiError, ValidationError } from "./errors.js";
import type { PreparedEntry, ResolvedConfig } from "./types.js";
import {
  type ContentEntry,
  contentEntryFromPrepared,
  renderJsonFeed,
  renderPost,
  renderRss,
  renderSocialOrg,
} from "./templates.js";
import { pathExists, runCommand, safeRelativePath } from "./utils.js";

export interface StagedSite {
  root: string;
  repository: string;
  generatedPaths: string[];
}

function normalizeDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  if (Number.isNaN(date.valueOf())) throw new ValidationError(`Invalid microblog date: ${String(value)}`);
  return date.toISOString();
}

async function readEntries(repository: string, config: ResolvedConfig): Promise<ContentEntry[]> {
  const postsPath = path.join(repository, config.site.posts_directory);
  if (!(await pathExists(postsPath))) return [];
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(postsPath)).filter((file) => file.endsWith(".md"));
  const entries = await Promise.all(
    files.map(async (file): Promise<ContentEntry | undefined> => {
      const source = matter(await readFile(path.join(postsPath, file), "utf8"));
      if (source.data.satomi !== true) return undefined;
      const slug = String(source.data.slug ?? path.basename(file, ".md"));
      const syndicate =
        source.data.syndicate && typeof source.data.syndicate === "object"
          ? (source.data.syndicate as Record<string, unknown>)
          : {};
      const entry: ContentEntry = {
        slug,
        title: String(source.data.title ?? slug),
        date: normalizeDate(source.data.date),
        tags: Array.isArray(source.data.tags) ? source.data.tags.map(String) : [],
        language: String(source.data.lang ?? source.data.language ?? config.content.language),
        orgSocialLanguage: String(
          syndicate.org_social_language ??
            source.data.lang ??
            source.data.language ??
            config.org_social.default_language,
        ),
        text: source.content.trim(),
        orgSocial: syndicate.org_social !== false,
      };
      if (source.data.image) entry.image = String(source.data.image);
      if (source.data.alt) entry.alt = String(source.data.alt);
      return entry;
    }),
  );
  return entries
    .filter((entry): entry is ContentEntry => entry !== undefined)
    .sort((left, right) => right.date.localeCompare(left.date));
}

async function writeGenerated(repository: string, relativePath: string, content: string | Buffer): Promise<void> {
  safeRelativePath(relativePath, "generated path");
  const target = path.join(repository, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

export async function stageSite(entry: PreparedEntry, config: ResolvedConfig): Promise<StagedSite> {
  const root = await mkdtemp(path.join(os.tmpdir(), "satomi-"));
  const repository = path.join(root, "site");
  const outputDirectory = path.normalize(config.jekyll.output_directory);
  await cp(config.repositoryPath, repository, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(config.repositoryPath, source);
      if (!relative) return true;
      const first = relative.split(path.sep)[0];
      return first !== ".git" && first !== outputDirectory;
    },
  });

  const generatedPaths: string[] = [];
  const postPath = path.join(config.site.posts_directory, `${entry.slug}.md`);
  if (await pathExists(path.join(config.repositoryPath, postPath))) {
    throw new ValidationError(`Microblog entry already exists: ${postPath}`);
  }
  await writeGenerated(repository, postPath, renderPost(contentEntryFromPrepared(entry, config), config));
  generatedPaths.push(postPath);
  if (entry.media) {
    const mediaPath = path.join(config.site.media_directory, entry.media.fileName);
    if (await pathExists(path.join(config.repositoryPath, mediaPath))) {
      throw new ValidationError(`Media target already exists: ${mediaPath}`);
    }
    await mkdir(path.dirname(path.join(repository, mediaPath)), { recursive: true });
    await cp(entry.media.sourcePath, path.join(repository, mediaPath));
    generatedPaths.push(mediaPath);
  }

  const entries = await readEntries(repository, config);
  const derived: Record<string, string> = {
    [path.join(config.site.public_files_directory, "feed.xml")]: renderRss(entries, config),
    [path.join(config.site.public_files_directory, "feed.json")]: renderJsonFeed(entries, config),
  };
  if (config.destinations.org_social) {
    derived[path.join(config.site.public_files_directory, "social.org")] = renderSocialOrg(
      entries,
      config,
    );
  }
  for (const [relativePath, content] of Object.entries(derived)) {
    await writeGenerated(repository, relativePath, content);
    generatedPaths.push(relativePath);
  }
  return { root, repository, generatedPaths: [...new Set(generatedPaths)] };
}

export async function runJekyllBuild(repository: string, config: ResolvedConfig): Promise<void> {
  const [command, ...args] = config.jekyll.build_command;
  if (!command) throw new ValidationError("jekyll.build_command cannot be empty.");
  await runCommand(command, args, { cwd: repository });
  const output = path.join(repository, config.jekyll.output_directory);
  if (!(await pathExists(output)) || !(await stat(output)).isDirectory()) {
    throw new SatomiError(`Jekyll build did not create ${config.jekyll.output_directory}.`);
  }
}

export async function applyStagedFiles(staged: StagedSite, config: ResolvedConfig): Promise<void> {
  const backup = path.join(staged.root, "backup");
  const existing = new Set<string>();
  await mkdir(backup, { recursive: true });
  try {
    for (const relativePath of staged.generatedPaths) {
      const target = path.join(config.repositoryPath, relativePath);
      if (await pathExists(target)) {
        existing.add(relativePath);
        await mkdir(path.dirname(path.join(backup, relativePath)), { recursive: true });
        await cp(target, path.join(backup, relativePath));
      }
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(staged.repository, relativePath), target);
    }
  } catch (error) {
    for (const relativePath of staged.generatedPaths) {
      const target = path.join(config.repositoryPath, relativePath);
      if (existing.has(relativePath)) {
        await cp(path.join(backup, relativePath), target);
      } else {
        await rm(target, { force: true });
      }
    }
    throw error;
  }
}

export async function cleanupStagedSite(staged: StagedSite | undefined): Promise<void> {
  if (staged) await rm(staged.root, { recursive: true, force: true });
}
