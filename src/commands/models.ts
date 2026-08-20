import { Command } from "commander";
import pc from "picocolors";
import type { ModelInfo } from "@curvet/sdk";
import { resolveProfile } from "../config.js";
import { makeClient, v1Root } from "../client.js";
import { printJson, table, warn } from "../output.js";

interface PublicModel {
  id: string;
  provider: string;
  inputCredits?: number;
  outputCredits?: number;
  contextLength?: number;
  vision: boolean;
}

/**
 * Keyless catalogue from GET /api/v1/public/models — an OpenAI-style list with
 * an `x_curvet_pricing` block (credits per million tokens). Lets `curvet models`
 * work before the user has any account at all.
 */
async function fetchPublicModels(baseURL?: string): Promise<PublicModel[]> {
  const res = await fetch(`${v1Root(baseURL)}/public/models`);
  if (!res.ok) {
    throw new Error(`Could not fetch the public model catalogue (HTTP ${res.status}).`);
  }
  const body = (await res.json()) as { data?: Record<string, any>[] };
  return (body.data ?? []).map((m) => ({
    id: String(m.id ?? ""),
    provider: String(m.owned_by ?? ""),
    inputCredits: m.x_curvet_pricing?.input,
    outputCredits: m.x_curvet_pricing?.output,
    contextLength: m.context_length,
    vision: Array.isArray(m.architecture?.input_modalities)
      ? m.architecture.input_modalities.includes("image")
      : false,
  }));
}

function formatContext(tokens?: number): string {
  if (tokens == null) return "";
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/** Why a model in the `--include all` listing cannot be called from here. */
export function statusOf(model: ModelInfo): string {
  if (model.comingSoon) return "coming soon";
  if (model.surface && model.surface !== "api") return `${model.surface} only`;
  return model.available === false ? "unavailable" : "";
}

/**
 * Build the app-key table. The CAPABILITY column appears only when the listing
 * actually mixes capabilities — it is pure noise on `--type chat`, and the one
 * thing you must see on an unfiltered list or `--type audio`, where a
 * speech-to-text model sits next to a text-to-speech one under the same type.
 */
export function modelRows(models: ModelInfo[], includeAll: boolean): {
  headers: string[];
  rows: string[][];
} {
  const capabilities = new Set(models.map((m) => m.capability ?? "generation"));
  const showCapability = capabilities.size > 1;

  const headers = ["MODEL", "TYPE"];
  if (showCapability) headers.push("CAPABILITY");
  headers.push("PROVIDER", "CREDITS", "VISION");
  if (includeAll) headers.push("STATUS");

  const rows = models.map((m) => {
    const row = [m.id, String(m.type)];
    if (showCapability) row.push(m.capability ?? "generation");
    row.push(m.provider, String(m.credits), m.supportsVision ? "yes" : "");
    if (includeAll) row.push(statusOf(m));
    return row;
  });

  return { headers, rows };
}

export function modelsCommand(): Command {
  return new Command("models")
    .description("List available models (works without a key via the public catalogue)")
    .option("--type <type>", "filter by type: chat, image, video, audio, 3d, … (app-key mode)")
    .option(
      "--capability <cap>",
      "filter by what the model does: generation or transcription (app-key mode)",
    )
    .option("--include <what>", "runnable (default) or all — all adds coming-soon models")
    .option("--cheapest", "sort by credit cost, cheapest first")
    .option("--refresh", "bypass the SDK's 60s model cache")
    .option("--json", "machine-readable output")
    .action(async (opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);

      const include = String(opts.include ?? "runnable").toLowerCase();
      if (include !== "runnable" && include !== "all") {
        throw new Error(`--include takes "runnable" or "all", not "${opts.include}".`);
      }
      const includeAll = include === "all";

      if (profile.appKey) {
        const client = makeClient(profile);
        let models = await client.models.list({
          type: opts.type,
          capability: opts.capability,
          include,
          refresh: opts.refresh,
        });
        if (opts.cheapest) models = [...models].sort((a, b) => a.credits - b.credits);
        if (opts.json) {
          printJson({ source: "app", include, models });
          return;
        }
        if (models.length === 0) {
          const filters = [
            opts.type ? `type "${opts.type}"` : "",
            opts.capability ? `capability "${opts.capability}"` : "",
          ].filter(Boolean);
          console.log(
            warn(filters.length > 0 ? `No models with ${filters.join(" and ")}.` : "No models returned."),
          );
          return;
        }
        const { headers, rows } = modelRows(models, includeAll);
        console.log(table(headers, rows));
        if (!includeAll) {
          console.log(
            pc.dim("\nOnly models this key can call right now. Add --include all to see what's coming."),
          );
        }
        const limits = await client.models.rateLimits();
        if (limits) {
          console.log(
            pc.dim(
              `\nApp limits: ${limits.requestsPerHour} requests/hour, $${limits.costCapPerDay}/day cost cap`,
            ),
          );
        }
        return;
      }

      // Keyless: public catalogue (chat models only, priced per million tokens).
      if (opts.type || opts.capability || includeAll) {
        process.stderr.write(
          pc.dim("--type/--capability/--include need an app key; showing the public catalogue.\n"),
        );
      }
      let models = await fetchPublicModels(profile.baseURL);
      if (opts.cheapest) {
        models = [...models].sort(
          (a, b) => (a.outputCredits ?? Infinity) - (b.outputCredits ?? Infinity),
        );
      }
      if (opts.json) {
        printJson({ source: "public", models });
        return;
      }
      if (models.length === 0) {
        console.log(warn("No models returned."));
        return;
      }
      console.log(
        table(
          ["MODEL", "PROVIDER", "IN cr/M", "OUT cr/M", "CONTEXT", "VISION"],
          models.map((m) => [
            m.id,
            m.provider,
            m.inputCredits != null ? String(m.inputCredits) : "",
            m.outputCredits != null ? String(m.outputCredits) : "",
            formatContext(m.contextLength),
            m.vision ? "yes" : "",
          ]),
        ),
      );
      console.log(
        pc.dim(
          "\nPublic chat catalogue, priced in credits per million tokens (100 credits = $1)." +
            "\nRun `curvet auth login` to see your app's own model list, media models, and rate limits.",
        ),
      );
    });
}
