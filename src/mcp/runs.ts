import { pauseFromEvent, type AgencyEvent, type AgencyDeliverable, type Curvet } from "@curvet/sdk";

/**
 * Live agency runs, held in this process.
 *
 * ### Why a registry rather than a blocking tool call
 *
 * An MCP tool call returns once; an agency run streams for minutes. The obvious
 * fix — return a runId and let the caller poll — does not work naively, because
 * `agency.run()` is a streaming generator and **abandoning the iterator aborts
 * the run server-side**: the server treats `req.on("close")` as a cancel, and
 * that is the documented way to stop one.
 *
 * So the stream has to stay consumed by *something*. This is that something:
 * `start()` returns as soon as the run has an id, and a detached loop keeps
 * draining events into a snapshot that `get_agent_run` reads. The MCP server is
 * a long-lived process in both transports, so there is somewhere for that loop
 * to live.
 *
 * ### Pauses
 *
 * A run can stop and wait for a person — a plan to approve, a question, a
 * destructive action to confirm. Over MCP there is nobody to ask: stdio is the
 * protocol, and the host's model is not a person (a model's yes is not consent).
 *
 * So a pause ends the run, records what it stopped on, and says to rerun it in
 * `curvet agent` where there is a terminal. That is non-negotiable #4 in
 * documentation/MCP_REVAMP_PLAN.md §4 — no channel, no approval, never an
 * assumed yes.
 */

export type RunStatus = "running" | "completed" | "paused" | "aborted" | "failed";

export interface RunSnapshot {
  runId: string;
  status: RunStatus;
  task: string;
  /** The agent's prose, accumulated from `agent_delta`. */
  text: string;
  /** The tool timeline — what it did, in order. Bounded; see MAX_TIMELINE. */
  timeline: string[];
  deliverables: AgencyDeliverable[];
  costUsd?: number;
  /** Set when status is "paused": what it stopped on, in the user's words. */
  stoppedOn?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

/** Enough to see what a run did, without re-sending a novel on every poll. */
const MAX_TIMELINE = 200;
/** The prose cap. Matches the CLI's tool-result cap for the same reason. */
const MAX_TEXT = 48_000;

/** A run whose id never arrived still needs a handle to report against. */
let fallbackSeq = 0;

export class RunRegistry {
  private runs = new Map<string, RunSnapshot>();
  private controllers = new Map<string, AbortController>();

  /**
   * Start a run and return as soon as it has an id.
   *
   * The id arrives in a header before the first event precisely so a caller can
   * refer to a run whose stream dies early, which is why this resolves on
   * `run_id` rather than on `run_start`.
   */
  async start(
    client: Curvet,
    params: { task: string; input?: string; modelId?: string; sessionId?: string; attachments?: { name: string; id?: string; content?: string }[] },
  ): Promise<RunSnapshot> {
    const controller = new AbortController();
    const iterator = client.agency.run({ ...params, signal: controller.signal });

    // A holder rather than a bare `let`: the executor runs synchronously, but
    // the compiler cannot see that and narrows the variable to `never`.
    const deferred: { settle?: (snap: RunSnapshot) => void } = {};
    const first = new Promise<RunSnapshot>((res) => {
      deferred.settle = res;
    });

    const snap: RunSnapshot = {
      runId: "",
      status: "running",
      task: params.task,
      text: "",
      timeline: [],
      deliverables: [],
      startedAt: Date.now(),
    };

    // Detached on purpose: the whole point is that this outlives the tool call
    // that started it. Every exit path settles `first`, so a run that dies
    // before it has an id is reported rather than hanging the caller.
    void (async () => {
      try {
        for await (const event of iterator) {
          if (!snap.runId && typeof event.runId === "string" && event.runId) {
            snap.runId = event.runId;
            this.runs.set(snap.runId, snap);
            this.controllers.set(snap.runId, controller);
            deferred.settle?.({ ...snap });
            deferred.settle = undefined;
          }

          const pause = pauseFromEvent(event);
          if (pause) {
            snap.status = "paused";
            snap.stoppedOn = `${pause.kind}: ${pause.prompt}`.slice(0, 2_000);
            snap.endedAt = Date.now();
            // Leaving the loop closes the stream, which aborts the run. That is
            // the intended cancel, and it is the correct answer to a question
            // nobody here can answer.
            controller.abort();
            break;
          }

          apply(snap, event);
        }
        if (snap.status === "running") {
          snap.status = "completed";
          snap.endedAt = Date.now();
        }
      } catch (err) {
        snap.status = snap.status === "paused" ? snap.status : "failed";
        snap.error = err instanceof Error ? err.message : String(err);
        snap.endedAt = Date.now();
      } finally {
        if (!snap.runId) {
          snap.runId = `local_${++fallbackSeq}`;
          this.runs.set(snap.runId, snap);
        }
        this.controllers.delete(snap.runId);
        // It may have ended before an id ever arrived — a 401, a refused scope,
        // a dead connection. The caller gets the finished snapshot, error and all.
        deferred.settle?.({ ...snap });
        deferred.settle = undefined;
      }
    })();

    return first;
  }

  get(runId: string): RunSnapshot | undefined {
    const snap = this.runs.get(runId);
    return snap ? { ...snap, timeline: [...snap.timeline], deliverables: [...snap.deliverables] } : undefined;
  }

  /** Stop a run that is still going. Returns false if it had already ended. */
  abort(runId: string): boolean {
    const controller = this.controllers.get(runId);
    const snap = this.runs.get(runId);
    if (!controller || !snap || snap.status !== "running") return false;
    snap.status = "aborted";
    snap.endedAt = Date.now();
    controller.abort();
    this.controllers.delete(runId);
    return true;
  }

  /** Every run this process has seen, newest first. */
  list(): RunSnapshot[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }
}

/** Fold one event into the snapshot. */
function apply(snap: RunSnapshot, event: AgencyEvent): void {
  switch (event.type) {
    case "agent_delta":
    case "text":
      if (typeof event.text === "string" && snap.text.length < MAX_TEXT) {
        snap.text += event.text;
      }
      break;
    case "tool_call":
      push(snap, `→ ${event.tool ?? "tool"}${event.summary ? `: ${event.summary}` : ""}`);
      break;
    case "tool_result":
      push(snap, `  ${event.ok === false ? "✗" : "✓"} ${event.tool ?? "tool"}${event.summary ? `: ${event.summary}` : ""}`);
      break;
    case "status":
      if (event.message) push(snap, String(event.message));
      break;
    case "deliverable":
      if (event.deliverable) snap.deliverables.push(event.deliverable);
      break;
    case "cost_update":
      if (typeof event.costUsd === "number") snap.costUsd = event.costUsd;
      break;
    case "error":
      snap.error = String(event.message ?? event.text ?? "The run reported an error.");
      break;
    case "run_end":
      snap.status = "completed";
      snap.endedAt = Date.now();
      if (typeof event.costUsd === "number") snap.costUsd = event.costUsd;
      break;
    default:
      break;
  }
}

function push(snap: RunSnapshot, line: string): void {
  // Drop the middle rather than the end: the last thing it did is the thing
  // being asked about, and the first thing is how it started. A run that loses
  // its tail to a cap reads as if it stopped early.
  if (snap.timeline.length >= MAX_TIMELINE) {
    snap.timeline.splice(MAX_TIMELINE / 2, 1, "… [timeline trimmed] …");
  }
  snap.timeline.push(line.slice(0, 500));
}
