import { stat } from "node:fs/promises";
import path from "node:path";
import type { PreparedEntry } from "./types.js";
import { runCommand } from "./utils.js";

export async function convertGifToMp4(entry: PreparedEntry, directory: string): Promise<string> {
  if (!entry.media || entry.media.type !== "gif") {
    throw new Error("GIF-to-MP4 conversion requires a GIF attachment.");
  }
  const output = path.join(directory, `${entry.slug}.mp4`);
  await runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    entry.media.sourcePath,
    "-vf",
    "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
    output,
  ]);
  if ((await stat(output)).size === 0) throw new Error("FFmpeg created an empty MP4 file.");
  return output;
}
