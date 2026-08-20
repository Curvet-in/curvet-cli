import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { resolveProfile, loadConfig, resolveShowCost } from "../config.js";
import { makeClient, requireAppKey } from "../client.js";
import { catalogueFor, pickModelInfo } from "../models.js";
import { costFlagFrom } from "./shared.js";
import { formatCost, printJson, warn } from "../output.js";

/** The gateway caps uploads at 10 MB; fail here rather than on a 413. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * multer reads the part's content type, and the ASR providers branch on it, so
 * an `application/octet-stream` upload can be rejected by a provider that would
 * have accepted the same bytes labelled correctly.
 */
const MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".mpga": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".amr": "audio/amr",
};

export function mimeFor(file: string): string {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function sttCommand(): Command {
  return new Command("stt")
    .description("Transcribe an audio file (speech-to-text)")
    .argument("<file>", "audio file to transcribe (mp3, wav, m4a, ogg, flac, webm…)")
    .option("-m, --model <id>", "transcription model (default: the gateway's own)")
    .option("--provider <name>", "force a provider: elevenlabs, deepinfra, dashscope, gnani")
    .option("--language <code>", "ISO 639-1 language hint, e.g. en")
    .option("--prompt <text>", "biasing prompt — names, jargon, spellings to expect")
    .option("--allow-fallback", "let the gateway retry on another provider if the first fails")
    .option("-o, --output <file>", "write the transcript here instead of stdout")
    .option("--cost", "show the cost line even when disabled in config")
    .option("--no-cost", "hide the cost line")
    .option("--json", "machine-readable output")
    .action(async (file: string, opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      requireAppKey(profile);
      const config = await loadConfig();
      const showCost = resolveShowCost(config, costFlagFrom(cmd)) && !opts.json;

      let bytes: Buffer;
      try {
        bytes = await fs.readFile(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`No such file: ${file}`);
        }
        throw err;
      }
      if (bytes.length === 0) throw new Error(`${file} is empty.`);
      if (bytes.length > MAX_BYTES) {
        throw new Error(
          `${file} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the upload limit is 10 MB. ` +
            "Split or re-encode it first.",
        );
      }

      const client = makeClient(profile);
      // Only resolved when named: without --model the gateway picks its own
      // default engine, and the result reports which one ran.
      const chosen = opts.model
        ? await pickModelInfo(catalogueFor(profile, client), {
            flag: opts.model,
            type: "audio",
            capability: "transcription",
          })
        : undefined;

      const result = await client.voice.stt({
        audio: new Blob([bytes], { type: mimeFor(file) }),
        filename: path.basename(file),
        model: chosen?.id,
        provider: opts.provider,
        languageCode: opts.language,
        prompt: opts.prompt,
        allowFallback: opts.allowFallback,
      });

      if (opts.json) {
        printJson(result);
        return;
      }

      // --allow-fallback lets the gateway transcribe on a different engine than
      // the one asked for. It bills the same either way, so say so rather than
      // reporting the requested model as though it had run.
      if (chosen && result.provider && result.provider !== chosen.provider) {
        process.stderr.write(
          warn(`${chosen.provider} was unavailable — transcribed with ${result.provider}.`) + "\n",
        );
      }

      const text = result.text ?? "";
      if (opts.output) {
        await fs.writeFile(opts.output, text.endsWith("\n") ? text : text + "\n");
        process.stderr.write(pc.dim(`saved ${opts.output}\n`));
      } else {
        console.log(text);
      }

      if (showCost) {
        process.stderr.write(
          pc.dim(
            formatCost({
              model: chosen?.id ?? result.provider,
              credits: result.creditsCharged,
              remainingBalance: result.creditsRemaining,
            }),
          ) + "\n",
        );
      }
    });
}
