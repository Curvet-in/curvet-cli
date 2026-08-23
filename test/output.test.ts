import { describe, expect, it, vi, afterEach } from "vitest";
import { maskKey, printJson, printJsonLine, table } from "../src/output.js";
import { v1Root } from "../src/client.js";
import { DEFAULT_BASE_URL } from "@curvet/sdk";

describe("maskKey", () => {
  it("keeps a recognizable prefix and suffix", () => {
    expect(maskKey("app_1234567890abcdef1234")).toBe("app_123456…1234");
  });
  it("collapses short keys entirely", () => {
    expect(maskKey("app_123")).toBe("app_…");
  });
});

describe("table", () => {
  it("pads columns to the widest cell", () => {
    const out = table(
      ["ID", "TYPE"],
      [
        ["gpt-4o", "chat"],
        ["wan-2.2", "video"],
      ],
    );
    const lines = out.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("gpt-4o");
    expect(lines[3]).toContain("wan-2.2");
  });
});

describe("v1Root", () => {
  it("strips the /playground suffix from the default base", () => {
    expect(v1Root(DEFAULT_BASE_URL)).toBe("https://curvet.ai/api/v1");
    expect(v1Root(undefined)).toBe("https://curvet.ai/api/v1");
  });
  it("handles a trailing slash", () => {
    expect(v1Root("https://x.test/api/v1/playground/")).toBe("https://x.test/api/v1");
  });
  it("leaves non-playground bases untouched", () => {
    expect(v1Root("https://x.test/api/v1")).toBe("https://x.test/api/v1");
  });
});


describe("--json is JSONL", () => {
  /** Capture what console.log wrote, the way a pipe would see it. */
  function capture(run: () => void): string {
    let out = "";
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out += a.join(" ") + "\n";
    });
    try {
      run();
    } finally {
      spy.mockRestore();
    }
    return out;
  }

  afterEach(() => vi.restoreAllMocks());

  it("writes exactly one line per event", () => {
    // The bug: the live event stream went through printJson, which indents.
    // A single agency run produced 21 events across 173 lines, so anything
    // reading a line at a time got a fragment of an object. `jq` tolerates
    // concatenated JSON, which is why the documented example kept working and
    // nothing noticed.
    const events = [
      { type: "run_start", runId: "run_1", task: "do a thing" },
      { type: "tool_call", tool: "GMAIL_SEND_EMAIL", nested: { a: [1, 2, 3] } },
      { type: "confirm_action", summary: 'Send email to a@b.c — "subject"' },
      { type: "run_end", costUsd: 0.1 },
    ];
    const out = capture(() => events.forEach(printJsonLine));
    const lines = out.split("\n").filter(Boolean);
    expect(lines).toHaveLength(events.length);
    expect(lines.map((l) => JSON.parse(l))).toEqual(events);
  });

  it("keeps a nested object on its own single line", () => {
    const out = capture(() => printJsonLine({ a: { b: { c: [1, 2] } } }));
    expect(out.trimEnd()).not.toContain("\n");
  });

  it("still indents a whole document, which is a different job", () => {
    // --runs, --log, --replay and --undo each print one thing for a person to
    // read. Collapsing those to one line would be the opposite mistake.
    const out = capture(() => printJson({ a: { b: 1 } }));
    expect(out).toContain("\n");
    expect(JSON.parse(out)).toEqual({ a: { b: 1 } });
  });
});
