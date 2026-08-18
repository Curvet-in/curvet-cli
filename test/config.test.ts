import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig, resolveProfile, configPath } from "../src/config.js";

let tmpDir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["XDG_CONFIG_HOME", "CURVET_APP_KEY", "CURVET_ENTERPRISE_KEY", "CURVET_BASE_URL"];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "curvet-cli-test-"));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("config", () => {
  it("returns an empty config when no file exists", async () => {
    const config = await loadConfig();
    expect(config.profiles).toEqual({});
    expect(config.defaultProfile).toBeUndefined();
  });

  it("round-trips a saved config with owner-only permissions", async () => {
    await saveConfig({
      defaultProfile: "work",
      profiles: { work: { appKey: "app_abc123", baseURL: "https://staging.example/api/v1/playground" } },
    });
    const config = await loadConfig();
    expect(config.defaultProfile).toBe("work");
    expect(config.profiles.work.appKey).toBe("app_abc123");
    const stat = await fs.stat(configPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("throws a helpful error on corrupt JSON", async () => {
    await fs.mkdir(path.dirname(configPath()), { recursive: true });
    await fs.writeFile(configPath(), "{not json");
    await expect(loadConfig()).rejects.toThrow(/not valid JSON/);
  });

  it("resolves the default profile and marks sources", async () => {
    await saveConfig({
      defaultProfile: "work",
      profiles: { work: { appKey: "app_abc123" } },
    });
    const profile = await resolveProfile();
    expect(profile.name).toBe("work");
    expect(profile.appKey).toBe("app_abc123");
    expect(profile.sources.appKey).toBe("profile");
  });

  it("lets env vars override profile values", async () => {
    await saveConfig({
      defaultProfile: "work",
      profiles: { work: { appKey: "app_from_profile" } },
    });
    process.env.CURVET_APP_KEY = "app_from_env";
    const profile = await resolveProfile();
    expect(profile.appKey).toBe("app_from_env");
    expect(profile.sources.appKey).toBe("env");
  });

  it("falls back to 'default' profile name when nothing is configured", async () => {
    const profile = await resolveProfile();
    expect(profile.name).toBe("default");
    expect(profile.appKey).toBeUndefined();
  });

  it("prefers an explicitly named profile over the default", async () => {
    await saveConfig({
      defaultProfile: "work",
      profiles: {
        work: { appKey: "app_work" },
        personal: { appKey: "app_personal" },
      },
    });
    const profile = await resolveProfile("personal");
    expect(profile.appKey).toBe("app_personal");
  });
});
