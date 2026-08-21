import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@curvet/sdk";
import { filterDiff } from "../src/git.js";
import { CHAT_TURN, COMMIT_TURN, estimateCredits, rankByCost } from "../src/modelCost.js";
import { cheapestChatModel, cleanMessage, detectsConventional } from "../src/commands/commit.js";

function model(partial: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    name: partial.id,
    cost: 0.01,
    type: "chat",
    provider: "test",
    credits: 1,
    capability: "generation",
    ...partial,
  } as ModelInfo;
}

const section = (path: string, lines = 3) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
  Array.from({ length: lines }, (_, i) => `+line ${i}`).join("\n") +
  "\n";

describe("filterDiff", () => {
  it("keeps ordinary source files", () => {
    const { diff, dropped } = filterDiff(section("src/index.ts"));
    expect(diff).toContain("src/index.ts");
    expect(dropped).toEqual([]);
  });

  // A lockfile churn is both the bulk of the payload and the least informative
  // part of it, and it crowds out the changes that explain the commit.
  it("drops lockfiles and build output, naming them", () => {
    const input = section("src/a.ts") + section("package-lock.json") + section("dist/bundle.js");
    const { diff, dropped } = filterDiff(input);
    expect(diff).toContain("src/a.ts");
    expect(diff).not.toContain("package-lock.json");
    expect(dropped).toEqual(["package-lock.json", "dist/bundle.js"]);
  });

  it("drops binary files", () => {
    const input = section("src/a.ts") + "diff --git a/logo.png b/logo.png\nBinary files differ\n";
    const { dropped } = filterDiff(input);
    expect(dropped).toContain("logo.png");
  });

  // Truncating at a file boundary and saying so is the difference between a
  // partial summary and a confidently wrong one.
  it("cuts at a file boundary and reports that it did", () => {
    const input = section("src/a.ts", 5) + section("src/enormous.ts", 5_000);
    const { diff, dropped, truncated } = filterDiff(input, 500);
    expect(truncated).toBe(true);
    expect(diff).toContain("src/a.ts");
    expect(diff).not.toContain("src/enormous.ts");
    expect(dropped).toContain("src/enormous.ts");
    // Whatever survives must still be a parseable diff, not a severed hunk.
    expect(diff.trimEnd().split("\n").at(-1)).toMatch(/^\+line/);
  });

  it("survives an empty diff", () => {
    expect(filterDiff("")).toEqual({ diff: "", dropped: [], truncated: false });
  });
});

describe("estimateCredits", () => {
  const metered = model({
    id: "metered",
    credits: 8,
    pricing: { meter: "tokens", unit: "credits_per_million_tokens", billing: "metered", input: 100, output: 1000 },
  });
  const flat = model({ id: "flat", credits: 2 });

  it("prices a metered model from its rates and the turn shape", () => {
    // 6000 in @100/M + 60 out @1000/M = 0.6 + 0.06
    expect(estimateCredits(metered, COMMIT_TURN)).toBeCloseTo(0.66, 5);
  });

  it("falls back to the flat charge when there are no rates", () => {
    expect(estimateCredits(flat, COMMIT_TURN)).toBe(2);
  });

  // The whole reason this exists: `credits` and `pricing` are different units,
  // and comparing them directly ranks a 2-credit flat model as dearer than a
  // model that would actually cost a fraction of that.
  it("makes flat and metered models comparable", () => {
    const ranked = rankByCost([flat, metered], COMMIT_TURN);
    expect(ranked[0].id).toBe("metered");
  });

  // A commit is input-heavy; a chat turn is not. Ranking by the headline output
  // price picks differently from ranking by what the job actually costs.
  it("ranks differently for differently shaped turns", () => {
    const inputHeavy = model({
      id: "cheap-in",
      pricing: { meter: "tokens", unit: "credits_per_million_tokens", billing: "metered", input: 10, output: 2000 },
    });
    const outputHeavy = model({
      id: "cheap-out",
      pricing: { meter: "tokens", unit: "credits_per_million_tokens", billing: "metered", input: 300, output: 100 },
    });
    expect(rankByCost([inputHeavy, outputHeavy], COMMIT_TURN)[0].id).toBe("cheap-in");
    expect(rankByCost([inputHeavy, outputHeavy], CHAT_TURN)[0].id).toBe("cheap-out");
  });
});

describe("cheapestChatModel", () => {
  it("never returns a transcription model", () => {
    const asr = model({ id: "whisper", capability: "transcription", credits: 0 });
    const chat = model({ id: "gpt", credits: 5 });
    expect(cheapestChatModel([asr, chat]).id).toBe("gpt");
  });

  it("says so when there is nothing to choose from", () => {
    expect(() => cheapestChatModel([])).toThrow(/No chat models/);
  });
});

describe("detectsConventional", () => {
  // Matching the repo's own history is the one thing a generic model reliably
  // gets wrong, and it is not worth a flag when the log already answers it.
  it("recognises a conventional-commit repo", () => {
    expect(
      detectsConventional(["feat: add thing", "fix(auth): stop redirect loop", "chore: bump"]),
    ).toBe(true);
  });

  it("recognises a prose repo", () => {
    expect(
      detectsConventional(["Add the thing", "Stop the redirect loop", "Bump dependencies"]),
    ).toBe(false);
  });

  it("needs a majority, not a single example", () => {
    expect(detectsConventional(["feat: one", "Second thing", "Third thing", "Fourth"])).toBe(false);
  });

  it("assumes nothing from an empty history", () => {
    expect(detectsConventional([])).toBe(false);
  });
});

describe("cleanMessage", () => {
  it("unwraps a fenced message", () => {
    expect(cleanMessage("```\nfix: the thing\n```")).toBe("fix: the thing");
    expect(cleanMessage("```text\nfix: the thing\n```")).toBe("fix: the thing");
  });

  it("strips a lead-in only when it is clearly separate", () => {
    expect(cleanMessage("Here's the commit message:\n\nfix: the thing")).toBe("fix: the thing");
  });

  // "commit message: …" on one line may well BE the subject; do not eat it.
  it("leaves a single-line subject alone", () => {
    expect(cleanMessage("fix: commit message: handle the colon")).toBe(
      "fix: commit message: handle the colon",
    );
  });

  it("preserves a multi-paragraph body", () => {
    const msg = "feat: add it\n\nBecause the old way was wrong.\n\nAlso this.";
    expect(cleanMessage(msg)).toBe(msg);
  });
});
