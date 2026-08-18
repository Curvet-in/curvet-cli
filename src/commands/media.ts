import { Command } from "commander";
import pc from "picocolors";
import type { Curvet, MediaParamsBase, MediaResource, ModelType } from "@curvet/sdk";
import { resolveProfile } from "../config.js";
import { makeClient, requireAppKey } from "../client.js";
import { pickModel } from "../models.js";
import { Progress } from "../progress.js";
import { downloadTo, extensionFor, formatBytes } from "../download.js";
import { formatEta, readPrompt, writeMediaCost } from "./shared.js";
import { printJson, ok, warn } from "../output.js";

interface MediaSpec {
  /** Command name, also the model type used to pick a default model. */
  name: "video" | "audio" | "3d";
  describe: string;
  /** Extension used when the URL carries none. */
  fallbackExt: string;
  resource: (client: Curvet) => MediaResource<MediaParamsBase>;
  /** Extra flags this modality accepts. */
  flags?: (cmd: Command) => void;
  /** Map parsed flags onto request params. */
  params?: (opts: Record<string, any>) => Record<string, unknown>;
}

const SPECS: MediaSpec[] = [
  {
    name: "video",
    describe: "Generate a video (async; polls to completion)",
    fallbackExt: ".mp4",
    resource: (c) => c.video as unknown as MediaResource<MediaParamsBase>,
    flags: (cmd) => {
      cmd
        .option("--mode <mode>", "text_to_video or image_to_video")
        .option("--duration <seconds>", "clip length in seconds", (v) => parseInt(v, 10))
        .option("--resolution <res>", "output resolution, e.g. 720p");
    },
    params: (o) => ({ mode: o.mode, duration: o.duration, resolution: o.resolution }),
  },
  {
    name: "audio",
    describe: "Generate audio (async; polls to completion)",
    fallbackExt: ".mp3",
    resource: (c) => c.audio as unknown as MediaResource<MediaParamsBase>,
    flags: (cmd) => {
      cmd.option("--voice <voice>", "voice id");
    },
    params: (o) => ({ voice: o.voice }),
  },
  {
    name: "3d",
    describe: "Generate a 3D model (async; polls to completion)",
    fallbackExt: ".glb",
    resource: (c) => c.threeD as unknown as MediaResource<MediaParamsBase>,
  },
];

/** Drop undefined entries so we never send explicit nulls the API must interpret. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function buildCommand(spec: MediaSpec): Command {
  const cmd = new Command(spec.name)
    .description(spec.describe)
    .argument("[prompt...]", "the prompt; combined with piped stdin if both are given")
    .option("-m, --model <id>", `model id (default: first ${spec.name} model)`)
    .option("-o, --output <file>", "download the result here when it finishes")
    .option("--no-wait", "submit and print the job id instead of polling")
    .option("--poll-interval <ms>", "poll interval in ms", (v) => parseInt(v, 10))
    .option("--timeout <ms>", "give up polling after this long", (v) => parseInt(v, 10))
    .option("--quiet", "suppress the progress bar")
    .option("--json", "machine-readable output");

  spec.flags?.(cmd);

  cmd.action(async (promptWords: string[], opts, self) => {
    const profile = await resolveProfile(self.optsWithGlobals().profile);
    requireAppKey(profile);

    const prompt = await readPrompt(promptWords);
    const model = await pickModel(profile, opts.model, spec.name as ModelType);
    const client = makeClient(profile);
    const resource = spec.resource(client);
    const params = compact({ model, prompt, ...(spec.params?.(opts) ?? {}) }) as MediaParamsBase;

    if (opts.wait === false) {
      const submitted = await resource.submit(params);
      if (opts.json) {
        printJson(submitted);
        return;
      }
      if (!submitted.jobId) {
        console.log(warn("The server did not return a job id."));
        if (submitted.mediaUrl) console.log(submitted.mediaUrl);
        return;
      }
      console.log(submitted.jobId);
      process.stderr.write(
        pc.dim(`follow it with: curvet jobs wait ${submitted.jobId}\n`),
      );
      return;
    }

    const progress = new Progress({
      label: spec.name,
      enabled: !opts.quiet && !opts.json,
    });

    let job;
    try {
      job = await resource.generate(params, {
        pollIntervalMs: opts.pollInterval,
        pollTimeoutMs: opts.timeout,
        onProgress: (percent, eta) => progress.update(percent, formatEta(eta)),
      });
    } catch (err) {
      progress.abort();
      throw err;
    }

    if (opts.json) {
      printJson(job);
      return;
    }
    progress.done(`${spec.name} ready`);

    if (opts.output && job.mediaUrl) {
      const bytes = await downloadTo(job.mediaUrl, opts.output);
      console.log(ok(`saved ${opts.output} (${formatBytes(bytes)})`));
    } else if (job.mediaUrl) {
      console.log(job.mediaUrl);
      if (opts.output === undefined) {
        process.stderr.write(
          pc.dim(`save it next time with -o out${extensionFor(job.mediaUrl, spec.fallbackExt)}\n`),
        );
      }
    } else {
      console.log(warn("Job completed without a media URL."));
    }

    writeMediaCost(job, model);
  });

  return cmd;
}

export function mediaCommands(): Command[] {
  return SPECS.map(buildCommand);
}
