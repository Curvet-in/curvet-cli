import pc from "picocolors";

const BAR_WIDTH = 24;

export interface ProgressOptions {
  /** Shown before the bar, e.g. "video". */
  label: string;
  enabled?: boolean;
}

/**
 * Progress reporting for long-running jobs and workflow runs.
 *
 * Renders an in-place bar on a TTY. Off-TTY it degrades to one line per 10%
 * bucket instead of redrawing — a CI log wants a readable trail, not thousands
 * of carriage returns. Everything goes to stderr so stdout stays pipe-clean.
 */
export class Progress {
  private readonly startedAt = Date.now();
  private readonly tty: boolean;
  private readonly enabled: boolean;
  private lastBucket = -1;
  private dirty = false;

  constructor(private readonly opts: ProgressOptions) {
    this.enabled = opts.enabled ?? true;
    this.tty = process.stderr.isTTY === true;
  }

  private elapsed(): string {
    const s = (Date.now() - this.startedAt) / 1000;
    return s >= 60 ? `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, "0")}s` : `${s.toFixed(0)}s`;
  }

  update(percent: number, detail?: string): void {
    if (!this.enabled) return;
    const pct = Math.max(0, Math.min(100, Math.round(percent || 0)));

    if (!this.tty) {
      const bucket = Math.floor(pct / 10);
      if (bucket === this.lastBucket) return;
      this.lastBucket = bucket;
      process.stderr.write(
        `${this.opts.label}: ${pct}%${detail ? ` — ${detail}` : ""} (${this.elapsed()})\n`,
      );
      return;
    }

    const filled = Math.round((pct / 100) * BAR_WIDTH);
    const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
    const tail = detail ? ` ${pc.dim("·")} ${detail}` : "";
    process.stderr.write(
      `\r${pc.dim(this.opts.label)} ${pc.cyan(bar)} ${String(pct).padStart(3)}%${tail} ${pc.dim(`· ${this.elapsed()}`)}\x1b[K`,
    );
    this.dirty = true;
  }

  /** Clear the in-place bar so the next write starts on a clean line. */
  private clear(): void {
    if (this.tty && this.dirty) {
      process.stderr.write("\r\x1b[K");
      this.dirty = false;
    }
  }

  done(message: string): void {
    if (!this.enabled) return;
    this.clear();
    process.stderr.write(`${pc.green("✔")} ${message} ${pc.dim(`· ${this.elapsed()}`)}\n`);
  }

  /** Stop rendering without claiming success — the caller reports the error. */
  abort(): void {
    this.clear();
  }
}
