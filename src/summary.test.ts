import { describe, expect, it } from "vitest";
import { publicationCompletionMessage } from "./summary.js";
import type { PublishSummary } from "./types.js";

function summary(status: "published" | "failed" | "unknown"): PublishSummary {
  return {
    slug: "test-post",
    web: "https://example.com/test-post/",
    platforms: { bluesky: { status } },
  };
}

describe("publication completion message", () => {
  it("reports a fully successful publication", () => {
    expect(publicationCompletionMessage(summary("published"))).toBe("Publication completed.");
  });

  it.each(["failed", "unknown"] as const)("reports a %s platform as partial", (status) => {
    expect(publicationCompletionMessage(summary(status))).toBe(
      "Publication partially completed.",
    );
  });
});
