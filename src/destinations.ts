import { ValidationError } from "./errors.js";
import type { ResolvedConfig } from "./types.js";

const SUPPORTED_CODES = new Set(["o", "x", "m", "b", "t"]);

export const EXCLUSION_CODES_HELP =
  "o=Org Social, x=X, m=Mastodon, b=Bluesky, t=Telegram";

export function applyDestinationExclusions(
  config: ResolvedConfig,
  value?: string,
): ResolvedConfig {
  if (value === undefined) return config;

  const codes = value.trim().toLowerCase();
  if (codes.length === 0) {
    throw new ValidationError(`--exclude requires at least one code (${EXCLUSION_CODES_HELP}).`);
  }

  const invalidCodes = [...new Set([...codes].filter((code) => !SUPPORTED_CODES.has(code)))];
  if (invalidCodes.length > 0) {
    throw new ValidationError(
      `Unknown --exclude code(s): ${invalidCodes.join("")}. Use ${EXCLUSION_CODES_HELP}.`,
    );
  }

  const destinations = { ...config.destinations };
  if (codes.includes("o")) destinations.org_social = false;
  if (codes.includes("x")) destinations.x = false;
  if (codes.includes("m")) destinations.mastodon = false;
  if (codes.includes("b")) destinations.bluesky = false;
  if (codes.includes("t")) destinations.telegram = false;

  return { ...config, destinations };
}
