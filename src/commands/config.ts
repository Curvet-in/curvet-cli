import { Command } from "commander";
import pc from "picocolors";
import { loadConfig, saveConfig, resolveProfile, configPath } from "../config.js";
import { ok, fail, printJson, table } from "../output.js";

/**
 * Settings reachable from `curvet config`. `scope` decides where a value lands:
 * global keys are display preferences shared by every profile, profile keys
 * belong to one set of credentials.
 */
const SETTINGS = {
  showCost: {
    scope: "global" as const,
    type: "boolean" as const,
    describe: "Show the per-request cost line on stderr (default: true)",
  },
  defaultModel: {
    scope: "profile" as const,
    type: "string" as const,
    describe: "Model used by `curvet chat` when --model is omitted",
  },
};

type SettingKey = keyof typeof SETTINGS;

function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

function unknownKey(key: string): never {
  console.error(
    fail(`Unknown setting "${key}". Known settings: ${Object.keys(SETTINGS).join(", ")}`),
  );
  process.exit(1);
}

function parseValue(key: SettingKey, raw: string): boolean | string {
  if (SETTINGS[key].type !== "boolean") return raw;
  if (/^(true|yes|1|on)$/i.test(raw)) return true;
  if (/^(false|no|0|off)$/i.test(raw)) return false;
  console.error(fail(`"${key}" expects a boolean (true/false), got "${raw}".`));
  process.exit(1);
}

export function configCommand(): Command {
  const config = new Command("config").description("Read and write CLI settings");

  config
    .command("list")
    .alias("ls")
    .description("Show every setting and its current value")
    .option("--json", "machine-readable output")
    .action(async (opts, cmd) => {
      const cfg = await loadConfig();
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      const values: Record<string, unknown> = {
        showCost: cfg.showCost ?? true,
        defaultModel: profile.defaultModel ?? null,
      };
      if (opts.json) {
        printJson({ configPath: configPath(), profile: profile.name, values });
        return;
      }
      console.log(
        table(
          ["SETTING", "VALUE", "SCOPE", "DESCRIPTION"],
          (Object.keys(SETTINGS) as SettingKey[]).map((key) => [
            key,
            values[key] == null ? pc.dim("(unset)") : String(values[key]),
            SETTINGS[key].scope === "global" ? "global" : `profile:${profile.name}`,
            SETTINGS[key].describe,
          ]),
        ),
      );
      console.log(pc.dim(`\n${configPath()}`));
    });

  config
    .command("get <key>")
    .description("Print one setting's value")
    .action(async (key: string, _opts, cmd) => {
      if (!isSettingKey(key)) unknownKey(key);
      const cfg = await loadConfig();
      if (SETTINGS[key].scope === "global") {
        console.log(String(cfg.showCost ?? true));
        return;
      }
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      console.log(profile.defaultModel ?? "");
    });

  config
    .command("set <key> <value>")
    .description("Change a setting")
    .action(async (key: string, raw: string, _opts, cmd) => {
      if (!isSettingKey(key)) unknownKey(key);
      const value = parseValue(key, raw);
      const cfg = await loadConfig();

      if (SETTINGS[key].scope === "global") {
        cfg.showCost = value as boolean;
        await saveConfig(cfg);
        console.log(ok(`showCost = ${value}`));
        return;
      }

      const profileName = cmd.optsWithGlobals().profile ?? cfg.defaultProfile ?? "default";
      cfg.profiles[profileName] = { ...(cfg.profiles[profileName] ?? {}), defaultModel: String(value) };
      await saveConfig(cfg);
      console.log(ok(`defaultModel = ${value} (profile ${profileName})`));
    });

  config
    .command("unset <key>")
    .description("Restore a setting to its default")
    .action(async (key: string, _opts, cmd) => {
      if (!isSettingKey(key)) unknownKey(key);
      const cfg = await loadConfig();

      if (SETTINGS[key].scope === "global") {
        delete cfg.showCost;
        await saveConfig(cfg);
        console.log(ok("showCost restored to its default (true)"));
        return;
      }

      const profileName = cmd.optsWithGlobals().profile ?? cfg.defaultProfile ?? "default";
      if (cfg.profiles[profileName]) delete cfg.profiles[profileName].defaultModel;
      await saveConfig(cfg);
      console.log(ok(`defaultModel cleared (profile ${profileName})`));
    });

  return config;
}
