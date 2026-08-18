import { Command } from "commander";
import pc from "picocolors";
import type { BalanceInfo } from "@curvet/sdk";
import { resolveProfile } from "../config.js";
import { makeClient, requireAppKey } from "../client.js";
import { printJson, trimNumber } from "../output.js";

function renderBalance(info: BalanceInfo): string {
  const lines: string[] = [];
  lines.push(`${pc.bold("Available:")} $${trimNumber(info.totalAvailableUSD)}`);
  const b = info.breakdown;
  if (b) {
    if (b.walletCredits != null)
      lines.push(`  personal credits   ${trimNumber(b.walletCredits)}`);
    if (b.isEnterprise) {
      if (b.enterpriseCredits != null)
        lines.push(
          `  company allotment  ${trimNumber(b.enterpriseCredits)}` +
            (b.enterpriseSpendable != null && b.enterpriseSpendable !== b.enterpriseCredits
              ? pc.dim(` (${trimNumber(b.enterpriseSpendable)} spendable under cap)`)
              : ""),
        );
      if (b.drawsFromPool && b.orgPoolCredits != null)
        lines.push(
          `  org pool           ${trimNumber(b.orgPoolCredits)}` +
            (b.orgPoolSpendable != null && b.orgPoolSpendable !== b.orgPoolCredits
              ? pc.dim(` (${trimNumber(b.orgPoolSpendable)} spendable under cap)`)
              : ""),
        );
      if (b.monthlyUsed != null)
        lines.push(
          `  used this month    ${trimNumber(b.monthlyUsed)}` +
            (b.organizationLimit ? pc.dim(` / ${trimNumber(b.organizationLimit)} cap`) : ""),
        );
    }
  }
  if (info.totalPoints != null)
    lines.push(pc.dim(`  points             ${trimNumber(info.totalPoints)}`));
  return lines.join("\n");
}

function totalCredits(info: BalanceInfo): number | undefined {
  return info.breakdown?.totalCredits;
}

export function balanceCommand(): Command {
  return new Command("balance")
    .description("Show the credit balance for the app owner")
    .option("--json", "machine-readable output")
    .option("--watch", "poll every 30s and show burn rate")
    .action(async (opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      requireAppKey(profile);
      const client = makeClient(profile);

      const first = await client.balance.get();
      if (opts.json && !opts.watch) {
        printJson(first);
        return;
      }
      console.log(renderBalance(first));

      if (!opts.watch) return;

      const started = Date.now();
      const startCredits = totalCredits(first);
      console.log(pc.dim("\nWatching every 30s — Ctrl-C to stop."));
      // Deliberately a plain loop, not setInterval: a slow request must not overlap the next tick.
      for (;;) {
        await new Promise((r) => setTimeout(r, 30_000));
        const info = await client.balance.get();
        const now = new Date().toLocaleTimeString();
        const credits = totalCredits(info);
        let burn = "";
        if (credits != null && startCredits != null) {
          const spent = startCredits - credits;
          const perHour = (spent / ((Date.now() - started) / 3_600_000)).toFixed(1);
          burn = spent > 0 ? pc.dim(`  (${spent} spent, ~${perHour}/h)`) : pc.dim("  (no spend)");
        }
        console.log(`${pc.dim(now)}  $${info.totalAvailableUSD}${burn}`);
      }
    });
}
