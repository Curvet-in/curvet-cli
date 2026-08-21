import { Command } from "commander";
import pc from "picocolors";
import type { CreateAppParams, DeveloperApp } from "@curvet/sdk";
import { loadConfig, resolveProfile, saveConfig } from "../config.js";
import { makeClient, requireCliToken } from "../client.js";
import { confirm } from "../confirm.js";
import { maskKey, ok, printJson, table, warn } from "../output.js";

function list(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function configFlags(cmd: Command): Command {
  return cmd
    .option("--models <ids>", "restrict to these model ids (comma-separated)", list)
    .option("--categories <types>", "restrict to these types, e.g. chat,image", list)
    .option("--rate-limit <n>", "requests per hour", (v) => parseInt(v, 10))
    .option("--cost-cap <usd>", "daily spend cap in USD", (v) => parseFloat(v));
}

function configFrom(opts: Record<string, any>): Partial<CreateAppParams> {
  const params: Partial<CreateAppParams> = {};
  if (opts.models) params.allowedModels = opts.models;
  if (opts.categories) params.allowedCategories = opts.categories;
  if (opts.rateLimit != null || opts.costCap != null) {
    params.rateLimits = {
      ...(opts.rateLimit != null ? { requestsPerHour: opts.rateLimit } : {}),
      ...(opts.costCap != null ? { costCapPerDay: opts.costCap } : {}),
    };
  }
  return params;
}

function appRows(apps: DeveloperApp[]): string[][] {
  return apps.map((a) => [
    String(a._id),
    a.name,
    a.status ?? "",
    a.appKey ? maskKey(a.appKey) : "",
    a.allowedModels?.length ? String(a.allowedModels.length) : "all",
    a.rateLimits?.requestsPerHour ? `${a.rateLimits.requestsPerHour}/h` : "default",
  ]);
}

const HEADERS = ["ID", "NAME", "STATUS", "KEY", "MODELS", "RATE"];

/** Every app command needs a login, not an app key. */
async function client(cmd: Command) {
  const profile = await resolveProfile(cmd.optsWithGlobals().profile);
  requireCliToken(profile);
  return { profile, sdk: makeClient(profile) };
}

export function appsCommand(): Command {
  const apps = new Command("apps").alias("app").description("Manage your apps and their keys");

  apps
    .command("list")
    .alias("ls")
    .description("Your apps")
    .option("--json", "machine-readable output")
    .action(async (opts, self) => {
      const { sdk } = await client(self);
      const found = await sdk.apps.list();
      if (opts.json) return printJson(found);
      if (found.length === 0) {
        return console.log(warn("No apps yet — create one with `curvet apps create <name>`."));
      }
      console.log(table(HEADERS, appRows(found)));
    });

  apps
    .command("show")
    .description("One app in full")
    .argument("<appId>")
    .option("--json", "machine-readable output")
    .action(async (appId: string, opts, self) => {
      const { sdk } = await client(self);
      const app = await sdk.apps.retrieve(appId);
      if (opts.json) return printJson(app);
      console.log(
        table(
          ["FIELD", "VALUE"],
          [
            ["id", String(app._id)],
            ["name", app.name],
            ["status", app.status ?? ""],
            ["key", app.appKey ? maskKey(app.appKey) : ""],
            ["playground", app.playgroundEnabled === false ? "disabled" : "enabled"],
            ["models", app.allowedModels?.length ? app.allowedModels.join(", ") : "all"],
            ["categories", app.allowedCategories?.length ? app.allowedCategories.join(", ") : "all"],
            ["rate limit", app.rateLimits?.requestsPerHour ? `${app.rateLimits.requestsPerHour}/hour` : "default"],
            ["cost cap", app.rateLimits?.costCapPerDay ? `$${app.rateLimits.costCapPerDay}/day` : "default"],
          ],
        ),
      );
    });

  const create = apps
    .command("create")
    .description("Create an app and print its key")
    .argument("<name>")
    .option("--description <text>")
    .option("--use", "save the new key into the active profile")
    .option("--json", "machine-readable output");
  configFlags(create).action(async (name: string, opts, self) => {
    const { profile, sdk } = await client(self);
    const app = await sdk.apps.create({
      name,
      description: opts.description,
      ...configFrom(opts),
    });

    if (opts.use && app.appKey) {
      const config = await loadConfig();
      config.profiles[profile.name] = { ...config.profiles[profile.name], appKey: app.appKey };
      await saveConfig(config);
    }
    if (opts.json) return printJson(app);

    console.log(ok(`created "${app.name}"`));
    console.log(table(["FIELD", "VALUE"], [["id", String(app._id)], ["key", app.appKey ?? ""]]));
    console.log(
      pc.dim(
        opts.use
          ? "\nSaved to the active profile — `curvet chat \"hello\"` will use it."
          : "\nThe key is shown here in full because it is new. Save it, or re-run with --use.",
      ),
    );
  });

  const update = apps
    .command("update")
    .description("Change an app's configuration")
    .argument("<appId>")
    .option("--name <name>")
    .option("--description <text>")
    .option("--json", "machine-readable output");
  configFlags(update).action(async (appId: string, opts, self) => {
    const { sdk } = await client(self);
    const params = {
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.description ? { description: opts.description } : {}),
      ...configFrom(opts),
    };
    if (Object.keys(params).length === 0) {
      throw new Error("Nothing to change. Pass --name, --models, --rate-limit, …");
    }
    const app = await sdk.apps.update(appId, params);
    if (opts.json) return printJson(app);
    console.log(ok(`updated "${app.name}"`));
  });

  apps
    .command("delete")
    .alias("rm")
    .description("Delete an app and its data")
    .argument("<appId>")
    .option("-y, --yes", "skip the confirmation")
    .action(async (appId: string, opts, self) => {
      const { sdk } = await client(self);
      const app = await sdk.apps.retrieve(appId);
      await confirm(`Delete "${app.name}"?`, {
        yes: opts.yes,
        detail:
          `This removes the app and everything recorded against it. Its key stops\n` +
          `working immediately, so anything still using it starts failing. Not reversible.`,
      });
      await sdk.apps.delete(appId);
      console.log(ok(`deleted "${app.name}"`));
    });

  apps
    .command("use")
    .description("Save an existing app's key into the active profile")
    .argument("<appId>")
    .action(async (appId: string, _opts, self) => {
      const { profile, sdk } = await client(self);
      const app = await sdk.apps.retrieve(appId);
      if (!app.appKey) throw new Error(`"${app.name}" has no key to use.`);
      const config = await loadConfig();
      config.profiles[profile.name] = { ...config.profiles[profile.name], appKey: app.appKey };
      await saveConfig(config);
      console.log(ok(`profile "${profile.name}" now uses "${app.name}" (${maskKey(app.appKey)})`));
    });

  return apps;
}

export function keysCommand(): Command {
  const keys = new Command("keys").description("Rotate and read app credentials");

  keys
    .command("rotate")
    .description("Replace an app's key and secret")
    .argument("<appId>")
    .option("-y, --yes", "skip the confirmation")
    .option("--use", "save the new key into the active profile")
    .option("--json", "machine-readable output")
    .action(async (appId: string, opts, self) => {
      const { profile, sdk } = await client(self);
      const app = await sdk.apps.retrieve(appId);

      await confirm(`Rotate the key for "${app.name}"?`, {
        yes: opts.yes,
        detail:
          `The current key stops working the moment this completes. Anything still\n` +
          `using it starts failing, including anything you have deployed.`,
      });

      const rotated = await sdk.apps.rotateKeys(appId);
      if (opts.use || profile.appKey === app.appKey) {
        const config = await loadConfig();
        config.profiles[profile.name] = { ...config.profiles[profile.name], appKey: rotated.appKey };
        await saveConfig(config);
      }
      if (opts.json) return printJson(rotated);

      console.log(ok(`rotated the key for "${app.name}"`));
      console.log(table(["FIELD", "VALUE"], [["key", rotated.appKey], ["secret", rotated.appSecret]]));
      console.log(pc.dim("\nThe secret is shown once. Anything using the old key needs updating now."));
    });

  keys
    .command("show")
    .description("Print an app's secret")
    .argument("<appId>")
    .option("-y, --yes", "skip the confirmation")
    .action(async (appId: string, opts, self) => {
      const { sdk } = await client(self);
      const app = await sdk.apps.retrieve(appId);
      await confirm(`Print the secret for "${app.name}" to this terminal?`, {
        yes: opts.yes,
        detail: "It will be in your scrollback, and in any log capturing this session.",
      });
      console.log(await sdk.apps.secret(appId));
    });

  return keys;
}
