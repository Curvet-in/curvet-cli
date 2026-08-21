import type { ModelInfo } from "@curvet/sdk";

/**
 * Estimate what one turn costs on a model, in credits.
 *
 * Needed because the catalogue reports two incomparable things: `credits` is a
 * flat per-request charge, `pricing` is a rate per million tokens. Sorting them
 * against each other ranks a 1-credit flat model above a 16-credits-per-million
 * one, which is meaningless — and wrong far more often than not.
 *
 * The turn shape matters as much as the rates. A commit message is thousands of
 * tokens in and a couple of dozen out, so its input rate dominates; a chat turn
 * is far more balanced. Ranking either by the headline output price picks the
 * wrong model, sometimes by an order of magnitude.
 */
export interface TurnShape {
  inputTokens: number;
  outputTokens: number;
}

/** A diff in, a subject line out. */
export const COMMIT_TURN: TurnShape = { inputTokens: 6_000, outputTokens: 60 };

/** A question in, a paragraph or two out. */
export const CHAT_TURN: TurnShape = { inputTokens: 1_500, outputTokens: 500 };

export function estimateCredits(model: ModelInfo, turn: TurnShape): number {
  const pricing = model.pricing;
  if (pricing?.input != null && pricing?.output != null) {
    return (pricing.input * turn.inputTokens + pricing.output * turn.outputTokens) / 1_000_000;
  }
  // No published rates: the flat per-request figure is what it actually charges.
  return model.credits;
}

/** Cheapest first, for the given turn shape. */
export function rankByCost(models: ModelInfo[], turn: TurnShape): ModelInfo[] {
  return [...models].sort((a, b) => estimateCredits(a, turn) - estimateCredits(b, turn));
}
