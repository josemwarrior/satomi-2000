import { afterEach, describe, expect, it } from "vitest";
import { loadCredentials } from "./credentials.js";
import type { ResolvedConfig } from "./types.js";

const originalWorkerToken = process.env.TELEGRAM_WORKER_TOKEN;

afterEach(() => {
  if (originalWorkerToken === undefined) delete process.env.TELEGRAM_WORKER_TOKEN;
  else process.env.TELEGRAM_WORKER_TOKEN = originalWorkerToken;
});

describe("Telegram Worker credentials", () => {
  it("loads only the gateway token and never requires the Telegram bot token", async () => {
    process.env.TELEGRAM_WORKER_TOKEN = "local-gateway-token";
    const config = {
      envPath: "/a/nonexistent/satomi-telegram-test.env",
      credentials: {
        provider: "env",
        env_file: ".env",
        keychain_service_prefix: "satomi",
      },
      destinations: {
        jekyll: true,
        org_social: false,
        mastodon: false,
        bluesky: false,
        x: false,
        telegram: true,
      },
    } as ResolvedConfig;

    await expect(loadCredentials(config, ["telegram"])).resolves.toEqual({
      telegram: { workerToken: "local-gateway-token" },
    });
  });
});
