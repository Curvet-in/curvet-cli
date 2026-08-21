import os from "node:os";
import { spawn } from "node:child_process";
import { Command } from "commander";
import pc from "picocolors";
import { Curvet, DeviceFlowPending, type CliScope } from "@curvet/sdk";
import { loadConfig, saveConfig, resolveProfile } from "../config.js";
import { makeClient } from "../client.js";
import { maskKey, ok, warn, printJson } from "../output.js";

/** Plain-language grants, so nobody approves a slug they did not read. */
const SCOPE_PROSE: Record<string, string> = {
  "apps:read": "see your apps and their usage",
  "apps:write": "create, configure and delete your apps",
  "apps:keys": "rotate your app keys and read your app secrets",
  "agency:run": "run agents as you — spending your credits, and using tools that can send email and messages on your behalf",
  "enterprise:admin": "administer your organization, including minting enterprise API keys",
};

function describeScopes(scopes: string[]): string {
  return scopes.map((s) => `  · ${SCOPE_PROSE[s] ?? s}`).join("\n");
}

/** Best-effort browser open; the code is always printed first regardless. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* headless: the printed URL is the fallback, and it was printed first */
  }
}

function parseExpiry(value?: string): number | undefined {
  if (!value) return undefined;
  const m = /^(\d+)\s*d(ays?)?$/i.exec(value.trim()) ?? /^(\d+)$/.exec(value.trim());
  if (!m) throw new Error(`--expires takes a number of days, e.g. 30d — not "${value}".`);
  return parseInt(m[1], 10);
}

export function loginCommand(): Command {
  return new Command("login")
    .description("Sign in so the CLI can manage your apps and keys")
    .option("--scope <scope>", "extra scope to request (repeatable)", (v, acc: string[]) => [...acc, v], [])
    .option("--expires <days>", "how long the login lasts, e.g. 30d (default 90d)")
    .option("--device <name>", "name this machine (default: its hostname)")
    .option("--no-browser", "print the URL instead of opening it")
    .option("--force", "re-authorise even if this machine is already signed in")
    .option("--json", "machine-readable output")
    .action(async (opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      const config = await loadConfig();
      const deviceName = opts.device || os.hostname();

      // Reuse before re-authorising: a token that still answers means there is
      // nothing to do. This is the common case — `curvet login` run twice — and
      // it should cost one request, not a browser round trip.
      if (profile.cliToken && !opts.force) {
        try {
          const me = await makeClient(profile).auth.whoami();
          if (opts.json) {
            printJson({ alreadyLoggedIn: true, ...me });
            return;
          }
          const days = me.device.expiresAt
            ? Math.round((Date.parse(me.device.expiresAt) - Date.now()) / 86_400_000)
            : null;
          console.log(ok(`already signed in as ${pc.bold(me.user.email)}`));
          console.log(
            pc.dim(
              `  device ${me.device.deviceName || "unnamed"} · ${me.scopes.join(", ")}` +
                (days != null ? ` · expires in ${days} days` : ""),
            ),
          );
          console.log(pc.dim("  Re-authorise with `curvet login --force`."));
          return;
        } catch {
          // Expired, revoked, or the server has never heard of it — fall through
          // and log in properly rather than reporting a confusing failure.
        }
      }

      const scopes = opts.scope.length > 0
        ? ([...new Set(["apps:read", "apps:write", "apps:keys", ...opts.scope])] as CliScope[])
        : undefined;

      // Unauthenticated: this is the request that gets us a credential.
      const anon = new Curvet({ cliToken: "pending", baseURL: profile.baseURL });
      const start = await anon.auth.deviceCode({ deviceName, scopes });

      if (opts.json) {
        printJson(start);
      } else {
        console.log(`\n  Your code is ${pc.bold(pc.cyan(start.userCode))}\n`);
        console.log(`  ${start.verificationUriComplete}\n`);
        console.log(pc.dim("This device is asking to:"));
        console.log(pc.dim(describeScopes(start.requestedScopes)));
        console.log(pc.dim(`\nWaiting for approval… (Ctrl-C to cancel)`));
      }

      // Printed before opening, so the flow still works with no browser at all.
      if (opts.browser !== false) openBrowser(start.verificationUriComplete);

      let result;
      try {
        result = await anon.auth.pollForToken(start, { expiresInDays: parseExpiry(opts.expires) });
      } catch (err) {
        if (err instanceof DeviceFlowPending) {
          if (err.code === "access_denied") throw new Error("Login was denied in the browser.");
          if (err.code === "expired_token") throw new Error("The code expired. Run `curvet login` again.");
        }
        throw err;
      }

      const name = profile.name;
      config.profiles[name] = {
        ...config.profiles[name],
        cliToken: result.token,
        // Only when this login created the account's first app, and never over
        // a key that is already there.
        ...(result.defaultApp && !config.profiles[name]?.appKey
          ? { appKey: result.defaultApp.appKey }
          : {}),
      };
      await saveConfig(config);

      if (opts.json) {
        printJson({ ...result, token: maskKey(result.token), profile: name });
        return;
      }

      const me = await makeClient(await resolveProfile(name)).auth.whoami().catch(() => null);
      console.log(ok(`signed in as ${pc.bold(me?.user.email ?? "your account")}`));
      console.log(pc.dim(`  device ${deviceName} · ${result.scopes.join(", ")}`));
      if (result.reusedDevice) {
        console.log(pc.dim("  reused this machine's existing login rather than adding another"));
      }
      const refused = start.requestedScopes.filter((s) => !result.scopes.includes(s));
      if (refused.length > 0) {
        console.log(warn(`not granted: ${refused.join(", ")} — your account is not eligible.`));
      }
      if (result.defaultApp) {
        console.log(
          ok(`created your first app "${result.defaultApp.name}" and saved its key`),
        );
        console.log(pc.dim(`  ${maskKey(result.defaultApp.appKey)} — try \`curvet chat "hello"\``));
      }
    });
}

export function logoutCommand(): Command {
  return new Command("logout")
    .description("Revoke this machine's login")
    .option("--all", "revoke every machine signed in to this account")
    .action(async (opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      if (!profile.cliToken) {
        console.log(warn("Not signed in."));
        return;
      }

      // Server first: a local delete that leaves a live token on the server is
      // the failure that actually matters.
      let revoked = 0;
      try {
        revoked = await makeClient(profile).auth.logout({ all: opts.all });
      } catch (err) {
        throw new Error(
          `Could not revoke server-side: ${(err as Error).message}\n` +
            "  The local token was left in place — fix the connection and retry, " +
            "or revoke it from the dashboard.",
        );
      }

      const config = await loadConfig();
      if (config.profiles[profile.name]) {
        // The app key is a separate credential; logging out of key management
        // should not stop `curvet chat` working.
        delete config.profiles[profile.name].cliToken;
        await saveConfig(config);
      }
      console.log(ok(opts.all ? `revoked ${revoked} logins` : "signed out"));
    });
}
