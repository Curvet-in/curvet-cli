import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Curvet } from "@curvet/sdk";
import { json, failure, refusal } from "../shared.js";
import type { RunRegistry, RunSnapshot } from "../runs.js";
import type { AttachResolver } from "../types.js";

/**
 * `run_agent` and `get_agent_run` — the surface that did not exist before.
 *
 * The whole agency stack was unreachable over MCP because the server demanded an
 * app key and agency needs a cliToken. Nothing else was in the way: the client
 * has carried all three credentials into the SDK all along.
 *
 * The two-call shape is the one the media tools already use — submit, then poll
 * `get_job` — and it is here for a stronger reason than consistency: see
 * `runs.ts` on why abandoning the stream would cancel the run.
 */

const MAX_ATTACHMENTS = 5; // the server drops the sixth silently, so refuse it here

export function registerAgentTools(
  server: McpServer,
  client: Curvet,
  runs: RunRegistry,
  attach: AttachResolver | null,
): void {
  server.registerTool(
    "run_agent",
    {
      title: "Run the Curvet agent",
      description:
        "Give a task to the Curvet agent — a multi-step agent with web search, memory, " +
        "media generation, workflows and the user's connected accounts (email, calendar, " +
        "Slack, GitHub). Use it for work that needs Curvet's own tools or the user's data; " +
        "do not use it for reading or editing files in this project, which you do better yourself. " +
        "SPENDS THE USER'S CREDITS. Returns a runId immediately — poll get_agent_run.",
      inputSchema: {
        task: z.string().describe("the request, in the user's own words where possible"),
        input: z
          .string()
          .optional()
          .describe("extra material the task refers to — a pasted document, data, an error log"),
        model: z.string().optional().describe("orchestrator model id; omit to let the server choose"),
        sessionId: z
          .string()
          .optional()
          .describe("pass the same value across turns to keep one conversation"),
        attachments: z
          .array(z.string())
          .max(MAX_ATTACHMENTS)
          .optional()
          .describe(
            "paths to files on this machine the agent should read. Secrets and anything " +
              "outside the project are refused. Only available when this server runs locally.",
          ),
      },
    },
    async ({ task, input, model, sessionId, attachments }) => {
      try {
        let resolved: { name: string; id?: string; content?: string }[] | undefined;

        if (attachments && attachments.length > 0) {
          if (!attach) {
            return refusal(
              "This Curvet server has no filesystem, so it cannot open a path. " +
                "Read the file yourself and pass its text as `input`.",
            );
          }
          resolved = [];
          for (const request of attachments) {
            const outcome = await attach(request);
            // A refusal ends the call rather than quietly running with four of
            // five files. A run that silently lost its input produces a
            // confident answer about the wrong thing.
            if (!outcome.ok) return refusal(outcome.reason);
            resolved.push(outcome.attachment);
          }
        }

        const snap = await runs.start(client, {
          task,
          input,
          modelId: model,
          sessionId,
          attachments: resolved,
        });
        return json(report(snap, { started: true }));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_agent_run",
    {
      title: "Check an agent run",
      description:
        "What a run from run_agent has done so far, and its answer once it finishes. " +
        "Runs take minutes: poll this every few seconds rather than once. Free.",
      inputSchema: {
        runId: z.string(),
        abort: z.boolean().optional().describe("stop the run instead of reading it"),
      },
    },
    async ({ runId, abort }) => {
      try {
        if (abort) {
          const stopped = runs.abort(runId);
          const snap = runs.get(runId);
          if (!snap) return refusal(`No run called "${runId}" was started from this server.`);
          return json({ ...report(snap), aborted: stopped });
        }

        const snap = runs.get(runId);
        if (snap) return json(report(snap));

        // Not in this process. It may still be a real run — a different MCP
        // session, or `curvet agent` — so read it back from history rather than
        // telling the model it does not exist.
        //
        // The server's own words for a miss are "not found", which reads as a
        // transport failure and gets retried. Say which id, and where it looked.
        const detail = await client.agency.retrieve(runId).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          if (/not found/i.test(message)) return null;
          throw err;
        });
        if (!detail) {
          return refusal(
            `No run called "${runId}". This server did not start it and it is not in the account's ` +
              "run history — check the id from run_agent.",
          );
        }
        return json({
          runId,
          status: detail.status ?? "unknown",
          task: detail.task,
          summary: detail.summary,
          costUsd: detail.costUsd,
          deliverables: detail.deliverables ?? [],
          note: "Replayed from history — this run was not started by this server.",
        });
      } catch (err) {
        return failure(err);
      }
    },
  );
}

/** What the model is told about a run. */
function report(snap: RunSnapshot, opts: { started?: boolean } = {}) {
  const base = {
    runId: snap.runId,
    status: snap.status,
    task: snap.task,
    costUsd: snap.costUsd,
    elapsedMs: (snap.endedAt ?? Date.now()) - snap.startedAt,
  };

  if (opts.started && snap.status === "running") {
    return { ...base, next: "Poll get_agent_run with this runId every few seconds." };
  }

  const detail = {
    ...base,
    timeline: snap.timeline,
    answer: snap.text || undefined,
    deliverables: snap.deliverables,
    error: snap.error,
  };

  if (snap.status === "paused") {
    return {
      ...detail,
      stoppedOn: snap.stoppedOn,
      // Said in full because the model's instinct is to retry, and retrying
      // produces the same pause. The user has to be told, not worked around.
      why:
        "The run needed a person to approve or answer something, and MCP has no way to ask — " +
        "so it stopped rather than assuming an answer. Tell the user what it stopped on and " +
        "suggest they rerun it with `curvet agent`, where they can answer.",
    };
  }
  if (snap.status === "running") {
    return { ...detail, next: "Still going. Poll again in a few seconds." };
  }
  return detail;
}
