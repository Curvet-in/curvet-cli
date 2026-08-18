import pc from "picocolors";
import {
  CurvetError,
  AuthError,
  PermissionError,
  RateLimitError,
  InsufficientBalanceError,
  ConnectionError,
} from "@curvet/sdk";

export const isTTY = process.stdout.isTTY === true;

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Mask a key for display: `app_12ab…89cd`. */
export function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + "…";
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}

/** Render a simple padded text table. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  const out = [pc.bold(line(headers)), pc.dim(line(widths.map((w) => "─".repeat(w))))];
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}

/** What a single request cost, normalized across the streaming and sync paths. */
export interface CostInfo {
  model?: string;
  credits?: number;
  /** Which scheme actually charged: token-metered, or the flat per-model credit. */
  billing?: "metered" | "flat";
  tokensIn?: number;
  tokensOut?: number;
  remainingBalance?: number;
  latencyMs?: number;
}

function compactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Credit arithmetic is floating point server-side, so a balance can arrive as
 * 44.44359999999997. Round to the smallest unit anyone bills in and drop the
 * noise rather than printing it back at the user.
 */
export function trimNumber(n: number): string {
  return String(Math.round(n * 10_000) / 10_000);
}

function compactDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** One-line cost summary, e.g. `— gpt-4o · 12 credits (metered) · 1.2k in / 340 out · 2.1s`. */
export function formatCost(info: CostInfo): string {
  const parts: string[] = [];
  if (info.model) parts.push(info.model);
  if (info.credits != null) {
    const unit = info.credits === 1 ? "credit" : "credits";
    const credits = trimNumber(info.credits);
    parts.push(info.billing ? `${credits} ${unit} (${info.billing})` : `${credits} ${unit}`);
  }
  if (info.tokensIn != null || info.tokensOut != null) {
    parts.push(`${compactTokens(info.tokensIn ?? 0)} in / ${compactTokens(info.tokensOut ?? 0)} out`);
  }
  if (info.remainingBalance != null) parts.push(`${trimNumber(info.remainingBalance)} left`);
  if (info.latencyMs != null) parts.push(compactDuration(info.latencyMs));
  return `— ${parts.join(" · ")}`;
}

export function ok(msg: string): string {
  return `${pc.green("✔")} ${msg}`;
}
export function warn(msg: string): string {
  return `${pc.yellow("!")} ${msg}`;
}
export function fail(msg: string): string {
  return `${pc.red("✘")} ${msg}`;
}

/** Human-friendly error text with actionable hints per error family. */
export function formatError(err: unknown): string {
  if (err instanceof AuthError) {
    return [
      fail(`Authentication failed (401): ${err.message}`),
      pc.dim("  Check the key for this scope — playground calls need an app key,"),
      pc.dim("  enterprise calls need an enterprise key. Run `curvet auth status` or `curvet doctor`."),
      requestIdLine(err),
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (err instanceof PermissionError) {
    return [
      fail(`Permission denied (403): ${err.message}`),
      pc.dim("  The app may be paused, the playground disabled, or the model/category not allowed."),
      requestIdLine(err),
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (err instanceof InsufficientBalanceError) {
    const detail =
      err.required != null && err.available != null
        ? ` (need ${err.required}, have ${err.available})`
        : "";
    return fail(`Not enough credits${detail}: ${err.message}`);
  }
  if (err instanceof RateLimitError) {
    const kind = err.kind === "cost" ? "daily cost cap" : "hourly rate limit";
    const retry =
      err.retryAfterMs != null ? ` Retry in ~${Math.ceil(err.retryAfterMs / 1000)}s.` : "";
    return fail(`Hit the ${kind} (${err.used ?? "?"}/${err.limit ?? "?"}).${retry}`);
  }
  if (err instanceof ConnectionError) {
    return [
      fail(`Could not reach the Curvet API: ${err.message}`),
      pc.dim("  Check your network and base URL (`curvet doctor`)."),
    ].join("\n");
  }
  if (err instanceof CurvetError) {
    return [fail(err.message), requestIdLine(err)].filter(Boolean).join("\n");
  }
  return fail(err instanceof Error ? err.message : String(err));
}

function requestIdLine(err: CurvetError): string {
  return err.requestId ? pc.dim(`  request id: ${err.requestId}`) : "";
}
