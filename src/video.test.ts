import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "./types.js";
import { runCommand } from "./utils.js";
import { inspectRemoteVideo, normalizeVideoUrl } from "./video.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryPaths.splice(0).map((item) => rm(item, { recursive: true, force: true })),
  );
});

const config = {
  validation: {
    max_remote_video_mb: 200,
    max_video_duration_seconds: 140,
    max_video_width: 1280,
    max_video_height: 1280,
    max_video_frame_rate: 60,
    video_download_timeout_seconds: 10,
  },
} as ResolvedConfig;

describe("remote MP4 input", () => {
  it("requires a direct HTTPS URL without credentials or fragments", () => {
    expect(normalizeVideoUrl("https://files.example/gameplay.mp4")).toBe(
      "https://files.example/gameplay.mp4",
    );
    expect(() => normalizeVideoUrl("http://files.example/gameplay.mp4")).toThrow(/HTTPS/);
    expect(() => normalizeVideoUrl("https://user:secret@files.example/gameplay.mp4")).toThrow(
      /without credentials/,
    );
    expect(() => normalizeVideoUrl("https://files.example/gameplay.mp4#fragment")).toThrow(
      /fragment/,
    );
  });

  it("downloads, hashes, and validates a compatible MP4 with ffprobe", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "satomi-video-test-"));
    temporaryPaths.push(root);
    const fixture = path.join(root, "fixture.mp4");
    await runCommand("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=30:duration=1",
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-an",
      fixture,
    ]);
    const bytes = await readFile(fixture);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(bytes.length),
      },
    })));

    const outputDirectory = path.join(root, "download");
    const video = await inspectRemoteVideo(
      "https://files.example/gameplay.mp4",
      outputDirectory,
      20_000_000,
      config,
    );
    expect(video).toMatchObject({
      publicUrl: "https://files.example/gameplay.mp4",
      bytes: bytes.length,
      width: 1280,
      height: 720,
      durationSeconds: 1,
      frameRate: 30,
    });
    expect(video.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(video.sourcePath)).toEqual(bytes);
  });
});
