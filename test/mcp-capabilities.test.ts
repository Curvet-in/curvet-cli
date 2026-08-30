import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, capabilitiesFor, instructionsFor, toolNamesFor } from "../src/mcp/index.js";
import type { Catalogue } from "../src/models.js";

/**
 * What the server offers, given what the profile holds.
 *
 * This is the defect the revamp exists to fix, so it is the first thing tested:
 * the old server called `requireAppKey` and exited, which made every agency tool
 * unreachable for a profile that held exactly the credential agency needs.
 *
 * The list is asserted through a real MCP client over an in-memory transport
 * rather than by reading the registration calls — a tool that fails to register
 * is invisible to the second kind of check.
 */

const catalogue: Catalogue = {
  runnable: async () => [],
  all: async () => [],
};

const client = {} as never;

// A host that claims a filesystem must supply these; the stubs are never called
// here because no test invokes a tool, only lists them.
const localHost = {
  attach: async () => ({ ok: false as const, reason: "stub" }),
  transcribe: async () => ({}),
};

async function toolsFor(profile: { appKey?: string; cliToken?: string }, localFiles = true) {
  const capabilities = capabilitiesFor(profile, { localFiles });
  const server = buildServer(new McpServer({ name: "curvet", version: "test" }), {
    client,
    capabilities,
    catalogue,
    ...(localFiles ? localHost : {}),
  });
  const mcp = new Client({ name: "test-host", version: "test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), mcp.connect(a)]);
  const { tools } = await mcp.listTools();
  await mcp.close();
  return tools.map((t) => t.name).sort();
}

describe("capabilities", () => {
  it("offers the agent tools to a cliToken-only profile", async () => {
    const names = await toolsFor({ cliToken: "cli_x" });
    expect(names).toEqual(["get_agent_run", "run_agent"]);
  });

  it("offers the playground tools to an appKey-only profile", async () => {
    const names = await toolsFor({ appKey: "app_x" });
    expect(names).not.toContain("run_agent");
    expect(names).toContain("chat");
    expect(names).toContain("generate_image");
  });

  it("offers everything to a profile holding both", async () => {
    const names = await toolsFor({ appKey: "app_x", cliToken: "cli_x" });
    expect(names).toEqual(
      [
        "account",
        "chat",
        "generate_3d",
        "generate_audio",
        "generate_image",
        "generate_video",
        "get_agent_run",
        "get_job",
        "list_models",
        "run_agent",
        "transcribe_audio",
        "workflows",
      ].sort(),
    );
  });

  it("keeps the tool count in the budget it was designed to", async () => {
    // §0.5 of the plan settled on ~11 against SDK capability rather than the
    // CLI's 22 commands, because every description is permanent context. A
    // change that pushes this past 14 is a decision, not an oversight.
    const names = await toolsFor({ appKey: "app_x", cliToken: "cli_x" });
    expect(names.length).toBeLessThanOrEqual(14);
  });

  it("withholds the tools that need a disk when there is none", async () => {
    const names = await toolsFor({ appKey: "app_x", cliToken: "cli_x" }, false);
    // A tool that could only ever fail is absent rather than offered — the
    // hosted transport has no filesystem to read a path from.
    expect(names).not.toContain("transcribe_audio");
  });

  it("toolNamesFor matches what actually registers", async () => {
    for (const profile of [{ appKey: "a" }, { cliToken: "c" }, { appKey: "a", cliToken: "c" }]) {
      const capabilities = capabilitiesFor(profile, { localFiles: true });
      expect(toolNamesFor(capabilities).sort()).toEqual(await toolsFor(profile));
    }
  });
});

describe("honesty about what is missing", () => {
  it("names the command that would fix a missing agent credential", () => {
    const caps = capabilitiesFor({ appKey: "app_x" }, { localFiles: true });
    expect(caps.missing.join(" ")).toContain("curvet login --scope agency:run");
    expect(instructionsFor(caps)).toContain("curvet login --scope agency:run");
  });

  it("names the command that would fix a missing app key", () => {
    const caps = capabilitiesFor({ cliToken: "cli_x" }, { localFiles: true });
    expect(caps.missing.join(" ")).toContain("curvet auth login");
  });

  it("says nothing is missing when nothing is", () => {
    const caps = capabilitiesFor({ appKey: "a", cliToken: "c" }, { localFiles: true });
    expect(caps.missing).toEqual([]);
    expect(instructionsFor(caps)).not.toContain("unavailable");
  });

  it("tells the model plainly that a hosted server cannot open a path", () => {
    const caps = capabilitiesFor({ appKey: "a", cliToken: "c" }, { localFiles: false });
    expect(instructionsFor(caps)).toContain("no filesystem");
  });
});

describe("the localFiles promise", () => {
  it("refuses to build a local server without the resolvers that back it", () => {
    expect(() =>
      buildServer(new McpServer({ name: "curvet", version: "test" }), {
        client,
        capabilities: capabilitiesFor({ appKey: "a" }, { localFiles: true }),
        catalogue,
      }),
    ).toThrow(/localFiles/);
  });
});
