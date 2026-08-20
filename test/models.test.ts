import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@curvet/sdk";
import { pickModel, type Catalogue } from "../src/models.js";
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

const RUNNABLE = [CHAT, TTS, ASR];

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
