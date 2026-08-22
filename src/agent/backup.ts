import path from "node:path";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { configDir } from "../config.js";

/**
 * What a file looked like before the agent changed it.
 *
 * Approving a diff on screen and understanding its consequences three files
 * later are different moments. Undo is what stands between them, and it has to
 * exist before the first write, not after the first regret.
 *
 * ── Why not git ─────────────────────────────────────────────────────────────
 *
 * Cline checkpoints with `git stash` into the user's own repository. That gets
 * history for free and costs something worth more: it mutates a repo the user is
 * also using, mid-session, with entries they did not create. It also does
 * nothing at all for a directory that is not a git repository.
 *
 * A copy on our own disk works everywhere, touches nothing the user owns, and
 * needs no explanation when it goes wrong.
 */

export interface BackupEntry {
  at: string;
  runId: string;
  /** Absolute path of the file that was changed. */
  file: string;
  /** Where the previous contents live, or null when the file was created. */
  saved: string | null;
  /** True when undo means deleting the file rather than restoring it. */
  created: boolean;
  /**
   * Hash of what the agent WROTE, so undo can tell whether the file still looks
   * the way the agent left it or the user has edited it since.
   */
  wroteHash?: string;
}

function sha(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function storeDir(): string {
  return path.join(configDir(), "agent-backups");
}

function manifestPath(): string {
  return path.join(storeDir(), "manifest.jsonl");
}

/**
 * Preserve `original` before `file` is overwritten. `null` records that the file
 * did not exist, so undo removes it rather than restoring an empty one.
 *
 * Throws on failure, deliberately: everything else in this client degrades
 * quietly, but a write whose backup failed is a write that cannot be undone, and
 * the caller must be able to refuse to proceed.
 */
export async function saveBackup(
  runId: string,
  file: string,
  original: string | null,
  written?: string,
): Promise<BackupEntry> {
  const dir = path.join(storeDir(), runId);
  await fs.mkdir(dir, { recursive: true });

  let saved: string | null = null;
  if (original !== null) {
    // Content-addressed: the same file rewritten twice in one run keeps both
    // states, and identical content is stored once.
    const hash = sha(original).slice(0, 16);
    saved = path.join(dir, `${hash}.bak`);
    await fs.writeFile(saved, original, { encoding: "utf8", mode: 0o600 });
  }

  const entry: BackupEntry = {
    at: new Date().toISOString(),
    runId,
    file,
    saved,
    created: original === null,
    wroteHash: written === undefined ? undefined : sha(written),
  };
  await fs.mkdir(path.dirname(manifestPath()), { recursive: true });
  await fs.appendFile(manifestPath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return entry;
}

/** Everything recorded, oldest first. `[]` when nothing has been written. */
export async function readManifest(): Promise<BackupEntry[]> {
  try {
    const raw = await fs.readFile(manifestPath(), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as BackupEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is BackupEntry => e !== null);
  } catch {
    return [];
  }
}

/** The most recent run that wrote anything, or null. */
export async function lastRunWithWrites(): Promise<string | null> {
  const entries = await readManifest();
  return entries.length ? entries[entries.length - 1].runId : null;
}

export interface UndoResult {
  restored: string[];
  deleted: string[];
  failed: { file: string; why: string }[];
}

/**
 * Put a run's files back.
 *
 * A file written twice in one run returns to how it looked BEFORE the run, not
 * to its state midway through — so the OLDEST backup of each file wins, not the
 * newest. Undo means "as if the run had not happened"; restoring the midway
 * state would mean "as if only its last write had not happened", which is not a
 * state anyone asked to be in.
 *
 * A file the user has edited since is still restored: the alternative is
 * deciding on their behalf that their edit matters more than their undo, and
 * they asked for the undo. What is not acceptable is doing it silently, so
 * `changedSince` reports which ones were not what the agent left behind.
 */
export async function undoRun(runId: string): Promise<UndoResult & { changedSince: string[] }> {
  // Manifest order is oldest-first, and first-seen-wins below is what makes the
  // oldest backup of each file the one restored.
  const entries = (await readManifest()).filter((e) => e.runId === runId);
  const out: UndoResult & { changedSince: string[] } = {
    restored: [],
    deleted: [],
    failed: [],
    changedSince: [],
  };
  const handled = new Set<string>();

  for (const entry of entries) {
    if (handled.has(entry.file)) continue; // the run's FIRST backup of this file
    handled.add(entry.file);
    try {
      // Has anyone touched this since the agent left it? The newest entry for
      // this file records what the agent wrote; anything else means the user has
      // edited it, and overwriting that without saying so would be its own
      // small betrayal.
      const newest = [...entries].reverse().find((e) => e.file === entry.file);
      if (newest?.wroteHash) {
        const current = await fs.readFile(entry.file, "utf8").catch(() => null);
        if (current !== null && sha(current) !== newest.wroteHash) out.changedSince.push(entry.file);
      }
      if (entry.created) {
        await fs.unlink(entry.file).catch((err) => {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        });
        out.deleted.push(entry.file);
      } else if (entry.saved) {
        const previous = await fs.readFile(entry.saved, "utf8");
        await fs.writeFile(entry.file, previous, "utf8");
        out.restored.push(entry.file);
      }
    } catch (err) {
      out.failed.push({ file: entry.file, why: (err as Error).message });
    }
  }
  return out;
}
