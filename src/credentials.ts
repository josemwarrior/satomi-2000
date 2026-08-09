import { stat } from "node:fs/promises";
import process from "node:process";
import dotenv from "dotenv";
import { ValidationError } from "./errors.js";
import type { Credentials, PlatformName, ResolvedConfig } from "./types.js";
import { pathExists, runCommand } from "./utils.js";
import { obtainXAccessToken } from "./x-auth.js";

async function loadEnvironment(config: ResolvedConfig): Promise<void> {
  if (!(await pathExists(config.envPath))) return;
  if (process.platform !== "win32") {
    const mode = (await stat(config.envPath)).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new ValidationError(
        `${config.envPath} is readable by other users. Run: chmod 600 ${config.envPath}`,
      );
    }
  }
  dotenv.config({ path: config.envPath, quiet: true });
}

async function keychainValue(config: ResolvedConfig, name: string): Promise<string | undefined> {
  if (config.credentials.provider !== "env_and_keychain" || process.platform !== "darwin") {
    return undefined;
  }
  const service = `${config.credentials.keychain_service_prefix}:${name}`;
  const result = await runCommand("security", ["find-generic-password", "-s", service, "-w"], {
    allowFailure: true,
  });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

async function value(config: ResolvedConfig, name: string): Promise<string> {
  const found = await optionalValue(config, name);
  if (!found) {
    throw new ValidationError(
      `Missing credential ${name}. Set it in the environment, a mode-600 .env file, or macOS Keychain service ${config.credentials.keychain_service_prefix}:${name}.`,
    );
  }
  return found;
}

async function optionalValue(config: ResolvedConfig, name: string): Promise<string | undefined> {
  return process.env[name]?.trim() || (await keychainValue(config, name));
}

export async function loadCredentials(
  config: ResolvedConfig,
  platforms: PlatformName[] = (["mastodon", "bluesky", "x"] as PlatformName[]).filter(
    (name) => config.destinations[name],
  ),
): Promise<Credentials> {
  await loadEnvironment(config);
  const credentials: Credentials = {};
  for (const platform of platforms) {
    if (!config.destinations[platform]) {
      throw new ValidationError(`${platform} is unchecked in destinations.`);
    }
    if (platform === "mastodon") {
      credentials.mastodon = {
        url: (await value(config, "MASTODON_URL")).replace(/\/+$/, ""),
        token: await value(config, "MASTODON_TOKEN"),
      };
    } else if (platform === "bluesky") {
      credentials.bluesky = {
        handle: await value(config, "BLUESKY_HANDLE"),
        appPassword: await value(config, "BLUESKY_APP_PASSWORD"),
      };
    } else {
      const clientId = await value(config, "X_CLIENT_ID");
      const refreshToken = await optionalValue(config, "X_REFRESH_TOKEN");
      credentials.x = {
        accessToken: await obtainXAccessToken(config, clientId, refreshToken),
      };
    }
  }
  return credentials;
}
