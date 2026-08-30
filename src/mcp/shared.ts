import type { MediaJob } from "@curvet/sdk";

/**
 * Shared shapes for the MCP tool module.
 *
 * This directory imports the Curvet client and nothing else from the CLI: the
 * same tools are meant to be served over HTTP from the backend, and every CLI
 * import is a thing that would have to be dragged along or forked. See
 * documentation/MCP_REVAMP_PLAN.md §0.8 in darkapp-haven.
 */

/** Tool results are JSON text; agents parse it, and it stays readable in a log. */
export function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function failure(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/**
 * A refusal is not an error.
 *
 * `isError` makes a host render a red box and makes a model retry. A tool that
 * declined on purpose — a secret, a path outside the project — wants the model
 * to read the sentence and do something else, so it comes back as an ordinary
 * result that says no.
 */
export function refusal(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Everything a caller should know about what a finished job cost.
 *
 * The two paths report it differently: a job returned by `generate()` carries
 * `usage` in credits, while one read back by `jobs.retrieve()` carries `cost`
 * in USD and no usage at all. An agent polling for its own spend would see
 * nothing if we only read one of them.
 */
export function jobSummary(job: MediaJob) {
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
