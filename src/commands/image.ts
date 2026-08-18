import { Command } from "commander";
import pc from "picocolors";
import { resolveProfile, loadConfig, resolveShowCost } from "../config.js";
import { makeClient, requireAppKey } from "../client.js";
import { pickModel } from "../models.js";
import { downloadTo, formatBytes } from "../download.js";
import { costFlagFrom, readPrompt } from "./shared.js";
import { formatCost, printJson, ok } from "../output.js";

export function imageCommand(): Command {
  return new Command("image")
    .description("Generate an image")
    .argument("[prompt...]", "the prompt; combined with piped stdin if both are given")
    .option("-m, --model <id>", "model id (default: first image model)")
    .option("--size <WxH>", "output dimensions, e.g. 1024x1024")
    .option("-o, --output <file>", "save the image here instead of printing its URL")
    .option("--cost", "show the cost line even when disabled in config")
    .option("--no-cost", "hide the cost line")
    .option("--json", "machine-readable output")
    .action(async (promptWords: string[], opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      requireAppKey(profile);
      const config = await loadConfig();
      const showCost = resolveShowCost(config, costFlagFrom(cmd)) && !opts.json;

      const prompt = await readPrompt(promptWords);
      const model = await pickModel(profile, opts.model, "image");
      const client = makeClient(profile);

      const res = await client.image.generate({ model, prompt, size: opts.size });

      if (opts.json) {
        printJson(res);
        return;
      }

      if (opts.output) {
        const bytes = await downloadTo(res.imageUrl, opts.output);
        console.log(ok(`saved ${opts.output} (${formatBytes(bytes)})`));
      } else {
        console.log(res.imageUrl);
      }

      if (showCost) {
        const usage = res.usage as typeof res.usage & { billing?: "metered" | "flat" };
        process.stderr.write(
          pc.dim(
            formatCost({
              model: res.metadata.model,
              credits: usage.credits,
              billing: usage.billing,
              remainingBalance: usage.remainingBalance,
              latencyMs: res.metadata.latencyMs,
            }),
          ) + "\n",
        );
      }
    });
}
