import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Curvet, MediaJob } from "@curvet/sdk";
// `pickModel` is model-resolution logic, not CLI logic — it moves into the
// extracted package with these tools. It is the one import here that is not the
// SDK, and it must stay that way; see documentation/MCP_REVAMP_PLAN.md §0.8.
import { pickModel, type Catalogue } from "../../models.js";
import { json, failure, jobSummary } from "../shared.js";
import type { TranscribeResolver } from "../types.js";

/** The shape every generate_* tool shares; `spec.extra` adds the rest. */
interface MediaArgs {
  prompt: string;
  model?: string;
  wait?: boolean;
  [key: string]: unknown;
}

const MEDIA = {
  video: {
    describe: "Generate a video from a text prompt. Costs credits — a single clip can be 300+.",
    extra: {
      duration: z.number().int().positive().optional().describe("clip length in seconds"),
      resolution: z.string().optional().describe("e.g. 720p"),
    },
  },
  audio: {
    describe: "Generate speech or audio from a text prompt. Costs credits.",
    extra: { voice: z.string().optional().describe("provider voice id") },
  },
  "3d": {
    describe: "Generate a 3D model (.glb) from a text prompt. Costs credits.",
    extra: {},
  },
} as const;

export function registerPlaygroundTools(
  server: McpServer,
  client: Curvet,
  catalogue: Catalogue,
  opts: { defaultModel?: string; transcribe: TranscribeResolver | null },
): void {
  server.registerTool(
    "list_models",
    {
      title: "List Curvet models",
      description:
        "The models this key can call right now, with credit cost and capability. " +
        "Call this before generating: model ids are not guessable and a wrong one fails. Free.",
      inputSchema: {
        type: z.string().optional().describe("chat, image, video, audio, 3d"),
        capability: z
          .enum(["generation", "transcription"])
          .optional()
          .describe("audio covers both text-to-speech and speech-to-text"),
      },
    },
    async ({ type, capability }) => {
      try {
        const models = await client.models.list({ type, capability });
        return json(
          models.map((m) => ({
            id: m.id,
            type: m.type,
            capability: m.capability,
            provider: m.provider,
            credits: m.credits,
            supportsVision: m.supportsVision,
            pricing: m.pricing,
          })),
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "chat",
    {
      title: "Chat completion",
      description:
        "Send a prompt to one of Curvet's models and get the reply — a second opinion from a " +
        "different model, or a cheap model for bulk work. Metered per token.",
      inputSchema: {
        prompt: z.string().describe("the user message"),
        model: z.string().optional().describe("model id; defaults to the first chat model"),
        system: z.string().optional(),
        temperature: z.number().optional(),
        maxTokens: z.number().int().positive().optional(),
      },
    },
    async ({ prompt, model, system, temperature, maxTokens }) => {
      try {
        const id = await pickModel(catalogue, {
          flag: model,
          type: "chat",
          defaultModel: opts.defaultModel,
        });
        const res = await client.chat.create({
          model: id,
          messages: [
            ...(system ? [{ role: "system" as const, content: system }] : []),
            { role: "user" as const, content: prompt },
          ],
          temperature,
          maxTokens,
        });
        return json({ model: id, response: res.response, usage: res.usage });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "generate_image",
    {
      title: "Generate an image",
      description: "Generate an image from a text prompt. Costs credits. Returns a URL.",
      inputSchema: {
        prompt: z.string(),
        model: z.string().optional(),
        size: z.string().optional().describe("e.g. 1024x1024"),
      },
    },
    async ({ prompt, model, size }) => {
      try {
        const id = await pickModel(catalogue, { flag: model, type: "image" });
        const res = await client.image.generate({ model: id, prompt, size });
        return json({ model: id, imageUrl: res.imageUrl, usage: res.usage });
      } catch (err) {
        return failure(err);
      }
    },
  );

  for (const [kind, spec] of Object.entries(MEDIA)) {
    server.registerTool(
      `generate_${kind}`,
      {
        title: `Generate ${kind}`,
        description:
          `${spec.describe} Runs asynchronously: by default this returns a jobId immediately — ` +
          "poll it with get_job. Pass wait:true to block until it finishes, which can take minutes.",
        inputSchema: {
          prompt: z.string(),
          model: z.string().optional(),
          wait: z.boolean().optional().describe("block until the job completes"),
          ...spec.extra,
        },
      },
      async (args: MediaArgs) => {
        const { prompt, model, wait, ...rest } = args;
        try {
          const id = await pickModel(catalogue, {
            flag: model,
            type: kind as "video" | "audio" | "3d",
            capability: "generation",
          });
          const resource = (
            kind === "video" ? client.video : kind === "audio" ? client.audio : client.threeD
          ) as { generate: Function; submit: Function };
          const params = {
            model: id,
            prompt,
            ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
          };
          if (wait) {
            const job = (await resource.generate(params)) as MediaJob;
            return json({ model: id, ...jobSummary(job) });
          }
          const submitted = await resource.submit(params);
          return json({
            model: id,
            ...submitted,
            next: "Poll get_job with this jobId until status is completed.",
          });
        } catch (err) {
          return failure(err);
        }
      },
    );
  }

  server.registerTool(
    "get_job",
    {
      title: "Check an async job",
      description: "Status, progress and result URL for a job id from a generate_* tool. Free.",
      inputSchema: { jobId: z.string() },
    },
    async ({ jobId }) => {
      try {
        const job = await client.jobs.retrieve(jobId);
        return json({ ...jobSummary(job), progress: job.progress });
      } catch (err) {
        return failure(err);
      }
    },
  );

  // Only where there is a filesystem to read the file from. Over HTTP the same
  // tool would take a path this process cannot open, so it is absent instead —
  // a tool that always fails is worse than one that was never offered.
  if (opts.transcribe) {
    const transcribe = opts.transcribe;
    server.registerTool(
      "transcribe_audio",
      {
        title: "Transcribe an audio file",
        description:
          "Speech to text from a local audio file (mp3, wav, m4a, ogg, flac, webm). " +
          "Costs credits. Max 10 MB.",
        inputSchema: {
          file: z.string().describe("absolute path to the audio file"),
          model: z.string().optional().describe("a transcription model; see list_models"),
          language: z.string().optional().describe("ISO 639-1 hint, e.g. en"),
        },
      },
      async ({ file, model, language }) => {
        try {
          return json(await transcribe({ file, model, language }));
        } catch (err) {
          return failure(err);
        }
      },
    );
  }

  server.registerTool(
    "workflows",
    {
      title: "Curvet workflows",
      description:
        "Saved multi-step workflows this key can run. `list` to find one, `describe` for the " +
        "exact input keys it accepts (do this before running rather than guessing), `run` to " +
        "start it, `status` to poll a run. Running costs whatever its nodes cost; the rest is free.",
      inputSchema: {
        action: z.enum(["list", "describe", "run", "status"]),
        workflowId: z.string().optional().describe("for describe and run"),
        runId: z.string().optional().describe("for status"),
        inputs: z.record(z.string(), z.unknown()).optional().describe("for run; see describe"),
        q: z.string().optional().describe("title search, for list"),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ action, workflowId, runId, inputs, q, limit }) => {
      try {
        switch (action) {
          case "list":
            return json(await client.workflows.list({ q, limit }));
          case "describe":
            if (!workflowId) throw new Error("describe needs a workflowId.");
            return json(await client.workflows.retrieve(workflowId));
          case "run": {
            if (!workflowId) throw new Error("run needs a workflowId.");
            const submitted = await client.workflows.submit(workflowId, { inputs: inputs ?? {} });
            return json({
              ...submitted,
              next: "Poll this tool again with action:'status' and this runId.",
            });
          }
          case "status":
            if (!runId) throw new Error("status needs a runId.");
            return json(await client.workflows.runs.retrieve(runId));
        }
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "account",
    {
      title: "Balance and usage",
      description:
        "`balance` is what is left to spend (100 credits = $1). `usage` is what has been spent, " +
        "broken down by model and category. Both free.",
      inputSchema: {
        action: z.enum(["balance", "usage"]),
        startDate: z.string().optional().describe("ISO date, for usage"),
        endDate: z.string().optional().describe("ISO date, for usage"),
      },
    },
    async ({ action, startDate, endDate }) => {
      try {
        return json(
          action === "balance"
            ? await client.balance.get()
            : await client.analytics.get({ startDate, endDate }),
        );
      } catch (err) {
        return failure(err);
      }
    },
  );
}
