import { Command } from "commander";
import pc from "picocolors";
import { resolveProfile } from "../config.js";
import { makeClient, requireAppKey } from "../client.js";
import { printJson, table, warn } from "../output.js";

/** Costs span several orders of magnitude, so keep small ones legible. */
export function formatUsd(n: number): string {
  if (n === 0) return "$0";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function section(title: string, headers: string[], rows: string[][]): void {
  if (rows.length === 0) return;
  console.log(`\n${pc.bold(title)}`);
  console.log(table(headers, rows));
}

export function analyticsCommand(): Command {
  return new Command("analytics")
    .description("Usage analytics for the app")
    .option("--start <date>", "ISO start date, e.g. 2026-08-01")
    .option("--end <date>", "ISO end date")
    .option("--json", "machine-readable output")
    .action(async (opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      requireAppKey(profile);

      const result = await makeClient(profile).analytics.get({
        startDate: opts.start,
        endDate: opts.end,
      });

      if (opts.json) {
        printJson(result);
        return;
      }

      console.log(
        pc.dim(opts.start || opts.end ? `${opts.start ?? "start"} to ${opts.end ?? "now"}` : "all time"),
      );

      const totalRequests = result.overview?.totalRequests ?? result.totalRequests;
      const totalCost = result.overview?.totalCost ?? result.totalCost;

      const totals: string[][] = [];
      if (totalRequests != null) totals.push(["requests", String(totalRequests)]);
      if (totalCost != null) totals.push(["cost", formatUsd(totalCost)]);
      if (result.overview?.avgCostPerRequest != null) {
        totals.push(["avg cost/request", formatUsd(result.overview.avgCostPerRequest)]);
      }
      if (result.overview?.avgLatency != null) {
        totals.push(["avg latency", formatLatency(result.overview.avgLatency)]);
      }
      if (totals.length > 0) console.log(table(["METRIC", "VALUE"], totals));
      else console.log(warn("No usage recorded for this range."));

      section(
        "BY MODEL",
        ["MODEL", "TYPE", "REQUESTS", "COST", "AVG LATENCY"],
        (result.modelBreakdown ?? [])
          .slice()
          .sort((a, b) => (b.totalCost ?? 0) - (a.totalCost ?? 0))
          .map((r) => [
            r._id ?? "—",
            r.category ?? "",
            String(r.requestCount ?? r.count ?? 0),
            formatUsd(r.totalCost ?? 0),
            formatLatency(r.avgLatency),
          ]),
      );

      section(
        "BY CATEGORY",
        ["CATEGORY", "REQUESTS", "COST"],
        (result.categoryBreakdown ?? [])
          .slice()
          .sort((a, b) => (b.totalCost ?? 0) - (a.totalCost ?? 0))
          .map((r) => [r._id ?? "—", String(r.requestCount ?? r.count ?? 0), formatUsd(r.totalCost ?? 0)]),
      );

      section(
        "BY STATUS",
        ["STATUS", "COUNT"],
        (result.statusBreakdown ?? []).map((r) => [r._id ?? "—", String(r.count ?? r.requestCount ?? 0)]),
      );

      section(
        "ERRORS",
        ["ERROR", "COUNT"],
        (result.errorBreakdown ?? []).map((r) => [r._id ?? "—", String(r.count ?? r.requestCount ?? 0)]),
      );
    });
}
