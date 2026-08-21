import { Curvet, DEFAULT_BASE_URL } from "@curvet/sdk";
import type { ResolvedProfile } from "./config.js";

/** The `/api/v1` root that sits above the playground base (public models, OpenAI-compat). */
export function v1Root(baseURL?: string): string {
  return (baseURL ?? DEFAULT_BASE_URL).replace(/\/playground\/?$/, "");
}

export class NoCredentialsError extends Error {
  constructor() {
    super(
      "No Curvet credentials found. Run `curvet login` (or `curvet auth login` to paste a key), " +
        "or set CURVET_APP_KEY / CURVET_ENTERPRISE_KEY / CURVET_CLI_TOKEN.",
    );
    this.name = "NoCredentialsError";
  }
}

export function makeClient(profile: ResolvedProfile): Curvet {
  if (!profile.appKey && !profile.enterpriseKey && !profile.cliToken) {
    throw new NoCredentialsError();
  }
  return new Curvet({
    appKey: profile.appKey,
    enterpriseKey: profile.enterpriseKey,
    cliToken: profile.cliToken,
    baseURL: profile.baseURL,
  });
}

export function requireCliToken(profile: ResolvedProfile): string {
  if (!profile.cliToken) {
    throw new Error(
      "This command needs you to be signed in. Run `curvet login`.",
    );
  }
  return profile.cliToken;
}

export function requireAppKey(profile: ResolvedProfile): string {
  if (!profile.appKey) {
    throw new Error(
      "This command needs an app key (playground scope). Run `curvet auth login` or set CURVET_APP_KEY.",
    );
  }
  return profile.appKey;
}
