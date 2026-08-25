import { clientToolCallFromEvent, pauseFromEvent, type AgencyEvent, type Curvet } from "@curvet/sdk";
import { execute, isEffectTool, isWriteTool, SUPPORTED_TOOLS, type ToolContext } from "./tools.js";
import { classifyPath, needsBlanketConfirm } from "./permissions.js";
import { record as auditRecord } from "./audit.js";
import { saveBackup } from "./backup.js";
import type { FileDiff } from "./diff.js";

/**
 * A conversation with an agent, as state rather than as output.
 *
 * Nothing here prints. That is the whole point: the terminal UI is a renderer of
 * this state, and so is whatever comes after it. Phase 4 of CLI_AGENT_TUI.md
 * wants the same client behind a desktop app, which only stays cheap if the
 * engine, the tool executor and the permission layer never learned what a
 * terminal is.
 *
 * The consequence worth understanding is what happened to approvals. In the
 * one-shot command they are a question written to stderr and an answer read from
 * stdin. That cannot work inside a full-screen app, so here an approval is a
 * piece of STATE — the session parks, publishes what it is waiting for, and
 * resumes when someone calls `answer()`. The renderer decides how to ask.
 */

export type SessionStatus = "idle" | "thinking" | "awaiting-approval" | "aborting";

/**
 * One thing that happened, in the order it happened.
 *
 * A single ordered list rather than messages-here and tools-there, because that
 * is what a transcript IS: a tool call belongs at the point in the conversation
 * where the agent made it, not in a column beside it. Keeping them apart forces
 * a renderer to reconstruct an order it was never given.
 */
export type Entry =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; text: string }
  /**
   * Something the CLIENT is telling you — a slash command's answer. Deliberately
   * a separate kind: it is not the agent speaking, it must not look as though it
   * is, and it must never go up as conversation history.
   */
  | { kind: "note"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      title: string;
      /** Local calls touched this machine and are worth marking as such. */
      where: "server" | "local";
      status: "running" | "ok" | "failed";
      detail?: string;
      /** Present once a write is applied, so the diff stays in the transcript. */
      diff?: FileDiff;
      path?: string;
    };

/** Something the session is parked on, waiting for a person. */
export type Approval =
  | { kind: "write"; id: string; path: string; diff: FileDiff; creating: boolean }
  | { kind: "read"; id: string; title: string; detail: string }
  | { kind: "ask_user"; id: string; prompt: string; options?: string[] }
  | { kind: "plan"; id: string; prompt: string; steps?: { agent: string; task: string }[] }
  | { kind: "confirm"; id: string; prompt: string; warning?: string }
  /**
   * A command. Its own kind rather than a `confirm` with a longer prompt,
   * because the renderer has to show the argv verbatim, the reason it is loud,
   * and any path it was handed outside the project — and a prompt that has to
   * squeeze all of that into one string is a prompt nobody reads.
   */
  | {
      kind: "command";
      id: string;
      display: string;
      tier: "confirm" | "unknown" | "loud";
      warning?: string;
      outsidePaths: string[];
      why?: string;
      scriptBody?: string;
      cwd: string;
    };

export interface SessionState {
  entries: Entry[];
  /** The agent's reply as it arrives, before it becomes an entry. */
  streaming: string;
  status: SessionStatus;
  pending: Approval | null;
  statusLine: string;
  costUsd: number;
  turns: number;
  model: string | null;
  runId: string | null;
  error: string | null;
}

export interface SessionOptions {
  client: Curvet;
  /** Project root. The boundary every path check is measured against. */
  cwd: string;
  /** Whether this session may touch the machine at all. */
  toolsEnabled: boolean;
  /** Ask about reads that would otherwise pass silently. */
  confirmReads?: boolean;
  model?: string;
  /** Groups turns server-side. Generated per session when absent. */
  sessionId?: string;
}

const MAX_HISTORY_TURNS = 6; // the server bounds this anyway; matching it avoids sending what is dropped

export class AgentSession {
  private state: SessionState = {
    entries: [],
    streaming: "",
    status: "idle",
    pending: null,
    statusLine: "",
    costUsd: 0,
    turns: 0,
    model: null,
    runId: null,
    error: null,
  };

  private listeners = new Set<(s: SessionState) => void>();
  private controller: AbortController | null = null;
  /** Resolves the approval the session is currently parked on. */
  private resolveApproval: ((approved: boolean, note?: string) => void) | null = null;
  /** The client tool currently executing, so its diff can be attached to it. */
  private writingCallId: string | null = null;
  readonly sessionId: string;

  constructor(private opts: SessionOptions) {
    this.sessionId = opts.sessionId ?? `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.state.model = opts.model ?? null;
  }

  subscribe(fn: (s: SessionState) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot(): SessionState {
    // A copy, so a renderer comparing previous to next sees a different object.
    return { ...this.state, entries: [...this.state.entries] };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        /* a renderer that throws must not take the session with it */
      }
    }
  }

  private patch(next: Partial<SessionState>): void {
    Object.assign(this.state, next);
    this.emit();
  }

  /** Say something to the user in the transcript, from the client rather than the agent. */
  note(text: string): void {
    this.addEntry({ kind: "note", id: `n_${Date.now()}_${this.state.entries.length}`, text });
  }

  /** Start a fresh conversation. The window, the spend and the audit trail stay. */
  clear(): void {
    this.patch({ entries: [], streaming: "", error: null });
  }

  /** Switch the orchestrator model for subsequent turns. */
  setModel(model: string | undefined): void {
    this.opts.model = model;
    this.patch({ model: model ?? null });
  }

  /** Answer whatever the session is parked on. No-op when it is not parked. */
  answer(approved: boolean, note?: string): void {
    const resolve = this.resolveApproval;
    if (!resolve) return;
    this.resolveApproval = null;
    this.patch({ pending: null, status: "thinking" });
    resolve(approved, note);
  }

  /** Stop the current turn. The run is aborted server-side, not just locally. */
  abort(): void {
    if (this.resolveApproval) this.answer(false);
    this.patch({ status: "aborting" });
    this.controller?.abort();
  }

  private park(approval: Approval): Promise<{ approved: boolean; note?: string }> {
    return new Promise((resolve) => {
      this.resolveApproval = (approved, note) => resolve({ approved, note });
      this.patch({ pending: approval, status: "awaiting-approval" });
    });
  }

  /** Prior turns, for continuity. Server-side conversation persistence is off, so
   * the client carries it — bounded to what the server would keep anyway. */
  private history(): { role: "user" | "assistant"; content: string }[] {
    return this.state.entries
      .filter((e): e is Extract<Entry, { kind: "user" | "agent" }> => e.kind === "user" || e.kind === "agent")
      .slice(-MAX_HISTORY_TURNS * 2)
      .map((e) => ({ role: e.kind === "agent" ? ("assistant" as const) : ("user" as const), content: e.text }));
  }

  private toolContext(runId: string): ToolContext {
    return {
      cwd: this.opts.cwd,
      signal: this.controller?.signal,
      confirmCommand: async (ask) => {
        const { approved } = await this.park({
          kind: "command",
          id: `cmd_${Date.now()}`,
          display: ask.display,
          tier: ask.tier,
          warning: ask.warning,
          outsidePaths: ask.outsidePaths,
          why: ask.why,
          scriptBody: ask.scriptBody,
          cwd: ask.cwd,
        });
        return approved;
      },
      confirm: async (question, detail) => {
        const { approved } = await this.park({
          kind: "read",
          id: `c_${Date.now()}`,
          title: question,
          detail: detail ?? "",
        });
        return approved;
      },
      confirmWrite: async (path, diff, creating) => {
        const { approved } = await this.park({ kind: "write", id: `w_${Date.now()}`, path, diff, creating });
        // Kept on the tool entry so the diff stays where it happened in the
        // transcript, rather than only in whatever pane last showed it.
        if (approved && this.writingCallId) this.setTool(this.writingCallId, { diff, path });
        return approved;
      },
      backup: (abs, original, written) => saveBackup(runId, abs, original, written).then(() => undefined),
    };
  }

  private setTool(id: string, patch: Partial<Extract<Entry, { kind: "tool" }>>): void {
    this.patch({
      entries: this.state.entries.map((e) => (e.kind === "tool" && e.id === id ? { ...e, ...patch } : e)),
    });
  }

  /** Turn the prose streamed so far into an entry, if there is any. */
  private flushStreaming(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      this.patch({ streaming: "" });
      return;
    }
    this.patch({
      entries: [...this.state.entries, { kind: "agent", id: `a_${Date.now()}_${this.state.entries.length}`, text: trimmed }],
      streaming: "",
    });
  }

  private addEntry(entry: Entry): void {
    this.patch({ entries: [...this.state.entries, entry] });
  }

  /** The tool entry for a call id, if the transcript holds one. */
  private toolEntry(id: string): Extract<Entry, { kind: "tool" }> | undefined {
    return this.state.entries.find((e): e is Extract<Entry, { kind: "tool" }> => e.kind === "tool" && e.id === id);
  }

  /** Send a message and run a turn to completion. */
  async send(text: string): Promise<void> {
    const typed = text.trim();
    if (!typed || this.state.status !== "idle") return;

    this.controller = new AbortController();
    this.patch({
      // The TRANSCRIPT keeps what the user typed, `@src/foo.ts` and all. It is
      // what they wrote, it is short, and it is what history() will replay.
      entries: [...this.state.entries, { kind: "user", id: `u_${Date.now()}`, text: typed }],
      streaming: "",
      status: "thinking",
      error: null,
      statusLine: "",
      runId: null,
    });

    // Attachments ride in THIS turn's task and not in history, on purpose. A
    // file re-sent on every later turn costs quadratically over the rest of the
    // run, which is the same reasoning behind the tool-output caps — and the
    // model does not need it re-sent, because it now knows the exact path and
    // has read_file.
    let task = typed;
    let attachments: { id: string; name: string }[] = [];
    if (this.opts.toolsEnabled) {
      const { resolveMentions } = await import("./mentions.js");
      const { task: expanded, resolved, attachments: parked } = await resolveMentions(typed, {
        cwd: this.opts.cwd,
        confirm: async (question, detail) => {
          const { approved } = await this.park({ kind: "read", id: `m_${Date.now()}`, title: question, detail: detail ?? "" });
          return approved;
        },
        upload: async ({ name, bytes }) =>
          this.opts.client.agency.attach({ data: bytes, name, sessionId: this.sessionId }),
      });
      task = expanded;
      attachments = parked;
      for (const r of resolved) {
        this.addEntry({
          kind: "tool",
          id: `mention_${r.path}_${Date.now()}`,
          name: "attach",
          title: r.attached
            ? r.upload
              ? `Uploaded ${r.path}`
              : `Attached ${r.path}${r.truncated ? " (truncated)" : ""}`
            : `${r.path} — ${r.reason}`,
          where: "local",
          status: r.attached ? "ok" : "failed",
        });
      }
    }

    let runId: string | null = null;
    let reply = "";

    try {
      const stream = this.opts.client.agency.run({
        task,
        modelId: this.opts.model,
        sessionId: this.sessionId,
        attachments: attachments.length ? attachments : undefined,
        history: this.history().slice(0, -1), // everything before the message just added
        clientTools: this.opts.toolsEnabled ? SUPPORTED_TOOLS : undefined,
        signal: this.controller.signal,
      });

      for await (const event of stream) {
        if (event.type === "run_id" || (event.type === "run_start" && event.runId)) {
          runId = String(event.runId);
          this.patch({ runId });
        }

        switch (event.type) {
          case "agent_delta":
            if (event.text) {
              reply += String(event.text);
              this.patch({ streaming: reply });
            }
            break;

          case "status":
            if (event.message) this.patch({ statusLine: String(event.message) });
            break;

          case "tool_call":
            // The agent's text so far becomes an entry BEFORE the tool, so the
            // transcript reads in the order it happened rather than collecting
            // all the prose above all the calls.
            this.flushStreaming(reply);
            reply = "";
            this.addEntry({
              kind: "tool",
              id: String(event.callId ?? Math.random()),
              name: String(event.tool ?? "tool"),
              title: String(event.tool ?? "tool"),
              where: "server",
              status: "running",
            });
            break;

          case "tool_result":
            this.setTool(String(event.callId ?? ""), {
              status: event.ok === false ? "failed" : "ok",
              detail: event.summary ? String(event.summary) : undefined,
            });
            break;

          case "error":
            this.patch({ error: String(event.message ?? "run failed") });
            break;

          case "run_end":
            if (typeof event.costUsd === "number") {
              this.patch({ costUsd: this.state.costUsd + event.costUsd });
            }
            break;

          default:
            break;
        }

        const call = clientToolCallFromEvent(event);
        if (call && runId) {
          // A local call replaces the server-side placeholder for the same id:
          // the run emitted both, and showing it twice would misreport the work.
          if (this.toolEntry(call.toolCallId)) {
            this.setTool(call.toolCallId, { where: "local", title: call.title });
          } else {
            this.flushStreaming(reply);
            reply = "";
            this.addEntry({
              kind: "tool",
              id: call.toolCallId,
              name: call.name,
              title: call.title,
              where: "local",
              status: "running",
            });
          }
          this.writingCallId = call.toolCallId;
          await this.runLocal(runId, call.toolCallId, call.name, call.title, call.rawInput);
          continue;
        }

        const pause = pauseFromEvent(event);
        if (pause && runId) {
          const { approved, note } = await this.park(
            pause.kind === "ask_user"
              ? { kind: "ask_user", id: pause.key, prompt: pause.prompt, options: pause.options }
              : pause.kind === "plan"
                ? { kind: "plan", id: pause.key, prompt: pause.prompt, steps: pause.steps }
                : { kind: "confirm", id: pause.key, prompt: pause.prompt, warning: pause.warning },
          );
          await this.opts.client.agency.resume(runId, {
            callId: pause.key,
            decision: pause.kind === "ask_user" ? undefined : approved ? "approve" : "cancel",
            note: pause.kind === "ask_user" ? note : undefined,
          });
        }
      }
    } catch (err) {
      if (!this.controller?.signal.aborted) {
        this.patch({ error: err instanceof Error ? err.message : String(err) });
      }
    }

    this.flushStreaming(reply);
    this.patch({
      streaming: "",
      status: "idle",
      statusLine: "",
      turns: this.state.turns + 1,
    });
    this.controller = null;
  }

  /** Execute one client-side tool and post the result back. */
  private async runLocal(
    runId: string,
    callId: string,
    name: string,
    title: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    const ctx = this.toolContext(runId);
    let decision: "auto" | "confirmed" | "denied" | "declined" = "auto";

    if (this.opts.confirmReads && !isWriteTool(name)) {
      const verdict = await classifyPath(this.opts.cwd, String(input.path ?? "."));
      if (needsBlanketConfirm(verdict, true)) {
        const { approved } = await this.park({ kind: "read", id: callId, title, detail: this.opts.cwd });
        if (!approved) {
          await this.finishLocal(runId, callId, name, title, "declined", {
            ok: false,
            error: "The user declined this. Continue without it, or ask them for what you need.",
          });
          return;
        }
        decision = "confirmed";
      }
    }

    const outcome = await execute(ctx, name, input);
    if (!outcome.ok && /^Refused:/.test(outcome.error ?? "")) decision = "denied";
    else if (!outcome.ok && /declined/.test(outcome.error ?? "")) decision = "declined";
    else if (outcome.ok && isEffectTool(name)) decision = "confirmed";

    await this.finishLocal(runId, callId, name, title, decision, outcome);
  }

  private async finishLocal(
    runId: string,
    callId: string,
    name: string,
    title: string,
    decision: "auto" | "confirmed" | "denied" | "declined",
    outcome: { ok: boolean; content?: string; error?: string; truncated?: boolean },
  ): Promise<void> {
    this.setTool(callId, {
      status: outcome.ok ? "ok" : "failed",
      detail: outcome.ok ? undefined : (outcome.error ?? "").slice(0, 80),
    });
    await auditRecord({
      at: new Date().toISOString(),
      runId,
      callId,
      tool: name,
      title,
      decision,
      ok: outcome.ok,
      bytes: outcome.content?.length ?? 0,
      error: outcome.error,
      cwd: this.opts.cwd,
    });
    await this.opts.client.agency.toolResult(runId, {
      callId,
      ok: outcome.ok,
      content: outcome.content,
      error: outcome.error,
      truncated: outcome.truncated,
    });
  }
}
