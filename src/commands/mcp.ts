import { Command } from "commander";
import { resolveProfile } from "../config.js";
import { makeClient } from "../client.js";
import { catalogueFor } from "../models.js";
import { buildServer, capabilitiesFor, instructionsFor, toolNamesFor } from "../mcp/index.js";
import { attachmentRoot, makeAttachResolver, makeTranscribeResolver } from "../mcp/local.js";

/**
 * `curvet mcp` — Curvet as an MCP server over stdio.
 *
 * The tools themselves are in `src/mcp/`, which knows nothing about a terminal:
 * the same set is meant to be served over HTTP from the backend, and anything
 * that needs the user's machine is injected from here. See
 * darkapp-haven/documentation/MCP_REVAMP_PLAN.md §0.
 *
 * This file used to call `requireAppKey` and exit, which is why the entire
 * agency surface was unreachable over MCP: agency needs the `cliToken`, and a
 * profile holding only that could not start the server at all. It now starts on
 * either credential and offers what that credential can reach.
 *
 * stdout IS the protocol transport. Nothing here may print to it — every
 * diagnostic goes to stderr.
 */
export function mcpCommand(): Command {
  return new Command("mcp")
    .description("Run Curvet as an MCP server over stdio (for Claude Code, Cursor, …)")
    .action(async (_opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      // One credential is enough. Which one decides what is offered, not whether
      // there is anything to offer — makeClient throws only when there are none.
      const client = makeClient(profile);
      const capabilities = capabilitiesFor(profile, { localFiles: true });

      const root = await attachmentRoot(process.cwd());

      // Imported here rather than at module scope: the MCP SDK is by far the
      // heaviest thing the CLI depends on, and `curvet chat` has no use for it.
      const [{ McpServer }, { StdioServerTransport }] = await Promise.all([
        import("@modelcontextprotocol/sdk/server/mcp.js"),
        import("@modelcontextprotocol/sdk/server/stdio.js"),
      ]);

      const server = buildServer(
        new McpServer(
          { name: "curvet", version: "1.0.0" },
          { instructions: instructionsFor(capabilities) },
        ),
        {
          client,
          capabilities,
          catalogue: catalogueFor(profile, client),
          defaultModel: profile.defaultModel,
          attach: makeAttachResolver(client, root),
          transcribe: makeTranscribeResolver(client, root),
        },
      );

      await server.connect(new StdioServerTransport());
      // stdout belongs to the protocol from here on.
      const names = toolNamesFor(capabilities);
      process.stderr.write(`curvet mcp: ready on stdio — ${names.length} tools (${names.join(", ")})\n`);
      process.stderr.write(`curvet mcp: files rooted at ${root}\n`);
      for (const line of capabilities.missing) process.stderr.write(`curvet mcp: ${line}\n`);
    });
}
