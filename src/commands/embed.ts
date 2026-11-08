import { Command } from "commander";
import pc from "picocolors";
import { resolveProfile, loadConfig, resolveShowCost } from "../config.js";
import { makeClient, requireAppKey } from "../client.js";
import { catalogueFor, pickModel } from "../models.js";
import { costFlagFrom, readPrompt } from "./shared.js";
import { formatCost, printJsonLine, type CostInfo } from "../output.js";

/** Components shown per vector: enough to see it is real, never the whole thing. */
const PREVIEW = 4;

/**
 * The part of an embeddings response this command reads: OpenAI's shape plus
 * Curvet's `x_curvet` settlement block. Narrower than the SDK's type on purpose,
 * so a deployment that predates `x_curvet` still prints its vectors.
 */
export interface EmbedResult {
  model?: string;
  data: Array<{ index: number; embedding: number[] }>;
  usage?: { prompt_tokens?: number };
  x_curvet?: { credits_charged?: number; billing?: string; tokens_in?: number };
}

/** One input by default; --lines embeds each non-empty line on its own. */
export function inputsFrom(text: string, perLine: boolean): string[] {
  if (!perLine) return [text];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** `384 dims  [0.0123, -0.0456, 0.0789, 0.0012, …]` */
export function describeVector(v: number[]): string {
  const head = v.slice(0, PREVIEW).map((n) => n.toFixed(4)).join(", ");
  return `${v.length} dims  [${head}${v.length > PREVIEW ? ", …" : ""}]`;
}

/**
 * The cost line's figures. Non-stream calls on the OpenAI-compatible surface
 * report the charge in X-Curvet-* headers, which the SDK does not expose, so the
 * same figures are read from the `x_curvet` block in the body instead.
 */
export function embedCost(res: EmbedResult, model: string, latencyMs: number): CostInfo {
  const billing = res.x_curvet?.billing;
  return {
    model: res.model ?? model,
    credits: res.x_curvet?.credits_charged,
    billing: billing === "metered" || billing === "flat" ? billing : undefined,
    tokensIn: res.x_curvet?.tokens_in ?? res.usage?.prompt_tokens,
    latencyMs,
  };
}

export function embedCommand(): Command {
  return new Command("embed")
    .description("Turn text into embedding vectors (reads stdin when piped)")
    .argument("[text...]", "the text; combined with piped stdin if both are given")
    .option("-m, --model <id>", "embedding model id (default: the first embedding model)")
    .option("--lines", "embed each non-empty line as its own input")
    .option("--cost", "show the cost line even when disabled in config")
    .option("--no-cost", "hide the cost line")
    .option("--json", "print the whole response, vectors included, as one line of JSON")
    .action(async (words: string[], opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      requireAppKey(profile);
      const config = await loadConfig();
      // Suppressed for --json too: the usage and x_curvet blocks are in stdout there.
      const showCost = resolveShowCost(config, costFlagFrom(cmd)) && !opts.json;

      const input = inputsFrom(await readPrompt(words), opts.lines === true);
      if (input.length === 0) throw new Error("Nothing to embed — every line was blank.");

      const client = makeClient(profile);
      // Checked before the call, as chat, image and stt are: `-m gpt-4o-mini`
      // here is refused for free instead of after a request.
      const model = await pickModel(catalogueFor(profile, client), {
        flag: opts.model,
        type: "embedding",
        capability: "embedding",
      });

      const started = Date.now();
      const res: EmbedResult = await client.embeddings.create({
        model,
        input: input.length === 1 ? input[0] : input,
      });

      if (opts.json) {
        // One line on purpose: indented, a 1,536-dim vector is 1,536 lines.
        printJsonLine(res);
        return;
      }

      const many = res.data.length > 1;
      for (const item of [...res.data].sort((a, b) => a.index - b.index)) {
        console.log(`${many ? pc.dim(`#${item.index}  `) : ""}${describeVector(item.embedding)}`);
      }
      if (showCost) {
        process.stderr.write(pc.dim(formatCost(embedCost(res, model, Date.now() - started))) + "\n");
      }
    });
}
