import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import { formatCost } from "../src/output.js";
import { resolveShowCost, type CliConfig } from "../src/config.js";

describe("--no-cost flag detection", () => {
  // Commander gives a `--no-x` option the value `true` when the flag is absent,
  // so the value alone cannot distinguish "omitted" from "explicitly on". Reading
  // the source is what keeps an omitted flag from masking env/config.
  const build = () =>
    new Command("chat")
      .option("--cost", "show the cost line")
      .option("--no-cost", "hide the cost line");

  /** Mirrors how chat.ts decides whether the flag was an explicit choice. */
  const flagFrom = (cmd: Command) =>
    cmd.getOptionValueSource("cost") === "cli" ? (cmd.opts().cost as boolean) : undefined;

  it("treats an omitted flag as no choice, leaving env/config in charge", () => {
    const cmd = build();
    cmd.parse(["node", "chat"]);
    expect(flagFrom(cmd)).toBeUndefined();
  });

  it("reads --no-cost as an explicit false", () => {
    const cmd = build();
    cmd.parse(["node", "chat", "--no-cost"]);
    expect(cmd.getOptionValueSource("cost")).toBe("cli");
    expect(flagFrom(cmd)).toBe(false);
  });

  it("reads --cost as an explicit true", () => {
    const cmd = build();
    cmd.parse(["node", "chat", "--cost"]);
    expect(cmd.getOptionValueSource("cost")).toBe("cli");
    expect(flagFrom(cmd)).toBe(true);
  });
});

describe("formatCost", () => {
  it("labels the billing scheme when the server reports one", () => {
    const line = formatCost({ model: "gpt-4o", credits: 12, billing: "metered" });
    expect(line).toBe("— gpt-4o · 12 credits (metered)");
  });

  it("renders a full metered stream summary", () => {
    const line = formatCost({
      model: "gpt-4o",
      credits: 12,
      billing: "metered",
      tokensIn: 1200,
      tokensOut: 340,
      latencyMs: 2100,
    });
    expect(line).toBe("— gpt-4o · 12 credits (metered) · 1.2k in / 340 out · 2.1s");
  });

  it("uses the singular for one credit and omits absent fields", () => {
    expect(formatCost({ model: "qwen-235b", credits: 1, billing: "flat" })).toContain("1 credit (flat)");
    expect(formatCost({ model: "qwen-235b" })).toBe("— qwen-235b");
  });

  it("formats sub-second latency in milliseconds", () => {
    expect(formatCost({ model: "m", latencyMs: 340 })).toBe("— m · 340ms");
  });

  it("includes the remaining balance when present", () => {
    expect(formatCost({ model: "m", credits: 2, remainingBalance: 892 })).toContain("892 left");
  });
});

describe("resolveShowCost", () => {
  const base: CliConfig = { profiles: {} };
  const saved = process.env.CURVET_NO_COST;

  beforeEach(() => {
    delete process.env.CURVET_NO_COST;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CURVET_NO_COST;
    else process.env.CURVET_NO_COST = saved;
  });

  it("shows the cost line by default", () => {
    expect(resolveShowCost(base, undefined)).toBe(true);
  });

  it("lets --no-cost win over everything", () => {
    expect(resolveShowCost({ profiles: {}, showCost: true }, false)).toBe(false);
  });

  it("honours CURVET_NO_COST for CI", () => {
    process.env.CURVET_NO_COST = "1";
    expect(resolveShowCost(base, undefined)).toBe(false);
    process.env.CURVET_NO_COST = "true";
    expect(resolveShowCost(base, undefined)).toBe(false);
  });

  it("lets an explicit flag override the env var", () => {
    process.env.CURVET_NO_COST = "1";
    expect(resolveShowCost(base, true)).toBe(true);
  });

  it("falls back to the config setting", () => {
    expect(resolveShowCost({ profiles: {}, showCost: false }, undefined)).toBe(false);
  });

  it("ignores a non-truthy env value", () => {
    process.env.CURVET_NO_COST = "0";
    expect(resolveShowCost(base, undefined)).toBe(true);
  });
});
