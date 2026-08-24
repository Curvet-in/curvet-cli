import readline from "node:readline";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import {
  pauseFromEvent,
  clientToolCallFromEvent,
  type AgencyEvent,
  type AgencyPause,
  type ClientToolCall,
  type Curvet,
} from "@curvet/sdk";
import { SUPPORTED_TOOLS, execute, isWriteTool, type ToolContext } from "../agent/tools.js";
import { classifyPath, needsBlanketConfirm, findProjectRoot, refusalReason } from "../agent/permissions.js";
import type { FileDiff } from "../agent/diff.js";
import { saveBackup, undoRun, lastRunWithWrites } from "../agent/backup.js";
import { record as auditRecord, readRecent, auditPath } from "../agent/audit.js";
import { resolveProfile, type ResolvedProfile } from "../config.js";
import { makeClient, requireCliToken } from "../client.js";
import { fail, ok, printJson, printJsonLine, table, warn } from "../output.js";

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

/**
 * One palette, defined once.
 *
 * A run prints four different kinds of thing, and they are not equally
 * important. The first version coloured almost all of it `dim`, which made the
 * deliverable — the artifact you actually asked for — as faint as the run id.
 *
 *   agent     what the agent says.       UNSTYLED. The default foreground is the
 *             only colour guaranteed to be readable on a light terminal and a
 *             dark one, and this is the thing you are here to read.
 *   artifact  what the run produced.     BOLD, with a coloured glyph. Weight
 *             rather than hue, so it stands out on any theme.
 *   tool      what it is doing.          Coloured, not dimmed — a timeline is
 *             for scanning, and you scan for the tool name.
 *   chrome    ids, timings, cost.        Grey. Present, never competing.
 *
 * `gray` rather than `dim`: dim is a terminal ATTRIBUTE that many themes render
 * at very low contrast (and some ignore entirely), while gray is a real colour.
 * Nothing here nests a colour inside `dim` either — the reset from the inner
 * colour closes the dim span early, which is what washed out the ✓ and ✖.
 *
 * picocolors turns all of this off on its own when stdout is not a TTY, or when
 * NO_COLOR is set, so piped output stays clean.
 */
const ui = {
  chrome: (s: string) => pc.gray(s),
  agentName: (s: string) => pc.bold(pc.cyan(s)),
  tool: (s: string) => pc.cyan(s),
  args: (s: string) => pc.gray(s),
  ok: () => pc.green("✓"),
  bad: () => pc.red("✖"),
  artifact: (s: string) => pc.bold(s),
  artifactMark: () => pc.bold(pc.yellow("◆")),
  link: (s: string) => pc.underline(pc.cyan(s)),
  error: (s: string) => pc.bold(pc.red(s)),
  ask: (s: string) => pc.bold(pc.yellow(s)),
  local: (s: string) => pc.magenta(s),
  addLine: (s: string) => pc.green(s),
  delLine: (s: string) => pc.red(s),
  lineNo: (s: string) => pc.gray(s),
  alarm: (s: string) => pc.bold(pc.red(s)),
};

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
        if (!this.quiet) this.line(ui.chrome(`run ${String(e.runId)}`));
        break;

      case "run_start":
        if (!this.quiet && e.task) this.line(ui.chrome(`▸ ${String(e.task).slice(0, 200)}`));
        break;

      case "agent_start": {
        const name = String(e.agentName ?? e.agentId ?? "agent");
        // Only announce a change. A single-agent run should not repeat itself.
        if (name !== this.currentAgent) {
          this.currentAgent = name;
          if (!this.quiet) this.line(ui.agentName(`\n${name}`));
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
          this.line(
            `  ${ui.chrome(ICON.tool_call)} ${ui.tool(String(e.tool ?? "tool"))}${args ? ` ${ui.args(args)}` : ""}`,
          );
        }
        break;

      case "tool_result":
        if (!this.quiet) {
          const mark = e.ok === false ? ui.bad() : ui.ok();
          const summary = String(e.summary ?? "").trim();
          this.line(`  ${ui.chrome(ICON.tool_result)} ${mark}${summary ? ` ${ui.args(summary)}` : ""}`);
        }
        break;

      case "client_tool_call":
        if (!this.quiet) {
          // Marked apart from the server's own tools: this one touched THIS
          // machine, and that distinction is the whole point of the feature.
          this.line(`  ${ui.local("⌂")} ${ui.local(String(e.title ?? e.name ?? "local tool"))}`);
        }
        break;

      case "client_tool_result":
        // Only a NON-delivery is rendered here. An ordinary failure already
        // arrives as the server's own tool_result a moment later, and rendering
        // both printed every local failure twice. A non-delivery is different:
        // it means the run never heard back, which no tool_result can say.
        if (!this.quiet && e.delivered === false) {
          this.line(
            ui.error(`  ${ICON.tool_result} ✖ ${String(e.name ?? "local tool")} — the run never received a result (${String(e.reason ?? "unknown")})`),
          );
        }
        break;

      case "status":
        if (!this.quiet && e.message) this.line(ui.chrome(`  ${ICON.status} ${String(e.message)}`));
        break;

      case "deliverable":
        if (e.deliverable) {
          this.deliverables.push({
            title: String(e.deliverable.title ?? "untitled"),
            url: e.deliverable.url,
            kind: e.deliverable.kind,
          });
          this.line(`  ${ui.artifactMark()} ${ui.artifact(String(e.deliverable.title ?? "deliverable"))}`);
        }
        break;

      case "plan_resolved":
      case "confirm_resolved":
        // The prompt already printed the outcome; a second line is noise.
        break;

      case "error":
        this.line(ui.error(`✖ ${String(e.message ?? "run failed")}`));
        if (e.retryable) this.line(ui.chrome("  This looked transient — retrying may work."));
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
        if (bits.length) this.line(ui.chrome(`\n${bits.join(" · ")}`));
        break;
      }

      default:
        break;
    }
  }

  finish(): void {
    this.breakStream();
    if (this.deliverables.length) {
      const label = this.deliverables.length === 1 ? "deliverable" : "deliverables";
      this.write(ui.chrome(`\n${this.deliverables.length} ${label}:\n`));
      for (const d of this.deliverables) {
        // The URL is the whole point of this block — underlined and coloured so it
        // reads as a link and so terminals that linkify pick it up.
        this.write(`  ${ui.artifactMark()} ${ui.artifact(d.title)}\n`);
        if (d.url) this.write(`    ${ui.link(d.url)}\n`);
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
 *
 * The note is deliberately omitted in that case. `ask_user` reads the note as the
 * ANSWER and quotes it to the model — "The user answered: no interactive
 * terminal" — which attributes a sentence about this process to a person who was
 * never there, and the model then acts on it. A refusal has no answer in it; the
 * decision alone says everything true.
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
    return { decision: "cancel" };
  }

  if (pause.kind === "ask_user") {
    process.stderr.write(ui.ask(`? ${pause.prompt}\n`));
    if (pause.options?.length) {
      process.stderr.write(ui.chrome(`  options: ${pause.options.join("  ·  ")}\n`));
    }
    const answer = await ask(ui.chrome("  your answer: "));
    // An empty answer is a real choice — the tool treats "no answer" as "proceed
    // on your best assumption and say so", which is often what you want.
    return { note: answer.trim() };
  }

  if (pause.kind === "plan") {
    process.stderr.write(ui.ask("? The agent proposed a plan:\n"));
    process.stderr.write(`${pause.prompt}\n`);
    for (const s of pause.steps ?? []) {
      process.stderr.write(ui.chrome(`  · ${s.agent}: ${s.task}\n`));
    }
    const answer = await ask(ui.chrome("  approve? [Y/n] "));
    return /^n(o)?$/i.test(answer.trim())
      ? { decision: "cancel" }
      : { decision: "approve" };
  }

  // confirm — an outward or destructive action. Default is NO.
  process.stderr.write(ui.alarm("! This action needs your approval:\n"));
  process.stderr.write(`${pause.prompt}\n`);
  if (pause.warning) process.stderr.write(ui.error(`  ${pause.warning}\n`));
  const answer = await ask(ui.chrome("  allow? [y/N] "));
  return /^y(es)?$/i.test(answer.trim()) ? { decision: "approve" } : { decision: "cancel" };
}

/**
 * Show a diff and ask whether to apply it.
 *
 * The whole file is not printed — only what changes, with three lines either
 * side. A prompt long enough to scroll is a prompt that gets approved unread,
 * which is the failure this exists to prevent.
 */
async function confirmWrite(target: string, diff: FileDiff, creating: boolean): Promise<boolean> {
  const w = (t: string) => process.stderr.write(t);

  w("\n");
  w(ui.ask(`! ${creating ? "Create" : "Change"} ${target}`));
  w(ui.chrome(`  +${diff.added} −${diff.removed}\n`));
  if (diff.coarse) {
    w(ui.chrome("  (too large to align line by line — shown as a wholesale replacement)\n"));
  }

  const MAX = 120;
  let printed = 0;
  for (const hunk of diff.hunks) {
    if (printed >= MAX) break;
    w(ui.chrome("  ┄\n"));
    for (const line of hunk.lines) {
      if (printed++ >= MAX) break;
      const no = String(line.kind === "add" ? line.newNo ?? "" : line.oldNo ?? "").padStart(5);
      const body = line.text.length > 200 ? `${line.text.slice(0, 200)}…` : line.text;
      if (line.kind === "add") w(`${ui.lineNo(no)} ${ui.addLine(`+ ${body}`)}\n`);
      else if (line.kind === "del") w(`${ui.lineNo(no)} ${ui.delLine(`- ${body}`)}\n`);
      else w(`${ui.lineNo(no)} ${ui.chrome(`  ${body}`)}\n`);
    }
  }
  const total = diff.hunks.reduce((n, h) => n + h.lines.length, 0);
  if (total > MAX) w(ui.chrome(`  ┄ … ${total - MAX} more lines not shown\n`));

  if (!process.stdin.isTTY) {
    // The rule the whole client follows: nobody there is not a yes. It matters
    // most here, where saying yes changes their files.
    w(warn("  No terminal to ask — refusing to write.\n"));
    return false;
  }
  const answer = await ask(ui.chrome("  apply? [y/N] "));
  return /^y(es)?$/i.test(answer.trim());
}

// ---- the run loop -----------------------------------------------------------

interface RunOptions {
  model?: string;
  session?: string;
  json?: boolean;
  quiet?: boolean;
  /** Let the agent read files in this directory. Off unless asked for. */
  tools?: boolean;
  /** Confirm every local read, not just the ones that leave the project. */
  confirmReads?: boolean;
}

/**
 * Run one tool the agent asked for on this machine, and report what happened.
 *
 * Three rules, in this order, and none of them can be relaxed from the server:
 *
 *   1. A secret is refused before the file is opened, by path. Not filtered
 *      afterwards — by then it has been read.
 *   2. Anything outside the working directory is confirmed by a person, every
 *      time. Never remembered, because "allow always" for a path the model
 *      chooses is not a decision the user can meaningfully make in advance.
 *   3. With no terminal, a confirmation is a REFUSAL. A piped `curvet agent`
 *      must not read outside its project because nobody was there to object.
 *
 * Always answers. A refusal posted back is a fact the model can work with; a
 * silence just costs the run its timeout and teaches it nothing.
 */
async function runLocalTool(
  client: Curvet,
  runId: string,
  call: ClientToolCall,
  opts: RunOptions,
  root: string,
): Promise<void> {
  // The project root, not process.cwd(): running the agent from `src/` should not
  // make `../package.json` an outside-the-project read requiring confirmation.
  const cwd = root;
  let decision: "auto" | "confirmed" | "denied" | "declined" = "auto";

  const ctx: ToolContext = {
    cwd,
    confirmWrite,
    // Throws on failure by design, and the executor lets it propagate: a write
    // whose backup failed is a write that cannot be undone.
    backup: (abs, original, written) => saveBackup(runId, abs, original, written).then(() => undefined),
    confirm: async (question, detail) => {
      if (!process.stdin.isTTY) {
        process.stderr.write(
          warn(`${question}\n${detail ?? ""}\n  No terminal to ask — refusing.\n`),
        );
        return false;
      }
      process.stderr.write(`\n${ui.ask(`! ${question}`)}\n`);
      if (detail) process.stderr.write(ui.chrome(`${detail}\n`));
      const answer = await ask(ui.chrome("  allow? [y/N] "));
      return /^y(es)?$/i.test(answer.trim());
    },
  };

  // --confirm-reads gates everything, including reads inside the project. Off by
  // default: the agent was pointed at this directory deliberately, and a prompt
  // per file is a prompt people learn to hit `y` on without reading. On for
  // anyone who would rather see each one.
  if (opts.confirmReads) {
    const target = String((call.rawInput as { path?: unknown }).path ?? ".");
    const verdict = await classifyPath(cwd, target);
    if (needsBlanketConfirm(verdict, true)) {
      const allowed = await ctx.confirm(call.title, `  in ${cwd}`);
      if (!allowed) {
        await auditRecord({
          at: new Date().toISOString(), runId, callId: call.toolCallId, tool: call.name,
          title: call.title, decision: "declined", ok: false, bytes: 0, cwd,
        });
        await client.agency.toolResult(runId, {
          callId: call.toolCallId,
          ok: false,
          error: "The user declined this read. Continue without it, or ask them for what you need.",
        });
        return;
      }
      decision = "confirmed";
    }
  }

  const outcome = await execute(ctx, call.name, call.rawInput);
  if (!outcome.ok && /^Refused:/.test(outcome.error ?? "")) decision = "denied";
  else if (!outcome.ok && /declined/.test(outcome.error ?? "")) decision = "declined";
  // A write cannot succeed without someone approving the diff — the executor
  // refuses outright when there is no way to ask. Recording one as "auto" would
  // understate it in the one direction that matters when someone later asks
  // whether a change was approved.
  else if (outcome.ok && isWriteTool(call.name)) decision = "confirmed";

  // The user should see a refusal happen, in their own terminal, in their own
  // words — not infer it from the model's paraphrase a few seconds later.
  if (decision === "denied" && !opts.json) {
    process.stderr.write(ui.error(`  ⌂ refused — ${refusalReason(outcome.error)}\n`));
  }

  await auditRecord({
    at: new Date().toISOString(),
    runId,
    callId: call.toolCallId,
    tool: call.name,
    title: call.title,
    decision,
    ok: outcome.ok,
    bytes: outcome.content?.length ?? 0,
    error: outcome.error,
    cwd,
  });

  await client.agency.toolResult(runId, {
    callId: call.toolCallId,
    ok: outcome.ok,
    content: outcome.content,
    error: outcome.error,
    truncated: outcome.truncated,
  });
}

/**
 * Run one slash command, returning what to show in the transcript.
 *
 * Anything that reports SERVER state asks the server rather than printing what
 * the client assumed when it started: the two drift, and the client's copy is
 * the one that is wrong. `null` means the command handled itself and there is
 * nothing to say.
 */
async function runSlashCommand(o: {
  name: string;
  arg: string;
  session: import("../agent/session.js").AgentSession;
  client: Curvet;
  cwd: string;
  access: { enabled: boolean; root: string; why: string };
}): Promise<string | null> {
  const { name, arg, session, client, cwd, access } = o;

  if (name === "clear") {
    session.clear();
    return null;
  }

  if (name === "model") {
    if (!arg) {
      const s = session.snapshot();
      return s.model ? `model: ${s.model}` : "model: whichever the server picks (auto)";
    }
    session.setModel(arg);
    return `model: ${arg} — from the next turn on`;
  }

  if (name === "cost") {
    const s = session.snapshot();
    return s.costUsd > 0
      ? `$${s.costUsd.toFixed(4)} across ${s.turns} turn${s.turns === 1 ? "" : "s"}`
      : "nothing spent yet";
  }

  if (name === "tools") {
    if (!access.enabled) return `no file access — ${access.why}`;
    return [
      `reading and editing ${access.root}`,
      "  read_file, list_dir, grep, write_file, edit_file — every change shown as a diff first",
      "  secrets are refused before opening; writes outside the project are refused",
    ].join("\n");
  }

  if (name === "status") {
    try {
      const s = (await client.agency.status()) as Record<string, unknown>;
      return [
        `orchestrator: ${s.orchestratorModel}`,
        `agents: ${s.agents}`,
        `memory: ${s.persistentMemory ? "on" : "off"} · connectors: ${s.connectors ? "on" : "off"}`,
        `plan approval: ${s.planApproval ? "on" : "off"} · scheduling: ${s.scheduling ? "on" : "off"}`,
      ].join("\n");
    } catch (err) {
      return `could not reach the server: ${(err as Error).message}`;
    }
  }

  if (name === "runs") {
    try {
      const runs = await client.agency.list();
      if (!runs.length) return "no runs yet";
      return runs
        .slice(0, 8)
        .map((r) => `${r.runId}  ${(r.task ?? "").slice(0, 46)}`)
        .join("\n");
    } catch (err) {
      return `could not list runs: ${(err as Error).message}`;
    }
  }

  if (name === "log") {
    const entries = await readRecent(12);
    if (!entries.length) return "nothing read or written on this machine yet";
    return entries
      .map((e) => `${e.ok ? "✓" : "✖"} ${e.tool.padEnd(11)} ${e.title.slice(0, 40)}  ${e.decision}`)
      .join("\n");
  }

  if (name === "undo") {
    const runId = arg || (await lastRunWithWrites());
    if (!runId) return "nothing to undo — no files have been changed";
    const result = await undoRun(runId);
    const parts = [
      ...result.restored.map((f) => `restored ${path.relative(cwd, f) || f}`),
      ...result.deleted.map((f) => `removed ${path.relative(cwd, f) || f}`),
      ...result.failed.map((f) => `could not undo ${f.file} — ${f.why}`),
      ...result.changedSince.map((f) => `note: ${path.relative(cwd, f) || f} had been edited since`),
    ];
    return parts.length ? parts.join("\n") : `run ${runId} did not write anything`;
  }

  return `/${name} is not wired up yet.`;
}

/**
 * Decide whether the agent may read from this machine, and where its boundary is.
 *
 * ON by default inside a project, OFF outside one. Not a compromise between
 * convenience and safety — it is the condition the permission layer was written
 * for. Its denylist recognises conventional names (`.env`, `*.pem`, `.ssh/`),
 * which is close to exhaustive inside a project and nowhere near it in a home
 * directory, where `~/notes/passwords.txt` matches nothing.
 *
 * The boundary is the project ROOT rather than the working directory, so running
 * from `src/` can still read `../package.json` without asking. Running from the
 * root reads everything under it, which is what someone pointing an agent at a
 * repository means.
 */
async function resolveToolAccess(opts: RunOptions): Promise<{ enabled: boolean; root: string; why: string }> {
  const cwd = process.cwd();
  const root = await findProjectRoot(cwd);

  if (opts.tools === false) return { enabled: false, root: cwd, why: "file access off (--no-tools)" };
  if (opts.tools === true) {
    return { enabled: true, root: root ?? cwd, why: root ? `project ${root}` : `${cwd} (not a project — forced with --tools)` };
  }
  if (root) return { enabled: true, root, why: `project ${root}` };
  return {
    enabled: false,
    root: cwd,
    why: `${cwd} is not inside a project, so file access is off. Use --tools to allow it here anyway.`,
  };
}

async function streamRun(
  client: Curvet,
  task: string,
  opts: RunOptions,
): Promise<{ runId?: string; failed: boolean }> {
  const renderer = new RunRenderer(opts.quiet === true);
  const access = await resolveToolAccess(opts);
  if (!opts.json && !opts.quiet) {
    // Always said out loud. Whether the agent can read this machine is the single
    // most consequential thing about a run, and it must never have to be inferred
    // from whether a tool call happens to appear later.
    process.stderr.write(
      access.enabled
        ? ui.chrome(`reading ${access.why} · --no-tools to disable\n`)
        : ui.chrome(`${access.why}\n`),
    );
  }
  const controller = new AbortController();
  let runId: string | undefined;
  let failed = false;

  // Ctrl-C aborts the RUN, not just the process: closing the stream is what the
  // server reads as a disconnect. Without this the run keeps going server-side,
  // spending money nobody is watching.
  const onSigint = () => {
    process.stderr.write(ui.chrome("\n  aborting run…\n"));
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  try {
    const stream = client.agency.run({
      task,
      modelId: opts.model,
      sessionId: opts.session,
      // Declaring a tool is a promise to execute it, so only when this client
      // will actually answer — see resolveToolAccess.
      clientTools: access.enabled ? SUPPORTED_TOOLS : undefined,
      signal: controller.signal,
    });

    for await (const event of stream) {
      if (event.type === "run_id") runId = String(event.runId);
      if (event.type === "run_start" && event.runId) runId = String(event.runId);
      if (event.type === "error") failed = true;

      if (opts.json) {
        // One line per event — see printJsonLine. This is the CI-facing
        // surface, and it is consumed a line at a time.
        printJsonLine(event);
      } else {
        renderer.handle(event);
      }

      const call = clientToolCallFromEvent(event);
      if (call) {
        if (!runId) {
          process.stderr.write(warn("A local tool was requested but no run id arrived — cannot answer it.\n"));
          continue;
        }
        // Awaited, not fired: the run is suspended on this call, and answering
        // out of order would let a later call overtake an earlier one.
        await runLocalTool(client, runId, call, opts, access.root);
        continue;
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
        process.stderr.write(ui.chrome("  sent\n"));
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      process.stderr.write(ui.chrome("  run aborted.\n"));
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
    .argument("[task...]", "what you want done; omit it for an interactive session")
    .option("-m, --model <id>", "orchestrator model id")
    .option("-s, --session <id>", "continue a previous session")
    .option("-q, --quiet", "only the agent's text — no tool timeline")
    .option("--json", "emit raw run events as JSONL, one per line")
    .option("-p, --profile <name>", "config profile")
    .option("-t, --tools", "read files even when this is not a recognised project")
    .option("--no-tools", "keep the agent off this machine entirely")
    .option("--confirm-reads", "ask before every read, not only ones outside the project")
    .addHelpText(
      "after",
      [
        "",
        "Needs the agency:run scope:  curvet login --scope agency:run",
        "",
        "Examples:",
        "  curvet agent                        # full-screen session, multi-turn",
        "  curvet agent 'summarise my unread email'",
        "  curvet agent 'draft a launch post' --model claude-sonnet-4-6",
        "  curvet agent 'weekly report' --json | jq -r 'select(.type==\"tool_call\").tool'",
        "  curvet agent --runs                 # recent runs",
        "  curvet agent --replay run_abc123    # what a finished run did",
        "",
        "Inside a project the agent can read it and change it — files, folders,",
        "search, and writes you approve as a diff first. It cannot delete or run",
        "anything; those tools do not exist here.",
        "",
        "Outside a project it gets no access at all, because the rules that keep",
        "reads safe assume a project: .env and keys live in known places there,",
        "and in a home directory they do not. --tools overrides that.",
        "",
        "Secrets are refused before the file is opened; reads outside the project",
        "ask you first and writes outside it are refused outright. --no-tools",
        "turns it all off, `curvet agent --log` shows what it touched, and",
        "`curvet agent --undo` puts changed files back.",
      ].join("\n"),
    )
    .option("--runs", "list recent runs instead of starting one")
    .option("--log", "show what the agent has read and written on this machine")
    .option("--undo [runId]", "put back the files the agent changed (defaults to the last run that wrote any)")
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

        if (opts.undo !== undefined) {
          const runId = typeof opts.undo === "string" ? opts.undo : await lastRunWithWrites();
          if (!runId) return console.log(warn("The agent has not written anything on this machine."));
          const result = await undoRun(runId);
          if (opts.json) return printJson({ runId, ...result });

          for (const f of result.restored) console.log(ok(`restored ${f}`));
          for (const f of result.deleted) console.log(ok(`removed ${f}`));
          for (const f of result.failed) console.log(fail(`${f.file} — ${f.why}`));
          // Said out loud rather than skipped: the user asked to undo, so their
          // own later edit is still overwritten — but they must know it happened.
          for (const f of result.changedSince) {
            console.log(warn(`${f} had been edited since the agent wrote it — restored anyway`));
          }
          if (!result.restored.length && !result.deleted.length && !result.failed.length) {
            console.log(warn(`Run ${runId} did not write anything.`));
          }
          return;
        }

        if (opts.log) {
          const entries = await readRecent(Number(opts.limit) || 50);
          if (opts.json) return printJson(entries);
          if (!entries.length) {
            return console.log(warn(`Nothing recorded yet. ${auditPath()}`));
          }
          console.log(
            table(
              ["when", "tool", "what", "decision", "bytes"],
              entries.map((e) => [
                new Date(e.at).toLocaleString(),
                e.tool,
                e.title.slice(0, 44),
                e.ok ? e.decision : `${e.decision} ✖`,
                e.bytes ? String(e.bytes) : "",
              ]),
            ),
          );
          console.log(ui.chrome(`\n${auditPath()}`));
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
            ui.chrome("\n(replay — token-by-token text and cost updates are not persisted)"),
          );
          return;
        }

        const task = taskParts.join(" ").trim();

        // No task means a SESSION: the full-screen, multi-turn shape. A task on
        // the command line stays one-shot and inline, because that is what pipes
        // and CI use and it should not open a UI.
        if (!task) {
          if (!process.stdin.isTTY) {
            throw new Error(
              "Tell the agent what to do:  curvet agent 'summarise my unread email'\n" +
                "  (an interactive session needs a terminal)",
            );
          }
          const access = await resolveToolAccess(opts);
          const { AgentSession } = await import("../agent/session.js");
          const { runTui } = await import("../agent/tui/index.js");
          const { repoStatus } = await import("../git.js");
          const session = new AgentSession({
            client,
            cwd: access.root,
            toolsEnabled: access.enabled,
            confirmReads: opts.confirmReads === true,
            model: opts.model,
            sessionId: opts.session,
          });
          await runTui({
            session,
            cwd: access.root,
            toolsEnabled: access.enabled,
            model: opts.model ?? "auto",
            git: await repoStatus(access.root),
            onCommand: (name, arg) =>
              runSlashCommand({ name, arg, session, client, cwd: access.root, access }),
          });
          return;
        }

        const { failed } = await streamRun(client, task, opts);
        if (failed) process.exitCode = 1;
      } catch (err) {
        explainScope(err);
      }
    });

  return agent;
}
