import { describe, expect, it } from "vitest";
import { applyDestinationExclusions } from "./destinations.js";
import type { ResolvedConfig } from "./types.js";

const config = {
  destinations: {
    jekyll: true,
    org_social: true,
    mastodon: true,
    bluesky: true,
    x: true,
  },
} as ResolvedConfig;

describe("per-run destination exclusions", () => {
  it("uses the configured destinations when --exclude is omitted", () => {
    expect(applyDestinationExclusions(config)).toBe(config);
  });

  it("excludes codes in any order without mutating the configuration", () => {
    const effective = applyDestinationExclusions(config, "Tx");
    expect(effective.destinations).toEqual({
      jekyll: true,
      org_social: true,
      mastodon: true,
      bluesky: true,
      x: false,
    });
    expect(config.destinations.x).toBe(true);
  });

  it("can leave only mandatory Jekyll enabled", () => {
    expect(applyDestinationExclusions(config, "xtmbo").destinations).toEqual({
      jekyll: true,
      org_social: false,
      mastodon: false,
      bluesky: false,
      x: false,
    });
  });

  it("accepts Telegram as a reserved no-op code", () => {
    expect(applyDestinationExclusions(config, "t").destinations).toEqual(config.destinations);
  });

  it("rejects unknown codes", () => {
    expect(() => applyDestinationExclusions(config, "mq")).toThrow(/Unknown --exclude code.*q/);
  });
});
