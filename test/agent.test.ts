import { describe, expect, it, afterEach } from "vitest";
import type { AgencyEvent } from "@curvet/sdk";
import { RunRenderer, previewArgs, formatDuration, answerPause } from "../src/commands/agent.js";

/**
 * `curvet agent` rendering and pause handling.
 *
 * The rendering assertions are about one thing: `agent_delta` streams token by
 * token with no newline, so anything printed while a stream is open lands in the
 * middle of the agent's sentence. Every structural line has to close the stream
 * first, and that is easy to break and invisible in a unit test that only checks
 * for substrings.
 *
 * The pause assertions are about the rule from src/confirm.ts: with no terminal,
 * refuse. A piped `curvet agent` must not approve an outward action because
 * nobody was there to answer.
 */

function capture(quiet = false) {
  const out: string[] = [];
  const renderer = new RunRenderer(quiet, (s) => out.push(s));
  return { renderer, out, text: () => out.join("") };
}

const realTTY = process.stdin.isTTY;
afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", { value: realTTY, configurable: true });
});
function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

describe("previewArgs", () => {
  it("summarises tool arguments on one line", () => {
    expect(previewArgs({ query: "weather in Bengaluru", limit: 5 })).toBe(
      "query=weather in Bengaluru limit=5",
    );
  });

  it("truncates a long value rather than printing a wall", () => {
    const preview = previewArgs({ body: "x".repeat(500) });
    expect(preview.length).toBeLessThanOrEqual(110);
    expect(preview).toContain("…");
  });

  it("shows an array as its length, not its contents", () => {
    expect(previewArgs({ urls: ["a", "b", "c"] })).toBe("urls=[3]");
  });

  it("handles junk without throwing", () => {
    for (const input of [null, undefined, "string", 42]) {
      expect(() => previewArgs(input)).not.toThrow();
    }
  });
});

describe("formatDuration", () => {
  it("uses ms below a second and seconds above", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(0)).toBe("");
    expect(formatDuration(undefined)).toBe("");
  });
});

describe("RunRenderer", () => {
  it("streams agent text with no framing of its own", () => {
    const { renderer, text } = capture();
    renderer.handle({ type: "agent_delta", text: "Hello " });
    renderer.handle({ type: "agent_delta", text: "world" });
    expect(text()).toBe("Hello world");
  });

  it("closes an open stream before printing a structural line", () => {
    // The bug this prevents: a tool call printed mid-sentence, so the agent's
    // text and the timeline interleave on one unreadable line.
    const { renderer, text } = capture();
    renderer.handle({ type: "agent_delta", text: "Looking that up" });
    renderer.handle({ type: "tool_call", tool: "web_search", input: { query: "x" } });
    const lines = text().split("\n");
    expect(lines[0]).toBe("Looking that up");
    expect(lines[1]).toContain("web_search");
  });

  it("does not emit a stray newline when nothing was streaming", () => {
    const { renderer, text } = capture();
    renderer.handle({ type: "tool_call", tool: "recall", input: {} });
    expect(text().startsWith("\n")).toBe(false);
  });

  it("marks a failed tool differently from a successful one", () => {
    const { renderer, text } = capture();
    renderer.handle({ type: "tool_result", tool: "send_email", summary: "sent", ok: true });
    renderer.handle({ type: "tool_result", tool: "scrape_url", summary: "failed", ok: false });
    expect(text()).toContain("✓");
    expect(text()).toContain("✖");
  });

  it("announces an agent only when it changes", () => {
    const { renderer, text } = capture();
    renderer.handle({ type: "agent_start", agentName: "Researcher" });
    renderer.handle({ type: "agent_start", agentName: "Researcher" });
    renderer.handle({ type: "agent_start", agentName: "Writer" });
    expect(text().match(/Researcher/g)).toHaveLength(1);
    expect(text()).toContain("Writer");
  });

  it("collects deliverables and lists them at the end with their URLs", () => {
    const { renderer, text } = capture();
    renderer.handle({
      type: "deliverable",
      deliverable: { title: "Q3 report", kind: "markdown", url: "https://cdn/x.md" },
    });
    renderer.finish();
    expect(text()).toContain("Q3 report");
    expect(text()).toContain("https://cdn/x.md");
  });

  it("prints the run's cost and duration when it ends", () => {
    const { renderer, text } = capture();
    renderer.handle({ type: "run_end", summary: "done", durationMs: 12400, costUsd: 0.0123 });
    expect(text()).toContain("done");
    expect(text()).toContain("12.4s");
    expect(text()).toContain("$0.0123");
  });

  it("does not repeat the answer it just streamed", () => {
    // run_end.summary IS the final text in full. Printing it after streaming the
    // same words gave every answer twice, and the longer the answer the worse it
    // read — which is how it was found, on a real run.
    const answer = "Bengaluru is the capital of Karnataka.";
    const { renderer, text } = capture();
    renderer.handle({ type: "agent_delta", text: answer });
    renderer.handle({ type: "run_end", summary: answer, durationMs: 1200, costUsd: 0.01 });
    expect(text().match(/Bengaluru/g)).toHaveLength(1);
    expect(text()).toContain("1.2s");
  });

  it("still shows a summary when nothing was streamed", () => {
    // A tool-only run, or --quiet: the summary is the only text there is.
    const { renderer, text } = capture();
    renderer.handle({ type: "tool_result", tool: "send_email", summary: "sent", ok: true });
    renderer.handle({ type: "run_end", summary: "Emailed the report.", durationMs: 900 });
    expect(text()).toContain("Emailed the report.");
  });

  it("caps a long unstreamed summary to one line", () => {
    const { renderer, text } = capture();
    renderer.handle({ type: "run_end", summary: "word ".repeat(200), durationMs: 100 });
    const last = text().trim().split("\n").filter(Boolean).pop() ?? "";
    expect(last.length).toBeLessThan(200);
    expect(last).toContain("…");
  });

  it("quiet mode keeps the agent's text and drops the timeline", () => {
    const { renderer, text } = capture(true);
    renderer.handle({ type: "agent_delta", text: "the answer" });
    renderer.handle({ type: "tool_call", tool: "web_search", input: { q: "x" } });
    renderer.handle({ type: "status", message: "thinking" });
    expect(text()).toContain("the answer");
    expect(text()).not.toContain("web_search");
    expect(text()).not.toContain("thinking");
  });

  it("says a run errored, and flags a transient one as worth retrying", () => {
    const { renderer, text } = capture();
    renderer.handle({ type: "error", message: "queue unavailable", retryable: true });
    expect(text()).toContain("queue unavailable");
    expect(text()).toMatch(/retry/i);
  });

  it("ignores event types it does not know", () => {
    // The stream gains event types over time; an unknown one must not crash a
    // run that is otherwise fine.
    const { renderer } = capture();
    expect(() =>
      renderer.handle({ type: "some_future_event", whatever: true } as AgencyEvent),
    ).not.toThrow();
  });
});

describe("colour", () => {
  it("is absent when stdout is not a terminal", () => {
    // The whole timeline is styled, so a pipe that carried escape codes would put
    // them straight into whatever reads it. picocolors drops them on a non-TTY —
    // which is what these tests run on, so an empty result here IS the assertion.
    const { renderer, text } = capture();
    renderer.handle({ type: "agent_start", agentName: "Researcher" });
    renderer.handle({ type: "tool_result", tool: "recall", summary: "2 memories", ok: true });
    renderer.handle({ type: "deliverable", deliverable: { title: "Report", url: "https://x/y.md" } });
    // eslint-disable-next-line no-control-regex
    expect(text()).not.toMatch(/\u001b\[/);
  });

  it("puts the deliverable's URL on its own line, so a double-click selects it whole", () => {
    const { renderer, text } = capture();
    renderer.handle({ type: "deliverable", deliverable: { title: "Report", url: "https://cdn/x.md" } });
    renderer.finish();
    const urlLine = text().split("\n").find((l) => l.includes("https://cdn/x.md")) ?? "";
    expect(urlLine.trim()).toBe("https://cdn/x.md");
  });

  it("counts deliverables in words, not in (s)", () => {
    const one = capture();
    one.renderer.handle({ type: "deliverable", deliverable: { title: "A" } });
    one.renderer.finish();
    expect(one.text()).toContain("1 deliverable:");

    const two = capture();
    two.renderer.handle({ type: "deliverable", deliverable: { title: "A" } });
    two.renderer.handle({ type: "deliverable", deliverable: { title: "B" } });
    two.renderer.finish();
    expect(two.text()).toContain("2 deliverables:");
  });
});

describe("answerPause without a terminal", () => {
  it("cancels rather than approving an outward action nobody saw", async () => {
    setTTY(false);
    const answer = await answerPause({
      kind: "confirm",
      key: "c1",
      prompt: "Send email to customer@example.com",
      raw: { type: "confirm_action" },
    });
    expect(answer?.decision).toBe("cancel");
  });

  it("cancels a plan too, rather than letting the run proceed unattended", async () => {
    setTTY(false);
    const answer = await answerPause({
      kind: "plan",
      key: "c1",
      prompt: "Step 1…",
      raw: { type: "plan_proposed" },
    });
    expect(answer?.decision).toBe("cancel");
  });

  it("cancels an ask_user pause instead of hanging until the server times out", async () => {
    setTTY(false);
    const answer = await answerPause({
      kind: "ask_user",
      key: "node-1",
      prompt: "Which repo?",
      raw: { type: "human_input" },
    });
    expect(answer?.decision).toBe("cancel");
  });

  it("sends NO note with a refusal, because ask_user quotes the note as the answer", async () => {
    // This assertion used to be `expect(answer?.note).toMatch(/terminal/i)` — it
    // asserted the bug. The server reads a pause's note as the user's answer and
    // tells the model "The user answered: no interactive terminal", attributing a
    // sentence about this process to a person who was never at the keyboard.
    //
    // A refusal has no answer in it. The decision alone says everything true, and
    // the explanation belongs on the user's terminal, where it already is.
    setTTY(false);
    const answer = await answerPause({
      kind: "ask_user",
      key: "node-1",
      prompt: "Which repo?",
      raw: { type: "human_input" },
    });
    expect(answer?.note).toBeUndefined();
  });

  it("sends no note on a refused confirm or plan either", async () => {
    setTTY(false);
    for (const kind of ["confirm", "plan"] as const) {
      const answer = await answerPause({
        kind,
        key: "c1",
        prompt: "…",
        raw: { type: kind === "plan" ? "plan_proposed" : "confirm_action" },
      });
      expect(answer?.note).toBeUndefined();
    }
  });
});
