import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeAttachResolver } from "../src/mcp/local.js";
import type { Curvet } from "@curvet/sdk";

/**
 * The attachment gate.
 *
 * `curvet agent` CONFIRMS a read outside the project. This refuses it, because
 * there is no terminal to confirm on — non-negotiable #4. That difference is the
 * point of these tests: the same classifier, a stricter answer.
 */

let root: string;
const parked: { name: string }[] = [];

const client = {
  agency: {
    async attach({ name }: { name: string }) {
      parked.push({ name });
      return { id: `parked_${parked.length}`, name, type: "application/pdf", size: 1 };
    },
  },
} as unknown as Curvet;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "curvet-mcp-"));
  await fs.mkdir(path.join(root, ".git"));
  parked.length = 0;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("attach", () => {
  it("inlines a text file", async () => {
    await fs.writeFile(path.join(root, "notes.md"), "# hello");
    const out = await makeAttachResolver(client, root)("notes.md");
    expect(out).toEqual({ ok: true, attachment: { name: "notes.md", content: "# hello" } });
  });

  it("parks a PDF as bytes rather than transcribing it", async () => {
    await fs.writeFile(path.join(root, "invoice.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46]));
    const out = await makeAttachResolver(client, root)("invoice.pdf");
    expect(out.ok && out.attachment.id).toBe("parked_1");
    expect(out.ok && out.attachment.content).toBeUndefined();
    expect(parked).toEqual([{ name: "invoice.pdf" }]);
  });

  it("refuses a secret before opening it", async () => {
    await fs.writeFile(path.join(root, ".env"), "OPENAI_API_KEY=sk-real");
    const out = await makeAttachResolver(client, root)(".env");
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/\.env/);
    // The refusal must not carry the thing it refused.
    expect(JSON.stringify(out)).not.toContain("sk-real");
  });

  it("refuses a file outside the project rather than asking", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "curvet-outside-"));
    await fs.writeFile(path.join(outside, "elsewhere.txt"), "data");
    try {
      const out = await makeAttachResolver(client, root)(path.join(outside, "elsewhere.txt"));
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toContain("outside the project");
      // It says what the user could do instead, rather than only refusing.
      expect(out.ok === false && out.reason).toContain("curvet agent");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a secret reached through a symlink inside the project", async () => {
    // A link inside the project pointing at credentials is inside the project
    // only as a string. This is how a path jail gets defeated.
    const secrets = await fs.mkdtemp(path.join(os.tmpdir(), "curvet-secret-"));
    await fs.writeFile(path.join(secrets, "id_rsa"), "PRIVATE KEY");
    try {
      await fs.symlink(path.join(secrets, "id_rsa"), path.join(root, "innocent.txt"));
      const out = await makeAttachResolver(client, root)("innocent.txt");
      expect(out.ok).toBe(false);
      expect(JSON.stringify(out)).not.toContain("PRIVATE KEY");
    } finally {
      await fs.rm(secrets, { recursive: true, force: true });
    }
  });

  it("says a directory is a directory", async () => {
    await fs.mkdir(path.join(root, "src"));
    const out = await makeAttachResolver(client, root)("src");
    expect(out.ok === false && out.reason).toContain("directory");
  });

  it("says a missing file is missing rather than failing obscurely", async () => {
    const out = await makeAttachResolver(client, root)("nope.txt");
    expect(out.ok === false && out.reason).toContain("does not exist");
  });

  it("cuts an oversized text file and says so in the text itself", async () => {
    await fs.writeFile(path.join(root, "big.txt"), "x".repeat(120_000));
    const out = await makeAttachResolver(client, root)("big.txt");
    expect(out.ok).toBe(true);
    // The model reads the content, not the metadata, so the loss is stated there.
    expect(out.ok && out.attachment.content).toContain("was cut at");
  });
});
