import { SatomiError } from "./errors.js";
import type { PreparedEntry, ResolvedConfig } from "./types.js";
import { sleep } from "./utils.js";

async function isAvailable(url: string, expectedImage = false): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "satomi/0.1" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    if (!expectedImage) return true;
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    return ["image/gif", "image/png", "image/jpeg", "image/webp"].some((mimeType) =>
      contentType.includes(mimeType),
    );
  } catch {
    return false;
  }
}

export async function waitForDeployment(
  entry: PreparedEntry | { canonicalUrl: string; mediaUrl?: string },
  config: ResolvedConfig,
): Promise<void> {
  if (!config.deployment.wait_for_public_url) return;
  const deadline = Date.now() + config.deployment.timeout_seconds * 1_000;
  while (Date.now() < deadline) {
    const page = await isAvailable(entry.canonicalUrl);
    const mediaUrl = "forceXUrl" in entry ? entry.media?.publicUrl : entry.mediaUrl;
    const media = mediaUrl ? await isAvailable(mediaUrl, true) : true;
    if (page && media) return;
    await sleep(config.deployment.poll_interval_seconds * 1_000);
  }
  throw new SatomiError(
    `Deployment was not available after ${config.deployment.timeout_seconds} seconds. The Git commit was preserved; social publishing did not start.`,
  );
}
