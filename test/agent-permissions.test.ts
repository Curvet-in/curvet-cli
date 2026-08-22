import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyPath,
  secretReason,
  isInside,
  needsBlanketConfirm,
  findProjectRoot,
  refusalReason,
  denialMessage,
} from "../src/agent/permissions.js";
import { execute, type ToolContext } from "../src/agent/tools.js";
import type { FileDiff } from "../src/agent/diff.js";

/**
 * The permission layer.
 *
 * This is the security boundary between an agent that routinely ingests
 * untrusted text — scraped pages, emails, a README in the repo it is reading —
 * and a developer's filesystem. Everything here is a rule that has to hold when
 * the path being checked was chosen by a model that just read something hostile.
 */

let root: string;
let outside: string;

beforeAll(async () => {
  // realpath because macOS hands out /var/… which is a symlink to /private/var,
  // and a boundary check that compares the two spellings is a boundary check
  // that fails on every Mac.
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "curvet-perm-")));
  root = path.join(base, "project");
  outside = path.join(base, "elsewhere");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });

  await fs.writeFile(path.join(root, "src", "index.ts"), "export const hello = 1;\n");
  await fs.writeFile(path.join(root, ".env"), "API_KEY=super-secret-value\n");
  await fs.writeFile(path.join(root, ".env.example"), "API_KEY=\n");
  await fs.writeFile(path.join(root, "config", "settings.json"), '{"codename":"kestrel"}\n');
  await fs.writeFile(path.join(outside, "notes.md"), "a sibling file\n");
  await fs.writeFile(path.join(outside, "id_rsa"), "PRIVATE KEY MATERIAL\n");
});

afterAll(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

/**
 * Run `body` with a symlink in place, and remove it even if an assertion throws.
 * A link left behind by a failing test breaks every test after it, which turns
 * one red result into a page of them and hides which one was real.
 */
async function withLink(link: string, target: string, body: () => Promise<void>): Promise<void> {
  await fs.rm(link, { force: true });
  await fs.symlink(target, link);
  try {
    await body();
  } finally {
    await fs.rm(link, { force: true });
  }
}

/** A context that records whether it was asked, and answers however we say. */
function ctxWith(answer: boolean): ToolContext & { asked: string[] } {
  const asked: string[] = [];
  return {
    cwd: root,
    asked,
    confirm: async (q: string) => {
      asked.push(q);
      return answer;
    },
  };
}

describe("secretReason", () => {
  it("names the credential files that are always refused", () => {
    for (const p of [
      "/proj/.env",
      "/proj/.env.local",
      "/proj/.env.production",
      "/home/u/.ssh/id_rsa",
      "/home/u/.aws/credentials",
      "/proj/server.pem",
      "/proj/private.key",
      "/proj/cert.p12",
      "/home/u/.npmrc",
      "/home/u/.netrc",
      "/proj/credentials.json",
      "/proj/service-account-prod.json",
      "/home/u/.kube/config",
      "/home/u/.gnupg/secring.gpg",
    ]) {
      expect(secretReason(p), p).not.toBeNull();
    }
  });

  it("does not refuse ordinary files that merely sound alarming", () => {
    // A denylist that blocks real work is a denylist people turn off.
    for (const p of [
      "/proj/.env.example",
      "/proj/.env.sample",
      "/proj/.env.template",
      "/proj/src/secrets.ts",
      "/proj/src/credentials-form.tsx",
      "/proj/docs/keys.md",
      "/proj/keychain-notes.txt",
      "/proj/README.md",
      "/proj/package.json",
    ]) {
      expect(secretReason(p), p).toBeNull();
    }
  });

  it("refuses anything reached THROUGH a credential directory", () => {
    expect(secretReason("/home/u/.ssh/config")).not.toBeNull();
    expect(secretReason("/home/u/.aws/some/nested/file.txt")).not.toBeNull();
  });
});

describe("isInside", () => {
  it("is not fooled by a shared prefix", () => {
    // /proj-evil is not inside /proj, however much the strings agree.
    expect(isInside("/proj", "/proj/src/a.ts")).toBe(true);
    expect(isInside("/proj", "/proj")).toBe(true);
    expect(isInside("/proj", "/proj-evil/a.ts")).toBe(false);
    expect(isInside("/proj", "/other/a.ts")).toBe(false);
    expect(isInside("/proj", "/")).toBe(false);
  });
});

describe("classifyPath", () => {
  it("allows a file in the project without asking", async () => {
    const v = await classifyPath(root, "src/index.ts");
    expect(v.decision).toBe("allow");
  });

  it("denies a secret in the project", async () => {
    const v = await classifyPath(root, ".env");
    expect(v.decision).toBe("deny");
  });

  it("denies a secret reached by climbing out with ..", async () => {
    const v = await classifyPath(root, "../elsewhere/id_rsa");
    expect(v.decision).toBe("deny");
  });

  it("confirms — does not deny — an ordinary file outside the project", async () => {
    // Reading a sibling package is real work in a monorepo. Doing it without
    // saying so is not.
    const v = await classifyPath(root, "../elsewhere/notes.md");
    expect(v.decision).toBe("confirm");
  });

  it("follows a symlink before deciding, so a link out is not 'inside'", async () => {
    // The classic path-jail defeat: a link that lives in the project and points
    // anywhere. String comparison says local; realpath says otherwise.
    const link = path.join(root, "shortcut.md");
    await fs.symlink(path.join(outside, "notes.md"), link);
    const v = await classifyPath(root, "shortcut.md");
    expect(v.decision).toBe("confirm");
    expect(v.abs).toBe(path.join(outside, "notes.md"));
    await fs.unlink(link);
  });

  it("DENIES a symlink whose target is a secret, rather than confirming it", async () => {
    // A confirmation prompt for "shortcut.txt" that silently yields a private key
    // is worse than no prompt: it launders the decision through the user.
    const link = path.join(root, "harmless.txt");
    await fs.symlink(path.join(outside, "id_rsa"), link);
    const v = await classifyPath(root, "harmless.txt");
    expect(v.decision).toBe("deny");
    await fs.unlink(link);
  });

  it("shows the real destination in the confirmation, not the name asked for", async () => {
    const link = path.join(root, "innocuous.md");
    await fs.symlink(path.join(outside, "notes.md"), link);
    const v = await classifyPath(root, "innocuous.md");
    expect(v.decision).toBe("confirm");
    if (v.decision === "confirm") expect(v.display).toContain("elsewhere");
    await fs.unlink(link);
  });

  it("classifies an absolute path by where it lands, not by how it was written", async () => {
    expect((await classifyPath(root, path.join(root, "src/index.ts"))).decision).toBe("allow");
    expect((await classifyPath(root, path.join(outside, "notes.md"))).decision).toBe("confirm");
    expect((await classifyPath(root, path.join(outside, "id_rsa"))).decision).toBe("deny");
  });

  it("does not widen a path it cannot resolve", async () => {
    // A file that does not exist yet must still be judged, not waved through.
    expect((await classifyPath(root, "../elsewhere/missing.txt")).decision).toBe("confirm");
    expect((await classifyPath(root, "../elsewhere/.env")).decision).toBe("deny");
  });

  // ── Links in the MIDDLE of the path ────────────────────────────────────────
  //
  // The cases above all name a file that already exists, so realpath resolves the
  // whole path and the boundary holds. A file that does NOT exist yet is the
  // interesting one, because that is every create: realpath throws ENOENT on the
  // missing leaf, and if the fallback is "judge the string we were handed" then a
  // symlinked PARENT is never resolved at all. Existence decides the boundary,
  // which is exactly backwards — the non-existent leaf IS the write.
  it("resolves a symlinked PARENT even though the leaf does not exist yet", async () => {
    await withLink(path.join(root, "escape"), outside, async () => {
      const v = await classifyPath(root, "escape/brand-new.txt");
      expect(v.decision).toBe("confirm");
      expect(v.abs).toBe(path.join(outside, "brand-new.txt"));
    });
  });

  it("denies a NEW file under a link into a secret directory", async () => {
    // ~/.ssh/authorized_keys is the sharp version: the name matches no secret
    // pattern, the directory it lands in is the whole point, and the file not
    // existing yet is what makes it worth writing.
    const secretDir = path.join(path.dirname(root), ".ssh");
    await fs.mkdir(secretDir, { recursive: true });
    await withLink(path.join(root, "keys"), secretDir, async () => {
      const v = await classifyPath(root, "keys/authorized_keys");
      expect(v.decision).toBe("deny");
    });
  });

  it("resolves a DANGLING link, which points somewhere precisely because nothing is there yet", async () => {
    // A link whose target does not exist still resolves for open(O_CREAT): the
    // write follows it and creates the target. So it has to be classified by
    // where it points, and realpath refuses to tell us — it throws on the link
    // itself, not only on the leaf.
    await withLink(path.join(root, "dangling.txt"), path.join(outside, "not-yet.txt"), async () => {
      const v = await classifyPath(root, "dangling.txt");
      expect(v.decision).toBe("confirm");
      expect(v.abs).toBe(path.join(outside, "not-yet.txt"));
    });
  });

  it("applies .. after resolving a link, not before", async () => {
    // POSIX resolves `..` against where the link LANDED. Collapsing it textually
    // first computes a different path than the kernel will open.
    await withLink(path.join(root, "hop"), outside, async () => {
      const v = await classifyPath(root, "hop/../elsewhere-sibling.txt");
      expect(v.abs).toBe(path.join(path.dirname(outside), "elsewhere-sibling.txt"));
    });
  });

  it("treats a project reached THROUGH a link as the project it is", async () => {
    // /tmp is a link to /private/tmp on macOS, so this is the ordinary case, not
    // an exotic one. Comparing an unresolved root against a resolved target makes
    // every file in the project look like it is outside the project.
    const alias = path.join(path.dirname(root), "project-alias");
    await withLink(alias, root, async () => {
      const v = await classifyPath(alias, "src/index.ts");
      expect(v.decision).toBe("allow");
    });
  });

  it("gives up on a symlink loop instead of hanging", async () => {
    const a = path.join(root, "loop-a");
    const b = path.join(root, "loop-b");
    await withLink(a, b, async () => {
      await withLink(b, a, async () => {
        const v = await classifyPath(root, "loop-a/whatever.txt");
        // Any decision is acceptable except crashing or spinning; what matters is
        // that it returns, and that it does not report a loop as a safe local file.
        expect(["deny", "confirm", "allow"]).toContain(v.decision);
      });
    });
  });
});

describe("findProjectRoot", () => {
  it("finds the nearest ancestor holding a project marker", async () => {
    await fs.writeFile(path.join(root, "package.json"), "{}");
    expect(await findProjectRoot(root)).toBe(root);
    expect(await findProjectRoot(path.join(root, "src"))).toBe(root);
  });

  it("resolves a package inside a monorepo to the package, not the whole tree", async () => {
    // The nearest marker wins, so an agent run inside one service is bounded by
    // that service rather than by everything its siblings can see.
    const inner = path.join(root, "packages", "api");
    await fs.mkdir(inner, { recursive: true });
    await fs.writeFile(path.join(inner, "package.json"), "{}");
    expect(await findProjectRoot(inner)).toBe(inner);
    await fs.rm(path.join(root, "packages"), { recursive: true, force: true });
  });

  it("returns null outside any project", async () => {
    // `outside` has no marker of its own and its ancestors are temp dirs.
    expect(await findProjectRoot(outside)).toBeNull();
  });

  it("never treats the home directory as a project", async () => {
    // The rule that keeps `cd ~ && curvet agent ...` from opening the whole home
    // directory: a stray ~/.git or ~/Makefile is common, and home is exactly
    // where the conventional-names denylist stops being adequate.
    const home = process.env.HOME;
    expect(home).toBeTruthy();
    expect(await findProjectRoot(home!)).toBeNull();
  });
});

describe("write_file", () => {
  /** A context that can write, recording what it was shown. */
  function writeCtx(approve: boolean) {
    const shown: { path: string; added: number; removed: number; creating: boolean }[] = [];
    const backups: { file: string; original: string | null }[] = [];
    return {
      shown,
      backups,
      ctx: {
        cwd: root,
        confirm: async () => approve,
        confirmWrite: async (p: string, d: FileDiff, creating: boolean) => {
          shown.push({ path: p, added: d.added, removed: d.removed, creating });
          return approve;
        },
        backup: async (file: string, original: string | null) => {
          backups.push({ file, original });
        },
      } as ToolContext,
    };
  }

  it("shows a diff and writes when approved", async () => {
    const { ctx, shown } = writeCtx(true);
    const target = path.join(root, "src", "written.ts");
    const out = await execute(ctx, "write_file", { path: "src/written.ts", content: "export const a = 1;\n" });
    expect(out.ok).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0].creating).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("export const a = 1;\n");
    await fs.unlink(target);
  });

  it("writes NOTHING when declined", async () => {
    const { ctx } = writeCtx(false);
    const target = path.join(root, "src", "declined.ts");
    const out = await execute(ctx, "write_file", { path: "src/declined.ts", content: "nope" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/declined/);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it("tells the model not to retry a declined write with a variation", async () => {
    // Otherwise a refusal becomes a negotiation, and the user gets asked four
    // times about the same change in slightly different words.
    const { ctx } = writeCtx(false);
    const out = await execute(ctx, "write_file", { path: "src/x.ts", content: "y" });
    expect(out.error).toMatch(/Do not try again/i);
  });

  it("cannot write at all without a way to ask", async () => {
    // Absent confirmWrite means writes are impossible, never automatic.
    const ctx = { cwd: root, confirm: async () => true } as ToolContext;
    const out = await execute(ctx, "write_file", { path: "src/sneaky.ts", content: "x" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/cannot write/i);
  });

  it("never writes a secret, and never even asks", async () => {
    const { ctx, shown } = writeCtx(true);
    const out = await execute(ctx, "write_file", { path: ".env", content: "API_KEY=hijacked" });
    expect(out.ok).toBe(false);
    expect(shown).toHaveLength(0);
    expect(await fs.readFile(path.join(root, ".env"), "utf8")).toContain("super-secret-value");
  });

  it("DENIES a write through a symlinked directory, and creates nothing", async () => {
    // The escape this whole block exists for. `escape` is a link out of the
    // project; `notes-new.md` does not exist. If the parent is not resolved, this
    // reads as an ordinary local create and the file lands outside the project.
    const { ctx, shown } = writeCtx(true);
    await withLink(path.join(root, "escape"), outside, async () => {
      const out = await execute(ctx, "write_file", {
        path: "escape/notes-new.md",
        content: "written through a link",
      });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/outside this project/);
      expect(shown).toHaveLength(0);
      await expect(fs.access(path.join(outside, "notes-new.md"))).rejects.toThrow();
    });
  });

  it("DENIES a write through a DANGLING link, which would have created the target", async () => {
    const { ctx, shown } = writeCtx(true);
    await withLink(path.join(root, "pending.md"), path.join(outside, "created-by-link.md"), async () => {
      const out = await execute(ctx, "write_file", { path: "pending.md", content: "x" });
      expect(out.ok).toBe(false);
      expect(shown).toHaveLength(0);
      await expect(fs.access(path.join(outside, "created-by-link.md"))).rejects.toThrow();
    });
  });

  it("DENIES a write outside the project rather than confirming it", async () => {
    // Reading a sibling package is ordinary work. Writing to one is not something
    // an agent pointed at this repository should do, and a prompt would only be a
    // way to say yes to it at 2am.
    const { ctx, shown } = writeCtx(true);
    const out = await execute(ctx, "write_file", { path: "../elsewhere/notes.md", content: "overwritten" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/outside this project/);
    expect(shown).toHaveLength(0);
    expect(await fs.readFile(path.join(outside, "notes.md"), "utf8")).toContain("sibling file");
  });

  it("preserves the previous contents before overwriting", async () => {
    const { ctx, backups } = writeCtx(true);
    const target = path.join(root, "src", "index.ts");
    const before = await fs.readFile(target, "utf8");
    await execute(ctx, "write_file", { path: "src/index.ts", content: "export const hello = 2;\n" });
    expect(backups).toHaveLength(1);
    expect(backups[0].original).toBe(before);
    await fs.writeFile(target, before);
  });

  it("records a creation as having no previous contents, so undo deletes it", async () => {
    const { ctx, backups } = writeCtx(true);
    const target = path.join(root, "src", "fresh.ts");
    await execute(ctx, "write_file", { path: "src/fresh.ts", content: "new\n" });
    expect(backups[0].original).toBeNull();
    await fs.unlink(target);
  });

  it("does not stage a prompt for a write that changes nothing", async () => {
    // A confirmation with an empty diff teaches people that prompts are noise.
    const { ctx, shown } = writeCtx(true);
    const before = await fs.readFile(path.join(root, "src", "index.ts"), "utf8");
    const out = await execute(ctx, "write_file", { path: "src/index.ts", content: before });
    expect(out.ok).toBe(true);
    expect(out.content).toMatch(/already has exactly these contents/);
    expect(shown).toHaveLength(0);
  });

  it("a successful write is never recorded as automatic", async () => {
    // The executor refuses outright when there is no way to ask, so a write that
    // SUCCEEDED was approved by a person. Logging it as "auto" would understate it
    // in the one direction that matters when someone later asks who approved a
    // change. (The decision itself is derived in the command; this pins the
    // property it derives from: no approval, no write.)
    const ctx = { cwd: root, confirm: async () => true } as ToolContext;
    const out = await execute(ctx, "write_file", { path: "src/nope.ts", content: "x" });
    expect(out.ok).toBe(false);
  });

  it("insists on the complete contents rather than accepting a fragment shape", async () => {
    const { ctx } = writeCtx(true);
    const out = await execute(ctx, "write_file", { path: "src/x.ts" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/complete new contents/);
  });
});

describe("refusalReason", () => {
  it("tells a secret apart from a boundary, because they are different rules", async () => {
    // The one-shot renderer used to print "is a protected file" for both. A write
    // stopped by the project boundary is not a protected file, and saying so
    // teaches the user a rule that does not exist.
    const secret = refusalReason(denialMessage(".env", ".env file"));
    expect(secret).toMatch(/\.env file/);

    const ctx = { cwd: root, confirm: async () => true, confirmWrite: async () => true } as ToolContext;
    const out = await execute(ctx, "write_file", { path: "../elsewhere/x.md", content: "y" });
    expect(refusalReason(out.error)).toMatch(/outside this project/);
    expect(refusalReason(out.error)).not.toMatch(/protected file/);
  });

  it("never renders an empty line", () => {
    expect(refusalReason(undefined)).toBeTruthy();
    expect(refusalReason("")).toBeTruthy();
    expect(refusalReason("Refused: ")).toBeTruthy();
  });

  it("stops at the first sentence — the rest is written for the model", () => {
    // The tail ("Do not try another path to the same file…") is an instruction to
    // the model, and printing it at the user reads as the CLI addressing them.
    expect(refusalReason(denialMessage("k.pem", "private key or certificate"))).not.toMatch(/Do not try/i);
  });
});

describe("needsBlanketConfirm", () => {
  it("asks only about reads that would otherwise pass silently", async () => {
    const inside = await classifyPath(root, "src/index.ts");
    expect(needsBlanketConfirm(inside, true)).toBe(true);
  });

  it("does not double-ask about a file outside the project", async () => {
    // The outside-project gate has its own prompt, and it is the better one — it
    // names the real destination. Two differently-worded questions about one read
    // is how people learn to answer `y` without reading either.
    const outsideFile = await classifyPath(root, "../elsewhere/notes.md");
    expect(outsideFile.decision).toBe("confirm");
    expect(needsBlanketConfirm(outsideFile, true)).toBe(false);
  });

  it("never asks about something already denied", async () => {
    const secret = await classifyPath(root, ".env");
    expect(needsBlanketConfirm(secret, true)).toBe(false);
  });

  it("asks about nothing when the flag is off", async () => {
    const inside = await classifyPath(root, "src/index.ts");
    expect(needsBlanketConfirm(inside, false)).toBe(false);
  });
});

describe("the executors enforce it", () => {
  it("reads a project file, with line numbers so the model can ask for a range", async () => {
    const out = await execute(ctxWith(true), "read_file", { path: "src/index.ts" });
    expect(out.ok).toBe(true);
    expect(out.content).toContain("hello");
    expect(out.content).toMatch(/^\s*1\t/);
  });

  it("never opens a secret, and tells the model not to try another way in", async () => {
    const ctx = ctxWith(true); // would say yes — must never be asked
    const out = await execute(ctx, "read_file", { path: ".env" });
    expect(out.ok).toBe(false);
    expect(out.content).toBeUndefined();
    expect(out.error).not.toContain("super-secret-value");
    expect(out.error).toMatch(/Do not try another path/);
    expect(ctx.asked).toHaveLength(0);
  });

  it("asks before reading outside the project, and honours a no", async () => {
    const yes = ctxWith(true);
    const allowed = await execute(yes, "read_file", { path: "../elsewhere/notes.md" });
    expect(yes.asked).toHaveLength(1);
    expect(allowed.ok).toBe(true);
    expect(allowed.content).toContain("sibling file");

    const no = ctxWith(false);
    const refused = await execute(no, "read_file", { path: "../elsewhere/notes.md" });
    expect(refused.ok).toBe(false);
    expect(refused.content).toBeUndefined();
    expect(refused.error).toMatch(/declined/);
  });

  it("grep skips files it would have had to ask about, rather than prompting per file", async () => {
    // A walk that prompts dozens of times is a walk the user rubber-stamps.
    const ctx = ctxWith(true);
    const out = await execute(ctx, "grep", { pattern: "secret|sibling" });
    expect(out.ok).toBe(true);
    expect(out.content).not.toContain("super-secret-value");
    expect(out.content).not.toContain("sibling file");
  });

  it("grep never reports a line out of a secret it walked past", async () => {
    const out = await execute(ctxWith(true), "grep", { pattern: "API_KEY" });
    expect(out.ok).toBe(true);
    expect(out.content).not.toContain("super-secret-value");
  });

  it("list_dir shows the project without descending into node_modules", async () => {
    await fs.mkdir(path.join(root, "node_modules", "junk"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules", "junk", "a.js"), "1");
    const out = await execute(ctxWith(true), "list_dir", { path: ".", recursive: true });
    expect(out.ok).toBe(true);
    expect(out.content).toContain("src/");
    expect(out.content).not.toContain("node_modules");
  });

  it("refuses a tool it does not implement rather than pretending", async () => {
    for (const name of ["run_command", "delete_file", "apply_patch"]) {
      const out = await execute(ctxWith(true), name, { path: "x" });
      expect(out.ok, name).toBe(false);
      expect(out.error, name).toMatch(/cannot run/);
    }
  });

  it("reports a missing file as a fact, not a crash", async () => {
    const out = await execute(ctxWith(true), "read_file", { path: "src/nope.ts" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/does not exist/);
  });

  it("declares truncation instead of silently returning half a file", async () => {
    // A silently truncated read produces confident wrong edits.
    const big = path.join(root, "big.txt");
    await fs.writeFile(big, Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n"));
    const out = await execute(ctxWith(true), "read_file", { path: "big.txt" });
    expect(out.ok).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.content).toMatch(/more lines/);
    await fs.unlink(big);
  });

  it("a line range is honoured and not capped as a whole-file read", async () => {
    const big = path.join(root, "big2.txt");
    await fs.writeFile(big, Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n"));
    const out = await execute(ctxWith(true), "read_file", { path: "big2.txt", start_line: 4990, end_line: 4995 });
    expect(out.ok).toBe(true);
    expect(out.truncated).toBe(false);
    expect(out.content).toContain("line 4989");
    await fs.unlink(big);
  });

  it("refuses a binary file rather than returning mojibake", async () => {
    const bin = path.join(root, "blob.bin");
    await fs.writeFile(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const out = await execute(ctxWith(true), "read_file", { path: "blob.bin" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/binary/);
    await fs.unlink(bin);
  });

  it("reports a bad regular expression instead of throwing", async () => {
    const out = await execute(ctxWith(true), "grep", { pattern: "unclosed(" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not a valid regular expression/);
  });

  it("grep finds a match and says where it is", async () => {
    const out = await execute(ctxWith(true), "grep", { pattern: "codename", glob: "*.json" });
    expect(out.ok).toBe(true);
    expect(out.content).toMatch(/settings\.json:1:/);
  });
});
