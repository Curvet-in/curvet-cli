import { Curvet, DEFAULT_BASE_URL } from "@curvet/sdk";
import type { ResolvedProfile } from "./config.js";

/** The `/api/v1` root that sits above the playground base (public models, OpenAI-compat). */
export function v1Root(baseURL?: string): string {
  return (baseURL ?? DEFAULT_BASE_URL).replace(/\/playground\/?$/, "");
}

export class NoCredentialsError extends Error {
  constructor() {
    super(
      "No Curvet credentials found. Run `curvet auth login`, or set CURVET_APP_KEY / CURVET_ENTERPRISE_KEY.",
    );
    this.name = "NoCredentialsError";
  }
}

export function makeClient(profile: ResolvedProfile): Curvet {
  if (!profile.appKey && !profile.enterpriseKey) throw new NoCredentialsError();
  return new Curvet({
    appKey: profile.appKey,
    enterpriseKey: profile.enterpriseKey,
    baseURL: profile.baseURL,
  });
}

export function requireAppKey(profile: ResolvedProfile): string {
  if (!profile.appKey) {
    throw new Error(
      "This command needs an app key (playground scope). Run `curvet auth login` or set CURVET_APP_KEY.",
    );
  }
  return profile.appKey;
}
