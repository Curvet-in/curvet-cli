import path from "node:path";
import { promises as fs } from "node:fs";
import { classifyPath, denialMessage, secretReason } from "./permissions.js";

/**
 * Which commands may run, with what approval, and what a path in an argument
 * means.
 *
 * The reasoning is in documentation/CLI_RUN_COMMAND_PLAN.md (darkapp-haven).
 * The two things to keep in mind when changing this file:
 *
 * ── There are two gates, and a command clears both ──────────────────────────
 *
 *   command   may this program run at all, and does it need approval?  → TIERS
 *   path      may this run touch this file?                            → classifyPath
 *
 * `cat .env` is refused because of `.env`, not because of `cat`. Putting the
 * boundary on the argument is what lets the everyday case be silent: `cat`,
 * `grep`, `find` and `git status` run with no prompt, and they are safe not
 * because we trust them but because every path they are handed is classified by
 * the same code `read_file` uses.
 *
 * ── Nothing here is a wall ──────────────────────────────────────────────────
 *
 * An unknown command asks. A dangerous one asks loudly, saying what it can do
 * that the others cannot. The only hard refusals are about a PATH — a secret, or
 * an argument that resolves somewhere a write may not go — which is why they can
 * be absolute without ever blocking a command outright. A tool people abandon
 * protects nobody.
 */

/** How a command is allowed to run. */
export type Tier =
  /** Reading and inspecting. Runs with no prompt. */
  | "auto"
  /** Has an effect inside the project. Asks every time. */
  | "confirm"
  /** No rule matched. Asks — an unrecognised command is not evidence of malice. */
  | "unknown"
  /** Asks loudly, and says what makes it different. */
  | "loud";

export interface Verdict {
  tier: Tier;
  /** Why this is `loud`, in terms the user can picture. */
  warning?: string;
  /** A hard refusal, about a path rather than the command. */
  refusal?: string;
  /** argv as it will actually be executed, after any hardening we inject. */
  argv: string[];
}

/**
 * Subcommands of `git` that only read. `git` is split by subcommand rather than
 * allowed whole because `push`, `reset`, `clean` and `config` are a different
 * question from `status`, and because a binary-level allowance would cover all
 * of them.
 */
const GIT_READ = new Set([
  "status", "diff", "log", "show", "blame", "branch", "remote", "rev-parse",
  "describe", "shortlog", "ls-files", "ls-tree", "cat-file", "count-objects",
  "config-list", "whatchanged", "reflog", "grep", "tag", "stash",
]);

/** Subcommands that change the repository or talk to a remote. */
const GIT_WRITE = new Set([
  "add", "commit", "checkout", "switch", "restore", "merge", "rebase",
  "cherry-pick", "revert", "mv", "apply", "am", "init", "fetch", "pull",
  "submodule", "worktree", "bisect", "notes",
]);

/** Subcommands that publish, destroy history, or reconfigure. Loud. */
const GIT_LOUD = new Set(["push", "reset", "clean", "config", "gc", "prune", "filter-branch", "update-ref"]);

/** Programs that only read and report. */
const AUTO = new Set([
  "ls", "pwd", "cat", "head", "tail", "nl", "wc", "file", "stat", "du", "df",
  "find", "grep", "rg", "egrep", "fgrep", "jq", "yq", "basename", "dirname",
  "realpath", "date", "echo", "which", "type", "tree", "diff", "cmp", "sort",
  "uniq", "cut", "tr", "seq", "true", "false",
]);

/** Programs whose effects are bounded by the project. */
const CONFIRM = new Set([
  "npm", "pnpm", "yarn", "bun", "npx", "node", "tsc", "tsx", "vitest", "jest",
  "eslint", "prettier", "biome", "python", "python3", "pytest", "ruff", "black",
  "mypy", "poetry", "pip-compile", "go", "gofmt", "cargo", "rustc", "rustfmt",
  "clippy-driver", "make", "cmake", "gradle", "mvn", "dotnet", "ruby", "rake",
  "bundle", "php", "composer", "swift", "java", "javac", "deno", "terraform",
  "docker", "docker-compose", "kubectl", "gh", "mkdir", "touch", "cp", "mv",
]);

/**
 * Programs that need the loud prompt, with what to say about each. The text is
 * the point: "curl is a network client" is abstract, "it can send any file this
 * run has read to a server you have not chosen" is not.
 */
const LOUD: Record<string, string> = {
  sh: "A shell interprets its argument, so this can run anything at all — the argv-only rule that protects every other command does not reach inside it.",
  bash: "A shell interprets its argument, so this can run anything at all — the argv-only rule that protects every other command does not reach inside it.",
  zsh: "A shell interprets its argument, so this can run anything at all — the argv-only rule that protects every other command does not reach inside it.",
  fish: "A shell interprets its argument, so this can run anything at all.",
  dash: "A shell interprets its argument, so this can run anything at all.",
  eval: "Runs whatever string it is given.",
  curl: "Can send the contents of any file this run has read to a server you have not chosen, and can fetch code for something else to execute. Nothing downstream inspects what comes back.",
  wget: "Can fetch code for something else to execute, and write it anywhere it is pointed.",
  nc: "A raw network connection — it can carry anything off this machine, in either direction.",
  ncat: "A raw network connection — it can carry anything off this machine.",
  telnet: "A raw network connection to a host you have not chosen.",
  ssh: "Runs commands on another machine using your keys, and your keys are not covered by anything here.",
  scp: "Copies files off this machine using your keys.",
  rsync: "Copies whole directory trees, and can reach a remote host.",
  sftp: "Transfers files off this machine using your keys.",
  sudo: "Runs as root. Nothing in this client — not the path rules, not the project boundary — applies to what happens next.",
  su: "Runs as another user, outside everything this client checks.",
  doas: "Runs as root, outside everything this client checks.",
  chmod: "Changes who may read or run a file, which can make a secret readable or a file executable.",
  chown: "Changes who owns a file.",
  ln: "Makes one path mean another, which is how a file outside the project gets a name inside it.",
  rm: "Deletes. There is no undo for this — `--undo` only restores files the agent wrote.",
  rmdir: "Deletes a directory.",
  crontab: "Schedules something to run again later, after this session is over.",
  launchctl: "Registers something to run again later, after this session is over.",
  systemctl: "Starts, stops or enables a system service.",
  brew: "Installs software, running whatever the formula says.",
  apt: "Installs software as root.",
  "apt-get": "Installs software as root.",
  yum: "Installs software as root.",
  dnf: "Installs software as root.",
  pacman: "Installs software as root.",
  killall: "Kills processes by name, including ones nothing to do with this project.",
  kill: "Kills a process.",
  dd: "Writes raw blocks, and can overwrite a disk.",
  mkfs: "Formats a filesystem.",
  shutdown: "Shuts the machine down.",
  reboot: "Restarts the machine.",
  env: "Prints the environment. The environment is scrubbed of credentials before a command runs, but this is still the wrong shape to make routine.",
  printenv: "Prints the environment.",
};

/** `-c`/`-e` on an interpreter is a shell by another name. */
const INLINE_CODE: Record<string, string[]> = {
  node: ["-e", "--eval", "-p", "--print"],
  python: ["-c"],
  python3: ["-c"],
  ruby: ["-e"],
  perl: ["-e", "-E"],
  php: ["-r"],
  deno: ["eval"],
};

/**
 * Flags that let `git` run something else. Injected hardening covers the config
 * WE set; these are the ones the model must not be allowed to set itself.
 */
const GIT_ESCAPES = new Set(["-c", "--exec-path", "--upload-pack", "--receive-pack", "--config-env"]);

/** Hardening prepended to every `git` invocation. */
const GIT_HARDENING = [
  "-c", "core.pager=cat",
  "-c", "core.editor=false",
  "-c", "core.sshCommand=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "protocol.ext.allow=never",
  "--no-pager",
];

/** Environment a command inherits. Everything else is dropped. */
const ENV_KEEP = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ", "SHELL", "USER", "PWD"];

/** Names whose VALUE is a credential, dropped even if a keep-list grows. */
const ENV_SECRET = /(_TOKEN|_KEY|_SECRET|_PASSWORD|_PASSWD|_CREDENTIALS|SESSION|COOKIE)$|^(AWS_|GCP_|GOOGLE_|AZURE_|GH_|GITHUB_|NPM_|PYPI_|DOCKER_|OPENAI|ANTHROPIC|CURVET)/i;

/**
 * The environment a command runs with.
 *
 * A command that cannot see a credential cannot send one anywhere, and most
 * build tools do not need one. `extra` is the per-project opt-in for the ones
 * that genuinely do.
 */
export function scrubbedEnv(source: NodeJS.ProcessEnv, extra: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [...ENV_KEEP, ...extra]) {
    const v = source[k];
    if (typeof v === "string" && !(ENV_SECRET.test(k) && !extra.includes(k))) out[k] = v;
  }
  // Git must never prompt or reach the network on its own account.
  out.GIT_TERMINAL_PROMPT = "0";
  out.GIT_ASKPASS = "";
  out.GIT_CONFIG_NOSYSTEM = "1";
  out.GIT_CONFIG_GLOBAL = "/dev/null";
  // Stop package managers running lifecycle scripts as a side effect.
  out.npm_config_ignore_scripts = "true";
  return out;
}

/** Does this argument name a filesystem path we should classify? */
async function looksLikePath(cwd: string, arg: string): Promise<boolean> {
  if (!arg || arg.startsWith("-")) return false;
  if (path.isAbsolute(arg) || arg.includes("/") || arg.startsWith("~")) return true;
  // A bare word that happens to be a file here: `cat .env`, `cat README.md`.
  try {
    await fs.stat(path.resolve(cwd, arg));
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify every path-shaped argument.
 *
 * A secret is a refusal, never a prompt — `read_file` refuses `.env` without
 * asking on the grounds that a prompt which silently yields a private key
 * launders the decision through the user, and if `cat .env` merely asked, the
 * shell would be the easy way around the strictest rule we have.
 *
 * Outside the project is a confirmation, matching a read rather than a write:
 * most commands here only look, and refusing `git diff ../sibling` outright
 * would be stricter than `read_file` is.
 */
export async function checkPaths(
  cwd: string,
  args: string[],
): Promise<{ refusal?: string; needsConfirm: string[] }> {
  const needsConfirm: string[] = [];
  for (const arg of args) {
    if (!(await looksLikePath(cwd, arg))) continue;
    const verdict = await classifyPath(cwd, arg);
    if (verdict.decision === "deny") {
      return { refusal: denialMessage(arg, verdict.matched), needsConfirm: [] };
    }
    if (verdict.decision === "confirm") needsConfirm.push(verdict.display);
  }
  return { needsConfirm };
}

/** Where the `-` in `--flag=value` hides a path. */
function flagValue(arg: string): string | null {
  const eq = arg.indexOf("=");
  return eq > 0 && arg.startsWith("-") ? arg.slice(eq + 1) : null;
}

/**
 * Decide how `command` with `args` may run.
 *
 * Pure and synchronous about the COMMAND; path checks are separate (`checkPaths`)
 * because they touch the filesystem and because they answer a different
 * question. Both have to pass.
 */
export function classifyCommand(command: string, args: string[]): Verdict {
  const bin = path.basename(String(command || "").trim());

  if (!bin) return { tier: "unknown", argv: [], refusal: "No command was given." };

  // A program named by an absolute path, or reached through .., is not the one
  // the tiers are about.
  if (command.includes("/")) {
    return {
      tier: "loud",
      warning: `This names a program by path (${command}) rather than by name, so it is not necessarily the ${bin} on your PATH.`,
      argv: [command, ...args],
    };
  }

  // An interpreter handed code inline is a shell wearing another name.
  const inline = INLINE_CODE[bin];
  if (inline && args.some((a) => inline.includes(a))) {
    return {
      tier: "loud",
      warning: `\`${bin} ${args.find((a) => inline.includes(a))}\` runs code given on the command line, so this can do anything — the argv-only rule does not reach inside it.`,
      argv: [bin, ...args],
    };
  }

  if (LOUD[bin]) return { tier: "loud", warning: LOUD[bin], argv: [bin, ...args] };

  if (bin === "git") {
    const escape = args.find((a) => GIT_ESCAPES.has(a) || GIT_ESCAPES.has(a.split("=")[0]));
    if (escape) {
      return {
        tier: "loud",
        argv: [bin, ...args],
        warning: `\`git ${escape}\` can point git at a different program or config, which is how a repository makes \`git log\` run something of its choosing.`,
      };
    }
    const sub = args.find((a) => !a.startsWith("-")) ?? "";
    const argv = ["git", ...GIT_HARDENING, ...args];
    if (GIT_LOUD.has(sub)) {
      return {
        tier: "loud",
        argv,
        warning:
          sub === "push"
            ? "Publishes to a remote, where it cannot be taken back."
            : sub === "config"
              ? "Changes git's configuration, which decides what later git commands do."
              : `\`git ${sub}\` can destroy work that is not committed, and --undo does not cover it.`,
      };
    }
    if (GIT_WRITE.has(sub)) return { tier: "confirm", argv };
    if (GIT_READ.has(sub)) {
      // `git stash` alone stashes; `git stash list` reads.
      if (sub === "stash" && !args.includes("list") && !args.includes("show")) {
        return { tier: "confirm", argv };
      }
      if (sub === "tag" && !args.some((a) => a === "-l" || a === "--list")) {
        return { tier: "confirm", argv };
      }
      return { tier: "auto", argv };
    }
    return { tier: "unknown", argv };
  }

  // `--version` / `--help` on anything is inspection.
  if (args.length && args.every((a) => /^--?(v|version|help|h)$/.test(a))) {
    return { tier: "auto", argv: [bin, ...args] };
  }

  if (AUTO.has(bin)) return { tier: "auto", argv: [bin, ...args] };

  if (bin === "npm" || bin === "pnpm" || bin === "yarn" || bin === "bun") {
    const sub = args.find((a) => !a.startsWith("-")) ?? "";
    if (sub === "ls" || sub === "list" || sub === "view" || sub === "outdated" || sub === "why") {
      return { tier: "auto", argv: [bin, ...args] };
    }
    if (/^(i|install|add|remove|rm|uninstall|update|publish|link|ci)$/.test(sub)) {
      return {
        tier: "loud",
        argv: [bin, ...args],
        warning: `\`${bin} ${sub}\` downloads and installs packages, and a package can run code as it installs.`,
      };
    }
    return { tier: "confirm", argv: [bin, ...args] };
  }

  if (CONFIRM.has(bin)) return { tier: "confirm", argv: [bin, ...args] };

  return { tier: "unknown", argv: [bin, ...args] };
}

/** Arguments whose `--flag=path` value should also be classified. */
export function pathishArgs(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    out.push(a);
    const v = flagValue(a);
    if (v) out.push(v);
  }
  return out;
}

/** Is this a path we would never let a command write to, whatever the tier? */
export function isSecretPath(p: string): boolean {
  return secretReason(p) !== null;
}
