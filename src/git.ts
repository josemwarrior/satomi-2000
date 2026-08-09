import path from "node:path";
import { ValidationError } from "./errors.js";
import type { ResolvedConfig } from "./types.js";
import { pathExists, runCommand } from "./utils.js";

export async function validateGitRepository(config: ResolvedConfig): Promise<void> {
  if (!(await pathExists(path.join(config.repositoryPath, ".git")))) {
    throw new ValidationError(`Not a Git repository: ${config.repositoryPath}`);
  }
  const inside = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: config.repositoryPath,
    allowFailure: true,
  });
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    throw new ValidationError(`Not a Git worktree: ${config.repositoryPath}`);
  }
  const branch = await runCommand("git", ["branch", "--show-current"], {
    cwd: config.repositoryPath,
  });
  if (branch.stdout.trim() !== config.site.branch) {
    throw new ValidationError(
      `Expected Git branch ${config.site.branch}, found ${branch.stdout.trim() || "detached HEAD"}.`,
    );
  }
  const staged = await runCommand("git", ["diff", "--cached", "--name-only"], {
    cwd: config.repositoryPath,
  });
  if (staged.stdout.trim()) {
    throw new ValidationError(
      "The Jekyll repository already has staged changes. Commit or unstage them before publishing.",
    );
  }
}

export async function assertGeneratedTargetsClean(
  generatedPaths: string[],
  config: ResolvedConfig,
): Promise<void> {
  const result = await runCommand(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ...generatedPaths],
    { cwd: config.repositoryPath },
  );
  if (result.stdout.trim()) {
    throw new ValidationError(
      `Generated target files have local changes:\n${result.stdout.trim()}\nResolve them before publishing.`,
    );
  }
}

export async function listWorktreeChanges(config: ResolvedConfig): Promise<string[]> {
  const result = await runCommand(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: config.repositoryPath },
  );
  const records = result.stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return [...new Set(paths)];
}

export async function commitLocalChanges(
  files: string[],
  attemptId: string,
  config: ResolvedConfig,
): Promise<string> {
  if (files.length === 0) throw new ValidationError("No local changes remain to resolve.");
  await validateGitRepository(config);
  const current = new Set(await listWorktreeChanges(config));
  const changedFiles = files.filter((file) => current.has(file));
  if (changedFiles.length === 0) throw new ValidationError("No recorded local changes remain.");
  await runCommand("git", ["add", "--", ...changedFiles], { cwd: config.repositoryPath });
  await runCommand(
    "git",
    ["commit", "--only", "-m", `chore: preserve local changes before ${attemptId}`, "--", ...changedFiles],
    { cwd: config.repositoryPath },
  );
  const commit = await runCommand("git", ["rev-parse", "HEAD"], { cwd: config.repositoryPath });
  return commit.stdout.trim();
}

export async function commitGeneratedFiles(
  generatedPaths: string[],
  slug: string,
  config: ResolvedConfig,
): Promise<string> {
  await runCommand("git", ["add", "--", ...generatedPaths], { cwd: config.repositoryPath });
  const staged = await runCommand("git", ["diff", "--cached", "--name-only", "--", ...generatedPaths], {
    cwd: config.repositoryPath,
  });
  if (!staged.stdout.trim()) throw new ValidationError("No generated changes to commit.");
  const message = config.git.commit_message_template.replaceAll("{slug}", slug);
  await runCommand("git", ["commit", "--only", "-m", message, "--", ...generatedPaths], {
    cwd: config.repositoryPath,
  });
  const commit = await runCommand("git", ["rev-parse", "HEAD"], { cwd: config.repositoryPath });
  return commit.stdout.trim();
}

export async function pushBranch(config: ResolvedConfig): Promise<void> {
  if (!config.git.push) return;
  await runCommand("git", ["push", "origin", config.site.branch], { cwd: config.repositoryPath });
}

export async function commitMetadataFile(
  relativePath: string,
  slug: string,
  config: ResolvedConfig,
): Promise<void> {
  await runCommand("git", ["add", "--", relativePath], { cwd: config.repositoryPath });
  await runCommand(
    "git",
    ["commit", "--only", "-m", `microblog: syndication metadata for ${slug}`, "--", relativePath],
    { cwd: config.repositoryPath },
  );
}
