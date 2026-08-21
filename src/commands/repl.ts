import readline from "node:readline";
import { promises as fs } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import type { ChatMessage, Curvet, ModelInfo } from "@curvet/sdk";
import { configDir, type ResolvedProfile } from "../config.js";
import { streamChat } from "../chatStream.js";
import { formatCost, trimNumber, warn, type CostInfo } from "../output.js";
import { CHAT_TURN, estimateCredits, rankByCost } from "../modelCost.js";

/**
 * An interactive chat session.
 *
 * Deliberately readline rather than a full-screen TUI. A full-screen app takes
 * the alternate screen buffer, which costs the three things this CLI is built
 * around: terminal scrollback (the thing you want *after* a chat — scrolling up
 * to copy an answer), piping, and working over a flaky SSH connection. Replies
 * therefore stream inline exactly as `curvet chat` prints them, and everything
 * the terminal already does well is left alone.
 */

interface Session {
  model: string;
  messages: ChatMessage[];
  system?: string;
  credits: number;
  turns: number;
}

const HISTORY_FILE = () => path.join(configDir(), "repl-history");
const MAX_HISTORY = 500;

/** Models absent from the compat surface answer sync-only; say so up front. */
async function streamableIds(client: Curvet, profile: ResolvedProfile): Promise<Set<string>> {
  try {
    const res = await fetch(`${profile.baseURL ?? "https://curvet.ai/api/v1/playground"}`.replace(/\/playground\/?$/, "") + "/public/models");
    if (!res.ok) return new Set();
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return new Set((body.data ?? []).map((m) => m.id));
  } catch {
    return new Set();
  }
}

async function loadHistory(): Promise<string[]> {
  try {
    const raw = await fs.readFile(HISTORY_FILE(), "utf8");
    // readline wants most-recent-first.
    return raw.split("\n").filter(Boolean).reverse();
  } catch {
    return [];
  }
}

async function saveHistory(lines: string[]): Promise<void> {
  try {
    await fs.mkdir(configDir(), { recursive: true });
    const recent = lines.slice(0, MAX_HISTORY).reverse().join("\n");
    await fs.writeFile(HISTORY_FILE(), recent + "\n", { mode: 0o600 });
  } catch {
    /* history is a convenience; never fail a session over it */
  }
}

const HELP = `
  ${pc.bold("/model")} [id]     show or switch the model, mid-conversation
  ${pc.bold("/models")}         chat models, cheapest first
  ${pc.bold("/cost")}           what this session has spent
  ${pc.bold("/system")} <text>  set the system prompt (resets the conversation)
  ${pc.bold("/clear")}          start over, same model
  ${pc.bold("/save")} [file]    write the transcript to a file
  ${pc.bold("/help")}           this
  ${pc.bold("/exit")}           leave (or Ctrl-D)

  Ctrl-C stops a reply in progress. Ctrl-C on an empty line exits.
  End a line with \\ to continue it on the next.
`;

export interface ReplOptions {
  model: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  showCost: boolean;
}

export async function runRepl(
  profile: ResolvedProfile,
  client: Curvet,
  options: ReplOptions,
): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "The REPL needs a terminal. Pipe into `curvet chat` instead: cat file | curvet chat \"…\"",
    );
  }

  const session: Session = {
    model: options.model,
    messages: options.system ? [{ role: "system", content: options.system }] : [],
    system: options.system,
    credits: 0,
    turns: 0,
  };

  let catalogue: ModelInfo[] = [];
  try {
    catalogue = await client.models.list({ type: "chat", capability: "generation" });
  } catch {
    /* offline-ish: /models will say so */
  }
  const streamable = await streamableIds(client, profile);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history: await loadHistory(),
    historySize: MAX_HISTORY,
    prompt: pc.cyan("› "),
    completer: (line: string) => {
      if (!line.startsWith("/model ")) {
        const cmds = ["/model ", "/models", "/cost", "/system ", "/clear", "/save", "/help", "/exit"];
        const hits = cmds.filter((c) => c.startsWith(line));
        return [hits.length ? hits : cmds, line];
      }
      const partial = line.slice("/model ".length);
      const hits = catalogue.map((m) => m.id).filter((id) => id.startsWith(partial));
      return [hits.map((id) => `/model ${id}`), line];
    },
  });

  console.log(pc.dim(`\n  ${session.model}  ·  /help for commands, /exit to leave\n`));

  let inFlight: AbortController | null = null;
  let pending = "";

  // Ctrl-C aborts the reply being streamed; on an idle prompt it exits. Anything
  // else would make a long answer unstoppable without killing the session.
  rl.on("SIGINT", () => {
    if (inFlight) {
      inFlight.abort();
      inFlight = null;
      process.stdout.write(pc.dim("\n  (stopped)\n"));
      rl.prompt();
      return;
    }
    if (rl.line.length > 0 || pending) {
      pending = "";
      // @ts-expect-error readline exposes no public clear-line
      rl.line = "";
      process.stdout.write("\n");
      rl.prompt();
      return;
    }
    rl.close();
  });

  const finish = async () => {
    await saveHistory((rl as unknown as { history: string[] }).history ?? []);
    if (session.turns > 0) {
      process.stderr.write(
        pc.dim(
          `\n  ${session.turns} message${session.turns === 1 ? "" : "s"} · ` +
            `${trimNumber(session.credits)} credits this session\n`,
        ),
      );
    }
  };

  rl.prompt();

  for await (const line of rl) {
    // Backslash continuation, so a pasted block or a long thought can span lines.
    if (line.endsWith("\\")) {
      pending += line.slice(0, -1) + "\n";
      process.stdout.write(pc.dim("  … "));
      continue;
    }
    const input = (pending + line).trim();
    pending = "";

    if (!input) {
      rl.prompt();
      continue;
    }

    if (input.startsWith("/")) {
      const done = await handleCommand(input, session, catalogue, streamable, rl);
      if (done) break;
      rl.prompt();
      continue;
    }

    session.messages.push({ role: "user", content: input });
    // Held locally as well: the SIGINT handler clears `inFlight` the moment it
    // aborts, so by the time the catch below runs there is nothing left to ask
    // whether this was a cancellation or a real failure.
    const controller = new AbortController();
    inFlight = controller;
    let reply = "";
    let cost: CostInfo | undefined;

    try {
      process.stdout.write("\n");
      cost = await streamChat(
        profile,
        {
          model: session.model,
          messages: session.messages,
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          signal: controller.signal,
        },
        (delta) => {
          reply += delta;
          process.stdout.write(delta);
        },
      );
      process.stdout.write("\n");
    } catch (err) {
      inFlight = null;
      if (controller.signal.aborted) {
        // Keep the partial reply in context: the next message usually refers to it.
        if (reply) session.messages.push({ role: "assistant", content: reply });
        else session.messages.pop();
        rl.prompt();
        continue;
      }
      session.messages.pop();
      console.error(warn(`${(err as Error).message}`));
      rl.prompt();
      continue;
    }
    inFlight = null;

    session.messages.push({ role: "assistant", content: reply });
    session.turns++;
    if (cost?.credits != null) session.credits += cost.credits;
    if (options.showCost && cost) {
      process.stderr.write(pc.dim(formatCost(cost)) + "\n");
    }
    process.stdout.write("\n");
    rl.prompt();
  }

  await finish();
}

/** Returns true when the session should end. */
async function handleCommand(
  input: string,
  session: Session,
  catalogue: ModelInfo[],
  streamable: Set<string>,
  rl: readline.Interface,
): Promise<boolean> {
  const [command, ...rest] = input.split(/\s+/);
  const argument = rest.join(" ").trim();

  switch (command) {
    case "/exit":
    case "/quit":
      rl.close();
      return true;

    case "/help":
      console.log(HELP);
      return false;

    case "/model": {
      if (!argument) {
        console.log(pc.dim(`  ${session.model}`));
        return false;
      }
      const known = catalogue.find((m) => m.id === argument);
      if (catalogue.length > 0 && !known) {
        console.log(warn(`"${argument}" is not a chat model here. /models to see them.`));
        return false;
      }
      session.model = argument;
      // Switching mid-conversation keeps the history: that is the point of it.
      const streams = streamable.size === 0 || streamable.has(argument);
      console.log(
        pc.dim(
          `  switched to ${argument}` +
            (streams ? "" : pc.yellow(" (no streaming — replies arrive all at once)")),
        ),
      );
      return false;
    }

    case "/models": {
      if (catalogue.length === 0) {
        console.log(warn("Could not read the model catalogue."));
        return false;
      }
      // Ranked by estimated cost of a chat-shaped turn, not by whichever number
      // the catalogue happens to publish: `credits` (flat) and `pricing` (per
      // million tokens) are not comparable, and sorting them together is
      // meaningless.
      const rows = rankByCost(catalogue, CHAT_TURN).slice(0, 20);
      for (const m of rows) {
        const est = `~${trimNumber(Math.round(estimateCredits(m, CHAT_TURN) * 1000) / 1000)} cr`;
        const here = m.id === session.model ? pc.green(" ←") : "";
        const streams = streamable.size === 0 || streamable.has(m.id) ? "" : pc.dim(" (sync)");
        console.log(`  ${m.id.padEnd(34)}${pc.dim(est.padEnd(12))}${streams}${here}`);
      }
      console.log(pc.dim("  estimated for a typical turn — /model <id> to switch"));
      return false;
    }

    case "/cost":
      console.log(
        pc.dim(
          `  ${session.turns} message${session.turns === 1 ? "" : "s"} · ` +
            `${trimNumber(session.credits)} credits · $${trimNumber(session.credits / 100)}`,
        ),
      );
      return false;

    case "/system": {
      if (!argument) {
        console.log(pc.dim(`  ${session.system ?? "(none)"}`));
        return false;
      }
      session.system = argument;
      session.messages = [{ role: "system", content: argument }];
      console.log(pc.dim("  system prompt set — conversation reset"));
      return false;
    }

    case "/clear":
      session.messages = session.system ? [{ role: "system", content: session.system }] : [];
      session.turns = 0;
      session.credits = 0;
      console.log(pc.dim("  conversation cleared"));
      return false;

    case "/save": {
      const file = argument || "curvet-chat.md";
      const body = session.messages
        .filter((m) => m.role !== "system")
        .map((m) => `## ${m.role}\n\n${m.content}`)
        .join("\n\n");
      await fs.writeFile(file, `# ${session.model}\n\n${body}\n`);
      console.log(pc.dim(`  saved ${file}`));
      return false;
    }

    default:
      console.log(warn(`Unknown command ${command}. /help for the list.`));
      return false;
  }
}
