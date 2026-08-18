import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ProfileConfig {
  appKey?: string;
  enterpriseKey?: string;
  baseURL?: string;
  defaultModel?: string;
}

export interface CliConfig {
  defaultProfile?: string;
  profiles: Record<string, ProfileConfig>;
}

export type CredentialSource = "env" | "profile";

export interface ResolvedProfile extends ProfileConfig {
  name: string;
  /** Where each credential came from, for `auth status` / `doctor`. */
  sources: {
    appKey?: CredentialSource;
    enterpriseKey?: CredentialSource;
    baseURL?: CredentialSource;
  };
}

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "curvet");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export async function loadConfig(): Promise<CliConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {} };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${configPath()} is not valid JSON — fix or delete it and run \`curvet auth login\` again.`);
  }
  const cfg = parsed as CliConfig;
  return { defaultProfile: cfg.defaultProfile, profiles: cfg.profiles ?? {} };
}

export async function saveConfig(config: CliConfig): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
  // Keys live in this file, so keep it owner-only.
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await fs.chmod(configPath(), 0o600);
}

/**
 * Resolve the effective profile: explicit --profile beats the config default,
 * and CURVET_APP_KEY / CURVET_ENTERPRISE_KEY / CURVET_BASE_URL env vars beat
 * the stored profile values (same precedence the SDK uses for env keys).
 */
export async function resolveProfile(name?: string): Promise<ResolvedProfile> {
  const config = await loadConfig();
  const profileName = name ?? config.defaultProfile ?? "default";
  const stored = config.profiles[profileName] ?? {};

  const resolved: ResolvedProfile = { name: profileName, sources: {}, ...stored };

  if (process.env.CURVET_APP_KEY) {
    resolved.appKey = process.env.CURVET_APP_KEY;
    resolved.sources.appKey = "env";
  } else if (stored.appKey) {
    resolved.sources.appKey = "profile";
  }

  if (process.env.CURVET_ENTERPRISE_KEY) {
    resolved.enterpriseKey = process.env.CURVET_ENTERPRISE_KEY;
    resolved.sources.enterpriseKey = "env";
  } else if (stored.enterpriseKey) {
    resolved.sources.enterpriseKey = "profile";
  }

  if (process.env.CURVET_BASE_URL) {
    resolved.baseURL = process.env.CURVET_BASE_URL;
    resolved.sources.baseURL = "env";
  } else if (stored.baseURL) {
    resolved.sources.baseURL = "profile";
  }

  return resolved;
}
