import { describe, expect, it } from "vitest";
import { __test } from "../src/commands/workflows.js";

const { parseInputs, describeNode, relativeAge } = __test;

describe("parseInputs", () => {
  it("keeps a plain string as a string", () => {
    expect(parseInputs(["name=Ada"])).toEqual({ name: "Ada" });
  });

  it("parses JSON scalars into real types", () => {
    expect(parseInputs(["count=3", "flag=true", "nothing=null"])).toEqual({
      count: 3,
      flag: true,
      nothing: null,
    });
  });

  it("parses JSON arrays and objects", () => {
    expect(parseInputs(['tags=["a","b"]', 'opts={"deep":1}'])).toEqual({
      tags: ["a", "b"],
      opts: { deep: 1 },
    });
  });

  it("keeps everything after the first = so values may contain =", () => {
    expect(parseInputs(["query=a=b=c"])).toEqual({ query: "a=b=c" });
  });

  it("returns an empty object for no inputs", () => {
    expect(parseInputs([])).toEqual({});
    expect(parseInputs()).toEqual({});
  });
});

describe("describeNode", () => {
  const base = { runId: "r1", status: "running" as const, raw: null };

  it("combines the node label with the node counts", () => {
    expect(
      describeNode({ ...base, currentNode: { id: "n1", label: "Summarize" }, totalNodes: 4, completedNodeCount: 2 }),
    ).toBe("Summarize (2/4)");
  });

  it("falls back to the node id when unlabelled", () => {
    expect(describeNode({ ...base, currentNode: { id: "n1" } })).toBe("n1");
  });

  it("shows counts alone when no node is current", () => {
    expect(describeNode({ ...base, totalNodes: 3, completedNodeCount: 1 })).toBe("1/3");
  });

  it("returns undefined when there is nothing to say", () => {
    expect(describeNode(base)).toBeUndefined();
  });
});

describe("relativeAge", () => {
  const now = Date.parse("2026-08-19T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("renders minutes, hours, days and months", () => {
    expect(relativeAge(ago(5 * 60_000), now)).toBe("5m ago");
    expect(relativeAge(ago(3 * 3_600_000), now)).toBe("3h ago");
    expect(relativeAge(ago(4 * 86_400_000), now)).toBe("4d ago");
    expect(relativeAge(ago(90 * 86_400_000), now)).toBe("3mo ago");
  });

  it("never renders a negative age for a clock-skewed future date", () => {
    expect(relativeAge(new Date(now + 60_000).toISOString(), now)).toBe("0m ago");
  });

  it("falls back for missing or unparseable timestamps", () => {
    expect(relativeAge(undefined, now)).toBe("—");
    expect(relativeAge("not a date", now)).toBe("—");
  });
});
