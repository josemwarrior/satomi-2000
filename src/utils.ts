import { createHash } from "node:crypto";
import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { SatomiError } from "./errors.js";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function graphemeCount(value: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return [...segmenter.segment(value)].length;
}

export function truncateGraphemes(value: string, maximum: number): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return [...segmenter.segment(value)]
    .slice(0, maximum)
    .map((segment) => segment.segment)
    .join("");
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "update";
}

export function joinUrl(origin: string, ...parts: string[]): string {
  const cleanOrigin = origin.replace(/\/+$/, "");
  const cleanParts = parts.map((part) => part.replace(/^\/+|\/+$/g, ""));
  return `${cleanOrigin}/${cleanParts.filter(Boolean).join("/")}`;
}

export function localDate(isoDate: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoDate));
}

export function safeRelativePath(value: string, field: string): string {
  if (path.isAbsolute(value) || value.split(path.sep).includes("..")) {
    throw new SatomiError(`${field} must be a path inside the Jekyll repository.`);
  }
  return path.normalize(value);
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function writeTextAtomic(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, value, { mode: 0o600 });
  const { rename } = await import("node:fs/promises");
  await rename(temporaryPath, filePath);
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => reject(error));
    child.on("close", (exitCode) => {
      const result = { stdout, stderr, exitCode: exitCode ?? 1 };
      if (result.exitCode !== 0 && !options.allowFailure) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${result.exitCode}`;
        reject(new SatomiError(`${command} failed: ${detail}`));
      } else {
        resolve(result);
      }
    });
  });
}

export async function commandExists(command: string): Promise<boolean> {
  const result = await runCommand("which", [command], { allowFailure: true });
  return result.exitCode === 0;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sanitizeError(error: unknown): string {
  const message = errorMessage(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(token|password|secret)=([^\s&]+)/gi, "$1=[REDACTED]")
    .slice(0, 500);
}
