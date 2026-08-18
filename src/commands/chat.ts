import { Command } from "commander";
import pc from "picocolors";
import type { ChatMessage } from "@curvet/sdk";
import { resolveProfile, loadConfig, resolveShowCost, type ResolvedProfile } from "../config.js";
import { makeClient, requireAppKey, v1Root } from "../client.js";
import { fail, printJson, formatCost, type CostInfo } from "../output.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Pick a model: --model flag > profile default > first chat model in the catalogue. */
async function resolveModel(profile: ResolvedProfile, flag?: string): Promise<string> {
  if (flag) return flag;
  if (profile.defaultModel) return profile.defaultModel;
  const client = makeClient(profile);
  const chatModels = await client.models.list({ type: "chat" });
  if (chatModels.length === 0) {
    throw new Error("No chat models available for this app — pass --model explicitly.");
  }
  return chatModels[0].id;
}

/**
 * Stream via the OpenAI-compatible endpoint (POST {v1}/chat/completions, SSE).
 * The playground /chat endpoint is sync-only, so streaming goes through the
 * compat surface with the same app key as a Bearer token. Both endpoints bill
 * on the same `api` surface, so streaming does not change what a call costs.
 */
async function streamChat(
  profile: ResolvedProfile,
  params: { model: string; messages: ChatMessage[]; temperature?: number; maxTokens?: number },
  onDelta: (text: string) => void,
): Promise<CostInfo> {
  const appKey = requireAppKey(profile);
  const startedAt = Date.now();
  const res = await fetch(`${v1Root(profile.baseURL)}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${appKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      stream: true,
      // Opt into the trailing usage chunk; without this the server has no
      // reason to forward token counts and the stream reports no usage at all.
      stream_options: { include_usage: true },
    }),
  });

  if (!res.ok || !res.body) {
    const bodyText = await res.text().catch(() => "");
    const err = new Error(
      `Streaming request failed (HTTP ${res.status})${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`,
    );
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const cost: CostInfo = { model: params.model };

  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      let chunk: Record<string, any>;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.model) cost.model = chunk.model;

      // Token counts from the include_usage chunk.
      if (chunk.usage) {
        cost.tokensIn = chunk.usage.prompt_tokens ?? cost.tokensIn;
        cost.tokensOut = chunk.usage.completion_tokens ?? cost.tokensOut;
      }

      // Curvet's settlement chunk: the credits the wallet actually moved, and
      // whether metered or flat pricing charged them. Sent last, once settled.
      if (chunk.x_curvet) {
        const x = chunk.x_curvet;
        if (x.credits_charged != null) cost.credits = x.credits_charged;
        if (x.billing) cost.billing = x.billing;
        if (x.tokens_in != null) cost.tokensIn = x.tokens_in;
        if (x.tokens_out != null) cost.tokensOut = x.tokens_out;
      }

      const delta: string | undefined = chunk.choices?.[0]?.delta?.content;
      if (delta) onDelta(delta);
    }
  }
  cost.latencyMs = Date.now() - startedAt;
  return cost;
}

export function chatCommand(): Command {
  return new Command("chat")
    .description("Send a chat prompt (streams by default; reads stdin when piped)")
    .argument("[prompt...]", "the prompt; combined with piped stdin if both are given")
    .option("-m, --model <id>", "model id (default: profile defaultModel, else first chat model)")
    .option("-s, --system <text>", "system prompt")
    .option("-t, --temperature <n>", "sampling temperature", parseFloat)
    .option("--max-tokens <n>", "max response tokens", (v) => parseInt(v, 10))
    .option("--no-stream", "wait for the full response instead of streaming")
    .option("--cost", "show the cost line even when disabled in config")
    .option("--no-cost", "hide the cost line (also: CURVET_NO_COST=1, or `curvet config set showCost false`)")
    .option("--json", "print the full response object as JSON (implies --no-stream)")
    .action(async (promptWords: string[], opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      requireAppKey(profile);
      const config = await loadConfig();
      // Commander defaults `cost` to true for a `--no-cost` option, so the value
      // alone cannot tell "flag omitted" from "flag given". Only treat it as an
      // explicit choice when it actually came from the command line — otherwise
      // it would mask CURVET_NO_COST and the stored setting.
      const costFlag =
        cmd.getOptionValueSource("cost") === "cli" ? (opts.cost as boolean) : undefined;
      // Suppressed for --json too: the usage object is already in stdout there.
      const showCost = resolveShowCost(config, costFlag) && !opts.json;

      const argPrompt = promptWords.join(" ").trim();
      const piped = process.stdin.isTTY ? "" : (await readStdin()).trim();
      const prompt = [argPrompt, piped].filter(Boolean).join("\n\n");
      if (!prompt) {
        console.error(fail("No prompt. Pass one as an argument or pipe text in."));
        process.exit(1);
      }

      const messages: ChatMessage[] = [];
      if (opts.system) messages.push({ role: "system", content: opts.system });
      messages.push({ role: "user", content: prompt });

      const model = await resolveModel(profile, opts.model);
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
