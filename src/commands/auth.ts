import { Command } from "commander";
import pc from "picocolors";
import { Curvet } from "@curvet/sdk";
import { loadConfig, saveConfig, resolveProfile, configPath } from "../config.js";
import { maskKey, ok, warn, fail, printJson, table } from "../output.js";

/** Prompt for a secret on a TTY without echoing it. */
async function promptSecret(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Piped input: read a single line.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").split("\n")[0].trim();
  }
  process.stdout.write(promptText);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    let value = "";
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          // Ctrl-C
          stdin.setRawMode?.(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function validateKeys(opts: {
  appKey?: string;
  enterpriseKey?: string;
  cliToken?: string;
  baseURL?: string;
}): Promise<string[]> {
  const notes: string[] = [];
  const client = new Curvet({
    appKey: opts.appKey,
    enterpriseKey: opts.enterpriseKey,
    cliToken: opts.cliToken,
    baseURL: opts.baseURL,
  });
  if (opts.appKey) {
    const models = await client.models.list();
    const limits = await client.models.rateLimits();
    notes.push(
      `app key valid — ${models.length} models available` +
        (limits ? `, ${limits.requestsPerHour} req/h, $${limits.costCapPerDay}/day cap` : ""),
    );
  }
  if (opts.cliToken) {
    const me = await client.auth.whoami();
    const days = me.device.expiresAt
      ? Math.round((Date.parse(me.device.expiresAt) - Date.now()) / 86_400_000)
      : null;
    notes.push(
      `signed in as ${me.user.email} — ${me.scopes.join(", ")}` +
        (days != null ? `, expires in ${days} days` : ""),
    );
  }
  if (opts.enterpriseKey) {
    const overview = await client.enterprise.overview();
    const orgName =
      (overview.organization as { name?: string } | undefined)?.name ?? "organization";
    notes.push(
      `enterprise key valid — ${orgName}, ${overview.memberCount} members, pool ${overview.pool.balance} credits`,
    );
  }
  return notes;
}

export function authCommand(): Command {
  const auth = new Command("auth").description("Manage credentials and profiles");

  auth
    .command("login")
    .description("Save an app key and/or enterprise key into a profile")
    .option("--app-key <key>", "app key (x-app-key scope)")
    .option("--enterprise-key <key>", "enterprise key (x-enterprise-key scope)")
    .option("--base-url <url>", "override API base URL (e.g. for staging)")
    .option("--no-verify", "skip validating the keys against the API")
    .action(async (opts, cmd) => {
      const profileName: string = cmd.optsWithGlobals().profile ?? "default";
      let appKey: string | undefined = opts.appKey;
      let enterpriseKey: string | undefined = opts.enterpriseKey;

      if (!appKey && !enterpriseKey) {
        console.log(
          pc.dim("Paste your key(s) — leave blank to skip. Keys are stored in ") +
            pc.dim(configPath()),
        );
        appKey = (await promptSecret("App key (app_…): ")) || undefined;
        enterpriseKey = (await promptSecret("Enterprise key (cvent_ent_…): ")) || undefined;
      }
      if (!appKey && !enterpriseKey) {
        console.error(fail("Nothing to save — provide at least one key."));
        process.exit(1);
      }

      if (appKey && !/^(app_|cvt_app_)/.test(appKey)) {
        console.log(warn(`app key doesn't start with app_ — double-check it's the right kind`));
      }
      if (enterpriseKey && !enterpriseKey.startsWith("cvent_ent_")) {
        console.log(warn("enterprise key doesn't start with cvent_ent_ — double-check it"));
      }

      if (opts.verify !== false) {
        const notes = await validateKeys({ appKey, enterpriseKey, baseURL: opts.baseUrl });
        for (const note of notes) console.log(ok(note));
      }

      const config = await loadConfig();
      const existing = config.profiles[profileName] ?? {};
      config.profiles[profileName] = {
        ...existing,
        ...(appKey ? { appKey } : {}),
        ...(enterpriseKey ? { enterpriseKey } : {}),
        ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      };
      config.defaultProfile ??= profileName;
      await saveConfig(config);
      console.log(ok(`Saved profile ${pc.bold(profileName)} to ${configPath()}`));
    });

  auth
    .command("status")
    .description("Show configured profiles and where credentials come from")
    .option("--json", "machine-readable output")
    .action(async (opts, cmd) => {
      const config = await loadConfig();
      const active = await resolveProfile(cmd.optsWithGlobals().profile);

      if (opts.json) {
        printJson({
          configPath: configPath(),
          defaultProfile: config.defaultProfile ?? null,
          activeProfile: {
            name: active.name,
            appKey: active.appKey ? maskKey(active.appKey) : null,
            enterpriseKey: active.enterpriseKey ? maskKey(active.enterpriseKey) : null,
            cliToken: active.cliToken ? maskKey(active.cliToken) : null,
            baseURL: active.baseURL ?? null,
            sources: active.sources,
          },
          profiles: Object.fromEntries(
            Object.entries(config.profiles).map(([name, p]) => [
              name,
              {
                appKey: p.appKey ? maskKey(p.appKey) : null,
                enterpriseKey: p.enterpriseKey ? maskKey(p.enterpriseKey) : null,
                cliToken: p.cliToken ? maskKey(p.cliToken) : null,
                baseURL: p.baseURL ?? null,
              },
            ]),
          ),
        });
        return;
      }

      const names = Object.keys(config.profiles);
      if (names.length === 0 && !active.appKey && !active.enterpriseKey && !active.cliToken) {
        console.log(warn("No profiles configured. Run `curvet login` to get started."));
        return;
      }
      const rows = names.map((name) => {
        const p = config.profiles[name];
        return [
          name === active.name ? `${name} ${pc.green("(active)")}` : name,
          p.appKey ? maskKey(p.appKey) : pc.dim("—"),
          p.enterpriseKey ? maskKey(p.enterpriseKey) : pc.dim("—"),
          p.cliToken ? pc.green("signed in") : pc.dim("—"),
          p.baseURL ?? pc.dim("default"),
        ];
      });
      console.log(table(["PROFILE", "APP KEY", "ENTERPRISE KEY", "LOGIN", "BASE URL"], rows));
      for (const [field, source] of Object.entries(active.sources)) {
        if (source === "env") {
          console.log(
            warn(`${field} is coming from the environment and overrides the profile value`),
          );
        }
      }
    });

  auth
    .command("use <profile>")
    .description("Set the default profile")
    .action(async (profileName: string) => {
      const config = await loadConfig();
      if (!config.profiles[profileName]) {
        console.error(
          fail(
            `No profile named "${profileName}". Existing: ${Object.keys(config.profiles).join(", ") || "(none)"}`,
          ),
        );
        process.exit(1);
      }
      config.defaultProfile = profileName;
      await saveConfig(config);
      console.log(ok(`Default profile is now ${pc.bold(profileName)}`));
    });

  return auth;
}
