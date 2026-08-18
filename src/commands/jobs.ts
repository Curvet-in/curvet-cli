import { Command } from "commander";
import { resolveProfile } from "../config.js";
import { makeClient, requireAppKey } from "../client.js";
import { Progress } from "../progress.js";
import { downloadTo, formatBytes } from "../download.js";
import { formatEta, writeMediaCost } from "./shared.js";
import { printJson, ok, warn, table } from "../output.js";

export function jobsCommand(): Command {
  const jobs = new Command("jobs").description("Inspect and await async media jobs");

  jobs
    .command("get <jobId>")
    .description("Fetch a job's current status once")
    .option("--json", "machine-readable output")
    .action(async (jobId: string, opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      requireAppKey(profile);
      const job = await makeClient(profile).jobs.retrieve(jobId);

      if (opts.json) {
        printJson(job);
        return;
      }
      const rows: string[][] = [
        ["status", job.status],
        ["progress", job.progress != null ? `${job.progress}%` : "—"],
      ];
      if (job.eta) rows.push(["eta", job.eta]);
      if (job.mediaUrl) rows.push(["url", job.mediaUrl]);
      if (job.error) rows.push(["error", job.error]);
      console.log(table(["FIELD", "VALUE"], rows));
    });

  jobs
    .command("wait <jobId>")
    .description("Poll a job until it finishes")
    .option("-o, --output <file>", "download the result here when it finishes")
    .option("--poll-interval <ms>", "poll interval in ms", (v) => parseInt(v, 10))
    .option("--timeout <ms>", "give up polling after this long", (v) => parseInt(v, 10))
    .option("--quiet", "suppress the progress bar")
    .option("--json", "machine-readable output")
    .action(async (jobId: string, opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      requireAppKey(profile);
      const handle = makeClient(profile).jobs.handle(jobId);

      const progress = new Progress({ label: "job", enabled: !opts.quiet && !opts.json });
      let job;
      try {
        job = await handle.wait({
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
      progress.done("job complete");

      if (opts.output && job.mediaUrl) {
        const bytes = await downloadTo(job.mediaUrl, opts.output);
        console.log(ok(`saved ${opts.output} (${formatBytes(bytes)})`));
      } else if (job.mediaUrl) {
        console.log(job.mediaUrl);
      } else {
        console.log(warn("Job completed without a media URL."));
      }
      writeMediaCost(job, (job.metadata?.model as string) ?? "");
    });

  return jobs;
}
