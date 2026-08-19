import { Command } from "commander";
import { promises as fs } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import type { WorkflowRun, WorkflowSummary, WorkflowDetail } from "@curvet/sdk";
import { resolveProfile } from "../config.js";
import { makeClient, requireAppKey } from "../client.js";
import { Progress } from "../progress.js";
import { printJson, table, ok, fail, warn } from "../output.js";

/**
 * Parse `--input key=value`. Values are tried as JSON first so numbers, booleans,
 * arrays and objects survive; anything that isn't valid JSON stays a string,
 * which is what makes `--input name=Ada` work without quoting gymnastics.
 */
function parseInputs(pairs: string[] = []): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 1) {
      console.error(fail(`Bad --input "${pair}" — expected key=value.`));
      process.exit(1);
    }
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    try {
      inputs[key] = JSON.parse(raw);
    } catch {
      inputs[key] = raw;
    }
  }
  return inputs;
}

/** Parse `--file field=./path` into Blobs the SDK can put in a multipart body. */
async function parseFiles(pairs: string[] = []): Promise<Record<string, Blob>> {
  const files: Record<string, Blob> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 1) {
      console.error(fail(`Bad --file "${pair}" — expected field=./path.`));
      process.exit(1);
    }
    const field = pair.slice(0, eq);
    const filePath = pair.slice(eq + 1);
    let buf: Buffer;
    try {
      buf = await fs.readFile(filePath);
    } catch (err) {
      console.error(fail(`Cannot read ${filePath}: ${(err as Error).message}`));
      process.exit(1);
    }
    const name = path.basename(filePath);
    // File carries the filename through multipart; Blob alone would send "blob".
    files[field] =
      typeof File !== "undefined" ? new File([buf], name) : new Blob([buf]);
  }
  return files;
}

function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([value]);
}

function describeNode(run: WorkflowRun): string | undefined {
  const label = run.currentNode?.label ?? run.currentNode?.id;
  const counts =
    run.totalNodes != null ? `${run.completedNodeCount ?? 0}/${run.totalNodes}` : undefined;
  if (label && counts) return `${label} (${counts})`;
  return label ?? counts;
}

function printRun(run: WorkflowRun): void {
  const rows: string[][] = [
    ["runId", run.runId],
    ["status", run.status],
  ];
  if (run.progress != null) rows.push(["progress", `${run.progress}%`]);
  if (run.totalNodes != null) {
    rows.push(["nodes", `${run.completedNodeCount ?? 0}/${run.totalNodes}`]);
  }
  if (run.currentNode) rows.push(["current", describeNode(run) ?? "—"]);
  if (run.startTime) rows.push(["started", run.startTime]);
  if (run.endTime) rows.push(["ended", run.endTime]);
  if (run.error) rows.push(["error", run.error]);
  console.log(table(["FIELD", "VALUE"], rows));
}

/** Compact relative age, so a listing reads at a glance. */
export function relativeAge(iso?: string, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

function printWorkflowList(workflows: WorkflowSummary[]): void {
  console.log(
    table(
      ["ID", "TITLE", "NODES", "UPDATED"],
      workflows.map((w) => [w.id, w.title, String(w.nodeCount), relativeAge(w.updatedAt)]),
    ),
  );
}

function printWorkflowDetail(wf: WorkflowDetail): void {
  const rows: string[][] = [
    ["id", wf.id],
    ["title", wf.title],
  ];
  if (wf.description) rows.push(["description", wf.description]);
  rows.push(["nodes", String(wf.nodeCount)]);
  if (wf.tags?.length) rows.push(["tags", wf.tags.join(", ")]);
  if (wf.status) rows.push(["status", wf.status]);
  if (wf.updatedAt) rows.push(["updated", relativeAge(wf.updatedAt)]);
  console.log(table(["FIELD", "VALUE"], rows));

  console.log(`\n${pc.bold("INPUTS")}`);
  if (!wf.inputs || wf.inputs.length === 0) {
    console.log(pc.dim("  none — this workflow takes no run inputs"));
    return;
  }
  console.log(
    table(
      ["NAME", "TYPE", "REQUIRED", "ALSO ACCEPTS"],
      wf.inputs.map((i) => [
        i.name,
        String(i.type),
        i.required ? pc.yellow("yes") : "no",
        (i.aliases ?? []).join(", "),
      ]),
    ),
  );
  // The whole point of the command: turn the answer into the next command.
  const example = wf.inputs.map((i) => `-i ${i.name}=<value>`).join(" ");
  console.log(pc.dim(`\nrun it with: curvet workflows run ${wf.id} ${example}`));
}

/** Internals exposed for unit tests. */
export const __test = { parseInputs, describeNode, relativeAge };

export function workflowsCommand(): Command {
  const workflows = new Command("workflows")
    .alias("wf")
    .description("Run workflows and inspect their runs");

  workflows
    .command("list")
    .alias("ls")
    .description("List the workflows this key can run")
    .option("-q, --query <text>", "filter by title (case-insensitive)")
    .option("-n, --limit <n>", "max results (1-100, default 50)", (v) => parseInt(v, 10))
    .option("--json", "machine-readable output")
    .action(async (opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      requireAppKey(profile);
      const workflowList = await makeClient(profile).workflows.list({
        limit: opts.limit,
        q: opts.query,
      });

      if (opts.json) {
        printJson(workflowList);
        return;
      }
      if (workflowList.length === 0) {
        console.log(
          warn(
            opts.query
              ? `No workflows matching "${opts.query}".`
              : "No workflows yet — build one in the visual builder.",
          ),
        );
        return;
      }
      printWorkflowList(workflowList);
      process.stderr.write(
        pc.dim(`\nsee a workflow's inputs with: curvet workflows show <id>\n`),
      );
    });

  workflows
    .command("show <workflowId>")
    .description("Show one workflow and the inputs it accepts")
    .option("--json", "machine-readable output")
    .action(async (workflowId: string, opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      requireAppKey(profile);
      const wf = await makeClient(profile).workflows.retrieve(workflowId);

      if (opts.json) {
        printJson(wf);
        return;
      }
      printWorkflowDetail(wf);
    });

  workflows
    .command("run <workflowId>")
    .description("Run a workflow, polling until it finishes")
    .option("-i, --input <key=value>", "workflow input (repeatable)", collect, [])
    .option("-f, --file <field=path>", "file input (repeatable)", collect, [])
    .option("--no-wait", "submit and print the run id instead of polling")
    .option("--poll-interval <ms>", "poll interval in ms", (v) => parseInt(v, 10))
    .option("--timeout <ms>", "give up polling after this long", (v) => parseInt(v, 10))
    .option("--full-state", "ask the server for the full execution state")
    .option("--quiet", "suppress the progress bar")
    .option("--json", "machine-readable output")
    .action(async (workflowId: string, opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      requireAppKey(profile);
      const client = makeClient(profile);

      const params = {
        inputs: parseInputs(opts.input),
        files: await parseFiles(opts.file),
        includeFullState: opts.fullState ? true : undefined,
      };

      if (opts.wait === false) {
        const submitted = await client.workflows.submit(workflowId, params);
        if (opts.json) {
          printJson(submitted);
          return;
        }
        console.log(submitted.runId);
        process.stderr.write(
          pc.dim(`follow it with: curvet workflows status ${submitted.runId}\n`),
        );
        return;
      }

      const progress = new Progress({
        label: "workflow",
        enabled: !opts.quiet && !opts.json,
      });

      let run: WorkflowRun;
      try {
        run = await client.workflows.runAndPoll(workflowId, params, {
          pollIntervalMs: opts.pollInterval,
          pollTimeoutMs: opts.timeout,
          onProgress: (r) => progress.update(r.progress ?? 0, describeNode(r)),
        });
      } catch (err) {
        progress.abort();
        throw err;
      }

      if (opts.json) {
        printJson(run);
        return;
      }
      progress.done(`workflow ${run.status}`);
      if (run.result !== undefined) {
        console.log(
          typeof run.result === "string" ? run.result : JSON.stringify(run.result, null, 2),
        );
      } else {
        console.log(ok(`run ${run.runId} finished with no result payload`));
      }
    });

  workflows
    .command("status <runId>")
    .description("Fetch an async run's current status")
    .option("--json", "machine-readable output")
    .action(async (runId: string, opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      requireAppKey(profile);
      const run = await makeClient(profile).workflows.runs.retrieve(runId);
      if (opts.json) {
        printJson(run);
        return;
      }
      printRun(run);
    });

  return workflows;
}
