import { spawn } from "node:child_process";
import { classifyCommand, checkPaths, pathishArgs, scriptBody, scrubbedEnv, type Tier } from "./policy.js";
import { MAX_RESULT_CHARS } from "./tools.js";
import type { ToolContext, ToolOutcome } from "./tools.js";

/**
 * `run_command` — running a program on the user's machine.
 *
 * Design and reasoning: documentation/CLI_RUN_COMMAND_PLAN.md in darkapp-haven.
 * `policy.ts` decides WHETHER; this file decides HOW, and the how has a few
 * properties that matter as much as the policy:
 *
 *   no shell        spawn with an argv array and shell:false. `;`, `|`, `$()`,
 *                   backticks, globs and `>` are characters, not operators,
 *                   because nothing is there to interpret them. This is the one
 *                   decision the whole design rests on.
 *   no inherited    the environment is rebuilt from a keep-list, so a command
 *   credentials     cannot send a token it never received.
 *   no stdin        /dev/null. A command waiting for input the model cannot see
 *                   is a hang nobody can explain.
 *   killed as a     a timeout kills the process GROUP, so a spawned child does
 *   group           not outlive the thing that spawned it.
 */

/** How long a command may run before it is killed. */
export const COMMAND_TIMEOUT_MS = 120_000;

/** Characters that would only be there because the model expected a shell. */
const SHELL_SYNTAX = /[;&|`$><]|\$\(|\)\s*$/;

/** How long to wait after SIGTERM before SIGKILL. */
const GRACE_MS = 2_000;

export interface CommandResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

/** Run it. No policy here — the caller has already decided. */
export async function spawnCommand(
  argv: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
): Promise<CommandResult> {
  const [bin, ...args] = argv;
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      // Never a shell. See the note at the top of this file.
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout can take its children with it.
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const room = () => MAX_RESULT_CHARS - (stdout.length + stderr.length);
    const take = (chunk: string, into: "out" | "err") => {
      const left = room();
      if (left <= 0) {
        truncated = true;
        return;
      }
      const slice = chunk.length > left ? ((truncated = true), chunk.slice(0, left)) : chunk;
      if (into === "out") stdout += slice;
      else stderr += slice;
    };

    child.stdout?.on("data", (d) => take(String(d), "out"));
    child.stderr?.on("data", (d) => take(String(d), "err"));

    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), GRACE_MS);
    }, opts.timeoutMs ?? COMMAND_TIMEOUT_MS);

    const onAbort = () => {
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), GRACE_MS);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal, stdout, stderr, truncated, timedOut });
    };

    child.on("error", (err) => finish(null, (err as NodeJS.ErrnoException).code ?? "ERROR"));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/** What the model is told, given how it ended. */
function describe(argv: string[], r: CommandResult): string {
  const head = `$ ${argv.join(" ")}`;
  const parts = [head];
  if (r.timedOut) {
    parts.push(`[timed out after ${COMMAND_TIMEOUT_MS / 1000}s and was killed]`);
  } else if (r.signal) {
    parts.push(`[killed by ${r.signal}]`);
  } else {
    parts.push(`[exit ${r.code}]`);
  }
  if (r.stdout.trim()) parts.push(r.stdout.replace(/\s+$/, ""));
  if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.replace(/\s+$/, "")}`);
  if (!r.stdout.trim() && !r.stderr.trim()) parts.push("(no output)");
  if (r.truncated) {
    parts.push(`[... output reached ${MAX_RESULT_CHARS} characters and was cut. Narrow the command rather than running it again ...]`);
  }
  return parts.join("\n");
}

/**
 * The tool.
 *
 * A non-zero exit is a RESULT, not a failure: `npm test` failing is exactly what
 * the model asked to find out, and reporting it as a tool error would make the
 * model retry rather than read it.
 */
export async function runCommand(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const command = String(input.command ?? "").trim();
  const rawArgs = Array.isArray(input.args) ? input.args.map((a) => String(a)) : [];
  const why = typeof input.why === "string" ? input.why.trim() : "";

  if (!command) return { ok: false, error: "No command was given." };
  if (!ctx.confirmCommand) {
    return { ok: false, error: "This client cannot run commands." };
  }

  // A command line smuggled into the `command` field, or shell syntax anywhere
  // in the argv, means the model is expecting a shell. Say so plainly rather
  // than running something that will not do what it thinks — `sh -c "a; b"` is
  // available and asks loudly, which is the honest way to get this.
  if (/\s/.test(command)) {
    return {
      ok: false,
      error:
        `Refused: \`command\` must be one program with no arguments — "${command.slice(0, 80)}" looks like a whole command line. ` +
        `Pass {command: "${command.split(/\s+/)[0]}", args: [${command.split(/\s+/).slice(1).map((a) => JSON.stringify(a)).join(", ")}]} instead.`,
    };
  }
  const shellish = [command, ...rawArgs].find((a) => SHELL_SYNTAX.test(a));
  if (shellish && !LOOKS_INTENTIONAL(command, shellish)) {
    return {
      ok: false,
      error:
        `Refused: "${shellish.slice(0, 80)}" contains shell syntax, and there is no shell here — it would be passed to the program literally. ` +
        "Run one program per call and combine the results yourself. If you genuinely need a shell, that is a separate command the user has to approve.",
    };
  }

  const verdict = classifyCommand(command, rawArgs);
  if (verdict.refusal) return { ok: false, error: verdict.refusal };

  // The path gate, independent of the tier.
  const paths = await checkPaths(ctx.cwd, pathishArgs(rawArgs));
  if (paths.refusal) return { ok: false, error: paths.refusal };

  const display = [command, ...rawArgs].join(" ");

  if (verdict.tier !== "auto" || paths.needsConfirm.length) {
    // An auto-tier command handed a path outside the project still asks — the
    // path gate is independent of the tier, and this is the case where it bites.
    const askTier = verdict.tier === "auto" ? "confirm" : verdict.tier;
    const approved = await ctx.confirmCommand({
      display,
      scriptBody: (await scriptBody(ctx.cwd, command, rawArgs)) ?? undefined,
      tier: askTier,
      warning: verdict.warning,
      outsidePaths: paths.needsConfirm,
      why,
      cwd: ctx.cwd,
    });
    if (!approved) {
      return {
        ok: false,
        error: `The user declined to run "${display.slice(0, 120)}". Do not try again with a variation — ask them what they want instead.`,
      };
    }
  }

  const result = await spawnCommand(verdict.argv, {
    cwd: ctx.cwd,
    env: scrubbedEnv(process.env, ctx.commandEnv ?? []),
    signal: ctx.signal,
  });

  if (result.signal === "ENOENT") {
    return { ok: false, error: `"${command}" is not installed on this machine, or not on PATH.` };
  }

  return {
    ok: true,
    content: describe([command, ...rawArgs], result),
    truncated: result.truncated,
  };
}

/**
 * `find . -name "*.ts"` and `grep 'a|b'` carry characters that look like shell
 * syntax and are ordinary arguments. Refusing those would make the tool useless
 * for the commands it is most needed for, so the check is narrowed to the shapes
 * that only make sense to a shell.
 */
function LOOKS_INTENTIONAL(command: string, arg: string): boolean {
  // A lone `|` inside a regex or glob is fine; `; rm` or `$(...)` is not.
  if (/\$\(|`/.test(arg)) return false;
  if (/^[^;&><]*$/.test(arg)) return true;
  // `>` and `<` appear in diffs and comparisons; a bare redirection is its own arg.
  if (/^[<>]{1,2}$/.test(arg)) return false;
  if (/[;&]\s*\w/.test(arg)) return false;
  return !/[;&]|[<>]{1,2}\s/.test(arg);
}
