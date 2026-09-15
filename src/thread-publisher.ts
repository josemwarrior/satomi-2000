import { TID } from "@atproto/common-web";
import { AmbiguousPublishError, ValidationError } from "./errors.js";
import { markAttempt, markFailed } from "./state.js";
import type { EntryState, PlatformName, PlatformResult, PreparedEntry, ThreadReply } from "./types.js";
import { sanitizeError, sha256, sleep } from "./utils.js";

export async function publishThread(
  platform: PlatformName,
  entry: PreparedEntry,
  entryState: EntryState,
  publishPart: (part: PreparedEntry, recordKey?: string, reply?: ThreadReply) => Promise<PlatformResult>,
  persist: () => Promise<void>,
): Promise<void> {
  const previous = entryState.platforms[platform];
  const texts = entry.platformChunks?.[platform] ?? [entry.platformPayloads[platform] ?? entry.text];
  previous.chunks ??= texts.map((text) => ({ text, status: "not_started" }));
  const chunks = previous.chunks;
  if (JSON.stringify(texts) !== JSON.stringify(chunks.map((chunk) => chunk.text))) {
    throw new ValidationError(`${platform}: the saved thread changed; refusing to duplicate or skip content.`);
  }
  if (chunks.some((chunk) => chunk.status === "unknown" || chunk.status === "pending")) {
    throw new ValidationError(`${platform}: reconcile the unconfirmed thread part before retrying.`);
  }
  markAttempt(entryState, platform);
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.status === "published") continue;
    const parent = chunks[index - 1];
    const root = chunks[0]!;
    if (parent && (parent.status !== "published" || !parent.url || !root.url)) {
      throw new ValidationError(`${platform}: the previous thread part has no confirmed result.`);
    }
    const reply: ThreadReply | undefined = parent ? {
      root: { ...root, url: root.url! }, parent: { ...parent, url: parent.url! },
    } : undefined;
    // Telegram recommends no more than one message per second in the same chat.
    if (platform === "telegram" && parent) await sleep(1_000);
    if (platform === "bluesky") {
      chunk.rkey ??= index === 0 ? (previous.rkey ?? TID.nextStr()) : TID.nextStr();
      if (index === 0) entryState.platforms[platform].rkey = chunk.rkey;
    }
    chunk.status = "pending";
    chunk.attempted_at = new Date().toISOString();
    delete chunk.error;
    // A crash or persistence failure leaves a pending part, never a blindly retryable write.
    await persist();
    const part: PreparedEntry = {
      ...entry,
      slug: index === 0 ? entry.slug : sha256(JSON.stringify([entry.slug, platform, index])),
      platformPayloads: { [platform]: chunk.text },
      platformChunks: { [platform]: [chunk.text] },
    };
    if (index > 0) {
      delete part.media;
      delete part.alt;
    }
    let result: PlatformResult;
    try {
      result = await publishPart(part, chunk.rkey, reply);
    } catch (error) {
      const ambiguous = error instanceof AmbiguousPublishError;
      chunk.status = ambiguous ? "unknown" : "failed";
      chunk.error = sanitizeError(error);
      markFailed(entryState, platform, error, ambiguous);
      await persist();
      return;
    }
    Object.assign(chunk, result, { status: "published" });
    if (index === 0) Object.assign(entryState.platforms[platform], result);
    if (index === chunks.length - 1) entryState.platforms[platform].status = "published";
    // Keep this outside the publication catch: a saved response failure is not safe to resend.
    await persist();
  }
}
