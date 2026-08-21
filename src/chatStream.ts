import type { ChatMessage } from "@curvet/sdk";
import type { ResolvedProfile } from "./config.js";
import { requireAppKey, v1Root } from "./client.js";
import type { CostInfo } from "./output.js";

export interface StreamParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Abort mid-stream — Ctrl-C in the REPL cancels a reply, not the session. */
  signal?: AbortSignal;
}

/**
 * Stream via the OpenAI-compatible endpoint (POST {v1}/chat/completions, SSE).
 * The playground /chat endpoint is sync-only, so streaming goes through the
 * compat surface with the same app key as a Bearer token. Both endpoints bill
 * on the same `api` surface, so streaming does not change what a call costs.
 */
export async function streamChat(
  profile: ResolvedProfile,
  params: StreamParams,
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
    signal: params.signal,
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

