import { describe, it, expect } from "vitest";
import { RunRegistry } from "../src/mcp/runs.js";
import type { AgencyEvent, Curvet } from "@curvet/sdk";

/**
 * The run registry, and the one behaviour that is not negotiable: a run that
 * stops to ask a person ENDS, because there is nobody here to ask.
 */

/** A fake agency that yields the given events, and records whether it was aborted. */
function fakeClient(events: AgencyEvent[], opts: { hang?: boolean } = {}) {
  const state = { aborted: false, drained: 0 };
  const client = {
    agency: {
      async *run(params: { signal?: AbortSignal }) {
        params.signal?.addEventListener("abort", () => {
          state.aborted = true;
        });
        for (const e of events) {
          state.drained += 1;
          yield e;
        }
        if (opts.hang) {
          // A run that keeps streaming after the events under test, so a break
          // in the consumer is observable as an abort.
          await new Promise((r) => setTimeout(r, 50));
        }
      },
      async retrieve() {
        return { runId: "x", status: "completed" };
      },
    },
  } as unknown as Curvet;
  return { client, state };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("RunRegistry", () => {
  it("returns as soon as the run has an id, before it finishes", async () => {
    const { client } = fakeClient([
      { type: "run_id", runId: "run_1" } as AgencyEvent,
      { type: "agent_delta", text: "hello" },
      { type: "run_end" },
    ]);
    const registry = new RunRegistry();
    const snap = await registry.start(client, { task: "t" });
    expect(snap.runId).toBe("run_1");
    expect(snap.status).toBe("running");
  });

  it("accumulates the answer and the tool timeline", async () => {
    const { client } = fakeClient([
      { type: "run_id", runId: "run_2" } as AgencyEvent,
      { type: "tool_call", tool: "web_search", summary: "curvet.in" },
      { type: "tool_result", tool: "web_search", ok: true, summary: "3 results" },
      { type: "agent_delta", text: "Here is " },
      { type: "agent_delta", text: "the answer." },
      { type: "cost_update", costUsd: 0.42 },
      { type: "run_end" },
    ]);
    const registry = new RunRegistry();
    await registry.start(client, { task: "t" });
    await settle();
    const snap = registry.get("run_2")!;
    expect(snap.status).toBe("completed");
    expect(snap.text).toBe("Here is the answer.");
    expect(snap.timeline).toEqual(["→ web_search: curvet.in", "  ✓ web_search: 3 results"]);
    expect(snap.costUsd).toBe(0.42);
  });

  it("ENDS a run that pauses, and says what it stopped on", async () => {
    // The core of §0.7: MCP has no channel to answer a plan approval on, and a
    // model's approval is not a person's. So it stops rather than assuming yes.
    const { client, state } = fakeClient(
      [
        { type: "run_id", runId: "run_3" } as AgencyEvent,
        { type: "confirm_action", callId: "c1", summary: "Send an email to the whole list" },
        { type: "agent_delta", text: "SHOULD NOT ARRIVE" },
      ],
      { hang: true },
    );
    const registry = new RunRegistry();
    await registry.start(client, { task: "t" });
    await settle();

    const snap = registry.get("run_3")!;
    expect(snap.status).toBe("paused");
    expect(snap.stoppedOn).toContain("Send an email to the whole list");
    expect(snap.text).not.toContain("SHOULD NOT ARRIVE");
    // Leaving the stream is what cancels the run server-side; if this stops
    // being true, a paused run pins a worker until it times out.
    expect(state.aborted).toBe(true);
  });

  it("reports a run that died before it ever had an id", async () => {
    const client = {
      agency: {
        // eslint-disable-next-line require-yield
        async *run() {
          throw new Error("This CLI token is missing the agency:run scope.");
        },
      },
    } as unknown as Curvet;
    const registry = new RunRegistry();
    const snap = await registry.start(client, { task: "t" });
    expect(snap.status).toBe("failed");
    expect(snap.error).toContain("agency:run");
    // It still gets a handle, so get_agent_run has something to answer with.
    expect(snap.runId).toMatch(/^local_/);
  });

  it("aborts a running run on request, and not one that already ended", async () => {
    const { client } = fakeClient(
      [{ type: "run_id", runId: "run_4" } as AgencyEvent, { type: "agent_delta", text: "..." }],
      { hang: true },
    );
    const registry = new RunRegistry();
    await registry.start(client, { task: "t" });
    expect(registry.abort("run_4")).toBe(true);
    expect(registry.get("run_4")!.status).toBe("aborted");
    expect(registry.abort("run_4")).toBe(false);
    expect(registry.abort("nope")).toBe(false);
  });

  it("hands back a copy, so a caller cannot edit the registry's state", async () => {
    const { client } = fakeClient([
      { type: "run_id", runId: "run_5" } as AgencyEvent,
      { type: "tool_call", tool: "a" },
      { type: "run_end" },
    ]);
    const registry = new RunRegistry();
    await registry.start(client, { task: "t" });
    await settle();
    registry.get("run_5")!.timeline.push("injected");
    expect(registry.get("run_5")!.timeline).toEqual(["→ a"]);
  });
});
