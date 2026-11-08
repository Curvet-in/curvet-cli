import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@curvet/sdk";
import { bareId, findModel, pickModel, type Catalogue } from "../src/models.js";
import { modelRows, statusOf } from "../src/commands/models.js";

function model(partial: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    name: partial.id,
    cost: 0.01,
    type: "chat",
    provider: "test",
    credits: 1,
    capability: "generation",
    available: true,
    comingSoon: false,
    surface: "api",
    ...partial,
  } as ModelInfo;
}

const TTS = model({ id: "ali-qwen3-tts-flash", type: "audio", provider: "dashscope" });
const ASR = model({
  id: "whisper-large-v3",
  type: "audio",
  provider: "deepinfra",
  capability: "transcription",
  endpoint: "POST /api/v1/voice/stt/public",
});
const CHAT = model({ id: "gpt-5.5", supportsVision: true, credits: 8 });
const SOON = model({ id: "sunno-ai", type: "audio", available: false, comingSoon: true, surface: null });
const DASHBOARD = model({ id: "kitten-tts", type: "audio", surface: "dashboard" });
// Capability left at the factory's "generation": the server fills a missing one
// in that way, and the CLI must still know an embedder when it sees one.
const EMBED = model({
  id: "all-minilm-l6-v2",
  type: "embedding",
  provider: "deepinfra",
  aliases: ["sentence-transformers/all-minilm-l6-v2"],
});
const LLAMA = model({
  id: "llama-3.3-70b",
  provider: "deepinfra",
  aliases: ["meta-llama/llama-3.3-70b-instruct"],
});

// New entries go last, so "the first model of the type" is still gpt-5.5.
const RUNNABLE = [CHAT, TTS, ASR, EMBED, LLAMA];

const catalogue: Catalogue = {
  runnable: async (type) => (type ? RUNNABLE.filter((m) => m.type === type) : RUNNABLE),
  all: async () => [...RUNNABLE, SOON, DASHBOARD],
};

describe("pickModel", () => {
  it("defaults to the first model of the type", async () => {
    expect(await pickModel(catalogue, { type: "chat" })).toBe("gpt-5.5");
  });

  it("prefers the profile default for chat", async () => {
    expect(await pickModel(catalogue, { type: "chat", defaultModel: "gpt-4o-mini" })).toBe(
      "gpt-4o-mini",
    );
  });

  it("skips transcription models when defaulting an audio generation", async () => {
    expect(await pickModel(catalogue, { type: "audio", capability: "generation" })).toBe(
      "ali-qwen3-tts-flash",
    );
  });

  it("defaults to a transcription model when that is what is wanted", async () => {
    expect(await pickModel(catalogue, { type: "audio", capability: "transcription" })).toBe(
      "whisper-large-v3",
    );
  });

  // The bug this whole change exists for: whisper is type "audio" like every TTS
  // model, so `curvet audio -m whisper-large-v3` used to submit a job that could
  // never succeed.
  it("rejects a speech-to-text model on an audio generation, and points at stt", async () => {
    await expect(
      pickModel(catalogue, { flag: "whisper-large-v3", type: "audio", capability: "generation" }),
    ).rejects.toThrow(/speech-to-text[\s\S]*curvet stt/);
  });

  it("rejects a text-to-speech model on a transcription", async () => {
    await expect(
      pickModel(catalogue, {
        flag: "ali-qwen3-tts-flash",
        type: "audio",
        capability: "transcription",
      }),
    ).rejects.toThrow(/cannot transcribe/);
  });

  it("rejects a model of the wrong type", async () => {
    await expect(pickModel(catalogue, { flag: "gpt-5.5", type: "image" })).rejects.toThrow(
      /is a chat model/,
    );
  });

  it("explains a coming-soon model instead of calling it", async () => {
    await expect(
      pickModel(catalogue, { flag: "sunno-ai", type: "audio" }),
    ).rejects.toThrow(/not callable yet/);
  });

  it("explains a dashboard-only model", async () => {
    await expect(
      pickModel(catalogue, { flag: "kitten-tts", type: "audio" }),
    ).rejects.toThrow(/only runs in the Curvet dashboard/);
  });

  it("explains an id that is in no catalogue at all", async () => {
    await expect(pickModel(catalogue, { flag: "nope-9000", type: "chat" })).rejects.toThrow(
      /not in this app's model catalogue/,
    );
  });

  it("errors when nothing of the type exists", async () => {
    await expect(pickModel(catalogue, { type: "video" })).rejects.toThrow(/No video models/);
  });

  // The fixture's embedder carries the server's default "generation" label, so
  // this only passes because the CLI keys embedders on their type.
  it("defaults to an embedder for embed, whatever capability it is labelled with", async () => {
    expect(await pickModel(catalogue, { type: "embedding", capability: "embedding" })).toBe(
      "all-minilm-l6-v2",
    );
  });

  // Even a listing that is not filtered by type must not make an embedder the
  // chat default because it happens to come first.
  it("never defaults chat to an embedder", async () => {
    const embedderFirst: Catalogue = {
      runnable: async () => [EMBED, CHAT],
      all: async () => [EMBED, CHAT],
    };
    expect(await pickModel(embedderFirst, { type: "chat" })).toBe("gpt-5.5");
  });

  it("says plainly when the app has no embedding models", async () => {
    const chatOnly: Catalogue = {
      runnable: async (type) => [CHAT].filter((m) => !type || m.type === type),
      all: async () => [CHAT],
    };
    await expect(
      pickModel(chatOnly, { type: "embedding", capability: "embedding" }),
    ).rejects.toThrow(/No embedding models are available to this app/);
  });

  it("rejects an embedder on chat, and points at embed", async () => {
    await expect(
      pickModel(catalogue, { flag: "all-minilm-l6-v2", type: "chat" }),
    ).rejects.toThrow(/embedding model[\s\S]*curvet embed -m all-minilm-l6-v2/);
  });

  it("rejects a chat model on embed, and points back at chat", async () => {
    await expect(
      pickModel(catalogue, { flag: "gpt-5.5", type: "embedding", capability: "embedding" }),
    ).rejects.toThrow(/cannot embed text[\s\S]*curvet chat -m gpt-5\.5[\s\S]*--type embedding/);
  });

  // The hint used to come from a capability → command table, so every
  // generator was sent to `curvet audio` — a chat model included.
  it("points a chat model handed to stt at chat, not at audio", async () => {
    const err = await pickModel(catalogue, {
      flag: "gpt-5.5",
      type: "audio",
      capability: "transcription",
    }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/cannot transcribe[\s\S]*curvet chat -m gpt-5\.5/);
    expect((err as Error).message).not.toMatch(/curvet audio/);
  });

  // An OpenRouter-style id the server publishes as an alias is the same model,
  // and the Curvet id is the one sent — so the cost line and the server agree.
  it("resolves a published alias to the Curvet id", async () => {
    expect(
      await pickModel(catalogue, { flag: "meta-llama/llama-3.3-70b-instruct", type: "chat" }),
    ).toBe("llama-3.3-70b");
    // Hugging Face casing: the server lowercases before it looks an alias up.
    expect(
      await pickModel(catalogue, { flag: "Meta-Llama/Llama-3.3-70B-Instruct", type: "chat" }),
    ).toBe("llama-3.3-70b");
  });

  it("resolves an embedder's alias on embed", async () => {
    expect(
      await pickModel(catalogue, {
        flag: "sentence-transformers/all-MiniLM-L6-v2",
        type: "embedding",
        capability: "embedding",
      }),
    ).toBe("all-minilm-l6-v2");
  });

  it("suggests the bare id for the OpenRouter spelling of a model we serve", async () => {
    await expect(pickModel(catalogue, { flag: "openai/gpt-5.5", type: "chat" })).rejects.toThrow(
      /not in this app's model catalogue[\s\S]*Did you mean `gpt-5\.5`\?/,
    );
  });

  // gpt-5 is a prefix of gpt-5.5, not the same model: suggesting it would be a
  // guess dressed up as a correction.
  it("suggests nothing when the bare id only prefixes a model", async () => {
    const err = await pickModel(catalogue, { flag: "openai/gpt-5", type: "chat" }).catch(
      (e: Error) => e,
    );
    expect((err as Error).message).toMatch(/not in this app's model catalogue/);
    expect((err as Error).message).not.toMatch(/Did you mean/);
  });

  // The alias is what was typed; the Curvet id is what `curvet models` shows.
  it("names a model reached by alias by its Curvet id when it cannot run", async () => {
    const soon = model({
      id: "nemotron-3-ultra-550b",
      available: false,
      comingSoon: true,
      surface: null,
      aliases: ["nvidia/nemotron-3-ultra-550b-a55b"],
    });
    const nothingRuns: Catalogue = { runnable: async () => [], all: async () => [soon] };
    await expect(
      pickModel(nothingRuns, { flag: "nvidia/nemotron-3-ultra-550b-a55b", type: "chat" }),
    ).rejects.toThrow(/^nemotron-3-ultra-550b is announced but not callable yet/);
  });
});

describe("findModel", () => {
  // The server resolves an exact id before any alias, so the CLI must too, or
  // the two could name different models for the same input.
  it("prefers an id to another model's alias, in any case", () => {
    const gemma = model({ id: "gemma-4-31b" });
    const squatter = model({ id: "other-1", aliases: ["gemma-4-31b"] });
    expect(findModel([squatter, gemma], "gemma-4-31b")).toBe(gemma);
    expect(findModel([squatter, gemma], "GEMMA-4-31B")).toBe(gemma);
  });

  it("matches no prefix and nothing fuzzy", () => {
    expect(findModel(RUNNABLE, "gpt-5")).toBeUndefined();
    expect(findModel(RUNNABLE, "llama")).toBeUndefined();
    expect(findModel(RUNNABLE, "meta-llama/llama-3.3-70b")).toBeUndefined();
    expect(findModel(RUNNABLE, "  ")).toBeUndefined();
  });

  // aliases comes from the server; a malformed one must not take the CLI down.
  it("ignores an aliases field that is not a list", () => {
    const odd = model({ id: "odd-1", aliases: "odd/alias" as unknown as string[] });
    expect(findModel([odd], "odd/alias")).toBeUndefined();
    expect(findModel([odd], "odd-1")).toBe(odd);
  });
});

describe("bareId", () => {
  it("drops the vendor prefix and the variant suffix", () => {
    expect(bareId("google/gemma-4-31b-it:free")).toBe("gemma-4-31b-it");
    expect(bareId("openai/gpt-oss-120b")).toBe("gpt-oss-120b");
  });

  it("leaves a Curvet id alone", () => {
    expect(bareId("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(bareId("ali-qwen3.7-flash")).toBe("ali-qwen3.7-flash");
  });
});

describe("modelRows", () => {
  it("hides the capability column when every model does the same thing", () => {
    const { headers } = modelRows([CHAT], false);
    expect(headers).toEqual(["MODEL", "TYPE", "PROVIDER", "CREDITS", "VISION"]);
  });

  it("shows the capability column when the listing mixes them", () => {
    const { headers, rows } = modelRows([TTS, ASR], false);
    expect(headers).toContain("CAPABILITY");
    expect(rows[1]).toContain("transcription");
  });

  it("adds a status column under --include all", () => {
    const { headers, rows } = modelRows([CHAT, SOON, DASHBOARD], true);
    expect(headers.at(-1)).toBe("STATUS");
    expect(rows.map((r) => r.at(-1))).toEqual(["", "coming soon", "dashboard only"]);
  });
});

describe("statusOf", () => {
  it("says nothing about a model that simply works", () => {
    expect(statusOf(CHAT)).toBe("");
  });

  it("names why a model cannot be called", () => {
    expect(statusOf(SOON)).toBe("coming soon");
    expect(statusOf(DASHBOARD)).toBe("dashboard only");
    expect(statusOf(model({ id: "x", available: false }))).toBe("unavailable");
  });
});
