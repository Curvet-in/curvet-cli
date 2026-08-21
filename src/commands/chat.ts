import { Command } from "commander";
import pc from "picocolors";
import type { ChatMessage } from "@curvet/sdk";
import { resolveProfile, loadConfig, resolveShowCost, type ResolvedProfile } from "../config.js";
import { makeClient, requireAppKey } from "../client.js";
import { catalogueFor, pickModel } from "../models.js";
import { costFlagFrom, readPrompt } from "./shared.js";
import { printJson, formatCost, type CostInfo } from "../output.js";
import { streamChat } from "../chatStream.js";

export function chatCommand(): Command {
  return new Command("chat")
    .description("Send a chat prompt (streams by default; reads stdin when piped)")
    .argument("[prompt...]", "the prompt; combined with piped stdin if both are given")
    .option("-m, --model <id>", "model id (default: profile defaultModel, else first chat model)")
    .option("-s, --system <text>", "system prompt")
    .option("-t, --temperature <n>", "sampling temperature", parseFloat)
    .option("--max-tokens <n>", "max response tokens", (v) => parseInt(v, 10))
    .option("--repl", "start an interactive session instead of a single prompt")
    .option("--no-stream", "wait for the full response instead of streaming")
    .option("--cost", "show the cost line even when disabled in config")
    .option("--no-cost", "hide the cost line (also: CURVET_NO_COST=1, or `curvet config set showCost false`)")
    .option("--json", "print the full response object as JSON (implies --no-stream)")
    .action(async (promptWords: string[], opts, cmd) => {
      if (opts.repl) {
        const profile = await resolveProfile(cmd.optsWithGlobals().profile);
        requireAppKey(profile);
        const config = await loadConfig();
        const { runRepl } = await import("./repl.js");
        await runRepl(profile, makeClient(profile), {
          model: await pickModel(catalogueFor(profile), {
            flag: opts.model,
            type: "chat",
            defaultModel: profile.defaultModel,
          }),
          system: opts.system,
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          showCost: resolveShowCost(config, costFlagFrom(cmd)),
        });
        return;
      }

      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      requireAppKey(profile);
      const config = await loadConfig();
      // Suppressed for --json too: the usage object is already in stdout there.
      const showCost = resolveShowCost(config, costFlagFrom(cmd)) && !opts.json;

      const prompt = await readPrompt(promptWords);

      const messages: ChatMessage[] = [];
      if (opts.system) messages.push({ role: "system", content: opts.system });
      messages.push({ role: "user", content: prompt });

      const model = await pickModel(catalogueFor(profile), {
        flag: opts.model,
        type: "chat",
        defaultModel: profile.defaultModel,
      });
      const wantStream = opts.stream !== false && !opts.json;

      if (wantStream) {
        try {
          const cost = await streamChat(
            profile,
            { model, messages, temperature: opts.temperature, maxTokens: opts.maxTokens },
            (delta) => process.stdout.write(delta),
          );
          process.stdout.write("\n");
          if (showCost) process.stderr.write(pc.dim(formatCost(cost)) + "\n");
          return;
        } catch (err) {
          const status = (err as { status?: number }).status;
          // Older backends may not expose the compat endpoint — fall back to sync.
          if (status !== 404 && status !== 405) throw err;
          process.stderr.write(
            pc.dim("(streaming endpoint unavailable, falling back to sync)\n"),
          );
        }
      }

      const client = makeClient(profile);
      const response = await client.chat.create({
        model,
        messages,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
      });
      if (opts.json) {
        printJson(response);
        return;
      }
      console.log(response.response);
      if (showCost) {
        // `billing` is returned by the API but not yet declared on the SDK's Usage type.
        const usage = response.usage as typeof response.usage & {
          billing?: "metered" | "flat";
        };
        process.stderr.write(
          pc.dim(
            formatCost({
              model: response.metadata.model,
              credits: usage.credits,
              billing: usage.billing,
              remainingBalance: usage.remainingBalance,
              latencyMs: response.metadata.latencyMs,
            }),
          ) + "\n",
        );
      }
    });
}
