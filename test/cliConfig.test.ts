import { describe, expect, it } from "vitest";
import {
  acceptsImages,
  prettyName,
  toClineFields,
  toOpenCodeConfig,
  toVsCodeCopilotConfig,
  toZedConfig,
  usdPerMillion,
  type CliModel,
} from "../src/cliConfig.js";
import { mergeOpenCode, mergeVsCode, mergeZed } from "../src/commands/init.js";

const GPT: CliModel = {
  id: "gpt-5.5",
  owned_by: "openai",
  context_length: 256000,
  pricing: {
    prompt: "0.000005",
    completion: "0.00003",
    input_cache_read: "0.0000005",
  },
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
};

const UNPRICED: CliModel = { id: "mystery-1", context_length: 8000 };

const BASE = { baseUrl: "https://curvet.ai/api/v1" };

describe("usdPerMillion", () => {
  // 3e-6 * 1e6 is 2.9999999999999996 without the round-trip, and that number
  // ends up in a config file.
  it("scales per-token strings without float noise", () => {
    expect(usdPerMillion("0.000003")).toBe(3);
    expect(usdPerMillion("0.000005")).toBe(5);
    expect(usdPerMillion("0.0000005")).toBe(0.5);
  });

  it("treats missing, zero and unparseable rates as absent", () => {
    expect(usdPerMillion(undefined)).toBeUndefined();
    expect(usdPerMillion("0")).toBeUndefined();
    expect(usdPerMillion("free")).toBeUndefined();
  });
});

describe("prettyName", () => {
  it("dots a short version pair", () => {
    expect(prettyName("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
  });

  // The naive regex turns this into "Claude Haiku 4 5.20251001".
  it("drops a trailing build date instead of dotting it", () => {
    expect(prettyName("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
  });

  it("capitalises known acronyms and drops vendor noise", () => {
    expect(prettyName("gpt-5.5")).toBe("GPT 5.5");
    expect(prettyName("ali-qwen-image-2.0")).toBe("Qwen Image 2.0");
  });
});

describe("toOpenCodeConfig", () => {
  it("emits a cost block in USD per million tokens", () => {
    const cfg = toOpenCodeConfig([GPT], BASE) as any;
    expect(cfg.provider.curvet.models["gpt-5.5"].cost).toEqual({
      input: 5,
      output: 30,
      cache_read: 0.5,
    });
  });

  // OpenCode rejects a partial cost block outright, which is worse for the user
  // than the model simply not being listed.
  it("omits a model it cannot price rather than emitting a partial cost", () => {
    const cfg = toOpenCodeConfig([GPT, UNPRICED], BASE) as any;
    expect(Object.keys(cfg.provider.curvet.models)).toEqual(["gpt-5.5"]);
  });

  it("references the env var unless the key is explicitly inlined", () => {
    const off = toOpenCodeConfig([GPT], { ...BASE, apiKey: "app_secret" }) as any;
    expect(off.provider.curvet.options.apiKey).toBe("{env:CURVET_APP_KEY}");
    const on = toOpenCodeConfig([GPT], { ...BASE, apiKey: "app_secret", inlineKey: true }) as any;
    expect(on.provider.curvet.options.apiKey).toBe("app_secret");
  });
});

describe("toZedConfig", () => {
  it("uses the context window as max_tokens and declares capabilities", () => {
    const cfg = toZedConfig([GPT], BASE) as any;
    expect(cfg.language_models.openai_compatible.curvet.available_models[0]).toEqual({
      name: "gpt-5.5",
      display_name: "GPT 5.5",
      max_tokens: 256000,
      capabilities: { tools: true, images: true },
    });
  });

  it("skips a model with no context window, since max_tokens is required", () => {
    const cfg = toZedConfig([{ id: "x" }], BASE) as any;
    expect(cfg.language_models.openai_compatible.curvet.available_models).toEqual([]);
  });
});

describe("toVsCodeCopilotConfig", () => {
  // Copilot wants a full completions URL per model, not a base URL.
  it("gives each model the full chat/completions URL", () => {
    const cfg = toVsCodeCopilotConfig([GPT], BASE) as any;
    expect(cfg[0].models[0].url).toBe("https://curvet.ai/api/v1/chat/completions");
    expect(cfg[0].models[0].vision).toBe(true);
  });
});

describe("toClineFields", () => {
  it("lists the settings Cline asks for, with prices per million", () => {
    const fields = toClineFields(GPT, BASE);
    const byName = Object.fromEntries(fields.map((f) => [f.field, f.value]));
    expect(byName["API Provider"]).toBe("OpenAI Compatible");
    expect(byName["Model"]).toBe("gpt-5.5");
    expect(byName["Context Window"]).toBe("256000");
    expect(byName["Input Price (per 1M tokens, USD)"]).toBe("5");
    expect(byName["API Key"]).toBe("YOUR_APP_KEY");
  });
});

describe("acceptsImages", () => {
  it("reads the input modalities", () => {
    expect(acceptsImages(GPT)).toBe(true);
    expect(acceptsImages(UNPRICED)).toBe(false);
  });
});

// These run against a settings file the user has curated. Replacing a parent
// object to write a child is a data-loss bug, so each merge is asserted to
// leave everything else exactly as it was.
describe("merging into an existing config", () => {
  it("mergeZed keeps other providers and unrelated settings", () => {
    const existing = {
      theme: "One Dark",
      language_models: {
        openai_compatible: { someone_else: { api_url: "https://other.test" } },
        anthropic: { version: "1" },
      },
    };
    const merged = mergeZed(existing, toZedConfig([GPT], BASE)) as any;
    expect(merged.theme).toBe("One Dark");
    expect(merged.language_models.anthropic).toEqual({ version: "1" });
    expect(Object.keys(merged.language_models.openai_compatible)).toEqual([
      "someone_else",
      "curvet",
    ]);
    expect(existing.language_models.openai_compatible).not.toHaveProperty("curvet");
  });

  it("mergeOpenCode keeps other providers and does not clobber a $schema", () => {
    const existing = { $schema: "https://opencode.ai/config.json", provider: { local: {} }, theme: "x" };
    const merged = mergeOpenCode(existing, toOpenCodeConfig([GPT], BASE)) as any;
    expect(Object.keys(merged.provider)).toEqual(["local", "curvet"]);
    expect(merged.theme).toBe("x");
  });

  it("mergeOpenCode adds the $schema when the file lacks one", () => {
    const merged = mergeOpenCode({ provider: {} }, toOpenCodeConfig([GPT], BASE)) as any;
    expect(merged.$schema).toBe("https://opencode.ai/config.json");
  });

  // chatLanguageModels.json is a top-level array, so a second "Curvet" entry
  // would show every model twice rather than replacing the old set.
  it("mergeVsCode replaces our entry by name instead of appending", () => {
    const existing = [{ name: "Other", models: [] }, { name: "Curvet", models: ["stale"] }];
    const merged = mergeVsCode(existing, toVsCodeCopilotConfig([GPT], BASE)) as any[];
    expect(merged).toHaveLength(2);
    expect(merged[0].name).toBe("Other");
    expect(merged[1].models[0].id).toBe("gpt-5.5");
  });

  it("mergeVsCode appends when we are not there yet", () => {
    const merged = mergeVsCode([{ name: "Other" }], toVsCodeCopilotConfig([GPT], BASE)) as any[];
    expect(merged.map((e) => e.name)).toEqual(["Other", "Curvet"]);
  });
});
