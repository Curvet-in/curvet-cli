import readline from "node:readline";
import { Command } from "commander";
import pc from "picocolors";
import { pauseFromEvent, type AgencyEvent, type AgencyPause, type Curvet } from "@curvet/sdk";
import { resolveProfile, type ResolvedProfile } from "../config.js";
import { makeClient, requireCliToken } from "../client.js";
import { printJson, table, warn } from "../output.js";

/**
 * `curvet agent` — run a Curvet agent from the terminal and watch it work.
 *
 * Phase 0 of documentation/CLI_AGENT_TUI.md: the run streams, the tool timeline
 * renders, and a run that pauses for a human gets answered. There are no
 * client-side tools yet — nothing here touches your files or runs a command, and
 * the agent has no way to ask it to.
 *
 * ── On not being full-screen ────────────────────────────────────────────────
 *
 * The design doc argues `curvet agent` is the full-screen case that `curvet chat
 * --repl` was not, because a coding agent needs a persistent plan, tool timeline
 * and diff pane. That is probably right *later*. It is not right yet: Phase 0 has
 * no diffs and no local tools, so what is left is a stream of events in the order
 * they happened — exactly the shape scrollback is for.
 *
 * So this renders inline, and the REPL's reasoning carries over verbatim: an
 * alternate-screen app costs you scrollback (the thing you want *after* a run —
 * scrolling up to copy an answer), piping, and a session that survives a flaky
 * SSH connection. It also costs ~6MB of ink for a phase that does not need it.
 * `--json` falls out for free, and a full-screen mode remains open in Phase 2
 * when a diff pane actually justifies one.
 */

// ---- rendering --------------------------------------------------------------

const ICON: Record<string, string> = {
  tool_call: "→",
  tool_result: "←",
  status: "·",
  error: "✖",
};

/** Compact one-line preview of tool arguments — enough to recognise, never a wall. */
export function previewArgs(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const val =
      typeof v === "string" ? v : Array.isArray(v) ? `[${v.length}]` : v == null ? "" : JSON.stringify(v);
    if (!val) continue;
    parts.push(`${k}=${val.length > 48 ? `${val.slice(0, 48)}…` : val}`);
    if (parts.join(" ").length > 100) break;
  }
  return parts.join(" ").slice(0, 110);
}

export function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Renders a run to the terminal, tracking just enough state to close the lines it
 * opened. `agent_delta` streams token by token, so it has to know whether it is
 * mid-paragraph before printing anything else.
 */
export class RunRenderer {
  private streaming = false;
  /** Sticky for the whole run, unlike `streaming`, which closes per paragraph. */
  private streamedText = false;
  private deliverables: { title: string; url?: string; kind?: string }[] = [];
  private currentAgent = "";

  constructor(
    private quiet: boolean,
    private write: (s: string) => void = (s) => process.stdout.write(s),
  ) {}

  /** Close an open stream of deltas before printing a structural line. */
  private breakStream(): void {
    if (this.streaming) {
      this.write("\n");
      this.streaming = false;
    }
  }

  private line(s: string): void {
    this.breakStream();
    this.write(`${s}\n`);
  }

  handle(e: AgencyEvent): void {
    switch (e.type) {
      case "run_id":
        if (!this.quiet) this.line(pc.dim(`run ${String(e.runId)}`));
        break;

      case "run_start":
        if (!this.quiet && e.task) this.line(pc.dim(`▸ ${String(e.task).slice(0, 200)}`));
        break;

      case "agent_start": {
        const name = String(e.agentName ?? e.agentId ?? "agent");
        // Only announce a change. A single-agent run should not repeat itself.
        if (name !== this.currentAgent) {
          this.currentAgent = name;
          if (!this.quiet) this.line(pc.cyan(`\n${name}`));
        }
        break;
      }

      case "agent_delta":
        if (e.text) {
          this.write(String(e.text));
          this.streaming = true;
          this.streamedText = true;
        }
        break;

      case "tool_call":
        if (!this.quiet) {
          const args = previewArgs(e.input);
          this.line(pc.dim(`  ${ICON.tool_call} ${String(e.tool ?? "tool")}${args ? ` ${args}` : ""}`));
        }
        break;

      case "tool_result":
        if (!this.quiet) {
          const okMark = e.ok === false ? pc.red("✖") : pc.green("✓");
          this.line(pc.dim(`  ${ICON.tool_result} ${okMark} ${String(e.summary ?? "")}`.trimEnd()));
        }
        break;

      case "status":
        if (!this.quiet && e.message) this.line(pc.dim(`  ${ICON.status} ${String(e.message)}`));
        break;

      case "deliverable":
        if (e.deliverable) {
          this.deliverables.push({
            title: String(e.deliverable.title ?? "untitled"),
            url: e.deliverable.url,
            kind: e.deliverable.kind,
          });
          this.line(pc.magenta(`  ⬡ ${String(e.deliverable.title ?? "deliverable")}`));
        }
        break;

      case "plan_resolved":
      case "confirm_resolved":
        // The prompt already printed the outcome; a second line is noise.
        break;

      case "error":
        this.line(pc.red(`✖ ${String(e.message ?? "run failed")}`));
        if (e.retryable) this.line(pc.dim("  This looked transient — retrying may work."));
        break;

      case "run_end": {
        this.breakStream();
        // `summary` is the run's final text in full, which has usually just been
        // streamed word for word — printing it again gave every answer twice, and
        // the longer the answer the worse it read. So it only appears when nothing
        // was streamed (a tool-only run, or --quiet), and even then as one line.
        const summary = String(e.summary ?? "").replace(/\s+/g, " ").trim();
        const bits = [
          this.streamedText || !summary
            ? ""
            : summary.length > 120
              ? `${summary.slice(0, 120)}…`
              : summary,
          formatDuration(e.durationMs as number),
          typeof e.costUsd === "number" ? `$${(e.costUsd as number).toFixed(4)}` : "",
          typeof e.creditsBilled === "number" && e.creditsBilled > 0 ? `${e.creditsBilled} credits` : "",
        ].filter(Boolean);
        if (bits.length) this.line(pc.dim(`\n${bits.join(" · ")}`));
        break;
      }

      default:
        break;
    }
  }

  finish(): void {
    this.breakStream();
    if (this.deliverables.length) {
      this.write(pc.dim(`\n${this.deliverables.length} deliverable(s):\n`));
      for (const d of this.deliverables) {
        this.write(`  ${d.title}${d.url ? pc.dim(` — ${d.url}`) : ""}\n`);
      }
    }
  }
}

// ---- answering a pause ------------------------------------------------------

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * What to send back for a pause, asked of the human.
 *
 * A non-TTY **refuses**, exactly as `src/confirm.ts` does and for the same
 * reason: a piped `curvet agent` must not approve a destructive action because
 * nobody was there to answer. Refusing cancels the run, which is the safe end.
 */
export async function answerPause(
  pause: AgencyPause,
): Promise<{ decision?: "approve" | "cancel"; note?: string } | null> {
  process.stderr.write("\n");

  if (!process.stdin.isTTY) {
    process.stderr.write(
      warn(
        `The run paused for a human (${pause.kind}) and there is no terminal to ask.\n` +
          `  ${pause.prompt.slice(0, 300)}\n` +
          "  Cancelling rather than assuming an answer.\n",
      ),
    );
    return { decision: "cancel", note: "no interactive terminal" };
  }

  if (pause.kind === "ask_user") {
    process.stderr.write(pc.yellow(`? ${pause.prompt}\n`));
    if (pause.options?.length) {
      process.stderr.write(pc.dim(`  options: ${pause.options.join("  ·  ")}\n`));
    }
    const answer = await ask(pc.dim("  your answer: "));
    // An empty answer is a real choice — the tool treats "no answer" as "proceed
    // on your best assumption and say so", which is often what you want.
    return { note: answer.trim() };
  }

  if (pause.kind === "plan") {
    process.stderr.write(pc.yellow("? The agent proposed a plan:\n"));
    process.stderr.write(`${pause.prompt}\n`);
    for (const s of pause.steps ?? []) {
      process.stderr.write(pc.dim(`  · ${s.agent}: ${s.task}\n`));
    }
    const answer = await ask(pc.dim("  approve? [Y/n] "));
    return /^n(o)?$/i.test(answer.trim())
      ? { decision: "cancel" }
      : { decision: "approve" };
  }

  // confirm — an outward or destructive action. Default is NO.
  process.stderr.write(pc.yellow("! This action needs your approval:\n"));
  process.stderr.write(`${pause.prompt}\n`);
  if (pause.warning) process.stderr.write(pc.red(`  ${pause.warning}\n`));
  const answer = await ask(pc.dim("  allow? [y/N] "));
  return /^y(es)?$/i.test(answer.trim()) ? { decision: "approve" } : { decision: "cancel" };
}

// ---- the run loop -----------------------------------------------------------

interface RunOptions {
  model?: string;
  session?: string;
  json?: boolean;
  quiet?: boolean;
}

async function streamRun(
  client: Curvet,
  task: string,
  opts: RunOptions,
): Promise<{ runId?: string; failed: boolean }> {
  const renderer = new RunRenderer(opts.quiet === true);
  const controller = new AbortController();
  let runId: string | undefined;
  let failed = false;

  // Ctrl-C aborts the RUN, not just the process: closing the stream is what the
  // server reads as a disconnect. Without this the run keeps going server-side,
  // spending money nobody is watching.
  const onSigint = () => {
    process.stderr.write(pc.dim("\n  aborting run…\n"));
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  try {
    const stream = client.agency.run({
      task,
      modelId: opts.model,
      sessionId: opts.session,
      signal: controller.signal,
    });

    for await (const event of stream) {
      if (event.type === "run_id") runId = String(event.runId);
      if (event.type === "run_start" && event.runId) runId = String(event.runId);
      if (event.type === "error") failed = true;

      if (opts.json) {
        printJson(event);
      } else {
        renderer.handle(event);
      }

      const pause = pauseFromEvent(event);
      if (!pause) continue;

      if (!runId) {
        // Nothing to resume against. Better to say so than to hang until the
        // server's ten-minute timeout.
        process.stderr.write(warn("The run paused but sent no run id — cannot answer it.\n"));
        continue;
      }

      const answer = await answerPause(pause);
      if (!answer) continue;
      const res = await client.agency.resume(runId, { callId: pause.key, ...answer });
      // "published" means the server handed it to the run queue without learning
      // whether a waiter existed. Nothing is wrong; it is just not a delivery
      // receipt, and if the run has already moved on this is the only clue.
      if (res.delivery === "published" && !opts.quiet && !opts.json) {
        process.stderr.write(pc.dim("  sent\n"));
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      process.stderr.write(pc.dim("  run aborted.\n"));
      return { runId, failed: false };
    }
    throw err;
  } finally {
    process.off("SIGINT", onSigint);
  }

  if (!opts.json) renderer.finish();
  return { runId, failed };
}

// ---- command ----------------------------------------------------------------

async function profileFor(opts: { profile?: string }): Promise<ResolvedProfile> {
  const profile = await resolveProfile(opts.profile);
  requireCliToken(profile);
  return profile;
}

/** The 403 a token without `agency:run` gets deserves a real instruction. */
function explainScope(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (/agency:run/.test(message)) {
    throw new Error(
      "This machine is signed in, but its token cannot run agents.\n" +
        "  Re-authorise with:  curvet login --scope agency:run\n" +
        "  (It is not granted by default — it spends credits and can act on your behalf.)",
    );
  }
  if (/LEGAL_ACCEPTANCE_REQUIRED/.test(message)) {
    throw new Error(
      "Your account needs to accept the current Curvet terms before running agents.\n" +
        "  Open https://curvet.ai/legal/accept in a browser, then try again.",
    );
  }
  throw err;
}

export function agentCommand(): Command {
  const agent = new Command("agent")
    .description("run a Curvet agent and watch it work")
    .argument("[task...]", "what you want done")
    .option("-m, --model <id>", "orchestrator model id")
    .option("-s, --session <id>", "continue a previous session")
    .option("-q, --quiet", "only the agent's text — no tool timeline")
    .option("--json", "emit raw run events as JSONL, one per line")
    .option("-p, --profile <name>", "config profile")
    .addHelpText(
      "after",
      [
        "",
        "Needs the agency:run scope:  curvet login --scope agency:run",
        "",
        "Examples:",
        "  curvet agent 'summarise my unread email'",
        "  curvet agent 'draft a launch post' --model claude-sonnet-4-6",
        "  curvet agent 'weekly report' --json | jq -r 'select(.type==\"tool_call\").tool'",
        "  curvet agent --runs                 # recent runs",
        "  curvet agent --replay run_abc123    # what a finished run did",
        "",
        "The agent runs entirely on Curvet's servers. It has no access to this",
        "machine — no files, no shell — and no way to ask for any.",
      ].join("\n"),
    )
    .option("--runs", "list recent runs instead of starting one")
    .option("--replay <runId>", "replay a finished run from history")
    .action(async (taskParts: string[], opts) => {
      const profile = await profileFor(opts);
      const client = makeClient(profile);

      try {
        if (opts.runs) {
          const runs = await client.agency.list();
          if (opts.json) return printJson(runs);
          if (!runs.length) return console.log(warn("No agent runs yet."));
          console.log(
            table(
              ["run", "task", "status", "cost", "when"],
              runs.slice(0, 25).map((r) => [
                r.runId,
                (r.task ?? "").slice(0, 48),
                r.status ?? "",
                typeof r.costUsd === "number" ? `$${r.costUsd.toFixed(4)}` : "",
                r.createdAt ? new Date(r.createdAt).toLocaleString() : "",
              ]),
            ),
          );
          return;
        }

        if (opts.replay) {
          const run = await client.agency.retrieve(opts.replay);
          if (opts.json) return printJson(run);
          // The task is not printed here: the persisted run_start carries it, and
          // the renderer prints that — doing both showed it twice.
          const renderer = new RunRenderer(opts.quiet === true);
          for (const e of run.events ?? []) renderer.handle(e);
          renderer.finish();
          // Said plainly, because the absence is confusing otherwise: the replay
          // is missing the text, not the run.
          console.log(
            pc.dim("\n(replay — token-by-token text and cost updates are not persisted)"),
          );
          return;
        }

        const task = taskParts.join(" ").trim();
        if (!task) {
          throw new Error(
            "Tell the agent what to do:  curvet agent 'summarise my unread email'",
          );
        }

        const { failed } = await streamRun(client, task, opts);
        if (failed) process.exitCode = 1;
      } catch (err) {
        explainScope(err);
      }
    });

  return agent;
}
