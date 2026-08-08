import { readFile } from "node:fs/promises";
import { AtpAgent, RichText, type AppBskyVideoDefs } from "@atproto/api";
import { SatomiError } from "../errors.js";
import type { PlatformResult, PreparedEntry, ResolvedConfig } from "../types.js";
import { sleep } from "../utils.js";
import { responseJson } from "./http.js";

interface BlueskyCredentials {
  handle: string;
  appPassword: string;
}

export async function publishBluesky(
  entry: PreparedEntry,
  mp4Path: string | undefined,
  config: ResolvedConfig,
  credentials: BlueskyCredentials,
): Promise<PlatformResult> {
  const agent = new AtpAgent({ service: "https://bsky.social" });
  await agent.login({ identifier: credentials.handle, password: credentials.appPassword });
  if (!agent.session) throw new SatomiError("Bluesky login returned no session.");

  let embed: Record<string, unknown> | undefined;
  if (entry.media?.type === "gif") {
    if (!mp4Path) throw new SatomiError("Bluesky GIF publishing requires a converted MP4.");
    const { data: serviceAuth } = await agent.com.atproto.server.getServiceAuth({
      aud: `did:web:${agent.dispatchUrl.host}`,
      lxm: "com.atproto.repo.uploadBlob",
      exp: Math.floor(Date.now() / 1_000) + 60 * 30,
    });
    const video = new Uint8Array(await readFile(mp4Path));
    const uploadUrl = new URL("https://video.bsky.app/xrpc/app.bsky.video.uploadVideo");
    uploadUrl.searchParams.set("did", agent.session.did);
    uploadUrl.searchParams.set("name", `${entry.slug}.mp4`);
    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceAuth.token}`,
        "Content-Type": "video/mp4",
        "Content-Length": String(video.byteLength),
        "User-Agent": "satomi/0.1",
      },
      body: video,
      signal: AbortSignal.timeout(120_000),
    });
    const job = await responseJson<AppBskyVideoDefs.JobStatus>(
      uploadResponse,
      "Bluesky video upload",
    );
    let blob = job.blob;
    const videoAgent = new AtpAgent({ service: "https://video.bsky.app" });
    const deadline = Date.now() + config.platforms.bluesky.video_timeout_seconds * 1_000;
    while (!blob && Date.now() < deadline) {
      await sleep(1_000);
      const { data } = await videoAgent.app.bsky.video.getJobStatus({ jobId: job.jobId });
      blob = data.jobStatus.blob;
      if (!blob && data.jobStatus.state === "JOB_STATE_FAILED") {
        throw new SatomiError(
          `Bluesky video processing failed: ${data.jobStatus.error ?? "unknown error"}`,
        );
      }
    }
    if (!blob) throw new SatomiError("Bluesky video processing timed out.");
    embed = {
      $type: "app.bsky.embed.video",
      video: blob,
      alt: entry.alt ?? "",
      aspectRatio: { width: entry.media.width, height: entry.media.height },
    };
  } else if (entry.media) {
    const image = new Uint8Array(await readFile(entry.media.sourcePath));
    const uploaded = await agent.uploadBlob(image, { encoding: entry.media.mimeType });
    embed = {
      $type: "app.bsky.embed.images",
      images: [
        {
          alt: entry.alt ?? "",
          image: uploaded.data.blob,
          aspectRatio: { width: entry.media.width, height: entry.media.height },
        },
      ],
    };
  }

  const richText = new RichText({ text: entry.platformPayloads.bluesky ?? entry.text });
  await richText.detectFacets(agent);
  const record: Record<string, unknown> = {
    $type: "app.bsky.feed.post",
    text: richText.text,
    facets: richText.facets,
    langs: [entry.language],
    createdAt: entry.publishedAt,
  };
  if (embed) record.embed = embed;
  let created;
  try {
    created = await agent.com.atproto.repo.createRecord({
      repo: agent.session.did,
      collection: "app.bsky.feed.post",
      rkey: entry.slug,
      record,
    });
  } catch (createError) {
    try {
      const existing = await agent.com.atproto.repo.getRecord({
        repo: agent.session.did,
        collection: "app.bsky.feed.post",
        rkey: entry.slug,
      });
      const value = existing.data.value as { text?: unknown };
      if (value.text !== richText.text) throw createError;
      const result: PlatformResult = {
        uri: existing.data.uri,
        url: `https://bsky.app/profile/${encodeURIComponent(credentials.handle)}/post/${entry.slug}`,
      };
      if (existing.data.cid) result.cid = existing.data.cid;
      return result;
    } catch {
      throw createError;
    }
  }
  return {
    uri: created.data.uri,
    cid: created.data.cid,
    url: `https://bsky.app/profile/${encodeURIComponent(credentials.handle)}/post/${entry.slug}`,
  };
}
