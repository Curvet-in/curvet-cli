import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute, type ToolContext } from "../src/agent/tools.js";
import { isWriteTool } from "../src/agent/tools.js";
import type { FileDiff } from "../src/agent/diff.js";

/**
 * edit_file — replacing an exact piece of a file rather than rewriting it.
 *
 * The interesting behaviour is almost all in the refusals. An edit tool that
 * guesses where the model meant lands in the wrong place while showing a diff
 * that looks entirely plausible, and the user approves it. So every case where
 * the target is not unambiguously identified has to be a refusal that says how
 * to be unambiguous, and never a best effort.
 */

let root: string;

const ORIGINAL = [
  "export function greet(name: string) {",
  "  const greeting = `Hello, ${name}`;",
  "  console.log(greeting);",
  "  return greeting;",
  "}",
  "",
  "export function farewell(name: string) {",
  "  const greeting = `Bye, ${name}`;",
  "  console.log(greeting);",
  "  return greeting;",
  "}",
  "",
].join("\n");

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "curvet-edit-")));
  await fs.writeFile(path.join(root, "package.json"), "{}");
  await fs.writeFile(path.join(root, "src.ts"), ORIGINAL);
  await fs.writeFile(path.join(root, ".env"), "SECRET=1\n");
});

afterAll(async () => {
  /* each beforeEach makes its own dir; the OS reaps the temp root */
});

/** A context that approves, recording the diff it was shown. */
function ctxWith(approve = true) {
  const shown: { path: string; diff: FileDiff; creating: boolean }[] = [];
  const backups: { file: string; original: string | null }[] = [];
  return {
    shown,
    backups,
    ctx: {
      cwd: root,
      confirm: async () => approve,
      confirmWrite: async (p: string, diff: FileDiff, creating: boolean) => {
        shown.push({ path: p, diff, creating });
        return approve;
      },
      backup: async (file: string, original: string | null) => {
        backups.push({ file, original });
      },
    } as ToolContext,
  };
}

const edit = (ctx: ToolContext, input: Record<string, unknown>) => execute(ctx, "edit_file", input);
const read = () => fs.readFile(path.join(root, "src.ts"), "utf8");

describe("edit_file applies a unique match", () => {
  it("changes only the matched text", async () => {
    const { ctx } = ctxWith();
    const out = await edit(ctx, {
      path: "src.ts",
      old_string: "`Hello, ${name}`",
      new_string: "`Hi, ${name}`",
    });
    expect(out.ok).toBe(true);
    const after = await read();
    expect(after).toContain("`Hi, ${name}`");
    expect(after).toContain("`Bye, ${name}`");
    // Every other byte is untouched — the point of the tool.
    expect(after).toBe(ORIGINAL.replace("`Hello, ${name}`", "`Hi, ${name}`"));
  });

  it("shows a diff of the change, not of the file", async () => {
    // The reason this tool exists as much as the token cost: a whole-file
    // rewrite hands the user a 900-line diff whose real change is buried, and an
    // approval nobody can read has stopped being an approval.
    const { ctx, shown } = ctxWith();
    await edit(ctx, { path: "src.ts", old_string: "Hello", new_string: "Hi" });
    expect(shown).toHaveLength(1);
    expect(shown[0].diff.added).toBe(1);
    expect(shown[0].diff.removed).toBe(1);
    expect(shown[0].creating).toBe(false);
  });

  it("backs up the original so --undo can put it back", async () => {
    const { ctx, backups } = ctxWith();
    await edit(ctx, { path: "src.ts", old_string: "Hello", new_string: "Hi" });
    expect(backups).toHaveLength(1);
    expect(backups[0].original).toBe(ORIGINAL);
  });

  it("writes nothing when the user declines", async () => {
    const { ctx } = ctxWith(false);
    const out = await edit(ctx, { path: "src.ts", old_string: "Hello", new_string: "Hi" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/declined/);
    expect(await read()).toBe(ORIGINAL);
  });
});

describe("edit_file refuses rather than guessing", () => {
  it("refuses text that appears more than once, and says how many", async () => {
    // "console.log(greeting);" is in both functions. Picking one would be a coin
    // flip dressed up as a decision.
    const { ctx, shown } = ctxWith();
    const out = await edit(ctx, {
      path: "src.ts",
      old_string: "  console.log(greeting);",
      new_string: "  // logged",
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/appears 2 times/);
    expect(out.error).toMatch(/more of the surrounding lines|replace_all/);
    expect(shown).toHaveLength(0);
    expect(await read()).toBe(ORIGINAL);
  });

  it("changes every occurrence when replace_all is explicit", async () => {
    const { ctx } = ctxWith();
    const out = await edit(ctx, {
      path: "src.ts",
      old_string: "  console.log(greeting);",
      new_string: "  // logged",
      replace_all: true,
    });
    expect(out.ok).toBe(true);
    expect(out.content).toMatch(/2 places/);
    expect(await read()).not.toContain("console.log");
  });

  it("refuses text that is not there, and quotes what it looked for", async () => {
    const { ctx } = ctxWith();
    const out = await edit(ctx, {
      path: "src.ts",
      old_string: "const greeting = `Howdy, ${name}`;",
      new_string: "x",
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not in "src\.ts"/);
    expect(out.error).toMatch(/Howdy/);
    expect(out.error).toMatch(/Do not guess/);
  });

  it("names a line-ending near-miss instead of just saying 'not found'", async () => {
    // The most common way an exact match fails on a real checkout, and the one
    // where "not found" sends the model round the same loop again.
    await fs.writeFile(path.join(root, "crlf.ts"), "const a = 1;\r\nconst b = 2;\r\n");
    const { ctx } = ctxWith();
    const out = await edit(ctx, {
      path: "crlf.ts",
      old_string: "const a = 1;\nconst b = 2;",
      new_string: "const a = 9;",
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/line endings or trailing whitespace/);
  });

  it("does not silently fix the near-miss it just diagnosed", async () => {
    // Diagnosing is help; rewriting bytes the user never approved is not.
    const before = "const a = 1;\r\nconst b = 2;\r\n";
    await fs.writeFile(path.join(root, "crlf.ts"), before);
    const { ctx } = ctxWith();
    await edit(ctx, { path: "crlf.ts", old_string: "const a = 1;\nconst b = 2;", new_string: "x" });
    expect(await fs.readFile(path.join(root, "crlf.ts"), "utf8")).toBe(before);
  });

  it("refuses an empty old_string, which is a create", async () => {
    const { ctx } = ctxWith();
    const out = await edit(ctx, { path: "src.ts", old_string: "", new_string: "x" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/write_file/);
  });

  it("refuses a no-op edit rather than staging an empty diff", async () => {
    const { ctx, shown } = ctxWith();
    const out = await edit(ctx, { path: "src.ts", old_string: "Hello", new_string: "Hello" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/identical/);
    expect(shown).toHaveLength(0);
  });

  it("refuses a file that does not exist, pointing at write_file", async () => {
    const { ctx } = ctxWith();
    const out = await edit(ctx, { path: "nope.ts", old_string: "a", new_string: "b" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/does not exist/);
    expect(out.error).toMatch(/write_file/);
  });

  it("cannot edit at all without a way to ask", async () => {
    const ctx = { cwd: root, confirm: async () => true } as ToolContext;
    const out = await edit(ctx, { path: "src.ts", old_string: "Hello", new_string: "Hi" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/cannot write/i);
  });
});

describe("edit_file obeys the same boundary as write_file", () => {
  it("never edits a secret, and never even asks", async () => {
    const { ctx, shown } = ctxWith();
    const out = await edit(ctx, { path: ".env", old_string: "SECRET=1", new_string: "SECRET=2" });
    expect(out.ok).toBe(false);
    expect(shown).toHaveLength(0);
    expect(await fs.readFile(path.join(root, ".env"), "utf8")).toContain("SECRET=1");
  });

  it("refuses an edit outside the project rather than confirming it", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "curvet-out-")));
    await fs.writeFile(path.join(outside, "sibling.md"), "hello\n");
    const { ctx, shown } = ctxWith();
    const out = await edit(ctx, {
      path: path.join(outside, "sibling.md"),
      old_string: "hello",
      new_string: "goodbye",
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/outside this project/);
    expect(shown).toHaveLength(0);
    expect(await fs.readFile(path.join(outside, "sibling.md"), "utf8")).toBe("hello\n");
  });

  it("refuses an edit through a symlinked parent, like write_file", async () => {
    // The escape fixed in #16. An edit is a write and gets the same answer.
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "curvet-out2-")));
    await fs.writeFile(path.join(outside, "target.md"), "hello\n");
    await fs.symlink(outside, path.join(root, "escape"));
    const { ctx } = ctxWith();
    const out = await edit(ctx, { path: "escape/target.md", old_string: "hello", new_string: "bye" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/outside this project/);
    expect(await fs.readFile(path.join(outside, "target.md"), "utf8")).toBe("hello\n");
  });
});

describe("isWriteTool", () => {
  it("knows both tools that change files", () => {
    // Three call sites used to ask `name === "write_file"` while meaning "does
    // this write". A new write tool must not be able to slip past one of them
    // and get recorded as an automatic read.
    expect(isWriteTool("write_file")).toBe(true);
    expect(isWriteTool("edit_file")).toBe(true);
    expect(isWriteTool("read_file")).toBe(false);
    expect(isWriteTool("grep")).toBe(false);
    expect(isWriteTool("list_dir")).toBe(false);
  });
});
