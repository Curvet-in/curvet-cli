import path from "node:path";
import { promises as fs } from "node:fs";
import { classifyPath, denialMessage } from "./permissions.js";
import { diffLines, type FileDiff } from "./diff.js";

/**
 * The tools that run on this machine.
 *
 * Five of them: three that read, and two that change files — `write_file` for
 * whole contents, `edit_file` for an exact replacement inside one. Nothing here
 * deletes or executes, and the client declares only what is in this file, so a
 * run cannot ask for a capability that has not shipped.
 *
 * ── On limits ───────────────────────────────────────────────────────────────
 *
 * Every character returned here is re-sent to the model on every later turn of
 * the run, so an oversized result does not cost once, it costs QUADRATICALLY
 * over the remaining turns. Hence the caps below, and hence declaring truncation
 * rather than trimming quietly: a model that knows it got half a file narrows
 * its next request, while one that does not simply believes the half.
 *
 * The numbers are borrowed from Cline, which has had them in production far
 * longer than we have.
 */

/** Most characters any single result may carry. */
export const MAX_RESULT_CHARS = 48_000;
/** Most lines a whole-file read returns before it insists on a range. */
export const MAX_READ_LINES = 2_000;
/** Most characters kept per line. Defangs minified bundles and long log lines. */
export const MAX_LINE_CHARS = 2_000;
/** Most entries a directory listing returns. */
export const MAX_DIR_ENTRIES = 300;
/** Most matches a search returns before it insists on a narrower pattern. */
export const MAX_GREP_RESULTS = 100;
/** Files skipped when walking. Reading them helps nobody and costs a fortune. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage",
  ".venv", "venv", "__pycache__", ".cache", "vendor", "target", ".turbo",
]);

export interface ToolOutcome {
  ok: boolean;
  content?: string;
  error?: string;
  truncated?: boolean;
}

export interface ToolContext {
  cwd: string;
  /** Ask the human. Returns false when there is nobody to ask — never assumes yes. */
  confirm: (question: string, detail?: string) => Promise<boolean>;
  /**
   * Show a diff and ask whether to apply it. Separate from `confirm` because it
   * renders, and rendering belongs to whoever owns the terminal.
   *
   * Absent means writes are impossible, not automatic. A caller that has not
   * supplied a way to ask has not earned the right to skip asking.
   */
  confirmWrite?: (path: string, diff: FileDiff, creating: boolean) => Promise<boolean>;
  /**
   * Preserve a file's previous contents before it is overwritten, so the write
   * can be undone. `null` means the file did not exist and undo should delete it.
   */
  backup?: (absPath: string, original: string | null, written: string) => Promise<void>;
  /**
   * Ask whether to run a command. Absent means commands are impossible, not
   * automatic — the same rule `confirmWrite` follows, for the same reason: a
   * caller that has not supplied a way to ask has not earned the right to skip
   * asking.
   */
  confirmCommand?: (ask: CommandApproval) => Promise<boolean>;
  /**
   * Environment variable names a command may see beyond the keep-list. The
   * per-project opt-in for build tools that genuinely need one.
   */
  commandEnv?: string[];
  /**
   * Park a file server-side and return its id. Absent means this client cannot
   * upload, and `attach_file` refuses rather than pretending — the same rule
   * `confirmWrite` and `confirmCommand` follow.
   */
  upload?: (file: { name: string; bytes: Buffer }) => Promise<{ id: string; name: string }>;
  /** Aborts a running command when the run is aborted. */
  signal?: AbortSignal;
}

/** What the user is being asked about a command. */
export interface CommandApproval {
  /** The command as the model wrote it, for the user to read. */
  display: string;
  /** How it was classified — decides how loud the prompt is. */
  tier: "confirm" | "unknown" | "loud";
  /** What this command can do that the others cannot. Only for `loud`. */
  warning?: string;
  /** Paths outside the project this command was handed. */
  outsidePaths: string[];
  /** The model's one line on what it expects to learn. */
  why?: string;
  /**
   * What the command will actually run, when that is defined elsewhere — a
   * package.json script, a Makefile recipe. `npm run setup` says nothing about
   * whether it is a build step or `curl … | sh`; this is the part worth reading.
   */
  scriptBody?: string;
  cwd: string;
}

/** Trim a result to the cap, saying so, so the model narrows instead of retrying. */
function cap(text: string, max = MAX_RESULT_CHARS): { content: string; truncated: boolean } {
  if (text.length <= max) return { content: text, truncated: false };
  // Keep the head: for a file read the top is where the imports and the shape
  // are, and for a listing it is the entries that sort first.
  return { content: text.slice(0, max), truncated: true };
}

/**
 * Resolve a model-supplied path, enforcing the local policy.
 *
 * Returns the real path, or an outcome to return to the model instead. Secrets
 * are refused outright; anything outside the working directory is confirmed by a
 * human every time and never remembered.
 */
async function gate(ctx: ToolContext, request: string, verb: string): Promise<{ abs: string } | ToolOutcome> {
  const verdict = await classifyPath(ctx.cwd, request);

  if (verdict.decision === "deny") {
    return { ok: false, error: denialMessage(request, verdict.matched) };
  }
  if (verdict.decision === "confirm") {
    const allowed = await ctx.confirm(
      `${verb} a file OUTSIDE this project?`,
      `  ${verdict.display}\n  The agent asked for this; it is not in ${ctx.cwd}.`,
    );
    if (!allowed) {
      return {
        ok: false,
        error: `The user declined access to "${String(request).slice(0, 120)}", which is outside the project. Continue without it.`,
      };
    }
  }
  return { abs: verdict.abs };
}

function isOutcome(v: { abs: string } | ToolOutcome): v is ToolOutcome {
  return (v as ToolOutcome).ok !== undefined;
}

// ---- attach_file ------------------------------------------------------------

/** What the server can read as a file. Mirrors the `@` mention set. */
const ATTACHABLE = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "xlsx", "xlsm", "xltx"]);
/** 50MB, the server's own multer limit, so an oversized file fails here. */
const MAX_ATTACH_BYTES = 50 * 1024 * 1024;

/**
 * Send one local file to the run, so the media tools can act on it by name.
 *
 * This is the first client tool that MOVES data rather than reading it, and the
 * boundary is the same one every other tool here sits behind — `gate` is
 * `classifyPath`, so a secret is refused before the file is opened and anything
 * outside the project is confirmed every time.
 *
 * Worth being explicit about why that is sufficient rather than merely
 * consistent: `read_file` already sends the CONTENTS of a local file to the same
 * server, on the same model's say-so. This carries a different file type through
 * the same door. What it is not is a new class of exposure — and if the rules
 * were ever wrong, they would already have been wrong for `read_file`.
 *
 * What it adds instead is durability: bytes read by `read_file` are text in a
 * prompt, while these are stored server-side for the conversation. That is why
 * the type list is narrow — only what the server can genuinely read as a file —
 * and why the run caps how many one run may pull.
 */
export async function attachFile(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const request = String(input.path ?? "");
  if (!request) return { ok: false, error: "No path was given." };
  if (!ctx.upload) {
    return { ok: false, error: "This client cannot attach files. Ask the user to attach it to their message with @." };
  }

  const ext = (request.split(/[\\/]/).pop() ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (!ATTACHABLE.has(ext)) {
    // Naming the set beats "unsupported": the model's next move should be
    // read_file for a text file, not another attach with a different extension.
    return {
      ok: false,
      error: `"${request}" cannot be attached. Only PDFs, images (png, jpg, gif, webp) and spreadsheets (xlsx) can be. For a text file use read_file; for a folder use list_dir and attach what is inside it.`,
    };
  }

  const gated = await gate(ctx, request, "Attach");
  if (isOutcome(gated)) return gated;

  let bytes: Buffer;
  try {
    const stat = await fs.stat(gated.abs);
    if (stat.isDirectory()) {
      return { ok: false, error: `"${request}" is a directory. Use list_dir, then attach the files you want one at a time.` };
    }
    if (stat.size === 0) return { ok: false, error: `"${request}" is empty.` };
    if (stat.size > MAX_ATTACH_BYTES) {
      return { ok: false, error: `"${request}" is ${Math.round(stat.size / 1024 / 1024)}MB, over the 50MB limit.` };
    }
    bytes = await fs.readFile(gated.abs);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ok: false, error: `"${request}" does not exist.` };
    if (e.code === "EACCES") return { ok: false, error: `"${request}" is not readable.` };
    return { ok: false, error: `Could not read "${request}": ${e.message}` };
  }

  const name = path.basename(gated.abs);
  try {
    const parked = await ctx.upload({ name, bytes });
    // JSON because the server needs the id to resolve the file later, and a
    // sentence would have to be parsed. agency/tools.js turns this into the
    // sentence the model actually reads.
    return { ok: true, content: JSON.stringify({ id: parked.id, name: parked.name || name }) };
  } catch (err) {
    return { ok: false, error: `Could not attach "${request}": ${(err as Error).message}` };
  }
}

// ---- read_file --------------------------------------------------------------

export async function readFile(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const request = String(input.path ?? "");
  if (!request) return { ok: false, error: "No path was given." };

  const gated = await gate(ctx, request, "Read");
  if (isOutcome(gated)) return gated;

  let raw: string;
  try {
    const stat = await fs.stat(gated.abs);
    if (stat.isDirectory()) {
      return { ok: false, error: `"${request}" is a directory. Use list_dir for it.` };
    }
    raw = await fs.readFile(gated.abs, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ok: false, error: `"${request}" does not exist.` };
    if (e.code === "EACCES") return { ok: false, error: `"${request}" is not readable.` };
    return { ok: false, error: `Could not read "${request}": ${e.message}` };
  }

  // A binary file read as utf8 is a screenful of replacement characters that
  // teaches the model nothing and costs as much as real content.
  if (raw.includes("\u0000")) {
    return { ok: false, error: `"${request}" is a binary file.` };
  }

  const start = Number(input.start_line) > 0 ? Math.floor(Number(input.start_line)) : 1;
  const end = Number(input.end_line) > 0 ? Math.floor(Number(input.end_line)) : Infinity;
  const all = raw.split("\n");
  const ranged = start > 1 || end !== Infinity;
  let lines = all.slice(start - 1, end === Infinity ? undefined : end);

  let lineTruncated = false;
  if (!ranged && lines.length > MAX_READ_LINES) {
    lines = lines.slice(0, MAX_READ_LINES);
    lineTruncated = true;
  }

  // Number the lines. Without them the model cannot ask for a range next time,
  // and cannot tell you where in the file something is.
  const width = String(start + lines.length - 1).length;
  const body = lines
    .map((l, i) => {
      const text = l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)} …[line truncated]` : l;
      return `${String(start + i).padStart(width, " ")}\t${text}`;
    })
    .join("\n");

  const { content, truncated } = cap(body);
  const note = lineTruncated
    ? `\n[... ${all.length - MAX_READ_LINES} more lines. Ask for a line range to see them ...]`
    : "";
  return { ok: true, content: content + note, truncated: truncated || lineTruncated };
}

// ---- list_dir ---------------------------------------------------------------

export async function listDir(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const request = String(input.path ?? ".");
  const gated = await gate(ctx, request, "List");
  if (isOutcome(gated)) return gated;

  const recursive = input.recursive === true;
  const out: string[] = [];
  let hitCap = false;

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (out.length >= MAX_DIR_ENTRIES) {
      hitCap = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= MAX_DIR_ENTRIES) {
        hitCap = true;
        return;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        out.push(`${prefix}${entry.name}/`);
        if (recursive && depth < 8) await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1);
      } else {
        out.push(`${prefix}${entry.name}`);
      }
    }
  }

  try {
    const stat = await fs.stat(gated.abs);
    if (!stat.isDirectory()) return { ok: false, error: `"${request}" is a file, not a directory.` };
  } catch {
    return { ok: false, error: `"${request}" does not exist.` };
  }

  await walk(gated.abs, "", 0);
  const body = out.join("\n") || "(empty)";
  const note = hitCap ? `\n[... stopped at ${MAX_DIR_ENTRIES} entries. List a subdirectory instead ...]` : "";
  const { content, truncated } = cap(body + note);
  return { ok: true, content, truncated: truncated || hitCap };
}

// ---- write_file -------------------------------------------------------------

/**
 * Create or replace a file, after a human has seen the diff and said yes.
 *
 * Three rules differ from reading, and each is a deliberate narrowing:
 *
 *   • Outside the project is DENIED, not confirmed. Reading a sibling package is
 *     ordinary work; writing to one is not something an agent pointed at this
 *     repository should be doing, and a prompt would only be a way to say yes to
 *     it at 2am.
 *   • Every write is confirmed. There is no auto-approve, no "allow always" and
 *     no flag to add one, because the thing being approved is different every
 *     time — it is the diff, not the capability.
 *   • The previous contents are preserved first. Approving a diff on screen and
 *     discovering its consequences a few files later are different moments, and
 *     undo is what stands between them.
 */
export async function writeFile(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const request = String(input.path ?? "");
  if (!request) return { ok: false, error: "No path was given." };
  if (typeof input.content !== "string") {
    return { ok: false, error: "write_file needs the complete new contents in `content`." };
  }
  if (!ctx.confirmWrite) {
    return { ok: false, error: "This client cannot write files." };
  }

  const verdict = await classifyPath(ctx.cwd, request);
  if (verdict.decision === "deny") {
    return { ok: false, error: denialMessage(request, verdict.matched) };
  }
  if (verdict.decision === "confirm") {
    // The read path asks here. The write path refuses.
    return {
      ok: false,
      error:
        `Refused: "${request.slice(0, 120)}" is outside this project, and this client only writes inside it. ` +
        "Write to a path within the project, or ask the user to make the change themselves.",
    };
  }

  let original: string | null = null;
  try {
    const stat = await fs.stat(verdict.abs);
    if (stat.isDirectory()) return { ok: false, error: `"${request}" is a directory.` };
    original = await fs.readFile(verdict.abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, error: `Could not open "${request}": ${(err as Error).message}` };
    }
  }

  const next = input.content;
  if (original !== null && original === next) {
    // Say so rather than staging a no-op diff for approval. A prompt with nothing
    // in it teaches the user that prompts are noise.
    return { ok: true, content: `${request} already has exactly these contents. Nothing was written.`, truncated: false };
  }

  const diff = diffLines(original ?? "", next);
  const approved = await ctx.confirmWrite(request, diff, original === null);
  if (!approved) {
    return {
      ok: false,
      error: `The user declined this change to "${request.slice(0, 120)}". Do not try again with a variation — ask them what they want instead.`,
    };
  }

  try {
    if (ctx.backup) await ctx.backup(verdict.abs, original, next);
    await fs.mkdir(path.dirname(verdict.abs), { recursive: true });
    await fs.writeFile(verdict.abs, next, "utf8");
  } catch (err) {
    return { ok: false, error: `Could not write "${request}": ${(err as Error).message}` };
  }

  const verb = original === null ? "Created" : "Updated";
  return {
    ok: true,
    content: `${verb} ${request} (+${diff.added} −${diff.removed}). The user approved this change.`,
    truncated: false,
  };
}

// ---- edit_file --------------------------------------------------------------

/**
 * How many characters of a failed `old_string` to quote back at the model.
 * Enough to see which attempt it was; not so much that a miss costs a page.
 */
const EDIT_ECHO_CHARS = 200;

/** Every index at which `needle` occurs in `haystack`. Plain, non-overlapping. */
function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + needle.length;
  }
}

/** Collapse CRLF and trailing spaces, for explaining a near-miss. */
function loosen(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
}

/**
 * Replace an exact piece of a file with another.
 *
 * ── Why this exists alongside write_file ────────────────────────────────────
 *
 * `write_file` takes the COMPLETE new contents, so changing one line of a
 * 950-line file costs the model ten thousand output tokens to reproduce the
 * other 949 — and hands the user a diff whose real change is buried in it.
 * Both halves of that are bad: the tokens are the smaller problem, and a
 * 900-line diff nobody can read is an approval that has stopped meaning
 * anything.
 *
 * Re-emitting a whole file is also where models drop things. The failure is
 * quiet, it lands in code that was never being edited, and the diff that would
 * have shown it is too big to read.
 *
 * ── Why the match is exact, and why a miss is a refusal ─────────────────────
 *
 * No fuzzy matching, no nearest-neighbour, no "did you mean". An edit tool that
 * guesses where the model meant lands in the wrong place while showing a diff
 * that looks entirely plausible, and the user approves it. Every uncertainty
 * here is a refusal that tells the model how to be certain instead:
 *
 *   not found      read the file and copy the text exactly
 *   found N times  include more surrounding lines, or say replace_all
 *
 * A near-miss is DIAGNOSED but still refused — when the only difference is line
 * endings or trailing whitespace, saying so turns an unactionable failure into
 * a one-line fix, without this quietly rewriting bytes the user did not approve.
 */
export async function editFile(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const request = String(input.path ?? "");
  if (!request) return { ok: false, error: "No path was given." };
  if (typeof input.old_string !== "string" || typeof input.new_string !== "string") {
    return { ok: false, error: "edit_file needs `old_string` and `new_string`, both strings." };
  }
  if (!ctx.confirmWrite) {
    return { ok: false, error: "This client cannot write files." };
  }

  const oldStr = input.old_string;
  const newStr = input.new_string;
  const replaceAll = input.replace_all === true;

  if (oldStr === "") {
    return {
      ok: false,
      error: "`old_string` is empty. To create a file, use write_file; edit_file only changes text that is already there.",
    };
  }
  if (oldStr === newStr) {
    return { ok: false, error: "`old_string` and `new_string` are identical, so there is nothing to change." };
  }

  const verdict = await classifyPath(ctx.cwd, request);
  if (verdict.decision === "deny") {
    return { ok: false, error: denialMessage(request, verdict.matched) };
  }
  if (verdict.decision === "confirm") {
    // Same rule as write_file: reads outside the project are confirmed, writes
    // are refused. An edit is a write.
    return {
      ok: false,
      error:
        `Refused: "${request.slice(0, 120)}" is outside this project, and this client only writes inside it. ` +
        "Edit a file within the project, or ask the user to make the change themselves.",
    };
  }

  let original: string;
  try {
    const stat = await fs.stat(verdict.abs);
    if (stat.isDirectory()) return { ok: false, error: `"${request}" is a directory.` };
    original = await fs.readFile(verdict.abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: false,
        error: `"${request}" does not exist. Use write_file to create it; edit_file only changes a file that is already there.`,
      };
    }
    return { ok: false, error: `Could not open "${request}": ${(err as Error).message}` };
  }

  const hits = occurrences(original, oldStr);

  if (hits.length === 0) {
    const echo = oldStr.slice(0, EDIT_ECHO_CHARS) + (oldStr.length > EDIT_ECHO_CHARS ? " …" : "");
    // A near-miss is worth naming. "Not found" sends the model round the loop
    // again with the same text; "your line endings differ" gets it right next try.
    const near = occurrences(loosen(original), loosen(oldStr)).length;
    const why = near
      ? " The text IS present apart from line endings or trailing whitespace — read the file again and copy it byte for byte, including how the lines end."
      : "";
    return {
      ok: false,
      error:
        `Refused: that exact text is not in "${request.slice(0, 120)}".${why}\n` +
        `Looked for:\n${echo}\n` +
        "Read the file and copy the text exactly as it appears. Do not guess at a variation.",
    };
  }

  if (hits.length > 1 && !replaceAll) {
    return {
      ok: false,
      error:
        `Refused: that text appears ${hits.length} times in "${request.slice(0, 120)}", so which one to change is ambiguous. ` +
        "Include more of the surrounding lines to pick out the one you mean, or pass replace_all: true to change every one.",
    };
  }

  const next = replaceAll
    ? original.split(oldStr).join(newStr)
    : original.slice(0, hits[0]) + newStr + original.slice(hits[0] + oldStr.length);

  const diff = diffLines(original, next);
  const approved = await ctx.confirmWrite(request, diff, false);
  if (!approved) {
    return {
      ok: false,
      error: `The user declined this change to "${request.slice(0, 120)}". Do not try again with a variation — ask them what they want instead.`,
    };
  }

  try {
    if (ctx.backup) await ctx.backup(verdict.abs, original, next);
    await fs.writeFile(verdict.abs, next, "utf8");
  } catch (err) {
    return { ok: false, error: `Could not write "${request}": ${(err as Error).message}` };
  }

  const where = hits.length > 1 ? ` in ${hits.length} places` : "";
  return {
    ok: true,
    content: `Edited ${request}${where} (+${diff.added} −${diff.removed}). The user approved this change.`,
    truncated: false,
  };
}

// ---- grep -------------------------------------------------------------------

/**
 * Turn a glob into a matcher: `*.ts`, `src/*.tsx`, `**` across directories.
 *
 * Walked character by character rather than done with chained replaces, because
 * the chained version needs a placeholder to keep `**` from being eaten by the
 * `*` rule — and any placeholder rare enough to be safe is also rare enough to
 * be unreadable.
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") i++;
        out += "(?:.*/)?"; // ** spans directory separators
      } else {
        out += "[^/]*"; // * stops at one
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`(^|/)${out}$`);
}

export async function grep(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const pattern = String(input.pattern ?? "");
  if (!pattern) return { ok: false, error: "No pattern was given." };

  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch (err) {
    return { ok: false, error: `"${pattern}" is not a valid regular expression: ${(err as Error).message}` };
  }

  const gated = await gate(ctx, String(input.path ?? "."), "Search");
  if (isOutcome(gated)) return gated;

  const limit = Math.min(Math.max(Number(input.max_results) || MAX_GREP_RESULTS, 1), MAX_GREP_RESULTS);
  const globRe = input.glob ? globToRegExp(String(input.glob)) : null;
  const hits: string[] = [];
  let scanned = 0;
  let hitCap = false;

  async function search(target: string, rel: string): Promise<void> {
    if (hits.length >= limit) {
      hitCap = true;
      return;
    }
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      return;
    }

    if (stat.isDirectory()) {
      let entries;
      try {
        entries = await fs.readdir(target, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (hits.length >= limit) {
          hitCap = true;
          return;
        }
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.isDirectory()) continue;
        await search(path.join(target, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      }
      return;
    }

    if (globRe && !globRe.test(rel)) return;
    // Never open a file the policy refuses, even while walking: a secret is a
    // secret whether the model named it or a directory walk found it.
    if (!(await isReadable(ctx, target))) return;
    if (stat.size > 2_000_000) return;
    scanned++;

    let text: string;
    try {
      text = await fs.readFile(target, "utf8");
    } catch {
      return;
    }
    if (text.includes("\u0000")) return; // binary

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= limit) {
        hitCap = true;
        return;
      }
      if (!re.test(lines[i])) continue;
      const snippet = lines[i].length > 300 ? `${lines[i].slice(0, 300)}…` : lines[i];
      hits.push(`${rel}:${i + 1}: ${snippet.trim()}`);
    }
  }

  await search(gated.abs, path.relative(ctx.cwd, gated.abs) || ".");

  if (!hits.length) {
    return { ok: true, content: `No matches for /${pattern}/ in ${scanned} file(s).`, truncated: false };
  }
  const note = hitCap ? `\n[... stopped at ${limit} matches. Narrow the pattern or the path ...]` : "";
  const { content, truncated } = cap(hits.join("\n") + note);
  return { ok: true, content, truncated: truncated || hitCap };
}

/** Would the policy allow this exact file? Used while walking, where nothing was named. */
async function isReadable(ctx: ToolContext, abs: string): Promise<boolean> {
  const verdict = await classifyPath(ctx.cwd, abs);
  // Only silently-allowed files are searched. A file that would need a
  // confirmation is skipped rather than interrupting a walk dozens of times.
  return verdict.decision === "allow";
}

// ---- dispatch ---------------------------------------------------------------

export type ToolName = "read_file" | "list_dir" | "grep" | "write_file" | "edit_file" | "run_command" | "attach_file";

/** Everything this client can execute. Declared to the server verbatim. */
export const SUPPORTED_TOOLS: ToolName[] = ["read_file", "list_dir", "grep", "write_file", "edit_file", "run_command", "attach_file"];

/**
 * The tools that change files.
 *
 * A predicate rather than a name check at each call site, because there were
 * three of those — the `--confirm-reads` gate, and the audit `decision` in both
 * renderers — and each read `name === "write_file"` while meaning "a tool that
 * writes". Adding edit_file to a list of one in three separate files is how a
 * write tool ends up recorded as an automatic read.
 */
export function isWriteTool(name: string): boolean {
  return name === "write_file" || name === "edit_file";
}

/**
 * Tools whose outcome the audit log must not record as "auto".
 *
 * Broader than `isWriteTool`: a command that ran because the user said yes was
 * confirmed, even though it wrote no file. The audit answers "was this approved
 * by a person", and a command is exactly the case where that question matters
 * most.
 */
export function isEffectTool(name: string): boolean {
  return isWriteTool(name) || name === "run_command";
}

const EXECUTORS: Record<ToolName, (ctx: ToolContext, input: Record<string, unknown>) => Promise<ToolOutcome>> = {
  read_file: readFile,
  list_dir: listDir,
  grep,
  write_file: writeFile,
  edit_file: editFile,
  run_command: runCommandTool,
  attach_file: attachFile,
};

/**
 * Lazily loaded so `tools.ts` and `run.ts` can refer to each other's types
 * without a require cycle at module load.
 */
async function runCommandTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const { runCommand } = await import("./run.js");
  return runCommand(ctx, input);
}

/**
 * Execute one tool call. Never throws: an unexpected failure is a result the
 * model can read and work around, where an exception would abandon the run
 * holding a call it will now wait out.
 */
export async function execute(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const fn = EXECUTORS[name as ToolName];
  if (!fn) return { ok: false, error: `This client cannot run "${name}".` };
  try {
    return await fn(ctx, input ?? {});
  } catch (err) {
    return { ok: false, error: `"${name}" failed: ${(err as Error).message}` };
  }
}
