import { describe, expect, it } from "vitest";
import { formatEta } from "../src/commands/shared.js";
import { formatUsd, formatLatency } from "../src/commands/analytics.js";

describe("formatEta", () => {
  it("turns an absolute ISO timestamp into a countdown", () => {
    const eta = new Date(Date.now() + 30_000).toISOString();
    expect(formatEta(eta)).toMatch(/^eta (29|30|31)s$/);
  });

  it("clamps a past timestamp to zero rather than going negative", () => {
    expect(formatEta(new Date(Date.now() - 60_000).toISOString())).toBe("eta 0s");
  });

  it("passes an unparseable value through untouched", () => {
    expect(formatEta("soon")).toBe("eta soon");
  });

  it("returns undefined when there is no eta", () => {
    expect(formatEta(undefined)).toBeUndefined();
  });
});

describe("analytics formatting", () => {
  it("keeps sub-cent costs legible instead of rounding them to zero", () => {
    expect(formatUsd(0.0033)).toBe("$0.0033");
    expect(formatUsd(4.8616)).toBe("$4.86");
    expect(formatUsd(0)).toBe("$0");
  });

  it("scales latency between milliseconds and seconds", () => {
    expect(formatLatency(645)).toBe("645ms");
    expect(formatLatency(6436.175)).toBe("6.4s");
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(undefined)).toBe("—");
  });
});
