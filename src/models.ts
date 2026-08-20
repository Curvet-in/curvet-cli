import type { Curvet, ModelCapability, ModelInfo, ModelType } from "@curvet/sdk";
import type { ResolvedProfile } from "./config.js";
import { makeClient } from "./client.js";

/**
 * The two views of the catalogue a resolution may need: what this key can call
 * right now, and — only when a named model is missing from it — everything the
 * key can see, which is what lets us say *why* it is missing.
 */
export interface Catalogue {
  runnable(type?: ModelType): Promise<ModelInfo[]>;
  all(): Promise<ModelInfo[]>;
}

export function catalogueFor(profile: ResolvedProfile, client?: Curvet): Catalogue {
  const sdk = client ?? makeClient(profile);
  return {
    runnable: (type) => sdk.models.list({ type }),
    all: () => sdk.models.list({ include: "all" }),
  };
}

export interface PickModelOptions {
  /** The id given on the command line, if any. */
  flag?: string;
  /** The model type this command generates. */
  type: ModelType;
  /** What the command needs the model to *do* (default "generation"). */
  capability?: ModelCapability;
  /** The profile's stored default, honoured for chat only. */
  defaultModel?: string;
}

/** A model's capability, defaulting for deployments that don't send one. */
function capabilityOf(model: ModelInfo): ModelCapability {
  return model.capability ?? "generation";
}

const COMMAND_FOR: Record<string, string> = {
  transcription: "curvet stt <file>",
  generation: "curvet audio",
};

/**
 * Explain a model that exists but is the wrong tool for this command. The
 * expensive version of this mistake is `curvet audio -m whisper-large-v3`:
 * Whisper is `type: "audio"` like every TTS model, so nothing about the id says
 * it transcribes rather than speaks, and without this check the CLI submits the
 * job and only fails once the request has been made.
 */
function wrongCapability(model: ModelInfo, wanted: ModelCapability): string {
  const has = capabilityOf(model);
  const what =
    has === "transcription"
      ? `${model.id} is a speech-to-text model — it transcribes audio rather than generating it.`
      : `${model.id} generates ${model.type}; it cannot transcribe.`;
  const instead = COMMAND_FOR[has];
  return [
    what,
    instead ? `Use \`${instead} -m ${model.id}\` instead.` : "",
    `List the right ones with \`curvet models --capability ${wanted}\`.`,
  ]
    .filter(Boolean)
    .join("\n  ");
}

/** Explain a model the runnable catalogue does not contain. */
function unusable(id: string, type: ModelType, full: ModelInfo[]): string {
  const known = full.find((m) => m.id === id);
  if (!known) {
    return [
      `"${id}" is not in this app's model catalogue.`,
      `See everything the key can reach with \`curvet models --include all\`.`,
    ].join("\n  ");
  }
  if (known.comingSoon) {
    return `${id} is announced but not callable yet. \`curvet models --type ${type}\` lists what runs today.`;
  }
  if (known.surface && known.surface !== "api") {
    return `${id} only runs in the Curvet dashboard — there is no API route for it.`;
  }
  return `${id} is currently unavailable. \`curvet models --type ${type}\` lists what runs today.`;
}

/**
 * Pick a model: --model flag > profile default (chat only) > first model of the
 * right type and capability in the app's catalogue.
 *
 * An explicit `--model` is checked against the catalogue before the request is
 * made. The stored default is not — it costs a round trip on every chat call,
 * and a bad one fails loudly server-side rather than silently doing the wrong
 * thing, which is the case this check exists for.
 */
export async function pickModel(
  catalogue: Catalogue,
  options: PickModelOptions,
): Promise<string> {
  // The stored chat default is honoured without a catalogue lookup — see
  // pickModelInfo, which returns undefined for exactly that case.
  if (!options.flag && options.type === "chat" && options.defaultModel) {
    return options.defaultModel;
  }
  const chosen = await pickModelInfo(catalogue, options);
  if (!chosen) throw new Error(`Could not resolve a ${options.type} model.`);
  return chosen.id;
}

/**
 * As {@link pickModel}, but returns the catalogue entry — the provider on it is
 * what lets a caller notice the gateway ran something else. Undefined only when
 * the profile's stored default was used, which is deliberately not looked up.
 */
export async function pickModelInfo(
  catalogue: Catalogue,
  options: PickModelOptions,
): Promise<ModelInfo | undefined> {
  const { flag, type, defaultModel } = options;
  const capability = options.capability ?? "generation";

  if (!flag) {
    if (type === "chat" && defaultModel) return undefined;
    const models = (await catalogue.runnable(type)).filter(
      (m) => capabilityOf(m) === capability,
    );
    if (models.length === 0) {
      throw new Error(
        `No ${type} models with ${capability} support are available to this app — ` +
          "pass --model explicitly, or check `curvet models`.",
      );
    }
    return models[0];
  }

  const runnable = await catalogue.runnable();
  const model = runnable.find((m) => m.id === flag);
  if (!model) throw new Error(unusable(flag, type, await catalogue.all()));
  if (capabilityOf(model) !== capability) throw new Error(wrongCapability(model, capability));
  if (model.type !== type) {
    throw new Error(
      `${flag} is a ${model.type} model, so it cannot be used here. ` +
        `\`curvet models --type ${type}\` lists the ones that can.`,
    );
  }
  return model;
}
