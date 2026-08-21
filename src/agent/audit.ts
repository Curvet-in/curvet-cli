import path from "node:path";
import { promises as fs } from "node:fs";
import { configDir } from "../config.js";

/**
 * A local record of every tool the agent ran on this machine.
 *
 * Written here rather than server-side on purpose. The point of the record is to
 * answer "what did it actually touch?" — and an audit trail that lives only
 * where the instructions came from answers a narrower question than it appears
 * to. This file is the user's, on the user's disk.
 *
 * JSONL, appended, never rewritten: a log you edit is a log you cannot trust,
 * and appending survives a crash mid-run with everything up to that point intact.
 */

export interface AuditEntry {
  at: string;
  runId: string;
  callId: string;
  tool: string;
  /** The one-line description the user was shown, when they were shown one. */
  title: string;
  /** allowed silently · confirmed by a human · refused by policy · refused by the user */
  decision: "auto" | "confirmed" | "denied" | "declined";
  ok: boolean;
  /** Bytes returned to the model. Cheap proxy for "how much left this machine". */
  bytes: number;
  error?: string;
  cwd: string;
}

export function auditPath(): string {
  return path.join(configDir(), "agent-audit.jsonl");
}

/**
 * Append one entry. Never throws: failing to write the log must not fail the
 * tool call it describes, and a run that dies because its logging failed is
 * strictly worse than a run with a gap in its log.
 */
export async function record(entry: AuditEntry): Promise<void> {
  try {
    const file = auditPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    /* the log is a record, not a dependency */
  }
}

/** The most recent entries, newest last. `[]` when nothing has been recorded. */
export async function readRecent(limit = 50): Promise<AuditEntry[]> {
  try {
    const raw = await fs.readFile(auditPath(), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as AuditEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is AuditEntry => e !== null);
  } catch {
    return [];
  }
}
