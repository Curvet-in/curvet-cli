import { Command } from "commander";
import pc from "picocolors";
import type { ChatMessage, Usage } from "@curvet/sdk";
import { resolveProfile, type ResolvedProfile } from "../config.js";
import { makeClient, requireAppKey, v1Root } from "../client.js";
import { fail, printJson } from "../output.js";

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

interface StreamResult {
  text: string;
  usage?: Usage;
  model?: string;
}

/**
 * Stream via the OpenAI-compatible endpoint (POST {v1}/chat/completions, SSE).
 * The playground /chat endpoint is sync-only, so streaming goes through the
 * compat surface with the same app key as a Bearer token.
 */
async function streamChat(
  profile: ResolvedProfile,
  params: { model: string; messages: ChatMessage[]; temperature?: number; maxTokens?: number },
  onDelta: (text: string) => void,
): Promise<StreamResult> {
  const appKey = requireAppKey(profile);
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
  let text = "";
  let usage: Usage | undefined;
  let model: string | undefined;

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
      model ??= chunk.model;
      if (chunk.usage) usage = chunk.usage as Usage;
      const delta: string | undefined = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        onDelta(delta);
      }
    }
  }
  return { text, usage, model };
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
    .option("--json", "print the full response object as JSON (implies --no-stream)")
    .action(async (promptWords: string[], opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      requireAppKey(profile);

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
          const result = await streamChat(
            profile,
            { model, messages, temperature: opts.temperature, maxTokens: opts.maxTokens },
            (delta) => process.stdout.write(delta),
          );
          process.stdout.write("\n");
          costLine(model, result.usage);
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
      costLine(response.metadata.model, response.usage, response.metadata.latencyMs);
    });
}

function costLine(model: string, usage?: Usage, latencyMs?: number): void {
  if (!process.stderr.isTTY) return;
  const parts = [model];
  if (usage?.credits != null) parts.push(`${usage.credits} credits`);
  if (usage?.remainingBalance != null) parts.push(`${usage.remainingBalance} left`);
  if (latencyMs != null) parts.push(`${latencyMs}ms`);
  process.stderr.write(pc.dim(`— ${parts.join(" · ")}\n`));
}
