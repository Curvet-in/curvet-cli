import path from "node:path";
import { promises as fs } from "node:fs";
import { classifyPath, denialMessage } from "./permissions.js";

/**
 * The tools that run on this machine.
 *
 * Read-only, all three of them. Nothing here writes, deletes or executes, and
 * the client declares only what is in this file — so a run cannot ask for a
 * capability that has not shipped.
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

export type ToolName = "read_file" | "list_dir" | "grep";

/** Everything this client can execute. Declared to the server verbatim. */
export const SUPPORTED_TOOLS: ToolName[] = ["read_file", "list_dir", "grep"];

const EXECUTORS: Record<ToolName, (ctx: ToolContext, input: Record<string, unknown>) => Promise<ToolOutcome>> = {
  read_file: readFile,
  list_dir: listDir,
  grep,
};

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
