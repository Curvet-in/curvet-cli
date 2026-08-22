import os from "node:os";
import readline from "node:readline";
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

/** Requested unless you say otherwise: managing the apps and keys you own. */
export const DEFAULT_SCOPES: CliScope[] = ["apps:read", "apps:write", "apps:keys"];

/**
 * Scopes you have to ask for, and what each one is for.
 *
 * Kept out of the default deliberately — `agency:run` is the only grant that
 * spends money by itself, and `enterprise:admin` mints credentials — but keeping
 * them out of the default is no reason to keep them out of SIGHT. Before this
 * existed the only way to discover `agency:run` was to run an agent, be refused,
 * and read the error.
 */
export const OPTIONAL_SCOPES: { scope: CliScope; why: string }[] = [
  { scope: "agency:run", why: "needed for `curvet agent`" },
  { scope: "enterprise:admin", why: "org admins only" },
];

/** Every scope, for `--help` and `--scope` validation. */
export const ALL_SCOPES: CliScope[] = [...DEFAULT_SCOPES, ...OPTIONAL_SCOPES.map((o) => o.scope)];

export function scopeHelp(): string {
  return [
    "",
    "Granted by default:",
    ...DEFAULT_SCOPES.map((s) => `  ${s.padEnd(18)} ${SCOPE_PROSE[s]}`),
    "",
    "Ask for these as well with --scope, or answer the prompt when signing in:",
    ...OPTIONAL_SCOPES.map((o) => `  ${o.scope.padEnd(18)} ${SCOPE_PROSE[o.scope]}`),
    "",
    "Examples:",
    "  curvet login --scope agency:run     # sign in and allow `curvet agent`",
    "  curvet login --all                  # every scope, no prompt",
  ].join("\n");
}

function askLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Offer the optional scopes, once, before the browser opens.
 *
 * Asked here rather than left to a flag because the flag was undiscoverable:
 * `--scope <scope>` never said which scopes exist, so the only way to find
 * `agency:run` was to be refused by something that needed it.
 *
 * Skipped entirely when scopes were named explicitly, when --all was passed, or
 * when there is no terminal — a scripted login must not block on a question, and
 * silence is not consent to a wider grant.
 */
export async function chooseScopes(explicit: string[], all: boolean): Promise<CliScope[]> {
  if (all) return ALL_SCOPES;
  if (explicit.length > 0) {
    return [...new Set([...DEFAULT_SCOPES, ...explicit])] as CliScope[];
  }
  if (!process.stdin.isTTY) return DEFAULT_SCOPES;

  process.stderr.write(`\n${pc.bold("Signing in will let this device:")}\n`);
  for (const s of DEFAULT_SCOPES) process.stderr.write(pc.dim(`  · ${SCOPE_PROSE[s]}\n`));

  process.stderr.write(`\n${pc.bold("Anything else?")}\n`);
  OPTIONAL_SCOPES.forEach((o, i) => {
    process.stderr.write(`  ${pc.cyan(`[${i + 1}]`)} ${SCOPE_PROSE[o.scope]}\n`);
    process.stderr.write(pc.dim(`      ${o.scope} — ${o.why}\n`));
  });

  const answer = (await askLine(pc.dim("\n  numbers to add, or Enter for none: "))).trim();
  if (!answer) return DEFAULT_SCOPES;

  const picked = answer
    .split(/[\s,]+/)
    .map((t) => OPTIONAL_SCOPES[parseInt(t, 10) - 1])
    .filter(Boolean)
    .map((o) => o.scope);

  return [...new Set([...DEFAULT_SCOPES, ...picked])] as CliScope[];
}

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
    .description("Sign in so the CLI can manage your apps, keys and agents")
    .option(
      "--scope <scope>",
      `extra scope to request, repeatable: ${OPTIONAL_SCOPES.map((o) => o.scope).join(" or ")}`,
      (v, acc: string[]) => [...acc, v],
      [],
    )
    .option("--all", "request every scope without being asked")
    .option("--expires <days>", "how long the login lasts, e.g. 30d (default 90d)")
    .option("--device <name>", "name this machine (default: its hostname)")
    .option("--no-browser", "print the URL instead of opening it")
    .option("--force", "re-authorise even if this machine is already signed in")
    .option("--json", "machine-readable output")
    .addHelpText("after", scopeHelp())
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
          const missing = OPTIONAL_SCOPES.filter((o) => !me.scopes.includes(o.scope));
          if (missing.length) {
            // The moment someone is most likely to be looking for this: they ran
            // `curvet login` again because something told them they could not do
            // a thing, and got "already signed in" with no way forward.
            console.log(
              pc.dim(
                `  This device cannot ${missing.map((m) => SCOPE_PROSE[m.scope].split(" — ")[0]).join(" or ")}.` +
                  `\n  Add with: curvet login --force --scope ${missing.map((m) => m.scope).join(" --scope ")}`,
              ),
            );
          } else {
            console.log(pc.dim("  Re-authorise with `curvet login --force`."));
          }
          return;
        } catch {
          // Expired, revoked, or the server has never heard of it — fall through
          // and log in properly rather than reporting a confusing failure.
        }
      }

      const unknown = opts.scope.filter((s: string) => !ALL_SCOPES.includes(s as CliScope));
      if (unknown.length) {
        throw new Error(
          `Unknown scope: ${unknown.join(", ")}.\nAvailable: ${ALL_SCOPES.join(", ")}.`,
        );
      }
      const scopes = await chooseScopes(opts.scope, opts.all === true);

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
