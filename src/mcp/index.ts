import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Curvet } from "@curvet/sdk";
import { capabilitiesFor, instructionsFor, type CapabilityReport } from "./capabilities.js";
import { RunRegistry } from "./runs.js";
import { registerAgentTools } from "./tools/agent.js";
import { registerPlaygroundTools } from "./tools/playground.js";
import type { AttachResolver, TranscribeResolver } from "./types.js";
import type { Catalogue } from "../models.js";

export { capabilitiesFor, instructionsFor, type CapabilityReport } from "./capabilities.js";
export { RunRegistry, type RunSnapshot } from "./runs.js";
export type { AttachResolver, TranscribeResolver, ResolvedAttachment, AttachOutcome } from "./types.js";

/**
 * Curvet as MCP tools.
 *
 * Eleven tools, chosen against what the SDK can reach rather than against the
 * CLI's command list: half the CLI exists because a human is typing, and every
 * tool description is in the model's context on every turn. The reasoning, and
 * the two collapses (`workflows`, `account`), are in
 * darkapp-haven/documentation/MCP_REVAMP_PLAN.md §0.5.
 *
 * Two rules hold in here and are the reason it is a module rather than a file
 * in the CLI:
 *
 *   1. It imports the Curvet SDK and nothing else that knows about a terminal.
 *      Anything needing the user's machine arrives as a resolver in `deps` and
 *      is simply absent when the host has no disk.
 *   2. What is unavailable is DECLARED. A credential that is missing takes its
 *      tools with it and says so in the server instructions, rather than
 *      registering a tool that fails on every call.
 */
export interface BuildServerDeps {
  client: Curvet;
  capabilities: CapabilityReport;
  catalogue: Catalogue;
  /** The profile's stored chat default, honoured without a catalogue lookup. */
  defaultModel?: string;
  /** Supplied only by a host that shares a filesystem with the user. */
  attach?: AttachResolver | null;
  transcribe?: TranscribeResolver | null;
  /** Injectable so tests can watch a run without reaching into the module. */
  runs?: RunRegistry;
}

export function buildServer(server: McpServer, deps: BuildServerDeps): McpServer {
  const { client, capabilities, catalogue } = deps;

  // `localFiles` is a promise about this host, so a host that makes it has to
  // keep it. Without this the two disagree silently and the tool list quietly
  // shrinks — which is the failure mode the whole revamp is a response to, at
  // the scale of one tool instead of forty.
  if (capabilities.localFiles && !(deps.attach && deps.transcribe)) {
    throw new Error(
      "buildServer: capabilities.localFiles is true but the attach/transcribe resolvers are missing. " +
        "A host with a filesystem must supply both; one without should set localFiles:false.",
    );
  }

  if (capabilities.playground) {
    registerPlaygroundTools(server, client, catalogue, {
      defaultModel: deps.defaultModel,
      transcribe: capabilities.localFiles ? (deps.transcribe ?? null) : null,
    });
  }

  if (capabilities.agent) {
    registerAgentTools(
      server,
      client,
      deps.runs ?? new RunRegistry(),
      capabilities.localFiles ? (deps.attach ?? null) : null,
    );
  }

  return server;
}

/** The names this set of capabilities produces. Exported for tests and `doctor`. */
export function toolNamesFor(capabilities: Pick<CapabilityReport, "playground" | "agent" | "localFiles">): string[] {
  const names: string[] = [];
  if (capabilities.playground) {
    names.push(
      "list_models",
      "chat",
      "generate_image",
      "generate_video",
      "generate_audio",
      "generate_3d",
      "get_job",
    );
    if (capabilities.localFiles) names.push("transcribe_audio");
    names.push("workflows", "account");
  }
  if (capabilities.agent) names.push("run_agent", "get_agent_run");
  return names;
}
