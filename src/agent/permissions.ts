import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * What the agent is allowed to touch on this machine.
 *
 * ── The threat ──────────────────────────────────────────────────────────────
 *
 * Not "is the Curvet server malicious". It is that an agent run ingests
 * untrusted text — scraped pages, emails, search results, a README in the repo
 * it is reading — and that text can steer tool calls. So this layer lives HERE,
 * is enforced locally, and cannot be relaxed by anything arriving over the wire.
 * The server *requests*; it does not *command*.
 *
 * ── The policy ──────────────────────────────────────────────────────────────
 *
 *   secret   Denied. Always, before the file is opened, by path — never by
 *            filtering content afterwards, because by then it has been read.
 *   outside  Allowed, but always confirmed, and never auto-approved. Reading a
 *            sibling package or a shared config is ordinary work in a monorepo;
 *            doing it without saying so is not.
 *   inside   Allowed. This is the directory the user pointed the agent at.
 *
 * Cline takes a different line — no boundary at all, with `.clineignore` as an
 * opt-in denylist, which means a fresh install reads your `.env`. A denylist
 * that defaults to empty is not a control.
 *
 * ── Why symlinks get their own resolution ───────────────────────────────────
 *
 * Every check runs against the REAL path. A symlink inside the project pointing
 * at `~/.ssh/id_rsa` looks local to a string comparison, and that is precisely
 * how a path jail is defeated. The target is what gets classified, and both ends
 * are checked so a link to a secret is denied rather than merely confirmed.
 */

/**
 * Files that mark the top of a project. Checked in no particular order — the
 * nearest ancestor holding any of them wins, so a package inside a monorepo
 * resolves to the package and not the whole tree.
 */
const PROJECT_MARKERS = [
  ".git", ".hg", ".svn",
  "package.json", "deno.json", "bun.lockb",
  "pyproject.toml", "setup.py", "requirements.txt", "Pipfile",
  "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts",
  "Gemfile", "composer.json", "mix.exs", "Package.swift", "CMakeLists.txt",
  "Makefile",
];

/**
 * The project `from` sits inside, or null if it does not sit inside one.
 *
 * This is what decides whether the agent may read anything at all by default,
 * and the reasoning is worth stating because it is not "reads are dangerous".
 *
 * The secret denylist in this file recognises CONVENTIONAL names — `.env`,
 * `*.pem`, `.ssh/`, `.aws/`. Inside a project that is close to exhaustive,
 * because projects put credentials in conventional places. A home directory does
 * not: `~/notes/passwords.txt` matches nothing here, and neither does a folder of
 * client contracts. So the denylist is only as good as the assumption that it is
 * looking at a project, and outside one that assumption is simply false.
 *
 * Stops at the home directory rather than treating it as a project, even though
 * a stray `~/.git` or `~/Makefile` is common. Home is exactly the place this must
 * not open up.
 */
export async function findProjectRoot(from: string): Promise<string | null> {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  let dir = path.resolve(from);

  for (let depth = 0; depth < 40; depth++) {
    // Home is a boundary, not a project — but a project may legitimately live
    // BELOW it, so only stop once we have climbed all the way up to home itself.
    if (home && path.resolve(dir) === path.resolve(home)) return null;

    for (const marker of PROJECT_MARKERS) {
      try {
        await fs.access(path.join(dir, marker));
        return dir;
      } catch {
        /* not this one */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
  return null;
}

export type Verdict =
  | { decision: "allow"; scope: "inside" }
  | { decision: "confirm"; scope: "outside"; display: string }
  | { decision: "deny"; scope: "secret"; matched: string };

/**
 * Files whose contents are credentials.
 *
 * Matched against the path's segments and basename, case-insensitively. Kept
 * deliberately narrow and literal: a pattern like /secret/ would deny
 * `src/secrets.ts`, which is ordinary source code, and a denylist that blocks
 * real work gets turned off.
 */
const SECRET_PATTERNS: { re: RegExp; what: string }[] = [
  // Environment files, but not the committed examples people legitimately read.
  { re: /^\.env(\.[^.]*)?$/i, what: ".env file" },
  // Private keys and certificates, by extension.
  { re: /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i, what: "private key or certificate" },
  // SSH key material by conventional name, including the OpenSSH defaults.
  { re: /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, what: "SSH key" },
  // Credential stores that live as plain files.
  { re: /^\.(netrc|pgpass|git-credentials|npmrc|pypirc)$/i, what: "credential file" },
  { re: /^credentials(\.json|\.yml|\.yaml)?$/i, what: "credential file" },
  { re: /^service-account.*\.json$/i, what: "service account key" },
  { re: /^\.htpasswd$/i, what: "password file" },
];

/** Directories that hold nothing but credentials. Any path through one is denied. */
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".password-store", ".gpg"]);

/** `.env.example` and friends are documentation, not secrets. */
const ENV_EXAMPLE = /^\.env\.(example|sample|template|dist|defaults?)$/i;

/** Why this path is refused, or null if nothing matches. */
export function secretReason(absPath: string): string | null {
  const base = path.basename(absPath);
  if (ENV_EXAMPLE.test(base)) return null;

  for (const segment of absPath.split(path.sep)) {
    if (SECRET_DIRS.has(segment.toLowerCase())) return `${segment}/ holds credentials`;
  }
  for (const { re, what } of SECRET_PATTERNS) {
    if (re.test(base)) return what;
  }
  return null;
}

/** Is `child` at or beneath `parent`? Both must already be resolved. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve a path the MODEL supplied and decide what may be done with it.
 *
 * The input is untrusted in the strict sense: it may have come from text the
 * model read a moment ago rather than from the user. It is resolved against the
 * working directory and then, if it exists, resolved again through any symlinks.
 *
 * @param cwd      the directory the agent was pointed at, already absolute
 * @param request  whatever the model asked for
 */
export async function classifyPath(cwd: string, request: string): Promise<Verdict & { abs: string }> {
  const root = path.resolve(cwd);
  const asked = path.resolve(root, String(request ?? ""));

  // Follow symlinks before deciding anything. A link inside the project that
  // points at ~/.ssh/id_rsa is inside the project only as a string.
  let real = asked;
  try {
    real = await fs.realpath(asked);
  } catch {
    // Does not exist yet, or is unreadable. Classify what was asked for — the
    // executor reports the missing file, and a path we cannot resolve is not a
    // path we should quietly widen.
  }

  // Either end being a secret is a denial: the link and its target both count.
  const reason = secretReason(real) ?? secretReason(asked);
  if (reason) return { decision: "deny", scope: "secret", matched: reason, abs: real };

  if (isInside(root, real)) return { decision: "allow", scope: "inside", abs: real };

  return {
    decision: "confirm",
    scope: "outside",
    // The REAL path, so a confirmation prompt shows where the read actually
    // lands rather than the link that looked harmless.
    display: real,
    abs: real,
  };
}

/**
 * Does `--confirm-reads` need to ask about this one?
 *
 * Only for files that would otherwise pass SILENTLY. The other two verdicts
 * already have their own handling and asking again is worse than not asking:
 *
 *   outside  has a better prompt of its own, naming the real destination. A
 *            blanket "allow this read?" first, then "outside the project?"
 *            second, is two differently-worded questions about one read — which
 *            is how people learn to answer `y` without reading either.
 *   deny     never asks. There is nothing to decide.
 */
export function needsBlanketConfirm(verdict: Verdict, confirmReads: boolean): boolean {
  return confirmReads === true && verdict.decision === "allow";
}

/**
 * Human-readable one-liner for a denial, written for the model rather than the
 * user: it is what comes back as the tool's error, and it should tell the model
 * to stop asking rather than to try a variation.
 */
export function denialMessage(request: string, matched: string): string {
  return (
    `Refused: "${String(request).slice(0, 120)}" is a ${matched}, and this client never sends those. ` +
    "Do not try another path to the same file. If you need something from it, ask the user to paste the part they are willing to share."
  );
}
