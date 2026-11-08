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

/**
 * A model's capability, defaulting for deployments that don't send one.
 *
 * An embedder is keyed on its type rather than trusted to carry the label: the
 * server fills a missing capability in as "generation", so an embedder labelled
 * that way would read as a generator and be offered to `curvet chat`.
 */
function capabilityOf(model: ModelInfo): ModelCapability {
  if (model.type === "embedding") return "embedding";
  return model.capability ?? "generation";
}

/**
 * The catalogue entry a typed id names — its Curvet id, or one of the aliases
 * the server publishes for it (`meta-llama/llama-3.3-70b-instruct` is
 * `llama-3.3-70b`). Exact first, then trimmed and case-insensitive, the order
 * the server resolves them in: an id before any alias. Never a prefix or fuzzy
 * match, which would hand back a model nobody named.
 */
export function findModel(models: ModelInfo[], typed: string): ModelInfo | undefined {
  const exact = models.find((m) => m.id === typed);
  if (exact) return exact;
  const key = typed.trim().toLowerCase();
  if (!key) return undefined;
  const aliasesOf = (m: ModelInfo): string[] =>
    Array.isArray(m.aliases) ? m.aliases.filter((a): a is string => typeof a === "string") : [];
  return (
    models.find((m) => m.id.toLowerCase() === key) ??
    models.find((m) => aliasesOf(m).some((a) => a.toLowerCase() === key))
  );
}

/**
 * An OpenRouter-style id without its vendor prefix and variant suffix:
 * `openai/gpt-oss-120b` → `gpt-oss-120b`, `google/gemma-4-31b-it:free` →
 * `gemma-4-31b-it`. Used to suggest an id only — never sent anywhere, because
 * the same name does not always mean the same weights.
 */
export function bareId(typed: string): string {
  return (typed.split("/").pop() ?? typed).replace(/:[\w-]+$/, "");
}

/** What a generator of each type produces, for reading in a sentence. */
const OUTPUT_OF: Record<string, string> = { chat: "text", image: "images", "3d": "3D models" };

/** The command that runs a model, for pointing at it from the wrong one. */
function commandFor(model: ModelInfo): string | undefined {
  const cap = capabilityOf(model);
  if (cap === "transcription") return `curvet stt <file> -m ${model.id}`;
  if (cap === "embedding") return `curvet embed -m ${model.id} "text"`;
  return ["chat", "image", "video", "audio", "3d"].includes(model.type)
    ? `curvet ${model.type} -m ${model.id}`
    : undefined;
}

/** The listing that shows the models a command wants. */
function listHint(wanted: ModelCapability, type: ModelType): string {
  if (wanted === "embedding") return "curvet models --type embedding";
  return type === "audio" ? `curvet models --capability ${wanted}` : `curvet models --type ${type}`;
}

/**
 * Explain a model that exists but is the wrong tool for this command. The
 * expensive version of this mistake is `curvet audio -m whisper-large-v3`:
 * Whisper is `type: "audio"` like every TTS model, so nothing about the id says
 * it transcribes rather than speaks, and without this check the CLI submits the
 * job and only fails once the request has been made. An embedder handed to
 * `curvet chat`, or a chat model handed to `curvet embed`, is the same mistake.
 */
function wrongCapability(model: ModelInfo, wanted: ModelCapability, type: ModelType): string {
  const has = capabilityOf(model);
  const what =
    has === "transcription"
      ? `${model.id} is a speech-to-text model — it transcribes audio rather than generating it.`
      : has === "embedding"
        ? `${model.id} is an embedding model — it turns text into vectors rather than generating anything.`
        : `${model.id} generates ${OUTPUT_OF[model.type] ?? model.type}; it cannot ${
            wanted === "embedding" ? "embed text" : "transcribe"
          }.`;
  const instead = commandFor(model);
  return [
    what,
    instead ? `Use \`${instead}\` instead.` : "",
    `List the right ones with \`${listHint(wanted, type)}\`.`,
  ]
    .filter(Boolean)
    .join("\n  ");
}

/** Explain a model the runnable catalogue does not contain. */
function unusable(id: string, type: ModelType, full: ModelInfo[]): string {
  const known = findModel(full, id);
  if (!known) {
    // `openai/gpt-5.5` is the OpenRouter spelling of an id we do serve. Only an
    // exact match on the bare id is offered: a prefix match would suggest
    // gemini-2.5-flash for google/gemini-2.5-flash-lite.
    const bare = bareId(id).trim().toLowerCase();
    const near = bare ? full.find((m) => m.id.toLowerCase() === bare) : undefined;
    return [
      `"${id}" is not in this app's model catalogue.`,
      near ? `Did you mean \`${near.id}\`? Curvet ids carry no vendor prefix or :variant suffix.` : "",
      `See everything the key can reach with \`curvet models --include all\`.`,
    ]
      .filter(Boolean)
      .join("\n  ");
  }
  // Named by its Curvet id: when an alias was typed, that is the one to look up.
  if (known.comingSoon) {
    return `${known.id} is announced but not callable yet. \`curvet models --type ${type}\` lists what runs today.`;
  }
  if (known.surface && known.surface !== "api") {
    return `${known.id} only runs in the Curvet dashboard — there is no API route for it.`;
  }
  return `${known.id} is currently unavailable. \`curvet models --type ${type}\` lists what runs today.`;
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
      // "No embedding models with embedding support" says the same thing twice.
      const which = capability === type ? `${type} models` : `${type} models with ${capability} support`;
      throw new Error(
        `No ${which} are available to this app — ` +
          "pass --model explicitly, or check `curvet models`.",
      );
    }
    return models[0];
  }

  // An alias resolves to its catalogue entry, so the canonical id is what gets
  // sent and what the cost line names.
  const runnable = await catalogue.runnable();
  const model = findModel(runnable, flag);
  if (!model) throw new Error(unusable(flag, type, await catalogue.all()));
  if (capabilityOf(model) !== capability) {
    throw new Error(wrongCapability(model, capability, type));
  }
  if (model.type !== type) {
    throw new Error(
      `${flag} is a ${model.type} model, so it cannot be used here. ` +
        `\`curvet models --type ${type}\` lists the ones that can.`,
    );
  }
  return model;
}
