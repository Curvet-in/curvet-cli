import { describe, expect, it } from "vitest";
import { renderBalance } from "../src/commands/balance.js";
import type { BalanceInfo } from "@curvet/sdk";

/**
 * What `curvet balance` says the money is.
 *
 * The buckets are not interchangeable, and a wrong label here is a wrong number
 * in someone's head. On a shared-org plan `walletCredits` is the COMPANY's pool
 * and `personalCredits` is the user's own — which is routinely zero.
 */

/** The exact payload production returned for a shared-org account. */
const SHARED_ORG = {
  walletBalance: 7.3877,
  totalPoints: 46,
  totalAvailableUSD: 7.8477,
  breakdown: {
    walletUSD: 7.3877,
    pointsAsUSD: 0.46,
    walletCredits: 738.77,
    orgPoolCredits: 738.77,
    personalCredits: 0,
    enterpriseCredits: 0,
    earnedCredits: 46,
    totalCredits: 784.77,
    organizationLimit: 5000,
    monthlyUsed: 785.27,
    isEnterprise: true,
    creditModel: "shared",
  },
} as unknown as BalanceInfo;

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("a shared-org balance", () => {
  it("does not report the company's pool as the user's own credits", () => {
    // The bug: `walletCredits` printed under "personal credits", so an account
    // with nothing of its own read as having 738.77 — and disagreed with every
    // other surface that reports a personal balance.
    const out = strip(renderBalance(SHARED_ORG));
    expect(out).toMatch(/personal credits\s+0\b/);
    expect(out).not.toMatch(/personal credits\s+738\.77/);
  });

  it("shows the org pool the spend actually comes out of", () => {
    // Previously gated on `drawsFromPool`, which production does not send, so
    // the pool never appeared at all — the 738.77 had no honest home on screen.
    const out = strip(renderBalance(SHARED_ORG));
    expect(out).toMatch(/org pool\s+738\.77/);
  });

  it("still totals the same money", () => {
    const out = strip(renderBalance(SHARED_ORG));
    expect(out).toContain("$7.8477");
    expect(out).toMatch(/points\s+46/);
  });
});

describe("a solo account", () => {
  it("reports its own credits as personal", () => {
    const out = strip(
      renderBalance({
        totalAvailableUSD: 12.5,
        totalPoints: 0,
        breakdown: { walletCredits: 1250, personalCredits: 1250, totalCredits: 1250 },
      } as unknown as BalanceInfo),
    );
    expect(out).toMatch(/personal credits\s+1250/);
    expect(out).not.toMatch(/org pool/);
  });

  it("falls back to walletCredits on a server that does not send personalCredits", () => {
    // Older servers, where the two were the same thing. Printing nothing would
    // be worse than printing the only number available.
    const out = strip(
      renderBalance({
        totalAvailableUSD: 5,
        breakdown: { walletCredits: 500, totalCredits: 500 },
      } as unknown as BalanceInfo),
    );
    expect(out).toMatch(/personal credits\s+500/);
  });
});
