import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyPath, secretReason, isInside } from "../src/agent/permissions.js";
import { execute, type ToolContext } from "../src/agent/tools.js";

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
    const out = await execute(ctxWith(true), "write_file", { path: "x", content: "y" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/cannot run/);
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
