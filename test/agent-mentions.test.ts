import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseMentions,
  resolveMentions,
  listProjectFiles,
  matchFiles,
  activeMention,
  applyCompletion,
  MAX_MENTION_CHARS,
} from "../src/agent/mentions.js";

/**
 * `@` file mentions.
 *
 * Two things carry the weight here. The parser has to tell a path from an email
 * address, because getting that wrong attaches nothing and confuses everyone.
 * And a mention is a READ of the user's disk that gets sent to a server and kept
 * in a run's history, so it obeys the same boundary the tools do.
 */

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "curvet-at-")));
  root = path.join(base, "project");
  outside = path.join(base, "elsewhere");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "junk"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), "{}");
  await fs.writeFile(path.join(root, "src", "server.ts"), "export const port = 3000;\n");
  await fs.writeFile(path.join(root, "src", "util.ts"), "export const noop = () => {};\n");
  await fs.writeFile(path.join(root, "README.md"), "# demo\n");
  await fs.writeFile(path.join(root, ".env"), "API_KEY=super-secret\n");
  await fs.writeFile(path.join(root, "node_modules", "junk", "index.js"), "module.exports = 1;\n");
  await fs.writeFile(path.join(outside, "notes.md"), "a sibling file\n");
});

describe("parseMentions", () => {
  it("finds a path after @", () => {
    expect(parseMentions("look at @src/server.ts please").map((m) => m.path)).toEqual(["src/server.ts"]);
  });

  it("does NOT treat an email address as a mention", () => {
    // The `@` has to start the message or follow whitespace. Otherwise every
    // message about emailing someone attaches a domain name.
    expect(parseMentions("email hello@curvet.in about it")).toEqual([]);
    expect(parseMentions("ping a.b@c.co and x@y.z")).toEqual([]);
  });

  it("takes a mention at the very start", () => {
    expect(parseMentions("@README.md what is this").map((m) => m.path)).toEqual(["README.md"]);
  });

  it("drops trailing sentence punctuation, which belongs to the sentence", () => {
    expect(parseMentions("read @src/server.ts, then @src/util.ts.").map((m) => m.path)).toEqual([
      "src/server.ts",
      "src/util.ts",
    ]);
  });

  it("keeps punctuation inside quotes, where the user said what they meant", () => {
    expect(parseMentions('open @"src/odd name, v2.ts" now').map((m) => m.path)).toEqual([
      "src/odd name, v2.ts",
    ]);
  });

  it("mentions the same file once, however many times it is written", () => {
    expect(parseMentions("@a.ts and @a.ts again").map((m) => m.path)).toEqual(["a.ts"]);
  });

  it("finds nothing in a message with no mentions", () => {
    expect(parseMentions("just a normal message")).toEqual([]);
    expect(parseMentions("an @ on its own")).toEqual([]);
  });
});

describe("resolveMentions attaches the file", () => {
  it("appends the contents and leaves the user's words alone", () => {
    return resolveMentions("what does @src/server.ts do", { cwd: root }).then(({ task, resolved }) => {
      expect(resolved[0].attached).toBe(true);
      // The sentence the user wrote survives verbatim — the reference reads
      // correctly to the model, and it is what the transcript shows.
      expect(task.startsWith("what does @src/server.ts do")).toBe(true);
      expect(task).toContain("### src/server.ts");
      expect(task).toContain("export const port = 3000;");
      expect(task).toContain("Files the user attached");
    });
  });

  it("leaves a message with no mentions completely untouched", async () => {
    const { task, resolved } = await resolveMentions("hello there", { cwd: root });
    expect(task).toBe("hello there");
    expect(resolved).toEqual([]);
  });

  it("attaches several files in one message", async () => {
    const { task, resolved } = await resolveMentions("@src/server.ts @src/util.ts", { cwd: root });
    expect(resolved.filter((r) => r.attached)).toHaveLength(2);
    expect(task).toContain("### src/server.ts");
    expect(task).toContain("### src/util.ts");
  });

  it("truncates a huge file and says so, rather than dropping it", async () => {
    await fs.writeFile(path.join(root, "big.txt"), "x".repeat(MAX_MENTION_CHARS + 5_000));
    const { task, resolved } = await resolveMentions("@big.txt", { cwd: root });
    expect(resolved[0].attached).toBe(true);
    expect(resolved[0].truncated).toBe(true);
    expect(task).toContain("truncated");
    expect(task).toContain("read_file");
  });
});

describe("resolveMentions refuses what read_file would refuse", () => {
  it("never attaches a secret, and says what to do instead", async () => {
    // Two keystrokes and a tab completion away, and irreversible: the value
    // lands in a prompt, in the run's history on the server, and in the model's
    // context. The user typed it deliberately; they did not choose those three.
    const { task, resolved } = await resolveMentions("check @.env", { cwd: root });
    expect(resolved[0].attached).toBe(false);
    expect(resolved[0].reason).toMatch(/\.env file/);
    expect(resolved[0].reason).toMatch(/Paste the part/);
    expect(task).not.toContain("super-secret");
  });

  it("tells the MODEL a mention was not attached, not only the user", async () => {
    // Otherwise the model sees a reference to a file that is not there and
    // quietly decides it was irrelevant.
    const { task } = await resolveMentions("check @.env", { cwd: root });
    expect(task).toContain("NOT attached");
    expect(task).toContain(".env");
  });

  it("asks before attaching a file outside the project", async () => {
    const asked: string[] = [];
    const { resolved } = await resolveMentions(`@${path.join(outside, "notes.md")}`, {
      cwd: root,
      confirm: async (q) => {
        asked.push(q);
        return true;
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/OUTSIDE this project/);
    expect(resolved[0].attached).toBe(true);
  });

  it("refuses an outside file when there is nobody to ask", async () => {
    const { resolved } = await resolveMentions(`@${path.join(outside, "notes.md")}`, { cwd: root });
    expect(resolved[0].attached).toBe(false);
    expect(resolved[0].reason).toMatch(/no terminal/);
  });

  it("honours a declined confirmation", async () => {
    const { task, resolved } = await resolveMentions(`@${path.join(outside, "notes.md")}`, {
      cwd: root,
      confirm: async () => false,
    });
    expect(resolved[0].attached).toBe(false);
    expect(task).not.toContain("a sibling file");
  });

  it("says so when the file is not there", async () => {
    const { resolved } = await resolveMentions("@src/ghost.ts", { cwd: root });
    expect(resolved[0].attached).toBe(false);
    expect(resolved[0].reason).toMatch(/no such file/);
  });

  it("refuses a directory", async () => {
    const { resolved } = await resolveMentions("@src", { cwd: root });
    expect(resolved[0].attached).toBe(false);
    expect(resolved[0].reason).toMatch(/directory/);
  });

  it("refuses a binary file it cannot upload rather than carrying a screenful of noise", async () => {
    // A .bin is not a type the server can read AS a file, so pasting it in as text
    // is the only option and it is a bad one — replacement characters that teach the
    // model nothing and cost a fortune to carry on every turn.
    await fs.writeFile(path.join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const { resolved } = await resolveMentions("@blob.bin", { cwd: root, upload: async () => ({ id: "x", name: "x" }) });
    expect(resolved[0].attached).toBe(false);
    expect(resolved[0].reason).toMatch(/binary/);
  });
});

describe("uploading a mentioned file", () => {
  // `@photo.jpg` used to be refused outright. Pasting a photo in as text is not a
  // degraded version of attaching it, it is impossible — which is why this goes up
  // as bytes and comes back as an id the run can name.
  let root: string;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mention-upload-"));
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  function uploader() {
    const calls: { name: string; bytes: Buffer }[] = [];
    const fn = async (f: { name: string; bytes: Buffer }) => {
      calls.push(f);
      return { id: `f_${calls.length}`, name: f.name };
    };
    return { fn, calls };
  }

  it("uploads an image and hands back an id for the run", async () => {
    await fs.writeFile(path.join(root, "photo.png"), png);
    const up = uploader();
    const { resolved, attachments, task } = await resolveMentions("edit @photo.png please", { cwd: root, upload: up.fn });

    expect(resolved[0].attached).toBe(true);
    expect(up.calls[0].name).toBe("photo.png");
    expect(up.calls[0].bytes.equals(png)).toBe(true);
    expect(attachments).toEqual([{ id: "f_1", name: "photo.png" }]);

    // The bytes are NOT pasted into the message — they reach the model as content
    // blocks. What the text carries is the NAME, because that is the handle the
    // media tools take as `source`.
    expect(task).not.toContain(png.toString("base64"));
    expect(task).toContain("photo.png");
    expect(task).toMatch(/source.*generate_image|generate_image/);
  });

  it("does not upload a text file it can simply read", async () => {
    await fs.writeFile(path.join(root, "notes.md"), "# hello");
    const up = uploader();
    const { attachments, task } = await resolveMentions("@notes.md", { cwd: root, upload: up.fn });
    expect(up.calls).toHaveLength(0);
    expect(attachments).toEqual([]);
    expect(task).toContain("# hello");
  });

  it("refuses to upload with no uploader, rather than pretending", async () => {
    await fs.writeFile(path.join(root, "photo.png"), png);
    const { resolved, attachments } = await resolveMentions("@photo.png", { cwd: root });
    expect(resolved[0].attached).toBe(false);
    expect(resolved[0].reason).toMatch(/cannot upload/);
    expect(attachments).toEqual([]);
  });

  it("stops at five uploads and says which ones did not go", async () => {
    // Agency keeps five attachments per run and drops the rest WITHOUT saying so.
    // The sixth photo has to fail loudly here or it quietly never existed.
    for (let i = 1; i <= 6; i++) await fs.writeFile(path.join(root, `p${i}.png`), png);
    const up = uploader();
    const { resolved, attachments } = await resolveMentions(
      "@p1.png @p2.png @p3.png @p4.png @p5.png @p6.png",
      { cwd: root, upload: up.fn },
    );
    expect(attachments).toHaveLength(5);
    expect(up.calls).toHaveLength(5);
    const sixth = resolved.find((r) => r.path === "p6.png");
    expect(sixth?.attached).toBe(false);
    expect(sixth?.reason).toMatch(/5 files/);
  });

  it("a secret is still refused, whatever its extension", async () => {
    // The upload branch must sit BEHIND classifyPath, not beside it. A .png named
    // like a key is contrived; `@credentials.json`-style mistakes are not.
    await fs.mkdir(path.join(root, ".ssh"), { recursive: true });
    await fs.writeFile(path.join(root, ".ssh", "id_rsa.png"), png);
    const up = uploader();
    const { resolved, attachments } = await resolveMentions("@.ssh/id_rsa.png", { cwd: root, upload: up.fn });
    expect(resolved[0].attached).toBe(false);
    expect(up.calls).toHaveLength(0);
    expect(attachments).toEqual([]);
  });

  it("an upload that fails says why, and does not become an attachment", async () => {
    await fs.writeFile(path.join(root, "photo.png"), png);
    const { resolved, attachments } = await resolveMentions("@photo.png", {
      cwd: root,
      upload: async () => { throw new Error("not enough credits"); },
    });
    expect(resolved[0].attached).toBe(false);
    expect(resolved[0].reason).toMatch(/not enough credits/);
    expect(attachments).toEqual([]);
  });
});

describe("the picker", () => {
  it("lists project files and skips the noise", async () => {
    const files = await listProjectFiles(root);
    expect(files).toContain(path.join("src", "server.ts"));
    expect(files).toContain("README.md");
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it("never offers a file it would then refuse", async () => {
    // Offering `.env` in a picker and refusing it a keystroke later is a worse
    // experience than not offering it.
    const files = await listProjectFiles(root);
    expect(files).not.toContain(".env");
  });

  it("puts a basename match above a directory match", () => {
    const files = ["src/server/util.ts", "src/server.ts", "docs/server-notes.md"];
    expect(matchFiles(files, "server")[0]).toBe("src/server.ts");
  });

  it("knows when an @ is being typed, and when it is not", () => {
    expect(activeMention("look at @src/ser")).toBe("src/ser");
    expect(activeMention("look at @")).toBe("");
    expect(activeMention("look at @src/a.ts ")).toBeNull();
    expect(activeMention("no mention here")).toBeNull();
    expect(activeMention("mail me at bob@")).toBeNull();
  });

  it("completes the fragment being typed, and leaves room to keep typing", () => {
    expect(applyCompletion("what does @src/ser", "src/server.ts")).toBe("what does @src/server.ts ");
    expect(applyCompletion("@", "README.md")).toBe("@README.md ");
  });

  it("quotes a completion that contains a space", () => {
    expect(applyCompletion("open @odd", "src/odd name.ts")).toBe('open @"src/odd name.ts" ');
  });
});
