import { describe, expect, it } from "vitest";
import { describeVector, embedCost, inputsFrom } from "../src/commands/embed.js";
import { formatCost } from "../src/output.js";

describe("inputsFrom", () => {
  // A paragraph is one text to embed; splitting it unasked would hand back
  // several vectors where one was wanted.
  it("keeps the text whole by default", () => {
    expect(inputsFrom("first line\nsecond line", false)).toEqual(["first line\nsecond line"]);
  });

  // A blank line would be an empty input, which the API refuses — and a file of
  // queries from Windows ends every line in \r.
  it("embeds each non-empty line on its own with --lines", () => {
    expect(inputsFrom("alpha\r\n\r\n  beta \n", true)).toEqual(["alpha", "beta"]);
  });
});

describe("describeVector", () => {
  // Enough to see the vector is real, never all 1,536 numbers of one.
  it("shows the length and the first few components", () => {
    expect(describeVector([0.1, -0.2, 0.3, 0.4, 0.5])).toBe(
      "5 dims  [0.1000, -0.2000, 0.3000, 0.4000, …]",
    );
  });

  it("drops the ellipsis when nothing was left out", () => {
    expect(describeVector([1, 2])).toBe("2 dims  [1.0000, 2.0000]");
  });
});

describe("embedCost", () => {
  // The compat route reports a non-stream charge in X-Curvet-* headers, which
  // the SDK does not surface; the x_curvet block in the body is the only place
  // the CLI can read what the call cost.
  it("reads the charge from the x_curvet block", () => {
    const line = formatCost(
      embedCost(
        {
          model: "all-minilm-l6-v2",
          data: [],
          usage: { prompt_tokens: 12 },
          x_curvet: { credits_charged: 0.01, billing: "metered", tokens_in: 12 },
        },
        "all-minilm-l6-v2",
        300,
      ),
    );
    expect(line).toBe("— all-minilm-l6-v2 · 0.01 credits (metered) · 12 in · 300ms");
  });

  // A deployment without the block still has usage, and the line should say
  // what it can rather than nothing.
  it("falls back to usage when there is no x_curvet block", () => {
    const info = embedCost({ data: [], usage: { prompt_tokens: 7 } }, "text-embedding-3-small", 5);
    expect(info.tokensIn).toBe(7);
    expect(info.credits).toBeUndefined();
  });

  it("names the model asked for when the response does not", () => {
    expect(embedCost({ data: [] }, "text-embedding-3-small", 5).model).toBe("text-embedding-3-small");
  });

  // CostInfo prints the billing label verbatim, so only the two schemes the
  // CLI knows how to describe get through.
  it("drops a billing label it does not know", () => {
    expect(embedCost({ data: [], x_curvet: { billing: "mystery" } }, "m", 1).billing).toBeUndefined();
  });
});
