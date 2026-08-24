import { Command } from "commander";
import pc from "picocolors";
import type { BalanceInfo } from "@curvet/sdk";
import { resolveProfile } from "../config.js";
import { makeClient, requireAppKey } from "../client.js";
import { printJson, trimNumber } from "../output.js";

/**
 * What the balance actually is, bucket by bucket.
 *
 * The buckets are NOT interchangeable and the labels have to say which is which.
 * On a shared-org account the API's `walletCredits` is the ORGANISATION's pool,
 * while `personalCredits` — the money that is actually yours — can be zero. This
 * used to print `walletCredits` under the label "personal credits", so an
 * account with nothing of its own read as having several hundred credits, and
 * the number disagreed with every other surface that reports a personal balance.
 *
 * `personalCredits` is the field to trust for "yours". `walletCredits` is the
 * wallet the spend will come out of, which on a shared plan is the company's.
 */
export function renderBalance(info: BalanceInfo): string {
  const lines: string[] = [];
  lines.push(`${pc.bold("Available:")} $${trimNumber(info.totalAvailableUSD)}`);
  const b = info.breakdown;
  if (b) {
    // `personalCredits` when the server sends it; `walletCredits` only as a
    // fallback for older servers, where the two were the same thing.
    const personal = b.personalCredits ?? b.walletCredits;
    if (personal != null) lines.push(`  personal credits   ${trimNumber(personal)}`);
    if (b.isEnterprise) {
      if (b.enterpriseCredits != null)
        lines.push(
          `  company allotment  ${trimNumber(b.enterpriseCredits)}` +
            (b.enterpriseSpendable != null && b.enterpriseSpendable !== b.enterpriseCredits
              ? pc.dim(` (${trimNumber(b.enterpriseSpendable)} spendable under cap)`)
              : ""),
        );
      // Shown whenever there IS a pool, not only when `drawsFromPool` is set —
      // the server does not always send that flag, and a pool the spend comes
      // out of is exactly what the user needs to see.
      if (b.orgPoolCredits != null)
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
