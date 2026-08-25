import path from "node:path";
import { promises as fs } from "node:fs";
import { classifyPath, secretReason } from "./permissions.js";
import { MAX_RESULT_CHARS } from "./tools.js";

/**
 * `@` file mentions.
 *
 * Typing `@src/server.ts` in a message attaches that file, so the model reads it
 * instead of spending two or three turns hunting for a path the user already
 * knew. That is the whole feature: the turns it removes are the ones where the
 * model greps, guesses a name, reads the wrong file and tries again — each a
 * round trip, and each landing in the context permanently.
 *
 * ── This is a read of the user's disk, and it is gated like one ─────────────
 *
 * An attachment is sent to the server and kept in that run's history, so it goes
 * through `classifyPath` exactly as `read_file` does. Secrets are refused, files
 * outside the project are confirmed.
 *
 * The threat model IS different here, and it is worth being explicit about how.
 * A `read_file` path may have been chosen by a model reasoning about text it
 * scraped a moment ago; a mention was typed by the person at the keyboard. So
 * this is not defending against a hostile suggestion. It is defending against
 * the ordinary mistake: `@.env` is two keystrokes and a tab completion away, and
 * the cost of getting it wrong — credentials in a prompt, in a server-side run
 * history, in a model's context — is invisible at the moment of typing and
 * cannot be taken back afterwards.
 *
 * So a secret is refused, with a message saying what to do instead. That is the
 * same answer `read_file` gives, for the same reason.
 */

/** How much of one attached file to send before truncating it. */
export const MAX_MENTION_CHARS = 24_000;
/** Total across every attachment in one message. Attachments ride every turn. */
export const MAX_MENTIONS_TOTAL = MAX_RESULT_CHARS;
/** Most files one message may attach. */
export const MAX_MENTIONS = 10;
/**
 * Most files one message may UPLOAD. Agency keeps five attachments per run and
 * drops the rest silently, so stopping at five here is what lets us say which
 * ones did not go rather than leaving the user to notice later.
 */
export const MAX_UPLOADS = 5;

/**
 * Extensions the server can actually read as a file rather than as text.
 *
 * Deliberately the set agency/attachmentExtract classifies — PDFs, the four image
 * types, and Excel. Anything else binary is still refused, because uploading a
 * `.zip` or a `.mp4` costs the transfer and the storage and then the model cannot
 * open it either.
 */
const UPLOADABLE = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "xlsx", "xlsm", "xltx"]);

/** 50MB, matching the server's own limit, so an oversized file fails here. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function extOf(p: string): string {
  return (p.split(/[\\/]/).pop() ?? "").split(".").pop()?.toLowerCase() ?? "";
}

export interface Mention {
  /** Exactly as typed, `@` included, so it can be found in the text again. */
  raw: string;
  /** The path part. */
  path: string;
}

/**
 * Every `@path` in a message.
 *
 * The `@` must start the string or follow whitespace, which is what keeps
 * `hello@curvet.in` from reading as an attachment of `curvet.in`. A quoted form,
 * `@"src/my file.ts"`, carries paths with spaces.
 */
export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  const re = /(^|\s)@(?:"([^"\n]+)"|([^\s"]+))/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const quoted = m[2] !== undefined;
    // Trailing punctuation belongs to the sentence, not the path: "look at
    // @src/a.ts, then…" means src/a.ts. Left alone inside quotes, where the user
    // has said exactly what they mean.
    const p = quoted ? m[2] : (m[3] ?? "").replace(/[.,;:!?)\]}]+$/, "");
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push({ raw: quoted ? `@"${p}"` : `@${p}`, path: p });
  }
  return out;
}

export interface ResolvedMention {
  path: string;
  attached: boolean;
  /** Why not, when it was not. Written for the person who typed it. */
  reason?: string;
  content?: string;
  truncated?: boolean;
  /** Set when the file was UPLOADED rather than pasted into the message. */
  upload?: { id: string; name: string; bytes: number };
}

/** A file parked server-side, ready to be named in `agency.run({ attachments })`. */
export interface UploadedAttachment {
  id: string;
  name: string;
}

export interface ResolveOptions {
  cwd: string;
  /**
   * Park a binary file server-side and return its id.
   *
   * Absent means there is nowhere to put one — an offline caller, or a test —
   * and binaries are refused exactly as they were before this existed. That is
   * the same shape as `confirm`: no facility, no action, said out loud.
   */
  upload?: (file: { name: string; bytes: Buffer }) => Promise<{ id: string; name: string }>;
  /**
   * Ask about a file outside the project. Absent means there is nobody to ask,
   * which is a refusal — the same rule the tools follow.
   */
  confirm?: (question: string, detail?: string) => Promise<boolean>;
}

/** Read one mentioned file, or explain why it was not read. */
async function resolveOne(opts: ResolveOptions, p: string): Promise<ResolvedMention> {
  const verdict = await classifyPath(opts.cwd, p);

  if (verdict.decision === "deny") {
    return {
      path: p,
      attached: false,
      reason:
        `refused — ${verdict.matched}. Attaching it would put it in this run's history on the server. ` +
        "Paste the part you are willing to share instead.",
    };
  }

  if (verdict.decision === "confirm") {
    if (!opts.confirm) {
      return { path: p, attached: false, reason: "outside the project, and there is no terminal to confirm it" };
    }
    const allowed = await opts.confirm(
      "Attach a file OUTSIDE this project?",
      `  ${verdict.display}\n  It is sent with your message and kept in the run's history.`,
    );
    if (!allowed) return { path: p, attached: false, reason: "you declined to attach it" };
  }

  let stat;
  try {
    stat = await fs.stat(verdict.abs);
  } catch {
    return { path: p, attached: false, reason: "no such file" };
  }
  if (stat.isDirectory()) {
    return { path: p, attached: false, reason: "that is a directory — mention a file" };
  }

  // A file the server can read AS A FILE goes up as bytes rather than being pasted
  // in as text. This is the older approach the parked-upload path was written to
  // replace: a PDF transcribed into the prompt loses its layout, tables and charts,
  // and a photo cannot be transcribed at all — which is why `@photo.jpg` used to be
  // refused outright rather than merely degraded.
  if (UPLOADABLE.has(extOf(verdict.abs))) {
    if (!opts.upload) {
      return { path: p, attached: false, reason: "this client cannot upload files" };
    }
    if (stat.size > MAX_UPLOAD_BYTES) {
      return { path: p, attached: false, reason: `it is ${Math.round(stat.size / 1024 / 1024)}MB, over the 50MB limit` };
    }
    if (stat.size === 0) {
      return { path: p, attached: false, reason: "that file is empty" };
    }
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(verdict.abs);
    } catch (err) {
      return { path: p, attached: false, reason: (err as Error).message };
    }
    const name = path.basename(verdict.abs);
    try {
      const parked = await opts.upload({ name, bytes });
      return { path: p, attached: true, upload: { id: parked.id, name: parked.name || name, bytes: stat.size } };
    } catch (err) {
      // Say what actually happened. "Attachment failed" sends the user to check the
      // file when the answer is usually the network or their credit balance.
      return { path: p, attached: false, reason: `upload failed — ${(err as Error).message}` };
    }
  }

  let text: string;
  try {
    text = await fs.readFile(verdict.abs, "utf8");
  } catch (err) {
    return { path: p, attached: false, reason: (err as Error).message };
  }

  // A binary file read as utf8 is a screenful of replacement characters that
  // teaches the model nothing and costs a fortune to carry. A NUL byte near the
  // start is the cheap, boring test for one.
  if (text.slice(0, 8_000).includes("\u0000")) {
    return {
      path: p,
      attached: false,
      reason: "that looks like a binary file — only PDFs, images and spreadsheets can be uploaded",
    };
  }

  const truncated = text.length > MAX_MENTION_CHARS;
  return {
    path: p,
    attached: true,
    content: truncated ? text.slice(0, MAX_MENTION_CHARS) : text,
    truncated,
  };
}

export interface ResolvedMessage {
  /** What to send: the user's own words, with the attachments appended. */
  task: string;
  resolved: ResolvedMention[];
  /** Files parked server-side. Pass straight to `agency.run({ attachments })`. */
  attachments: UploadedAttachment[];
}

/**
 * Turn a message containing `@path` into the message the server should see.
 *
 * The user's text is left EXACTLY as typed — `@src/foo.ts` stays in the
 * sentence, because that is what they wrote and it reads correctly to the model
 * as a reference. The contents are appended below under a heading that says
 * where they came from and that the user chose them, so the model does not
 * treat an attachment as something it discovered.
 */
export async function resolveMentions(text: string, opts: ResolveOptions): Promise<ResolvedMessage> {
  const mentions = parseMentions(text).slice(0, MAX_MENTIONS);
  if (!mentions.length) return { task: text, resolved: [], attachments: [] };

  const resolved: ResolvedMention[] = [];
  let budget = MAX_MENTIONS_TOTAL;

  let uploads = 0;
  for (const m of mentions) {
    // The server keeps five attachments per run and drops the rest WITHOUT
    // saying so. Stopping here is what turns that into something the user is
    // told, rather than a sixth photo that quietly never existed.
    if (uploads >= MAX_UPLOADS && UPLOADABLE.has(extOf(m.path))) {
      resolved.push({ path: m.path, attached: false, reason: `only ${MAX_UPLOADS} files can be uploaded per message` });
      continue;
    }
    const r = await resolveOne(opts, m.path);
    if (r.upload) uploads++;
    if (r.attached && r.content !== undefined) {
      if (r.content.length > budget) {
        // Truncate rather than drop: part of a file the user asked for is more
        // use than a note saying they asked for it.
        r.content = r.content.slice(0, Math.max(0, budget));
        r.truncated = true;
      }
      budget -= r.content.length;
    }
    resolved.push(r);
  }

  const attached = resolved.filter((r) => r.attached && r.content);
  const uploaded = resolved.filter((r) => r.upload);
  const failed = resolved.filter((r) => !r.attached);

  const parts = [text.trim()];
  if (attached.length) {
    parts.push(
      "",
      "--- Files the user attached to this message with @ ---",
      "Their full contents are below, current as of now. Do NOT call read_file on these paths —",
      "you already have them. Read one only if you need a part that is marked truncated.",
    );
    for (const a of attached) {
      parts.push("", `### ${a.path}`, "```", (a.content ?? "").replace(/\s*$/, ""), "```");
      if (a.truncated) {
        parts.push(`[... truncated. Use read_file with a line range for the rest of ${a.path} ...]`);
      }
    }
  }
  if (uploaded.length) {
    // The bytes are NOT in this text — they reach the model as content blocks. What
    // goes here is the naming, because the media tools address a source by file name
    // and the model needs to know which names it may use.
    parts.push(
      "",
      "--- Files the user attached to this message with @ ---",
      "These are attached to this conversation as files and you can see them directly.",
      "Refer to one by its NAME (for example as `source` on generate_image):",
    );
    for (const u of uploaded) parts.push(`${u.upload!.name}  (from ${u.path})`);
  }
  if (failed.length) {
    // Tell the model too, not only the user. Otherwise it sees a reference to a
    // file that is not there and quietly assumes it was irrelevant.
    parts.push("", "--- Mentioned but NOT attached ---");
    for (const f of failed) parts.push(`${f.path} — ${f.reason}`);
  }

  return {
    task: parts.join("\n"),
    resolved,
    attachments: uploaded.map((u) => ({ id: u.upload!.id, name: u.upload!.name })),
  };
}

/** Directories never worth offering in a picker, and never worth walking. */
const SKIP = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage",
  ".venv", "venv", "__pycache__", ".cache", "vendor", "target", ".turbo",
]);

/**
 * Project-relative paths for the `@` picker.
 *
 * Bounded on purpose: a picker over a monorepo must not walk the whole thing
 * before the next keystroke. The cap counts files COLLECTED, so a huge tree
 * stops early rather than sorting a hundred thousand entries.
 */
export async function listProjectFiles(root: string, limit = 4_000): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= limit || depth > 8) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
        await walk(abs, depth + 1);
      } else if (e.isFile()) {
        // Never offer what would only be refused a moment later.
        if (secretReason(abs)) continue;
        out.push(path.relative(root, abs));
      }
    }
  }
  await walk(root, 0);
  return out.sort();
}

/**
 * Files matching what has been typed after `@`, best first.
 *
 * Substring over the whole path, then a basename hit beats a directory hit:
 * typing `server` should offer `src/server.ts` before `src/server/util.ts`,
 * because the file you named is more likely the file you meant.
 */
export function matchFiles(files: string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  if (!q) return files.slice(0, limit);
  return files
    .filter((f) => f.toLowerCase().includes(q))
    .sort((a, b) => {
      const ab = path.basename(a).toLowerCase().includes(q) ? 0 : 1;
      const bb = path.basename(b).toLowerCase().includes(q) ? 0 : 1;
      return ab - bb || a.length - b.length || a.localeCompare(b);
    })
    .slice(0, limit);
}

/** The `@fragment` currently being typed at the end of the input, if any. */
export function activeMention(input: string): string | null {
  const m = /(^|\s)@([^\s"]*)$/.exec(input);
  return m ? m[2] : null;
}

/** Replace the `@fragment` being typed with a chosen path, ready to keep typing. */
export function applyCompletion(input: string, file: string): string {
  const replacement = /\s/.test(file) ? `@"${file}"` : `@${file}`;
  return `${input.replace(/(^|\s)@([^\s"]*)$/, (_m, lead) => `${lead}${replacement}`)} `;
}
