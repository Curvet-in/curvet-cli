import { execFile } from "node:child_process";

/** Run a git command, resolving stdout. Rejects with git's own stderr. */
function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || (error as Error).message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function isRepo(): Promise<boolean> {
  try {
    await git(["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

export async function stagedDiff(): Promise<string> {
  // No colour, no ext diff, and a generous context window: the model reads this.
  return git(["--no-pager", "diff", "--cached", "--no-color", "--no-ext-diff", "-U8"]);
}

export async function stageTrackedChanges(): Promise<void> {
  await git(["add", "-u"]);
}

/** Files staged, for the summary line. */
export async function stagedFiles(): Promise<string[]> {
  const out = await git(["diff", "--cached", "--name-only"]);
  return out.split("\n").filter(Boolean);
}

/**
 * Recent commit subjects and bodies.
 *
 * Used to match the repo's existing style rather than imposing one. A repo that
 * writes `fix(auth): …` and a repo that writes `Fix the login redirect` both
 * deserve to keep doing that, and neither wants a flag for it.
 */
export async function recentCommits(count = 10): Promise<string[]> {
  const out = await git(["--no-pager", "log", `-${count}`, "--format=%B%x00"]);
  return out
    .split("\0")
    .map((c) => c.trim())
    .filter(Boolean);
}

export async function commit(message: string): Promise<string> {
  // -F - so the message goes over stdin: a message with quotes, backticks or
  // newlines must not be re-parsed by a shell.
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["commit", "-F", "-"], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || (error as Error).message));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin?.end(message);
  });
}

/**
 * Paths whose diffs are enormous and say nothing about intent. A lockfile churn
 * of 4,000 lines is both the bulk of the payload and the least informative part
 * of it.
 */
const NOISE = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)Gemfile\.lock$/,
  /\.(min\.js|min\.css|map)$/,
  /(^|\/)dist\//,
];

export interface FilteredDiff {
  diff: string;
  /** Paths dropped, so the command can say what the model did not see. */
  dropped: string[];
  /** True when the diff was cut to fit; the model is told so too. */
  truncated: boolean;
}

/**
 * Split a diff into per-file sections, drop the uninformative ones, and cap the
 * total.
 *
 * The cap matters for correctness, not just cost: a diff that overruns the
 * context window gets silently truncated by the server at whatever boundary it
 * lands on, and the model then writes a message about the half it happened to
 * see. Cutting deliberately, at a file boundary, and saying so, is the
 * difference between a partial summary and a wrong one.
 */
export function filterDiff(diff: string, maxChars = 60_000): FilteredDiff {
  const sections = diff.split(/^(?=diff --git )/m).filter((s) => s.trim());
  const dropped: string[] = [];
  const kept: string[] = [];
  let size = 0;
  let truncated = false;

  for (const section of sections) {
    const path = /^diff --git a\/(.+?) b\//m.exec(section)?.[1] ?? "";
    if (NOISE.some((re) => re.test(path)) || /^Binary files /m.test(section)) {
      dropped.push(path || "(binary)");
      continue;
    }
    if (size + section.length > maxChars) {
      dropped.push(path);
      truncated = true;
      continue;
    }
    kept.push(section);
    size += section.length;
  }

  return { diff: kept.join(""), dropped, truncated };
}
