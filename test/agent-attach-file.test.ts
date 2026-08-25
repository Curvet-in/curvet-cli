import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute, SUPPORTED_TOOLS, type ToolContext } from "../src/agent/tools.js";

/**
 * `attach_file` — the first client tool that MOVES data rather than reading it.
 *
 * It exists so "go through my icons folder and restyle them" works without the
 * user naming twelve files: the model lists the directory, attaches what it finds,
 * and passes each name to generate_image as `source`.
 *
 * The boundary is the one every tool here sits behind. `read_file` already sends
 * the CONTENTS of a local file to the same server on the same model's say-so, so
 * this carries a different file TYPE through the same door rather than opening a
 * new one — and if the rules were wrong, they would already have been wrong for
 * read_file. What it adds is durability, which is why the type list is narrow and
 * the run caps how many it may pull.
 */

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("attach_file", () => {
  let root: string;
  let uploads: { name: string; bytes: Buffer }[];
  let asked: string[];

  function ctx(over: Partial<ToolContext> = {}): ToolContext {
    return {
      cwd: root,
      confirm: async (q) => { asked.push(q); return false; },
      upload: async (f) => { uploads.push(f); return { id: `f_${uploads.length}`, name: f.name }; },
      ...over,
    };
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "attach-tool-"));
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    uploads = [];
    asked = [];
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("is offered to the server as a supported tool", () => {
    // Declaring a tool is a promise to execute it — the catalogue is server-side,
    // so this list is the promise.
    expect(SUPPORTED_TOOLS).toContain("attach_file");
  });

  it("uploads the file and returns a reference the server can resolve", async () => {
    await fs.writeFile(path.join(root, "icon.png"), png);
    const res = await execute(ctx(), "attach_file", { path: "icon.png" });
    expect(res.ok).toBe(true);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].bytes.equals(png)).toBe(true);
    // JSON because the server needs the id to resolve the file later; it turns
    // this into the sentence the model reads.
    expect(JSON.parse(res.content!)).toEqual({ id: "f_1", name: "icon.png" });
  });

  it("refuses a type the server cannot read as a file", async () => {
    // Naming the set beats "unsupported": the model's next move should be
    // read_file for a text file, not another attach with a different extension.
    await fs.writeFile(path.join(root, "notes.txt"), "hello");
    const res = await execute(ctx(), "attach_file", { path: "notes.txt" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/read_file/);
    expect(uploads).toHaveLength(0);
  });

  it("refuses a secret before opening it, like every other tool here", async () => {
    await fs.mkdir(path.join(root, ".ssh"), { recursive: true });
    await fs.writeFile(path.join(root, ".ssh", "key.png"), png);
    const res = await execute(ctx(), "attach_file", { path: ".ssh/key.png" });
    expect(res.ok).toBe(false);
    expect(uploads).toHaveLength(0);
  });

  it("asks before sending a file from outside the project, and sends nothing on a no", async () => {
    // The confirm stub above answers NO, which is also what "there is nobody to
    // ask" means. Either way the bytes must not move.
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
    await fs.writeFile(path.join(elsewhere, "far.png"), png);
    const res = await execute(ctx(), "attach_file", { path: path.join(elsewhere, "far.png") });
    expect(res.ok).toBe(false);
    expect(asked.length).toBe(1);
    expect(uploads).toHaveLength(0);
    await fs.rm(elsewhere, { recursive: true, force: true });
  });

  it("a symlink out of the project is judged by where it lands", async () => {
    // The curvet-cli#16 shape: inside the project only as a string.
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
    await fs.writeFile(path.join(elsewhere, "far.png"), png);
    await fs.symlink(path.join(elsewhere, "far.png"), path.join(root, "local.png"));
    const res = await execute(ctx(), "attach_file", { path: "local.png" });
    expect(res.ok).toBe(false);
    expect(asked.length).toBe(1);
    expect(uploads).toHaveLength(0);
    await fs.rm(elsewhere, { recursive: true, force: true });
  });

  it("refuses when this client cannot upload, rather than pretending", async () => {
    // Same rule confirmWrite and confirmCommand follow: no facility, no action,
    // said out loud.
    await fs.writeFile(path.join(root, "icon.png"), png);
    const res = await execute(ctx({ upload: undefined }), "attach_file", { path: "icon.png" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cannot attach/i);
  });

  it("points a folder at list_dir instead of leaving the model guessing", async () => {
    // The common shape of the request this tool exists for is "attach my icons
    // folder". Answering "only PDFs and images can be attached" is true and
    // useless; the next step is list_dir, so the error says so.
    await fs.mkdir(path.join(root, "icons"));
    const res = await execute(ctx(), "attach_file", { path: "icons" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/list_dir/);
    expect(uploads).toHaveLength(0);
  });

  it("reports an upload failure with the reason", async () => {
    await fs.writeFile(path.join(root, "icon.png"), png);
    const res = await execute(
      ctx({ upload: async () => { throw new Error("not enough credits"); } }),
      "attach_file",
      { path: "icon.png" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not enough credits/);
  });

  it("refuses an empty or missing file", async () => {
    await fs.writeFile(path.join(root, "empty.png"), Buffer.alloc(0));
    expect((await execute(ctx(), "attach_file", { path: "empty.png" })).ok).toBe(false);
    expect((await execute(ctx(), "attach_file", { path: "ghost.png" })).ok).toBe(false);
    expect(uploads).toHaveLength(0);
  });
});
