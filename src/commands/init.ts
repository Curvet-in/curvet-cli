import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { resolveProfile } from "../config.js";
import { v1Root } from "../client.js";
import { ok, printJson, table, warn } from "../output.js";
import {
  toAssistantPrompt,
  toClineFields,
  toCurlExample,
  toOpenCodeConfig,
  toVsCodeCopilotConfig,
  toZedConfig,
  type CliModel,
} from "../cliConfig.js";

type ToolId = "opencode" | "zed" | "vscode" | "cline" | "cursor" | "continue";

interface Tool {
  id: ToolId;
  label: string;
  /** Where the tool keeps its config, when it has a file at all. */
  file?: () => string;
  /** Build the config object for this tool. */
  build?: (models: CliModel[], o: BuildOptions) => unknown;
  /** Fold the generated config into whatever is already in the file. */
  merge?: (existing: unknown, generated: unknown) => unknown;
  /** Shown after a successful write. */
  next: string;
}

interface BuildOptions {
  baseUrl: string;
  apiKey?: string;
  inlineKey?: boolean;
}

function xdgConfig(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".config");
}

/**
 * VS Code stores per-user config in a different place on every platform, and
 * writing to the wrong one silently does nothing.
 */
function vsCodeUserDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Code", "User");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Code", "User");
  }
  return path.join(xdgConfig(), "Code", "User");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge only our own subtree. Everything else in the user's file is passed
 * through untouched — this runs against a settings file people have curated,
 * so replacing a parent object to write a child would be a data loss bug.
 */
function setIn(root: unknown, keys: string[], value: unknown): unknown {
  const out = isRecord(root) ? { ...root } : {};
  let cursor: Record<string, unknown> = out;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    cursor[key] = isRecord(next) ? { ...next } : {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]] = value;
  return out;
}

export function mergeOpenCode(existing: unknown, generated: unknown): unknown {
  const gen = generated as { $schema: string; provider: Record<string, unknown> };
  const withSchema = isRecord(existing) && existing.$schema ? existing : setIn(existing, ["$schema"], gen.$schema);
  return setIn(withSchema, ["provider", "curvet"], gen.provider.curvet);
}

export function mergeZed(existing: unknown, generated: unknown): unknown {
  const gen = generated as {
    language_models: { openai_compatible: Record<string, unknown> };
  };
  return setIn(
    existing,
    ["language_models", "openai_compatible", "curvet"],
    gen.language_models.openai_compatible.curvet,
  );
}

/**
 * chatLanguageModels.json is a top-level array of providers, so merging means
 * replacing our entry by name rather than by key — appending a second "Curvet"
 * would leave the editor showing every model twice.
 */
export function mergeVsCode(existing: unknown, generated: unknown): unknown {
  const gen = (generated as unknown[])[0] as { name: string };
  if (!Array.isArray(existing)) return generated;
  const idx = existing.findIndex((e) => isRecord(e) && e.name === gen.name);
  if (idx === -1) return [...existing, gen];
  const out = [...existing];
  out[idx] = gen;
  return out;
}

const TOOLS: Record<ToolId, Tool> = {
  opencode: {
    id: "opencode",
    label: "OpenCode",
    file: () => path.join(xdgConfig(), "opencode", "opencode.json"),
    build: (models, o) => toOpenCodeConfig(models, o),
    merge: mergeOpenCode,
    next: "Restart OpenCode and pick a curvet/… model. The key is read from CURVET_APP_KEY.",
  },
  zed: {
    id: "zed",
    label: "Zed",
    file: () => path.join(xdgConfig(), "zed", "settings.json"),
    build: (models, o) => toZedConfig(models, { baseUrl: o.baseUrl }),
    merge: mergeZed,
    next:
      "Restart Zed, then set the key in the Agent Panel (or export CURVET_API_KEY) — " +
      "Zed keys the credential off the provider id, so it never goes in this file.",
  },
  vscode: {
    id: "vscode",
    label: "VS Code Copilot Chat",
    file: () => path.join(vsCodeUserDir(), "chatLanguageModels.json"),
    build: (models, o) => toVsCodeCopilotConfig(models, o),
    merge: mergeVsCode,
    next: 'Reload VS Code, then run "Chat: Manage Language Models" and pick Curvet.',
  },
  cline: {
    id: "cline",
    label: "Cline",
    next: "Cline has no config file — enter the values above in its settings UI.",
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    next: "Cursor has no config file for this — Settings → Models → custom OpenAI base URL.",
  },
  continue: {
    id: "continue",
    label: "Continue",
    next: 'Add a provider of type "openai" with apiBase set to the base URL above.',
  },
};

/**
 * The catalogue, in the OpenAI-compatible shape the emitters expect. With a key
 * it returns that app's allowed subset; without one the public route serves the
 * curated set, so `curvet init` works before anyone has logged in.
 */
async function fetchCliModels(baseURL: string | undefined, appKey?: string): Promise<CliModel[]> {
  const root = v1Root(baseURL);
  const url = appKey ? `${root}/models` : `${root}/public/models`;
  const res = await fetch(url, {
    headers: appKey ? { authorization: `Bearer ${appKey}` } : {},
  });
  if (!res.ok) throw new Error(`Could not load the model catalogue (HTTP ${res.status}).`);
  const body = (await res.json()) as { data?: CliModel[] };
  const models = Array.isArray(body.data) ? body.data : [];
  if (models.length === 0) throw new Error("The model catalogue came back empty.");
  return models;
}

/** Read a config file for merging. Returns undefined when there is nothing there. */
async function readExisting(file: string): Promise<{ raw: string; parsed: unknown } | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  if (raw.trim() === "") return { raw, parsed: undefined };
  return { raw, parsed: JSON.parse(raw) };
}

export function initCommand(): Command {
  return new Command("init")
    .description("Point a coding tool at Curvet, using the live model catalogue")
    .argument("[tool]", `one of: ${Object.keys(TOOLS).join(", ")}`)
    .option("--print", "print the config instead of writing it")
    .option("-o, --output <file>", "write to this path instead of the tool's default")
    .option("--inline-key", "embed the app key in the config instead of referencing an env var")
    .option("--prompt", "print a prompt to hand to an AI assistant instead of a config")
    .option("-m, --model <id>", "which model's settings to print (cline)")
    .option("--json", "machine-readable output")
    .action(async (toolArg: string | undefined, opts, cmd) => {
      if (!toolArg) {
        console.log("Usage: curvet init <tool>\n");
        console.log(
          table(
            ["TOOL", "WHAT IT WRITES"],
            Object.values(TOOLS).map((t) => [t.id, t.file ? t.file() : "settings UI — printed, not written"]),
          ),
        );
        return;
      }
      const tool = TOOLS[toolArg.toLowerCase() as ToolId];
      if (!tool) {
        throw new Error(
          `Unknown tool "${toolArg}". Try one of: ${Object.keys(TOOLS).join(", ")}.`,
        );
      }

      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      const baseUrl = v1Root(profile.baseURL);
      const models = await fetchCliModels(profile.baseURL, profile.appKey);

      // A live key in a shared config file is the user's call, never a default.
      if (opts.inlineKey && !profile.appKey) {
        throw new Error("--inline-key needs an app key. Run `curvet auth login` first.");
      }
      const buildOptions: BuildOptions = {
        baseUrl,
        apiKey: profile.appKey,
        inlineKey: !!opts.inlineKey,
      };
      // --inline-key is the single opt-in for "put my real credential in this
      // output". Without it the key never reaches stdout — not in the config,
      // not in the printed fields, and not in the verification command, which
      // uses a shell reference so it still runs.
      const shownKey = opts.inlineKey ? profile.appKey : undefined;

      const config = tool.build?.(models, buildOptions);
      const rendered = config === undefined ? undefined : JSON.stringify(config, null, 2);

      if (opts.prompt) {
        console.log(
          toAssistantPrompt(models, {
            tool: tool.id,
            ...buildOptions,
            generatedConfig: rendered,
          }),
        );
        return;
      }

      // Tools without a config file: print what to type, and stop.
      if (!tool.build || !tool.file) {
        const model = opts.model
          ? models.find((m) => m.id === opts.model)
          : models[0];
        if (!model) {
          throw new Error(`"${opts.model}" is not in the catalogue — see \`curvet models\`.`);
        }
        const fields = toClineFields(model, { baseUrl, apiKey: shownKey });
        if (opts.json) {
          printJson({ tool: tool.id, baseUrl, model: model.id, fields });
          return;
        }
        console.log(pc.bold(`${tool.label} — enter these in its settings:`));
        console.log(table(["FIELD", "VALUE"], fields.map((f) => [f.field, f.value])));
        console.log(pc.dim(`\n${tool.next}`));
        if (!opts.inlineKey && profile.appKey) {
          console.log(pc.dim("Add --inline-key to print your real key instead of the placeholder."));
        }
        console.log(pc.dim(`Other models: curvet init ${tool.id} -m <model-id>  ·  curvet models`));
        return;
      }

      if (opts.json) {
        printJson({ tool: tool.id, file: opts.output ?? tool.file(), config });
        return;
      }
      if (opts.print) {
        console.log(rendered);
        return;
      }

      const file = opts.output ?? tool.file();
      const existing = await readExisting(file).catch((err) => {
        // A settings file with comments or trailing commas is valid for the
        // tool and unparseable for us. Rewriting it would silently strip the
        // comments, so refuse and let the user paste instead.
        if (err instanceof SyntaxError) return "unparseable" as const;
        throw err;
      });

      if (existing === "unparseable") {
        console.log(
          warn(`${file} is not plain JSON (comments or trailing commas), so it was left alone.`),
        );
        console.log(pc.dim("Merge this in by hand:\n"));
        console.log(rendered);
        process.exitCode = 1;
        return;
      }

      const merged = existing?.parsed !== undefined ? tool.merge!(existing.parsed, config) : config;

      if (existing?.raw) {
        // The file already had content we are about to replace on disk.
        await fs.writeFile(`${file}.bak`, existing.raw);
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(merged, null, 2) + "\n");

      const count = models.length;
      console.log(ok(`${tool.label}: wrote ${count} model${count === 1 ? "" : "s"} to ${file}`));
      if (existing?.raw) console.log(pc.dim(`  previous file saved as ${file}.bak`));
      console.log(pc.dim(`  ${tool.next}`));
      if (profile.appKey) {
        console.log(
          pc.dim(
            `\nVerify it:\n${toCurlExample(models[0].id, {
              baseUrl,
              apiKey: shownKey ?? "$CURVET_APP_KEY",
            })}`,
          ),
        );
      }
    });
}
