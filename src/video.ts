import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "./errors.js";
import type { ResolvedConfig } from "./types.js";
import { commandExists, runCommand } from "./utils.js";

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  avg_frame_rate?: string;
  field_order?: string;
  channels?: number;
}

interface ProbeResult {
  streams?: ProbeStream[];
  format?: {
    format_name?: string;
    duration?: string;
  };
}

export interface VideoInfo {
  sourcePath: string;
  publicUrl: string;
  bytes: number;
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number;
  sha256: string;
}

function parseFrameRate(value: string | undefined): number {
  if (!value) return Number.NaN;
  const parts = value.split("/").map(Number);
  const numerator = parts[0];
  const denominator = parts[1];
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return Number.NaN;
  }
  return numerator! / denominator!;
}

export function normalizeVideoUrl(value: string): string {
  if (value.length > 2_048) throw new ValidationError("Video URL cannot exceed 2048 characters.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("Video must be a valid HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname ||
    url.hash
  ) {
    throw new ValidationError(
      "Video must be a direct HTTPS URL without credentials or a fragment.",
    );
  }
  return url.toString();
}

async function fetchVideo(url: string, timeoutSeconds: number): Promise<{
  response: Response;
}> {
  let current = normalizeVideoUrl(url);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(current, {
        method: "GET",
        headers: {
          Accept: "video/mp4",
          "User-Agent": "satomi/0.1",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutSeconds * 1_000),
      });
    } catch (error) {
      const timedOut = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
      throw new ValidationError(
        timedOut ? "Video download timed out." : "Video URL could not be downloaded.",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new ValidationError("Video URL returned a redirect without a location.");
      if (redirects === 5) throw new ValidationError("Video URL exceeded five redirects.");
      current = normalizeVideoUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ValidationError(`Video download failed with HTTP ${response.status}.`);
    }
    return { response };
  }
  throw new ValidationError("Video URL exceeded five redirects.");
}

async function downloadVideo(
  videoUrl: string,
  directory: string,
  maximumBytes: number,
  timeoutSeconds: number,
): Promise<{ sourcePath: string; publicUrl: string; bytes: number; sha256: string }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const sourcePath = path.join(directory, "remote-video.mp4");
  const { response } = await fetchVideo(videoUrl, timeoutSeconds);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "video/mp4") {
    await response.body?.cancel();
    throw new ValidationError(
      `Video URL must return Content-Type video/mp4; received ${contentType || "none"}.`,
    );
  }
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
    await response.body?.cancel();
    throw new ValidationError(
      `Video is ${(declaredBytes / 1_000_000).toFixed(2)} MB; the common limit is ${(maximumBytes / 1_000_000).toFixed(2)} MB.`,
    );
  }
  if (!response.body) throw new ValidationError("Video URL returned an empty response body.");

  const output = await open(sourcePath, "wx", 0o600);
  const digest = createHash("sha256");
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new ValidationError(
          `Video exceeds the common limit of ${(maximumBytes / 1_000_000).toFixed(2)} MB.`,
        );
      }
      digest.update(chunk.value);
      await output.write(chunk.value);
    }
  } catch (error) {
    await output.close();
    await rm(sourcePath, { force: true });
    throw error;
  }
  await output.close();
  if (bytes === 0) {
    await rm(sourcePath, { force: true });
    throw new ValidationError("Video URL returned an empty file.");
  }
  return { sourcePath, publicUrl: normalizeVideoUrl(videoUrl), bytes, sha256: digest.digest("hex") };
}

async function probeVideo(sourcePath: string): Promise<ProbeResult> {
  if (!(await commandExists("ffprobe"))) {
    throw new ValidationError("Required command is not available: ffprobe");
  }
  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=format_name,duration:stream=codec_type,codec_name,profile,pix_fmt,width,height,sample_aspect_ratio,avg_frame_rate,field_order,channels",
    "-of",
    "json",
    sourcePath,
  ]);
  try {
    return JSON.parse(result.stdout) as ProbeResult;
  } catch {
    throw new ValidationError("ffprobe returned invalid metadata for the video.");
  }
}

function validateProbe(probe: ProbeResult, config: ResolvedConfig): {
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number;
} {
  if (!probe.format?.format_name?.split(",").includes("mp4")) {
    throw new ValidationError("The downloaded file is not an MP4 container.");
  }
  const streams = probe.streams ?? [];
  const videos = streams.filter((stream) => stream.codec_type === "video");
  const audios = streams.filter((stream) => stream.codec_type === "audio");
  const unsupported = streams.filter(
    (stream) => stream.codec_type !== "video" && stream.codec_type !== "audio",
  );
  if (videos.length !== 1) throw new ValidationError("MP4 must contain exactly one video stream.");
  if (audios.length > 1 || unsupported.length > 0) {
    throw new ValidationError("MP4 may contain at most one audio stream and no other stream types.");
  }

  const video = videos[0]!;
  if (video.codec_name !== "h264") throw new ValidationError("MP4 video codec must be H.264.");
  if (!["Baseline", "Constrained Baseline", "Main", "High"].includes(video.profile ?? "")) {
    throw new ValidationError("H.264 profile must be Baseline, Main, or High.");
  }
  if (video.pix_fmt !== "yuv420p") {
    throw new ValidationError("MP4 pixel format must be yuv420p (YUV 4:2:0).");
  }
  if (video.field_order !== "progressive") {
    throw new ValidationError("MP4 video must use progressive scan.");
  }
  if (video.sample_aspect_ratio !== "1:1") {
    throw new ValidationError("MP4 pixel aspect ratio must be 1:1.");
  }

  const width = video.width ?? 0;
  const height = video.height ?? 0;
  if (width < 32 || height < 32 || width % 2 !== 0 || height % 2 !== 0) {
    throw new ValidationError("MP4 dimensions must be even and at least 32x32 pixels.");
  }
  if (width > config.validation.max_video_width || height > config.validation.max_video_height) {
    throw new ValidationError(
      `MP4 is ${width}x${height}; the configured maximum is ${config.validation.max_video_width}x${config.validation.max_video_height}.`,
    );
  }

  const frameRate = parseFrameRate(video.avg_frame_rate);
  if (!Number.isFinite(frameRate) || frameRate <= 0 || frameRate > config.validation.max_video_frame_rate) {
    throw new ValidationError(
      `MP4 frame rate must be at most ${config.validation.max_video_frame_rate} fps.`,
    );
  }
  const durationSeconds = Number(probe.format.duration);
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds < 0.5 ||
    durationSeconds > config.validation.max_video_duration_seconds
  ) {
    throw new ValidationError(
      `MP4 duration must be between 0.5 and ${config.validation.max_video_duration_seconds} seconds.`,
    );
  }

  const audio = audios[0];
  if (audio) {
    if (audio.codec_name !== "aac" || audio.profile !== "LC") {
      throw new ValidationError("MP4 audio must use AAC Low Complexity (AAC-LC).");
    }
    if (!audio.channels || audio.channels > 2) {
      throw new ValidationError("MP4 audio must be mono or stereo.");
    }
  }
  return { width, height, durationSeconds, frameRate };
}

export async function inspectRemoteVideo(
  videoUrl: string,
  directory: string,
  maximumBytes: number,
  config: ResolvedConfig,
): Promise<VideoInfo> {
  const safeMaximumBytes = Math.min(
    maximumBytes,
    config.validation.max_remote_video_mb * 1_000_000,
  );
  const downloaded = await downloadVideo(
    videoUrl,
    directory,
    safeMaximumBytes,
    config.validation.video_download_timeout_seconds,
  );
  try {
    return {
      ...downloaded,
      ...validateProbe(await probeVideo(downloaded.sourcePath), config),
    };
  } catch (error) {
    await rm(downloaded.sourcePath, { force: true });
    throw error;
  }
}
