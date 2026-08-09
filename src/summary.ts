import type { PublishSummary } from "./types.js";

export function publicationCompletionMessage(summary: PublishSummary): string {
  const incomplete = Object.values(summary.platforms).some(
    (state) => state && state.status !== "not_started" && state.status !== "published",
  );
  return incomplete ? "Publication partially completed." : "Publication completed.";
}
