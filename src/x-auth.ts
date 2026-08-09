import { createHash, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import process from "node:process";
import { SatomiError, ValidationError } from "./errors.js";
import type { ResolvedConfig } from "./types.js";
import { pathExists, runCommand, writeTextAtomic } from "./utils.js";

const AUTHORIZATION_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";

export const X_OAUTH_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "media.write",
  "offline.access",
] as const;

interface TokenResponse {
  token_type?: string;
  expires_in?: number;
  access_token?: string;
  scope?: string;
  refresh_token?: string;
}

interface ValidTokenResponse extends TokenResponse {
  token_type: string;
  access_token: string;
}

interface XOAuthDependencies {
  fetchImpl?: typeof globalThis.fetch;
  openBrowser?: (url: string) => Promise<void>;
  writeStatus?: (message: string) => void;
}

class RefreshRejectedError extends SatomiError {}

function oauthDependencyDefaults(dependencies: XOAuthDependencies): Required<XOAuthDependencies> {
  return {
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
    openBrowser: dependencies.openBrowser ?? openBrowser,
    writeStatus: dependencies.writeStatus ?? ((message) => process.stderr.write(message)),
  };
}

function tokenDetail(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const record = body as Record<string, unknown>;
  const detail = record.error_description ?? record.error ?? record.detail ?? record.title;
  return typeof detail === "string" ? detail.slice(0, 300) : fallback;
}

async function requestToken(
  body: URLSearchParams,
  action: string,
  fetchImpl: typeof globalThis.fetch,
  allowReauthorization = false,
): Promise<ValidTokenResponse> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new SatomiError(`${action} did not receive a response: ${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = {};
  }
  if (!response.ok) {
    const message = `${action} failed (${response.status}): ${tokenDetail(parsed, response.statusText)}`;
    if (allowReauthorization && (response.status === 400 || response.status === 401)) {
      throw new RefreshRejectedError(message);
    }
    throw new SatomiError(message);
  }

  const token = parsed as TokenResponse;
  if (!token.access_token || token.token_type?.toLowerCase() !== "bearer") {
    throw new SatomiError(`${action} returned an invalid token response.`);
  }
  return token as ValidTokenResponse;
}

export function buildXAuthorizationUrl(
  config: ResolvedConfig,
  clientId: string,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(AUTHORIZATION_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", config.platforms.x.oauth_callback_url);
  url.searchParams.set("scope", X_OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function parseXAuthorizationCallback(requestUrl: URL, expectedState: string): string {
  const error = requestUrl.searchParams.get("error");
  if (error) throw new ValidationError(`X authorization failed: ${error}`);
  const state = requestUrl.searchParams.get("state");
  const code = requestUrl.searchParams.get("code");
  if (state !== expectedState || !code) {
    throw new ValidationError("X authorization callback did not contain the expected state and code.");
  }
  return code;
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin"
    ? { name: "open", args: [url] }
    : process.platform === "win32"
      ? { name: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
      : { name: "xdg-open", args: [url] };
  const result = await runCommand(command.name, command.args, { allowFailure: true });
  if (result.exitCode !== 0) {
    throw new SatomiError(result.stderr.trim() || `Could not run ${command.name}.`);
  }
}

async function receiveAuthorizationCode(
  config: ResolvedConfig,
  authorizationUrl: string,
  expectedState: string,
  dependencies: Required<XOAuthDependencies>,
): Promise<string> {
  const callback = new URL(config.platforms.x.oauth_callback_url);
  const port = Number(callback.port);

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", callback.origin);
      if (requestUrl.pathname !== callback.pathname) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      let code: string;
      try {
        code = parseXAuthorizationCallback(requestUrl, expectedState);
      } catch (error) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Invalid X authorization callback. You can close this window.");
        finish(error instanceof Error ? error : new ValidationError(String(error)));
        return;
      }

      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Satomi authorized</title><p>X authorization completed. You can close this window.</p>");
      finish(undefined, code);
    });

    function finish(error?: Error, code?: string): void {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      server.close();
      if (error) reject(error);
      else if (code) resolve(code);
      else reject(new SatomiError("X authorization ended without a code."));
    }

    server.on("error", (error) => {
      finish(
        new ValidationError(
          `Cannot listen for the X OAuth callback at ${config.platforms.x.oauth_callback_url}: ${error.message}`,
        ),
      );
    });

    server.listen(port, callback.hostname, async () => {
      timeout = setTimeout(
        () => finish(new ValidationError("X authorization timed out before the callback was received.")),
        config.platforms.x.oauth_timeout_seconds * 1_000,
      );
      dependencies.writeStatus(
        `X authorization is required. Opening the browser.\nIf it does not open, visit:\n${authorizationUrl}\n`,
      );
      try {
        await dependencies.openBrowser(authorizationUrl);
      } catch {
        dependencies.writeStatus("The browser could not be opened automatically; use the URL shown above.\n");
      }
    });
  });
}

function envLine(name: string, value: string): string {
  return `${name}=${JSON.stringify(value)}`;
}

export async function persistXRefreshToken(config: ResolvedConfig, refreshToken: string): Promise<void> {
  let contents = "";
  if (await pathExists(config.envPath)) {
    const mode = (await stat(config.envPath)).mode & 0o777;
    if (process.platform !== "win32" && (mode & 0o077) !== 0) {
      throw new ValidationError(`${config.envPath} must have mode 600 before storing X credentials.`);
    }
    contents = await readFile(config.envPath, "utf8");
  }

  const lines = contents.split(/\r?\n/);
  const updated: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (/^\s*X_REFRESH_TOKEN\s*=/.test(line)) {
      if (!replaced) updated.push(envLine("X_REFRESH_TOKEN", refreshToken));
      replaced = true;
    } else {
      updated.push(line);
    }
  }
  if (!replaced) {
    while (updated.at(-1) === "") updated.pop();
    updated.push(envLine("X_REFRESH_TOKEN", refreshToken));
  }
  await writeTextAtomic(config.envPath, `${updated.join("\n").replace(/\n+$/, "")}\n`);
  process.env.X_REFRESH_TOKEN = refreshToken;
}

async function authorizeX(
  config: ResolvedConfig,
  clientId: string,
  dependencies: Required<XOAuthDependencies>,
): Promise<string> {
  const codeVerifier = randomBytes(64).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  const authorizationUrl = buildXAuthorizationUrl(config, clientId, state, codeChallenge);
  const code = await receiveAuthorizationCode(config, authorizationUrl, state, dependencies);
  const token = await requestToken(
    new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: config.platforms.x.oauth_callback_url,
      code_verifier: codeVerifier,
    }),
    "X OAuth authorization-code exchange",
    dependencies.fetchImpl,
  );
  if (!token.refresh_token) {
    throw new SatomiError(
      "X did not return a refresh token. Confirm that offline.access is authorized, then try again.",
    );
  }
  await persistXRefreshToken(config, token.refresh_token);
  dependencies.writeStatus("X authorization completed and the refresh token was stored securely.\n");
  return token.access_token;
}

export async function obtainXAccessToken(
  config: ResolvedConfig,
  clientId: string,
  refreshToken?: string,
  providedDependencies: XOAuthDependencies = {},
): Promise<string> {
  const dependencies = oauthDependencyDefaults(providedDependencies);
  if (!refreshToken) return await authorizeX(config, clientId, dependencies);

  try {
    const token = await requestToken(
      new URLSearchParams({
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        client_id: clientId,
      }),
      "X OAuth token refresh",
      dependencies.fetchImpl,
      true,
    );
    if (token.refresh_token && token.refresh_token !== refreshToken) {
      await persistXRefreshToken(config, token.refresh_token);
    }
    return token.access_token;
  } catch (error) {
    if (!(error instanceof RefreshRejectedError)) throw error;
    dependencies.writeStatus("The stored X authorization is no longer valid; authorization is required again.\n");
    return await authorizeX(config, clientId, dependencies);
  }
}
