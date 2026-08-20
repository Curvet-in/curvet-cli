import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Curvet, MediaJob } from "@curvet/sdk";
import { resolveProfile } from "../config.js";
import { makeClient, requireAppKey } from "../client.js";
import { catalogueFor, pickModel } from "../models.js";
import { mimeFor } from "./stt.js";

/**
 * MCP server over the Curvet API.
 *
 * Deliberately not a bridge to darkapp-haven's `mcp-servers/consolidated-server.js`:
 * that one imports `backend/services/deploymentService.js` directly, so it only
 * runs inside a checkout of the platform repo and could not ship in an npm CLI.
 * This exposes what an app key can actually reach, which is what makes
 * `claude mcp add curvet -- curvet mcp` a one-liner for someone who has only
 * ever run `npm i -g @curvet/cli`.
 *
 * stdout IS the protocol transport. Nothing here may print to it — every
 * diagnostic goes to stderr.
 */

/** Tool results are JSON text; agents parse it, and it stays readable in a log. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

/**
 * Everything a caller should know about what a finished job cost.
 *
 * The two paths report it differently: a job returned by `generate()` carries
 * `usage` in credits, while one read back by `jobs.retrieve()` carries `cost`
 * in USD and no usage at all. An agent polling for its own spend would see
 * nothing if we only read one of them.
 */
function jobSummary(job: MediaJob) {
  const usage = job.usage;
  return {
    jobId: job.jobId,
    status: job.status,
    mediaUrl: job.mediaUrl,
    creditsCharged: usage?.credits,
    creditsRemaining: usage?.remainingBalance,
    costUsd: job.cost?.actual ?? job.cost?.estimated,
  };
}

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
      mode: z.enum(["text_to_video", "image_to_video"]).optional(),
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

function buildServer(
  server: McpServer,
  client: Curvet,
  profile: Awaited<ReturnType<typeof resolveProfile>>,
): McpServer {
  const catalogue = catalogueFor(profile, client);

  server.registerTool(
    "list_models",
    {
      title: "List Curvet models",
      description:
        "The models this key can call right now, with credit cost and capability. " +
        "Call this before generating: model ids are not guessable and a wrong one fails. " +
        "Free.",
      inputSchema: {
        type: z
          .string()
          .optional()
          .describe("chat, image, video, audio, 3d"),
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
        "Send a prompt to a Curvet chat model and get the reply. Metered per token.",
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
          defaultModel: profile.defaultModel,
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
      `generate_${kind === "3d" ? "3d" : kind}`,
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
            type: kind,
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
        const bytes = await fs.readFile(file);
        if (bytes.length > 10 * 1024 * 1024) {
          throw new Error(`${file} is over the 10 MB upload limit.`);
        }
        const result = await client.voice.stt({
          audio: new Blob([bytes], { type: mimeFor(file) }),
          filename: path.basename(file),
          model,
          languageCode: language,
        });
        return json({
          text: result.text,
          provider: result.provider,
          languageCode: result.languageCode,
          creditsCharged: result.creditsCharged,
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "list_workflows",
    {
      title: "List workflows",
      description: "Workflows this key can run, most recently updated first. Free.",
      inputSchema: {
        q: z.string().optional().describe("title search"),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ q, limit }) => {
      try {
        return json(await client.workflows.list({ q, limit }));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "describe_workflow",
    {
      title: "Describe a workflow",
      description:
        "One workflow and the exact input keys it accepts, derived from its node graph. " +
        "Call this before run_workflow rather than guessing key names. Free.",
      inputSchema: { workflowId: z.string() },
    },
    async ({ workflowId }) => {
      try {
        return json(await client.workflows.retrieve(workflowId));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "run_workflow",
    {
      title: "Run a workflow",
      description:
        "Run a workflow with JSON inputs. Costs whatever its nodes cost. Returns a runId " +
        "immediately; poll get_workflow_run. Use describe_workflow first for the input keys.",
      inputSchema: {
        workflowId: z.string(),
        inputs: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ workflowId, inputs }) => {
      try {
        const submitted = await client.workflows.submit(workflowId, { inputs: inputs ?? {} });
        return json({ ...submitted, next: "Poll get_workflow_run with this runId." });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_workflow_run",
    {
      title: "Check a workflow run",
      description: "Status, per-node progress and result for a runId. Free.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      try {
        return json(await client.workflows.runs.retrieve(runId));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_balance",
    {
      title: "Credit balance",
      description: "Credits available to the key's owner. Free. 100 credits = $1.",
      inputSchema: {},
    },
    async () => {
      try {
        return json(await client.balance.get());
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_analytics",
    {
      title: "Usage analytics",
      description: "What this app has spent, broken down by model and category. Free.",
      inputSchema: {
        startDate: z.string().optional().describe("ISO date"),
        endDate: z.string().optional().describe("ISO date"),
      },
    },
    async ({ startDate, endDate }) => {
      try {
        return json(await client.analytics.get({ startDate, endDate }));
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}

export function mcpCommand(): Command {
  return new Command("mcp")
    .description("Run Curvet as an MCP server over stdio (for Claude Code, Cursor, …)")
    .action(async (_opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      requireAppKey(profile);
      const client = makeClient(profile);

      // Imported here rather than at module scope: the MCP SDK is by far the
      // heaviest thing the CLI depends on, and `curvet chat` has no use for it.
      const [{ McpServer }, { StdioServerTransport }] = await Promise.all([
        import("@modelcontextprotocol/sdk/server/mcp.js"),
        import("@modelcontextprotocol/sdk/server/stdio.js"),
      ]);

      const server = buildServer(new McpServer({ name: "curvet", version: "1.0.0" }), client, profile);
      await server.connect(new StdioServerTransport());
      // stdout belongs to the protocol from here on.
      process.stderr.write("curvet mcp: ready on stdio\n");
    });
}
