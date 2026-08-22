import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/agent/session.js";
import type { AgencyEvent } from "@curvet/sdk";

/**
 * The session engine.
 *
 * It never prints, and that is the point being tested as much as the behaviour:
 * a renderer subscribes to state, and the interesting consequence is that an
 * APPROVAL is state too. In the one-shot command an approval is a question on
 * stderr and an answer from stdin, which cannot work inside a full-screen app —
 * so here the session parks, publishes what it is waiting for, and resumes when
 * someone answers.
 */

/** A client whose run() yields the given events, recording what was sent back. */
function fakeClient(events: AgencyEvent[]) {
  const sent: { resume: unknown[]; toolResult: unknown[] } = { resume: [], toolResult: [] };
  return {
    sent,
    client: {
      agency: {
        run: () =>
          (async function* () {
            for (const e of events) yield e;
          })(),
        resume: async (_id: string, p: unknown) => {
          sent.resume.push(p);
          return { ok: true };
        },
        toolResult: async (_id: string, p: unknown) => {
          sent.toolResult.push(p);
          return { ok: true };
        },
      },
    } as never,
  };
}

const make = (events: AgencyEvent[], toolsEnabled = false) => {
  const { client, sent } = fakeClient(events);
  return { sent, session: new AgentSession({ client, cwd: process.cwd(), toolsEnabled }) };
};

describe("a turn", () => {
  it("records the exchange and clears the streaming buffer", async () => {
    const { session } = make([
      { type: "run_id", runId: "run_1" },
      { type: "agent_delta", text: "Hello " },
      { type: "agent_delta", text: "there" },
      { type: "run_end", costUsd: 0.02 },
    ]);
    await session.send("hi");
    const s = session.snapshot();
    expect(s.entries.map((e) => [e.kind, "text" in e ? e.text : ""])).toEqual([
      ["user", "hi"],
      ["agent", "Hello there"],
    ]);
    expect(s.streaming).toBe("");
    expect(s.status).toBe("idle");
    expect(s.costUsd).toBeCloseTo(0.02);
    expect(s.turns).toBe(1);
  });

  it("publishes each change to subscribers, so a renderer never polls", async () => {
    const { session } = make([{ type: "agent_delta", text: "x" }, { type: "run_end" }]);
    const seen: string[] = [];
    session.subscribe((s) => seen.push(s.status));
    await session.send("hi");
    expect(seen[0]).toBe("idle"); // published immediately on subscribe
    expect(seen).toContain("thinking");
    expect(seen[seen.length - 1]).toBe("idle");
  });

  it("ignores a message sent while a turn is already running", async () => {
    const { session } = make([{ type: "run_end" }]);
    const first = session.send("one");
    await session.send("two"); // must be dropped, not queued into the same turn
    await first;
    expect(session.snapshot().entries.filter((e) => e.kind === "user")).toHaveLength(1);
  });

  it("carries prior turns as history, so a follow-up can say 'that one'", async () => {
    // Server-side conversation persistence is off, so continuity is the client's
    // job. Without this, every turn starts from nothing.
    const { client } = fakeClient([{ type: "run_end" }]);
    const runSpy = vi.fn((_p?: unknown) => (async function* () { yield { type: "run_end" } as AgencyEvent; })());
    (client as never as { agency: { run: unknown } }).agency.run = runSpy;
    const session = new AgentSession({ client, cwd: process.cwd(), toolsEnabled: false });
    await session.send("first");
    await session.send("second");
    const second = runSpy.mock.calls[1]?.[0] as unknown as { history: unknown[] };
    expect(second.history.length).toBeGreaterThan(0);
  });

  it("surfaces a run error without losing the turn", async () => {
    const { session } = make([{ type: "error", message: "queue unavailable" }, { type: "run_end" }]);
    await session.send("hi");
    expect(session.snapshot().error).toBe("queue unavailable");
    expect(session.snapshot().status).toBe("idle");
  });
});

describe("approvals are state", () => {
  it("parks on a question and resumes with the answer", async () => {
    const { session, sent } = make([
      { type: "run_id", runId: "run_1" },
      { type: "human_input", nodeId: "node-7", prompt: "Which repo?" },
      { type: "run_end" },
    ]);

    const turn = session.send("go");
    await vi.waitFor(() => expect(session.snapshot().status).toBe("awaiting-approval"));

    const pending = session.snapshot().pending!;
    expect(pending.kind).toBe("ask_user");
    expect(pending.id).toBe("node-7"); // ask_user resumes on nodeId, not callId
    session.answer(true, "the api one");
    await turn;

    expect(sent.resume).toEqual([{ callId: "node-7", decision: undefined, note: "the api one" }]);
    expect(session.snapshot().pending).toBeNull();
  });

  it("declining a destructive action cancels it", async () => {
    const { session, sent } = make([
      { type: "run_id", runId: "run_1" },
      { type: "confirm_action", callId: "c1", summary: "Send email", prompt: "Approve?" },
      { type: "run_end" },
    ]);
    const turn = session.send("go");
    await vi.waitFor(() => expect(session.snapshot().pending?.kind).toBe("confirm"));
    session.answer(false);
    await turn;
    expect((sent.resume[0] as { decision: string }).decision).toBe("cancel");
  });

  it("answering when nothing is parked does nothing", () => {
    const { session } = make([]);
    expect(() => session.answer(true)).not.toThrow();
  });

  it("aborting while parked declines rather than leaving the run hanging", async () => {
    const { session } = make([
      { type: "run_id", runId: "run_1" },
      { type: "plan_proposed", callId: "c1", plan: "do things" },
      { type: "run_end" },
    ]);
    const turn = session.send("go");
    await vi.waitFor(() => expect(session.snapshot().pending).not.toBeNull());
    session.abort();
    await turn;
    expect(session.snapshot().pending).toBeNull();
  });
});

describe("the transcript", () => {
  it("keeps tools in the order they happened, between the prose", async () => {
    // A tool call belongs where the agent made it. Collecting all the prose
    // above all the calls would misreport the order of everything.
    const { session } = make([
      { type: "agent_delta", text: "Let me look." },
      { type: "tool_call", callId: "t1", tool: "web_search", input: {} },
      { type: "tool_result", callId: "t1", ok: true, summary: "4 results" },
      { type: "agent_delta", text: "Found it." },
      { type: "run_end" },
    ]);
    await session.send("go");
    expect(session.snapshot().entries.map((e) => e.kind)).toEqual(["user", "agent", "tool", "agent"]);
  });


  it("tracks a server tool from running to done", async () => {
    const { session } = make([
      { type: "tool_call", callId: "t1", tool: "web_search", input: {} },
      { type: "tool_result", callId: "t1", tool: "web_search", ok: true, summary: "4 results" },
      { type: "run_end" },
    ]);
    await session.send("go");
    const tool = session.snapshot().entries.find((e) => e.kind === "tool");
    expect(tool).toMatchObject({ name: "web_search", where: "server", status: "ok", detail: "4 results" });
  });

  it("marks a failed tool as failed", async () => {
    const { session } = make([
      { type: "tool_call", callId: "t1", tool: "scrape_url", input: {} },
      { type: "tool_result", callId: "t1", ok: false, summary: "blocked" },
      { type: "run_end" },
    ]);
    await session.send("go");
    expect(session.snapshot().entries.find((e) => e.kind === "tool")).toMatchObject({ status: "failed" });
  });

  it("does not list a local tool twice when the run announces it as both", async () => {
    // A client tool arrives as tool_call AND client_tool_call. Showing both would
    // misreport how much work happened.
    const { session } = make(
      [
        { type: "run_id", runId: "run_1" },
        { type: "tool_call", callId: "toolu_1", tool: "read_file", input: { path: "x" } },
        {
          type: "client_tool_call",
          toolCallId: "toolu_1",
          name: "read_file",
          kind: "read",
          title: "Read x",
          rawInput: { path: "does-not-exist-here.txt" },
        },
        { type: "run_end" },
      ],
      true,
    );
    await session.send("go");
    const tools = session.snapshot().entries.filter((e) => e.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ where: "local", title: "Read x" });
  });

  it("answers a local tool even when it fails, rather than leaving the run to time out", async () => {
    const { session, sent } = make(
      [
        { type: "run_id", runId: "run_1" },
        {
          type: "client_tool_call",
          toolCallId: "toolu_1",
          name: "read_file",
          kind: "read",
          title: "Read nope",
          rawInput: { path: "definitely-not-a-real-file-xyz.txt" },
        },
        { type: "run_end" },
      ],
      true,
    );
    await session.send("go");
    expect(sent.toolResult).toHaveLength(1);
    expect((sent.toolResult[0] as { ok: boolean }).ok).toBe(false);
  });
});
