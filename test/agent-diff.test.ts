import { describe, expect, it } from "vitest";
import { diffLines } from "../src/agent/diff.js";

/**
 * The diff a person approves before their files change.
 *
 * Correctness here is not cosmetic. The diff IS the thing being consented to, so
 * a line attributed to the wrong side, or a change that does not appear at all,
 * is a change made without consent.
 */

const lines = (...l: string[]) => l.join("\n");

describe("diffLines", () => {
  it("reports an unchanged file as no change at all", () => {
    const text = lines("a", "b", "c");
    const d = diffLines(text, text);
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.hunks).toHaveLength(0);
  });

  it("counts a pure insertion as added only", () => {
    const d = diffLines(lines("a", "c"), lines("a", "b", "c"));
    expect(d.added).toBe(1);
    expect(d.removed).toBe(0);
    const added = d.hunks.flatMap((h) => h.lines).filter((l) => l.kind === "add");
    expect(added.map((l) => l.text)).toEqual(["b"]);
    expect(added[0].newNo).toBe(2);
  });

  it("counts a pure deletion as removed only", () => {
    const d = diffLines(lines("a", "b", "c"), lines("a", "c"));
    expect(d.added).toBe(0);
    expect(d.removed).toBe(1);
    const removed = d.hunks.flatMap((h) => h.lines).filter((l) => l.kind === "del");
    expect(removed[0].text).toBe("b");
    expect(removed[0].oldNo).toBe(2);
  });

  it("shows a modified line as one removal and one addition", () => {
    const d = diffLines(lines("a", "old", "c"), lines("a", "new", "c"));
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
  });

  it("numbers both sides so a reader can find the line in either file", () => {
    const d = diffLines(lines("x", "a", "b", "c"), lines("x", "a", "B", "c"));
    const flat = d.hunks.flatMap((h) => h.lines);
    const del = flat.find((l) => l.kind === "del")!;
    const add = flat.find((l) => l.kind === "add")!;
    expect(del.oldNo).toBe(3);
    expect(del.newNo).toBeUndefined();
    expect(add.newNo).toBe(3);
    expect(add.oldNo).toBeUndefined();
  });

  it("handles creating a file from nothing", () => {
    const d = diffLines("", lines("a", "b"));
    expect(d.removed).toBe(0);
    expect(d.added).toBe(2);
  });

  it("handles emptying a file", () => {
    const d = diffLines(lines("a", "b"), "");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(2);
  });

  it("keeps context around a change and drops the rest", () => {
    // The point of hunks: approving a two-line change should not mean scrolling
    // a thousand unchanged lines, because a prompt that long is approved unread.
    const before = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const afterLines = before.split("\n");
    afterLines[200] = "line 200 CHANGED";
    const d = diffLines(before, afterLines.join("\n"), 3);

    const shown = d.hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(shown).toBeLessThan(20);
    expect(d.hunks).toHaveLength(1);
    const texts = d.hunks[0].lines.map((l) => l.text);
    expect(texts).toContain("line 200 CHANGED");
    expect(texts).toContain("line 197");
    expect(texts).not.toContain("line 100");
  });

  it("splits distant changes into separate hunks", () => {
    const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const after = before.split("\n");
    after[10] = "TOP CHANGED";
    after[150] = "BOTTOM CHANGED";
    const d = diffLines(before, after.join("\n"), 2);
    expect(d.hunks).toHaveLength(2);
  });

  it("degrades honestly rather than exhausting memory on a huge rewrite", () => {
    // The LCS table is O(n·m). Twenty thousand changed lines on both sides would
    // be 400 million cells, so past a threshold it says "replaced wholesale"
    // instead of trying.
    const before = Array.from({ length: 6000 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 6000 }, (_, i) => `new ${i}`).join("\n");
    const started = Date.now();
    const d = diffLines(before, after);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(d.coarse).toBe(true);
    expect(d.added).toBe(6000);
    expect(d.removed).toBe(6000);
  });

  it("stays precise on a small change inside a very large file", () => {
    // Trimming the common head and tail is what keeps this off the slow path:
    // the file is big, but the changed middle is one line.
    const before = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n");
    const after = before.split("\n");
    after[9999] = "line 9999 CHANGED";
    const started = Date.now();
    const d = diffLines(before, after.join("\n"));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(d.coarse).toBe(false);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
  });

  it("does not lose a change that repeats elsewhere in the file", () => {
    // Repeated lines are where a naive matcher aligns the wrong pair and reports
    // no change at all.
    const before = lines("x", "same", "y", "same", "z");
    const after = lines("x", "same", "Y", "same", "z");
    const d = diffLines(before, after);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    const flat = d.hunks.flatMap((h) => h.lines);
    expect(flat.find((l) => l.kind === "del")!.text).toBe("y");
    expect(flat.find((l) => l.kind === "add")!.text).toBe("Y");
  });
});
