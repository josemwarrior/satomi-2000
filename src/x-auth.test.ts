import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "./types.js";
import {
  buildXAuthorizationUrl,
  obtainXAccessToken,
  parseXAuthorizationCallback,
  X_OAUTH_SCOPES,
} from "./x-auth.js";

const temporaryPaths: string[] = [];
const originalRefreshToken = process.env.X_REFRESH_TOKEN;

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalRefreshToken === undefined) delete process.env.X_REFRESH_TOKEN;
  else process.env.X_REFRESH_TOKEN = originalRefreshToken;
  await Promise.all(temporaryPaths.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

async function testConfig(callbackUrl = "http://127.0.0.1:3000/callback"): Promise<ResolvedConfig> {
  const root = await mkdtemp(path.join(os.tmpdir(), "satomi-x-oauth-"));
  temporaryPaths.push(root);
  return {
    envPath: path.join(root, ".env"),
    platforms: {
      x: {
        oauth_callback_url: callbackUrl,
        oauth_timeout_seconds: 5,
      },
    },
  } as ResolvedConfig;
}

function tokenResponse(accessToken: string, refreshToken?: string): Response {
  return new Response(JSON.stringify({
    token_type: "bearer",
    access_token: accessToken,
    expires_in: 7200,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("X OAuth authorization", () => {
  it("builds a PKCE authorization URL with every required publishing scope", async () => {
    const config = await testConfig();
    const url = new URL(buildXAuthorizationUrl(config, "client-id", "expected-state", "challenge"));
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3000/callback");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(X_OAUTH_SCOPES);
    expect(url.searchParams.get("state")).toBe("expected-state");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("accepts only the authorization code paired with the expected state", () => {
    const valid = new URL("http://127.0.0.1:3000/callback?state=expected&code=authorization-code");
    expect(parseXAuthorizationCallback(valid, "expected")).toBe("authorization-code");
    expect(() => parseXAuthorizationCallback(valid, "different")).toThrow(/expected state and code/);
    expect(() => parseXAuthorizationCallback(
      new URL("http://127.0.0.1:3000/callback?error=access_denied"),
      "expected",
    )).toThrow(/access_denied/);
  });
});

describe("X OAuth refresh", () => {
  it("renews once and persists a rotated refresh token without storing the access token", async () => {
    const config = await testConfig();
    await writeFile(
      config.envPath,
      "MASTODON_TOKEN=preserved\nX_REFRESH_TOKEN=old-refresh\n",
      { mode: 0o600 },
    );
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("old-refresh");
      expect(body.get("client_id")).toBe("client-id");
      return tokenResponse("new-access", "new-refresh");
    });

    const accessToken = await obtainXAccessToken(config, "client-id", "old-refresh", {
      fetchImpl: fetchImpl as typeof globalThis.fetch,
      writeStatus: () => undefined,
      openBrowser: async () => {
        throw new Error("Browser should not be opened during a valid refresh");
      },
    });

    expect(accessToken).toBe("new-access");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const environment = await readFile(config.envPath, "utf8");
    expect(environment).toContain("MASTODON_TOKEN=preserved");
    expect(environment).toContain('X_REFRESH_TOKEN="new-refresh"');
    expect(environment).not.toContain("new-access");
  });
});
