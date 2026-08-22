/**
 * Slash commands.
 *
 * Every one of these does something the session or agency can actually do —
 * nothing is listed that would answer "not implemented". Where a command reports
 * server state (`/status`), it asks the server rather than printing what the
 * client assumed at startup, because the two drift and the client's copy is the
 * one that is wrong.
 *
 * Parsing lives here, away from the renderer, so it can be tested without a
 * terminal and so the desktop client gets the same vocabulary for free.
 */

export interface SlashCommand {
  name: string;
  /** Shown in the picker and in /help. */
  summary: string;
  /** Argument hint, when it takes one. */
  arg?: string;
}

export const COMMANDS: SlashCommand[] = [
  { name: "help", summary: "what these commands do" },
  { name: "model", summary: "show or switch the orchestrator model", arg: "[id]" },
  { name: "status", summary: "what this server has enabled — agents, memory, connectors" },
  { name: "tools", summary: "what the agent may do on this machine" },
  { name: "cost", summary: "what this session has spent" },
  { name: "runs", summary: "recent runs on your account" },
  { name: "log", summary: "what the agent has read and written here" },
  { name: "undo", summary: "put back the files this session changed" },
  { name: "clear", summary: "start a fresh conversation, keeping the window" },
  { name: "exit", summary: "leave" },
];

export interface ParsedCommand {
  name: string;
  arg: string;
  known: boolean;
}

/** Is this input a slash command rather than a message? */
export function isCommand(input: string): boolean {
  return /^\s*\//.test(input);
}

/** Split `/model claude-sonnet-4-6` into its name and argument. */
export function parseCommand(input: string): ParsedCommand {
  const body = input.trim().replace(/^\//, "");
  const space = body.indexOf(" ");
  const name = (space === -1 ? body : body.slice(0, space)).toLowerCase();
  const arg = space === -1 ? "" : body.slice(space + 1).trim();
  return { name, arg, known: COMMANDS.some((c) => c.name === name) };
}

/**
 * Commands matching what has been typed so far, for the picker.
 *
 * `/` alone offers everything — that is how someone finds out what exists, and
 * it is the reason the list is worth keeping short and real.
 */
export function completions(input: string): SlashCommand[] {
  if (!isCommand(input)) return [];
  const { name, arg } = parseCommand(input);
  // Once an argument is being typed the command is settled; stop suggesting.
  if (arg || /\s$/.test(input)) return [];
  return COMMANDS.filter((c) => c.name.startsWith(name));
}

/** The line `/help` prints. */
export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length + (c.arg ? c.arg.length + 1 : 0)));
  return COMMANDS.map((c) => {
    const label = `/${c.name}${c.arg ? ` ${c.arg}` : ""}`;
    return `${label.padEnd(width + 2)}${c.summary}`;
  }).join("\n");
}
