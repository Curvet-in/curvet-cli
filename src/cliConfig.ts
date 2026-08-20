/**
 * Coding-tool configuration, generated from the live model catalogue.
 *
 * Ported from darkapp-haven's `src/components/developer/cliConfig.ts` so the
 * docs page and `curvet init` cannot drift apart. The reasoning there holds
 * here and is worth restating: hand-written setup snippets are how we shipped a
 * config that made OpenCode report "$0.00 spent" on a 16,705-token session, and
 * how a model id we do not serve (`gemini-3-pro`) ended up in a real user's
 * config 404-ing every request. Both are the same failure — a literal that the
 * code has no way to keep true.
 *
 * So nothing here hardcodes a model id or a price. Everything is derived from
 * `GET /v1/models`.
 */

export interface CliModel {
  id: string;
  owned_by?: string;
  context_length?: number;
  /** OpenRouter shape — USD per token, as strings. */
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
  /** Curvet shape — credits per million tokens. */
  x_curvet_pricing?: {
    input?: number;
    output?: number;
    cached_input?: number;
    billing?: "metered" | "flat_per_request";
  };
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
}

/** Whether a model accepts images, for the tools whose config declares it. */
export function acceptsImages(m: CliModel): boolean {
  return (m.architecture?.input_modalities || []).includes("image");
}

/** Placeholder used wherever we cannot (or should not) print a real key. */
export const KEY_PLACEHOLDER = "YOUR_APP_KEY";

/** USD per 1,000,000 tokens, from the per-token string the API publishes. */
export function usdPerMillion(perToken?: string): number | undefined {
  if (!perToken) return undefined;
  const n = Number(perToken);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Float noise: 3e-6 * 1e6 is 2.9999999999999996 without the round-trip.
  return Number((n * 1e6).toFixed(4));
}

/**
 * `opencode.json` for the Curvet provider.
 *
 * The `cost` block is the point. OpenCode prices a turn from its own model
 * metadata and has no field for reading rates off a provider — its schema takes
 * `cost: { input, output, cache_read, cache_write }` in USD per million tokens,
 * the models.dev convention. Omit it and every session reads $0.00 no matter how
 * many tokens went through.
 *
 * `limit` is deliberately not emitted: it requires `output` (max completion
 * tokens), which we do not publish, and OpenCode may use that number to cap
 * requests. A guess there would silently truncate answers.
 */
export function toOpenCodeConfig(
  models: CliModel[],
  opts: { baseUrl: string; apiKey?: string; inlineKey?: boolean },
): unknown {
  const { baseUrl, apiKey, inlineKey = false } = opts;
  const modelBlock: Record<string, unknown> = {};

  for (const m of models) {
    const cost: Record<string, number> = {};
    const input = usdPerMillion(m.pricing?.prompt);
    const output = usdPerMillion(m.pricing?.completion);
    // Both are required by OpenCode's schema — a partial cost block is rejected
    // outright, which is worse than leaving the model unpriced.
    if (input === undefined || output === undefined) continue;
    cost.input = input;
    cost.output = output;
    const cacheRead = usdPerMillion(m.pricing?.input_cache_read);
    const cacheWrite = usdPerMillion(m.pricing?.input_cache_write);
    if (cacheRead !== undefined) cost.cache_read = cacheRead;
    if (cacheWrite !== undefined) cost.cache_write = cacheWrite;

    modelBlock[m.id] = { name: prettyName(m.id), cost };
  }

  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      curvet: {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: baseUrl,
          apiKey: inlineKey && apiKey ? apiKey : "{env:CURVET_APP_KEY}",
        },
        models: modelBlock,
      },
    },
  };
}

/**
 * Zed's `settings.json` block.
 *
 * Zed keys the credential off the provider id — the provider below is `curvet`,
 * so the key goes in `CURVET_API_KEY` or through the Agent Panel, never into
 * this file. `max_tokens` is the context window; `max_output_tokens` is optional
 * and omitted for the same reason as everywhere else.
 */
export function toZedConfig(models: CliModel[], opts: { baseUrl: string }): unknown {
  return {
    language_models: {
      openai_compatible: {
        curvet: {
          api_url: opts.baseUrl,
          available_models: models
            .filter((m) => m.context_length)
            .map((m) => ({
              name: m.id,
              display_name: prettyName(m.id),
              max_tokens: m.context_length,
              capabilities: { tools: true, images: acceptsImages(m) },
            })),
        },
      },
    },
  };
}

/**
 * `chatLanguageModels.json` for VS Code's built-in Copilot Chat.
 *
 * Copilot takes a custom OpenAI-compatible endpoint natively: Chat: Manage
 * Language Models → Add Models → Custom Endpoint, which opens this file. Note it
 * wants a **full** completions URL per model rather than a base URL.
 *
 * `maxOutputTokens` is deliberately absent — we do not publish a per-model
 * ceiling, and a guessed one would silently truncate replies.
 */
export function toVsCodeCopilotConfig(
  models: CliModel[],
  opts: { baseUrl: string; apiKey?: string; inlineKey?: boolean },
): unknown {
  const { baseUrl, apiKey, inlineKey = false } = opts;
  return [
    {
      name: "Curvet",
      vendor: "customendpoint",
      apiKey: inlineKey && apiKey ? apiKey : "${input:curvetAppKey}",
      apiType: "chat-completions",
      models: models.map((m) => ({
        id: m.id,
        name: prettyName(m.id),
        url: `${baseUrl}/chat/completions`,
        toolCalling: true,
        vision: acceptsImages(m),
        ...(m.context_length ? { maxInputTokens: m.context_length } : {}),
      })),
    },
  ];
}

/**
 * The values to type into Cline, which has no config file.
 *
 * Its OpenAI-Compatible provider takes Base URL / API Key / Model, and a Model
 * Configuration section with Context Window and Input/Output Price — the same
 * numbers OpenCode reads from a file, entered by hand. Max Output Tokens is left
 * to the user: we do not publish a per-model ceiling and Cline sends this value.
 */
export function toClineFields(
  model: CliModel,
  opts: { baseUrl: string; apiKey?: string },
): Array<{ field: string; value: string }> {
  const { baseUrl, apiKey } = opts;
  const input = usdPerMillion(model.pricing?.prompt);
  const output = usdPerMillion(model.pricing?.completion);
  return [
    { field: "API Provider", value: "OpenAI Compatible" },
    { field: "Base URL", value: baseUrl },
    { field: "API Key", value: apiKey || KEY_PLACEHOLDER },
    { field: "Model", value: model.id },
    ...(model.context_length
      ? [{ field: "Context Window", value: String(model.context_length) }]
      : []),
    ...(input !== undefined
      ? [{ field: "Input Price (per 1M tokens, USD)", value: String(input) }]
      : []),
    ...(output !== undefined
      ? [{ field: "Output Price (per 1M tokens, USD)", value: String(output) }]
      : []),
  ];
}

/** Where each tool keeps its configuration, for the assistant prompt. */
const TOOL_CONFIG_HINT: Record<string, string> = {
  opencode:
    "OpenCode — the file is ~/.config/opencode/opencode.json. Model entries take a `cost` block: { input, output, cache_read, cache_write } in USD per MILLION tokens.",
  cline:
    'Cline (VS Code extension) — configured through its settings UI, not a file. Provider is "OpenAI Compatible"; the price fields live under "Model Configuration" (Input Price, Output Price, Context Window).',
  vscode:
    'VS Code\'s built-in Copilot Chat — run "Chat: Manage Language Models" → Add Models → Custom Endpoint → API type "Chat Completions", which opens chatLanguageModels.json. Each model needs a FULL url ending in /chat/completions, not a base URL.',
  zed:
    "Zed — ~/.config/zed/settings.json, under language_models.openai_compatible. Each model takes name, display_name, max_tokens (the context window) and capabilities { tools, images }.",
  cursor:
    "Cursor — Settings → Models → enable a custom OpenAI base URL, then add the model ids as custom models.",
  continue: 'Continue — its config.json, as a provider of type "openai" with apiBase set.',
  other: "The tool the user names below. Anything that speaks OpenAI Chat Completions works.",
};

/**
 * A prompt the user can hand to an AI assistant to do the setup for them.
 *
 * Increasingly the way people configure anything, and it fails in a specific way
 * worth designing against: an assistant asked to "add Curvet to my editor" will
 * invent plausible model ids and omit prices, which is exactly how a config ends
 * up 404-ing and reporting $0.00 a session. So the prompt carries the real ids
 * and the real rates as data, and says plainly that neither is to be guessed at.
 *
 * The key is left as a placeholder unless the user opts in — pasting a live
 * credential into a chat window is a different risk from pasting it into a
 * config file, and it is not our call to make quietly.
 */
export function toAssistantPrompt(
  models: CliModel[],
  opts: {
    tool?: string;
    baseUrl: string;
    apiKey?: string;
    inlineKey?: boolean;
    /** The config `curvet init` already generated for the tool, when there is one. */
    generatedConfig?: string;
  },
): string {
  const { tool = "other", baseUrl, apiKey, inlineKey = false, generatedConfig } = opts;
  const key = inlineKey && apiKey ? apiKey : KEY_PLACEHOLDER;

  const table = models
    .map((m) => {
      const i = usdPerMillion(m.pricing?.prompt);
      const o = usdPerMillion(m.pricing?.completion);
      const cr = usdPerMillion(m.pricing?.input_cache_read);
      const cw = usdPerMillion(m.pricing?.input_cache_write);
      const cache = [
        cr !== undefined ? `$${cr}/1M cached input` : null,
        cw !== undefined ? `$${cw}/1M cache write` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const ctx = m.context_length
        ? `${Math.round(m.context_length / 1000)}K context`
        : "context unknown";
      const vision = acceptsImages(m) ? ", accepts images" : "";
      return `- ${m.id} — $${i}/1M input, $${o}/1M output${cache ? `, ${cache}` : ""}, ${ctx}${vision}`;
    })
    .join("\n");

  const facts = `Connection:
- Base URL: ${baseUrl}
- Auth: Authorization: Bearer ${key}   (the header x-app-key also works)
- Endpoints: POST /chat/completions and GET /models, relative to that base URL
- Fully OpenAI Chat Completions compatible: stream, tools/tool_choice, image input,
  and stream_options.include_usage all behave as they do with OpenAI.

Models — use these ids EXACTLY as written. Do not guess, abbreviate or "correct"
them; an id that is not on this list returns 404. Prices are USD per MILLION
tokens:
${table}

Why the prices matter, because this is the mistake that gets made: coding tools
compute spend from their own model catalogue, and these ids are in no public
catalogue. If the tool has price or context fields, they must be filled in from
the list above, or it displays $0.00 for every request no matter how many tokens
are used. The charge is real either way.

Billing note: requests are metered per token, and the key bills the Curvet
account that owns it — not whoever is typing.`;

  // When we already generated the file, hand it over rather than describing it.
  //
  // Asked to write the config from a description, an assistant reliably invents
  // the surrounding schema — tested against this exact prompt, it produced
  // OpenCode config with "providers" for "provider", "type" for "npm", invented
  // contextLength/attachments keys and zeroed cache rates, all with correct
  // model ids. Correct data in a schema the tool rejects is still a broken
  // setup, and no wording fixes it: the assistant does not know the schema.
  if (generatedConfig) {
    return `Set me up to use Curvet in ${TOOL_CONFIG_HINT[tool] || "my coding tool"}

Below is the exact configuration, already generated for me from Curvet's live
model catalogue. Use it VERBATIM — do not rewrite the structure, rename keys,
drop models, or "improve" the schema. It is correct for this tool as it stands.

Your job is the part I cannot copy-paste:
1. Tell me exactly where this file goes, and if one already exists there, merge
   these entries into it without destroying my other settings.
2. Handle the API key properly for this tool (env var, prompt, or keychain —
   whichever it supports) rather than leaving a credential in a shared file.
3. Give me one command to verify it works, and tell me what a correct response
   looks like.
4. If anything in the config conflicts with a newer version of the tool, say so
   explicitly rather than silently changing it.

\`\`\`json
${generatedConfig}
\`\`\`

${facts}`;
  }

  return `Set up Curvet as an OpenAI-compatible AI provider in my coding tool, and give me the exact config plus where to put it.

Target tool: ${TOOL_CONFIG_HINT[tool] || TOOL_CONFIG_HINT.other}

Before writing anything: check the tool's current documentation for the exact
config schema, and use only fields it actually defines. Do not invent key names
— a config with the right numbers in the wrong shape is rejected outright. If
you are unsure of the schema, say so instead of guessing.

${facts}

Output: the complete config file (or the exact settings to enter), the path it
belongs at, and how to verify it works in one command.`;
}

/** A curl that proves the key and the model id in one shot. */
export function toCurlExample(
  modelId: string,
  opts: { baseUrl: string; apiKey?: string },
): string {
  return `curl ${opts.baseUrl}/chat/completions \\
  -H "Authorization: Bearer ${opts.apiKey || KEY_PLACEHOLDER}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${modelId}","messages":[{"role":"user","content":"Say hi in 3 words."}]}'`;
}

/**
 * "claude-sonnet-4-6" → "Claude Sonnet 4.6". Display label only; the id is what
 * gets sent.
 *
 * Careful with the version join: a naive `-(\d+)-(\d+)$` turns
 * `claude-haiku-4-5-20251001` into "Claude Haiku 4 5.20251001". Dated builds
 * drop the date, and only short numeric pairs become a dotted version.
 */
export function prettyName(id: string): string {
  const CAPS: Record<string, string> = { gpt: "GPT", ali: "", sdk: "SDK" };
  return id
    .replace(/-\d{8}$/, "") // trailing build date: claude-haiku-4-5-20251001
    .replace(/-(\d{1,2})-(\d{1,2})$/, "-$1.$2") // 4-6 → 4.6, never 5-20251001
    .split("-")
    .map((part) => {
      const mapped = CAPS[part.toLowerCase()];
      if (mapped !== undefined) return mapped;
      if (/^\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .filter(Boolean)
    .join(" ");
}
