import type { Command } from "commander";
import pc from "picocolors";
import type { MediaJob } from "@curvet/sdk";
import { formatCost } from "../output.js";

/**
 * Read the flag only when it actually came from the command line. Commander
 * gives a `--no-x` option the value true when omitted, so the value alone would
 * mask CURVET_NO_COST and the stored setting.
 */
export function costFlagFrom(cmd: Command): boolean | undefined {
  return cmd.getOptionValueSource("cost") === "cli"
    ? (cmd.opts().cost as boolean)
    : undefined;
}

/**
 * The API reports a job's ETA as an absolute ISO timestamp. A countdown is what
 * a progress line actually wants, so convert when it parses and pass anything
 * else through untouched.
 */
export function formatEta(eta?: string): string | undefined {
  if (!eta) return undefined;
  const ts = Date.parse(eta);
  if (Number.isNaN(ts)) return `eta ${eta}`;
  return `eta ${Math.max(0, Math.round((ts - Date.now()) / 1000))}s`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Combine the positional prompt with piped stdin, erroring when both are empty. */
export async function readPrompt(words: string[]): Promise<string> {
  const fromArgs = words.join(" ").trim();
  const piped = process.stdin.isTTY ? "" : (await readStdin()).trim();
  const prompt = [fromArgs, piped].filter(Boolean).join("\n\n");
  if (!prompt) {
    console.error(`${pc.red("✘")} No prompt. Pass one as an argument or pipe text in.`);
    process.exit(1);
  }
  return prompt;
}

/** Print the cost line for a finished media job, when the job reported usage. */
export function writeMediaCost(job: MediaJob, model: string): void {
  const usage = job.usage as (typeof job.usage & { billing?: "metered" | "flat" }) | undefined;
  if (!usage) return;
  process.stderr.write(
    pc.dim(
      formatCost({
        model: (job.metadata?.model as string) ?? model,
        credits: usage.credits,
        billing: usage.billing,
        remainingBalance: usage.remainingBalance,
      }),
    ) + "\n",
  );
}
