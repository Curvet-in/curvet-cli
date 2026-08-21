import { Command } from "commander";
import pc from "picocolors";
import {
  AuthError,
  InsufficientBalanceError,
  PermissionError,
  RateLimitError,
  type ChatResponse,
  type ModelInfo,
} from "@curvet/sdk";
import { resolveProfile, loadConfig, resolveShowCost } from "../config.js";
import { makeClient, requireAppKey } from "../client.js";
import { confirm } from "../confirm.js";
import { costFlagFrom } from "./shared.js";
import { formatCost, ok, printJson, warn } from "../output.js";
import { COMMIT_TURN, rankByCost } from "../modelCost.js";
import {
  commit as gitCommit,
  filterDiff,
  isRepo,
  recentCommits,
  stagedDiff,
  stagedFiles,
  stageTrackedChanges,
} from "../git.js";

/** Chat models ordered by what a commit-shaped turn would cost, cheapest first. */
export function rankChatModels(models: ModelInfo[]): ModelInfo[] {
  return rankByCost(
    models.filter((m) => (m.capability ?? "generation") === "generation"),
    COMMIT_TURN,
  );
}

export function cheapestChatModel(models: ModelInfo[]): ModelInfo {
  const ranked = rankChatModels(models);
  if (ranked.length === 0) throw new Error("No chat models are available to this app.");
  return ranked[0];
}

/**
 * Whether it is worth trying a different model.
 *
 * The catalogue advertises models that cannot actually serve a request -- at the
 * time of writing `gpt-oss-120b` and `gemma-4-26b` are both `available: true`
 * and both fail every call. Since this command picks the model *for* you, a
 * catalogue that lies should cost you a retry, not a failed commit. But only for
 * that class: a bad key, an empty balance or a rate limit will fail identically
 * on every model, and trying three of them just wastes time and money.
 */
function worthAnotherModel(err: unknown): boolean {
  if (err instanceof AuthError || err instanceof PermissionError) return false;
  if (err instanceof InsufficientBalanceError || err instanceof RateLimitError) return false;
  return true;
}

/**
 * Whether this repo writes conventional commits, judged by its own history
 * rather than by a flag. Matching what is already there is nearly always what
 * someone wants, and it is the one thing a generic model reliably gets wrong.
 */
export function detectsConventional(subjects: string[]): boolean {
  if (subjects.length === 0) return false;
  const conventional = subjects.filter((s) =>
    /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: /.test(s),
  );
  return conventional.length / subjects.length >= 0.5;
}

function buildPrompt(
  diff: string,
  history: string[],
  opts: { dropped: string[]; truncated: boolean },
): string {
  const subjects = history.map((c) => c.split("\n")[0]);
  const conventional = detectsConventional(subjects);

  const notes = [
    opts.dropped.length > 0
      ? `Not shown (excluded as noise or for length): ${opts.dropped.join(", ")}. Do not mention them.`
      : "",
    opts.truncated
      ? "This diff was TRUNCATED. Describe only what you can see; do not imply it is the whole change."
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `Write a git commit message for the staged diff below.

Match the style of this repository's recent commits. They are the authority on
format, tense, capitalisation and length — not any convention you know:

${history.slice(0, 6).map((c) => c.split("\n").slice(0, 6).join("\n")).join("\n---\n")}

Rules:
- Output ONLY the commit message. No preamble, no code fences, no explanation.
- First line: a subject under 72 characters.${conventional ? " This repo uses Conventional Commits — keep that." : ""}
- If the change needs it, add a blank line then a body explaining WHY, not what.
  A body that restates the diff is worse than no body.
- Do not invent motivation you cannot see in the diff.
${notes ? `\n${notes}\n` : ""}
Staged diff:

${diff}`;
}

/** Models sometimes wrap output in fences or a preamble regardless of instructions. */
export function cleanMessage(raw: string): string {
  let text = raw.trim();
  const fenced = /^```(?:\w+)?\n([\s\S]*?)\n```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  // Strip a leading "Commit message:" style lead-in, but only if a blank line
  // separates it from the real content — otherwise it may be the subject.
  text = text.replace(/^(?:here(?:'s| is) the )?commit message:?\s*\n\s*\n/i, "");
  return text.trim();
}

export function commitCommand(): Command {
  return new Command("commit")
    .description("Write a commit message for the staged diff, then commit it")
    .option("-a, --all", "stage tracked modifications first, like `git commit -a`")
    .option("-m, --model <id>", "model id (default: the cheapest for a diff-shaped turn)")
    .option("-y, --yes", "commit without confirming")
    .option("--print", "print the message and do not commit")
    .option("--hint <text>", "context the diff cannot show, e.g. why the change was needed")
    .option("--cost", "show the cost line even when disabled in config")
    .option("--no-cost", "hide the cost line")
    .option("--json", "machine-readable output")
    .action(async (opts, cmd) => {
      if (!(await isRepo())) throw new Error("Not a git repository.");

      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      requireAppKey(profile);
      const config = await loadConfig();
      const showCost = resolveShowCost(config, costFlagFrom(cmd)) && !opts.json && !opts.print;

      if (opts.all) await stageTrackedChanges();

      const raw = await stagedDiff();
      if (!raw.trim()) {
        throw new Error(
          "Nothing staged. Stage your changes with `git add`, or re-run with -a to " +
            "include tracked modifications.",
        );
      }

      const { diff, dropped, truncated } = filterDiff(raw);
      if (!diff.trim()) {
        throw new Error(
          `Everything staged was excluded as noise (${dropped.join(", ")}). ` +
            "Nothing left to describe.",
        );
      }

      const client = makeClient(profile);
      // An explicit --model is honoured exactly; an automatic choice gets
      // fallbacks, because the user did not make it.
      const candidates = opts.model
        ? [opts.model]
        : rankChatModels(await client.models.list({ type: "chat" }))
            .slice(0, 4)
            .map((m) => m.id);

      const history = await recentCommits(10).catch(() => []);
      const prompt = buildPrompt(diff, history, { dropped, truncated });
      const messages = [
        ...(opts.hint
          ? [{ role: "user" as const, content: `Context from the author: ${opts.hint}` }]
          : []),
        { role: "user" as const, content: prompt },
      ];

      let res: ChatResponse | undefined;
      let model = candidates[0];
      const skipped: string[] = [];
      for (const candidate of candidates) {
        try {
          res = await client.chat.create({ model: candidate, messages, temperature: 0.2 });
          model = candidate;
          break;
        } catch (err) {
          if (candidate === candidates[candidates.length - 1] || !worthAnotherModel(err)) throw err;
          skipped.push(candidate);
        }
      }
      if (!res) throw new Error("No chat model could write a message.");
      // stderr, so it still shows under --print without touching the piped message.
      if (skipped.length > 0 && !opts.json) {
        process.stderr.write(
          pc.dim(`skipped ${skipped.join(", ")} — the catalogue lists them but they failed\n`),
        );
      }

      const message = cleanMessage(res.response ?? "");
      if (!message) throw new Error("The model returned an empty message.");

      if (opts.json) {
        printJson({ model, message, dropped, truncated, usage: res.usage });
        return;
      }
      if (opts.print) {
        // stdout only, so `curvet commit --print | git commit -F -` works.
        console.log(message);
        return;
      }

      const files = await stagedFiles();
      process.stderr.write(
        pc.dim(`${files.length} file${files.length === 1 ? "" : "s"} staged · ${model}\n`),
      );
      if (dropped.length > 0) {
        process.stderr.write(pc.dim(`excluded: ${dropped.join(", ")}\n`));
      }
      if (truncated) {
        process.stderr.write(
          warn("the diff was too large to send in full — check the message covers everything\n"),
        );
      }
      console.log(`\n${message}\n`);

      await confirm("Commit with this message?", {
        yes: opts.yes,
        detail: "Edit it afterwards with `git commit --amend` if it needs a tweak.",
      });

      const out = await gitCommit(message);
      console.log(ok(out.split("\n")[0] ?? "committed"));

      if (showCost) {
        const usage = res.usage as (typeof res.usage & { billing?: "metered" | "flat" }) | undefined;
        process.stderr.write(
          pc.dim(
            formatCost({
              model,
              credits: usage?.credits,
              billing: usage?.billing,
              remainingBalance: usage?.remainingBalance,
            }),
          ) + "\n",
        );
      }
    });
}
