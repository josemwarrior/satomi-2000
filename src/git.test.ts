import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertGeneratedTargetsClean,
  commitGeneratedFiles,
  commitLocalChanges,
  listWorktreeChanges,
  validateGitRepository,
} from "./git.js";
import type { ResolvedConfig } from "./types.js";
import { runCommand } from "./utils.js";

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

describe("scoped Git commits", () => {
  it("commits generated files without including unrelated worktree changes", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "satomi-git-"));
    temporaryPaths.push(repository);
    await runCommand("git", ["init", "-b", "main"], { cwd: repository });
    await runCommand("git", ["config", "user.name", "Satomi Test"], { cwd: repository });
    await runCommand("git", ["config", "user.email", "satomi@example.invalid"], { cwd: repository });
    await writeFile(path.join(repository, "existing.md"), "original\n");
    await runCommand("git", ["add", "existing.md"], { cwd: repository });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: repository });

    const config = {
      repositoryPath: repository,
      site: { branch: "main" },
      git: {
        commit_message_template: "microblog: {slug}",
        push: false,
        stage_only_generated_files: true,
      },
    } as ResolvedConfig;
    const generated = "_posts/2026-08-08-test.md";
    await validateGitRepository(config);
    await assertGeneratedTargetsClean([generated], config);

    await writeFile(path.join(repository, "existing.md"), "user change\n");
    await mkdir(path.dirname(path.join(repository, generated)), { recursive: true });
    await writeFile(path.join(repository, generated), "generated\n");
    await commitGeneratedFiles([generated], "2026-08-08-test", config);

    const committed = await runCommand("git", ["show", "--pretty=", "--name-only", "HEAD"], {
      cwd: repository,
    });
    expect(committed.stdout.trim()).toBe(generated);
    expect(await readFile(path.join(repository, "existing.md"), "utf8")).toBe("user change\n");
    const status = await runCommand("git", ["status", "--porcelain"], { cwd: repository });
    expect(status.stdout).toContain("existing.md");
  });

  it("commits only explicitly accepted blocking files", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "satomi-resolve-"));
    temporaryPaths.push(repository);
    await runCommand("git", ["init", "-b", "main"], { cwd: repository });
    await runCommand("git", ["config", "user.name", "Satomi Test"], { cwd: repository });
    await runCommand("git", ["config", "user.email", "satomi@example.invalid"], { cwd: repository });
    await writeFile(path.join(repository, "feed.json"), "original\n");
    await writeFile(path.join(repository, "notes.md"), "original\n");
    await runCommand("git", ["add", "feed.json", "notes.md"], { cwd: repository });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: repository });
    await writeFile(path.join(repository, "feed.json"), "accepted\n");
    await writeFile(path.join(repository, "notes.md"), "unrelated\n");
    const resolveConfig = {
      repositoryPath: repository,
      site: { branch: "main" },
    } as ResolvedConfig;

    expect(await listWorktreeChanges(resolveConfig)).toEqual(["feed.json", "notes.md"]);
    await commitLocalChanges(["feed.json"], "A000001", resolveConfig);
    const committed = await runCommand("git", ["show", "--pretty=", "--name-only", "HEAD"], {
      cwd: repository,
    });
    expect(committed.stdout.trim()).toBe("feed.json");
    expect(await listWorktreeChanges(resolveConfig)).toEqual(["notes.md"]);
  });
});
