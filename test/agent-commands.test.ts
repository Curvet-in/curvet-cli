import { describe, expect, it } from "vitest";
import { COMMANDS, completions, helpText, isCommand, parseCommand } from "../src/agent/commands.js";

/**
 * Slash commands.
 *
 * The rule these exist to hold: nothing is offered that does not work. A picker
 * listing a command the session answers "not implemented" to is worse than no
 * picker, because it is the list people learn the tool from.
 */

describe("parsing", () => {
  it("tells a command from a message", () => {
    expect(isCommand("/status")).toBe(true);
    expect(isCommand("  /status")).toBe(true);
    expect(isCommand("what is /etc/hosts")).toBe(false);
    expect(isCommand("")).toBe(false);
  });

  it("splits the name from its argument", () => {
    expect(parseCommand("/model claude-sonnet-4-6")).toMatchObject({
      name: "model",
      arg: "claude-sonnet-4-6",
      known: true,
    });
    expect(parseCommand("/cost")).toMatchObject({ name: "cost", arg: "", known: true });
  });

  it("keeps the whole argument, spaces and all", () => {
    expect(parseCommand("/undo run_abc def").arg).toBe("run_abc def");
  });

  it("is case-insensitive on the name", () => {
    expect(parseCommand("/STATUS").known).toBe(true);
  });

  it("marks an unknown command rather than guessing at one", () => {
    // Guessing would run something the user did not type.
    expect(parseCommand("/deploy").known).toBe(false);
  });
});

describe("the picker", () => {
  it("offers everything for a bare slash — that is how anyone finds out what exists", () => {
    expect(completions("/")).toHaveLength(COMMANDS.length);
  });

  it("narrows as you type", () => {
    const names = completions("/mo").map((c) => c.name);
    expect(names).toEqual(["model"]);
  });

  it("stops once an argument is being typed", () => {
    // The command is settled by then; suggestions would only be in the way.
    expect(completions("/model ")).toHaveLength(0);
    expect(completions("/model claude")).toHaveLength(0);
  });

  it("offers nothing for ordinary text", () => {
    expect(completions("summarise my email")).toHaveLength(0);
  });

  it("offers nothing when nothing matches", () => {
    expect(completions("/zzz")).toHaveLength(0);
  });
});

describe("the list itself", () => {
  it("describes every command in /help", () => {
    const help = helpText();
    for (const c of COMMANDS) expect(help, c.name).toContain(`/${c.name}`);
  });

  it("promises nothing it cannot do", () => {
    // The property that matters: a picker listing a command the session answers
    // "not implemented" to is worse than no picker, because the list is what
    // people learn the tool from. (Length is not the test — "leave" is a
    // perfectly good summary for /exit.)
    for (const c of COMMANDS) {
      expect(c.summary.trim(), c.name).not.toBe("");
      expect(c.summary, c.name).not.toMatch(/TODO|coming soon|not implemented|wip/i);
    }
  });

  it("has no duplicates, which would make the picker ambiguous", () => {
    expect(new Set(COMMANDS.map((c) => c.name)).size).toBe(COMMANDS.length);
  });
});
