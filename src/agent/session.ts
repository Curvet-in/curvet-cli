import { clientToolCallFromEvent, pauseFromEvent, type AgencyEvent, type Curvet } from "@curvet/sdk";
import { execute, SUPPORTED_TOOLS, type ToolContext } from "./tools.js";
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

export interface TurnMessage {
  role: "user" | "agent";
  text: string;
  /** Set once the turn finishes, so a renderer can show cost per exchange. */
  costUsd?: number;
  runId?: string;
}

export interface ToolRecord {
  id: string;
  name: string;
  title: string;
  /** Where it ran. Local calls touched this machine and should look different. */
  where: "server" | "local";
  status: "running" | "ok" | "failed";
  detail?: string;
}

/** Something the session is parked on, waiting for a person. */
export type Approval =
  | { kind: "write"; id: string; path: string; diff: FileDiff; creating: boolean }
  | { kind: "read"; id: string; title: string; detail: string }
  | { kind: "ask_user"; id: string; prompt: string; options?: string[] }
  | { kind: "plan"; id: string; prompt: string; steps?: { agent: string; task: string }[] }
  | { kind: "confirm"; id: string; prompt: string; warning?: string };

export interface SessionState {
  messages: TurnMessage[];
  /** The agent's reply as it arrives, before it becomes a message. */
  streaming: string;
  tools: ToolRecord[];
  status: SessionStatus;
  pending: Approval | null;
  /** Most recent diff, so a pane can keep showing it after the prompt closes. */
  lastDiff: { path: string; diff: FileDiff } | null;
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
    messages: [],
    streaming: "",
    tools: [],
    status: "idle",
    pending: null,
    lastDiff: null,
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
    return { ...this.state, messages: [...this.state.messages], tools: [...this.state.tools] };
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
    return this.state.messages
      .slice(-MAX_HISTORY_TURNS * 2)
      .map((m) => ({ role: m.role === "agent" ? ("assistant" as const) : ("user" as const), content: m.text }));
  }

  private toolContext(runId: string): ToolContext {
    return {
      cwd: this.opts.cwd,
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
        this.patch({ lastDiff: { path, diff } });
        const { approved } = await this.park({ kind: "write", id: `w_${Date.now()}`, path, diff, creating });
        return approved;
      },
      backup: (abs, original, written) => saveBackup(runId, abs, original, written).then(() => undefined),
    };
  }

  private setTool(id: string, patch: Partial<ToolRecord>): void {
    const tools = this.state.tools.map((t) => (t.id === id ? { ...t, ...patch } : t));
    this.patch({ tools });
  }

  /** Send a message and run a turn to completion. */
  async send(text: string): Promise<void> {
    const task = text.trim();
    if (!task || this.state.status !== "idle") return;

    this.controller = new AbortController();
    this.patch({
      messages: [...this.state.messages, { role: "user", text: task }],
      streaming: "",
      status: "thinking",
      error: null,
      statusLine: "",
      runId: null,
    });

    let runId: string | null = null;
    let reply = "";

    try {
      const stream = this.opts.client.agency.run({
        task,
        modelId: this.opts.model,
        sessionId: this.sessionId,
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
            this.patch({
              tools: [
                ...this.state.tools,
                {
                  id: String(event.callId ?? Math.random()),
                  name: String(event.tool ?? "tool"),
                  title: String(event.tool ?? "tool"),
                  where: "server",
                  status: "running",
                },
              ],
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
          const existing = this.state.tools.find((t) => t.id === call.toolCallId);
          if (existing) this.setTool(call.toolCallId, { where: "local", title: call.title });
          else {
            this.patch({
              tools: [
                ...this.state.tools,
                { id: call.toolCallId, name: call.name, title: call.title, where: "local", status: "running" },
              ],
            });
          }
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

    this.patch({
      messages: [
        ...this.state.messages,
        ...(reply.trim() ? [{ role: "agent" as const, text: reply.trim(), runId: runId ?? undefined }] : []),
      ],
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

    if (this.opts.confirmReads && name !== "write_file") {
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
    else if (outcome.ok && name === "write_file") decision = "confirmed";

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
