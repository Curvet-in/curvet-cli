import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Undo.
 *
 * Approving a diff on screen and understanding its consequences three files
 * later are different moments. These tests are about the second one.
 */

const home = await fs.mkdtemp(path.join(os.tmpdir(), "curvet-undo-"));
vi.mock("../src/config.js", async (orig) => ({
  ...(await orig<typeof import("../src/config.js")>()),
  configDir: () => home,
}));

const { saveBackup, undoRun, readManifest, lastRunWithWrites } = await import("../src/agent/backup.js");

let work: string;
beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), "curvet-work-"));
  await fs.rm(path.join(home, "agent-backups"), { recursive: true, force: true });
});
afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("undo", () => {
  it("puts a changed file back exactly as it was", async () => {
    const file = path.join(work, "a.ts");
    await fs.writeFile(file, "original\n");
    await saveBackup("run_1", file, "original\n");
    await fs.writeFile(file, "changed by the agent\n");

    const out = await undoRun("run_1");
    expect(out.restored).toEqual([file]);
    expect(await fs.readFile(file, "utf8")).toBe("original\n");
  });

  it("deletes a file the agent created, rather than restoring an empty one", async () => {
    const file = path.join(work, "new.ts");
    await saveBackup("run_2", file, null);
    await fs.writeFile(file, "brand new\n");

    const out = await undoRun("run_2");
    expect(out.deleted).toEqual([file]);
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("returns a twice-written file to how it looked BEFORE the run", async () => {
    // Newest-wins would restore the midway state, which is not what undo means.
    const file = path.join(work, "b.ts");
    await fs.writeFile(file, "v1\n");
    await saveBackup("run_3", file, "v1\n");
    await fs.writeFile(file, "v2\n");
    await saveBackup("run_3", file, "v2\n");
    await fs.writeFile(file, "v3\n");

    await undoRun("run_3");
    expect(await fs.readFile(file, "utf8")).toBe("v1\n");
  });

  it("undoes only the run asked for", async () => {
    const a = path.join(work, "mine.ts");
    const b = path.join(work, "theirs.ts");
    await fs.writeFile(a, "A\n");
    await fs.writeFile(b, "B\n");
    await saveBackup("run_a", a, "A\n");
    await saveBackup("run_b", b, "B\n");
    await fs.writeFile(a, "A changed\n");
    await fs.writeFile(b, "B changed\n");

    await undoRun("run_a");
    expect(await fs.readFile(a, "utf8")).toBe("A\n");
    expect(await fs.readFile(b, "utf8")).toBe("B changed\n");
  });

  it("reports a file it could not put back instead of failing silently", async () => {
    const file = path.join(work, "gone.ts");
    await saveBackup("run_4", file, "was here\n");
    // Remove the saved copy out from under it.
    await fs.rm(path.join(home, "agent-backups", "run_4"), { recursive: true, force: true });

    const out = await undoRun("run_4");
    expect(out.restored).toHaveLength(0);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].file).toBe(file);
  });

  it("survives a file the user already deleted themselves", async () => {
    const file = path.join(work, "vanished.ts");
    await saveBackup("run_5", file, null);
    const out = await undoRun("run_5");
    expect(out.deleted).toEqual([file]);
    expect(out.failed).toHaveLength(0);
  });

  it("notices when the user edited a file after the agent wrote it", async () => {
    // Undo still restores — they asked for it — but doing that to someone's own
    // later edit without saying so would be its own small betrayal.
    const file = path.join(work, "touched.ts");
    await fs.writeFile(file, "original\n");
    await saveBackup("run_7", file, "original\n", "agent wrote this\n");
    await fs.writeFile(file, "agent wrote this\n");
    await fs.writeFile(file, "and then I edited it\n");

    const out = await undoRun("run_7");
    expect(out.changedSince).toEqual([file]);
    expect(await fs.readFile(file, "utf8")).toBe("original\n");
  });

  it("stays quiet when the file is still exactly as the agent left it", async () => {
    const file = path.join(work, "untouched.ts");
    await fs.writeFile(file, "original\n");
    await saveBackup("run_8", file, "original\n", "agent wrote this\n");
    await fs.writeFile(file, "agent wrote this\n");

    const out = await undoRun("run_8");
    expect(out.changedSince).toEqual([]);
    expect(await fs.readFile(file, "utf8")).toBe("original\n");
  });

  it("knows which run wrote last, so --undo needs no argument", async () => {
    await saveBackup("run_old", path.join(work, "x"), "x");
    await saveBackup("run_new", path.join(work, "y"), "y");
    expect(await lastRunWithWrites()).toBe("run_new");
  });

  it("has nothing to offer before anything is written", async () => {
    expect(await readManifest()).toEqual([]);
    expect(await lastRunWithWrites()).toBeNull();
  });

  it("stores identical contents once", async () => {
    const f1 = path.join(work, "one.ts");
    const f2 = path.join(work, "two.ts");
    await saveBackup("run_6", f1, "same contents\n");
    await saveBackup("run_6", f2, "same contents\n");
    const saved = await fs.readdir(path.join(home, "agent-backups", "run_6"));
    expect(saved).toHaveLength(1);
  });
});
