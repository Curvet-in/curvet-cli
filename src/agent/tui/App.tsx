import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import path from "node:path";
import type { AgentSession, SessionState, Approval, Entry } from "../session.js";
import type { DiffLine } from "../diff.js";

/**
 * The full-screen session.
 *
 * Purely a renderer: everything it shows comes from AgentSession, and everything
 * it does goes back through `send`, `answer` and `abort`. That separation is what
 * lets the same engine sit behind a desktop app later, and it is why an approval
 * is state here rather than a stdin read — the session parks and publishes what
 * it is waiting for, and this decides how to ask.
 *
 * ── The shape, and where it came from ───────────────────────────────────────
 *
 * One column, not panes. This began as a conversation pane with a tool timeline
 * and a diff pane beside it; reading Cline's CLI made the case for the simpler
 * thing, and it is right for three reasons:
 *
 *   • A tool call belongs where the agent made it. In a side pane it loses the
 *     conversation it was part of, and the reader has to reconstruct an order
 *     nobody gave them.
 *   • A side pane takes width from the only thing anyone reads. On an 80-column
 *     terminal, a third of it leaves neither column comfortable.
 *   • The approval REPLACES the input, so it appears exactly where attention
 *     already is, and there is nothing to type past.
 *
 * Colours follow the inline renderer's rules: unstyled for what the agent says
 * (the only colour legible on a light terminal and a dark one), weight rather
 * than hue for what matters, grey — never `dim` — for chrome.
 */

interface Props {
  session: AgentSession;
  cwd: string;
  toolsEnabled: boolean;
  model: string;
  /** Branch and changed-file count, when this is a git repo. */
  git: { branch: string | null; files: number } | null;
}

/**
 * What a chunk of terminal input means.
 *
 * Separated from the component so it can be tested without a terminal, which is
 * how the space-bar bug should have been caught: a lone " " is a keystroke like
 * any other, and trimming it away left a UI you could type in but never put a
 * gap between two words in.
 *
 * A keypress is not always one key. Typing delivers a character at a time;
 * PASTING delivers the whole clipboard at once, and so does anything driving
 * this over a pty. ink reports Enter as key.return only for a lone CR, so a
 * pasted line ending in a newline has to be recognised here, or it lands in the
 * buffer as an invisible character that can never be typed out.
 */
export function readChunk(char: string): { text: string; submit: boolean } {
  const submit = /[\r\n]$/.test(char);
  // A TRAILING newline is the submit signal, not content, so it is dropped.
  // Newlines INSIDE a paste become spaces — a multi-line prompt is still one
  // message, and a raw newline in a single-line input breaks the line it lands on.
  const body = submit ? char.replace(/[\r\n]+$/, "") : char;
  return {
    submit,
    text: [...body.replace(/[\r\n]+/g, " ")].filter((c) => c >= " " && c !== "\u007f").join(""),
  };
}

/** Wrap to a column, cutting a single over-long word rather than breaking out. */
function wrap(text: string, width: number): string[] {
  if (width < 8) return [text];
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (line.length + word.length + 1 > width) {
        if (line) out.push(line);
        line = word.length > width ? word.slice(0, width) : word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function DiffLines({ lines, width }: { lines: DiffLine[]; width: number }) {
  return (
    <>
      {lines.map((l, i) => {
        const body = l.text.length > width ? `${l.text.slice(0, Math.max(1, width - 1))}…` : l.text;
        if (l.kind === "add") return <Text key={i} color="green">{`  + ${body}`}</Text>;
        if (l.kind === "del") return <Text key={i} color="red">{`  - ${body}`}</Text>;
        return <Text key={i} color="gray">{`    ${body}`}</Text>;
      })}
    </>
  );
}

/** Does this summary tell the reader anything the title has not already? */
function isEmptySummary(detail: string, name: string): boolean {
  const d = detail.trim().toLowerCase();
  return d === "ok" || d === `${name.toLowerCase()} ok` || d === name.toLowerCase();
}

/** A tool call, in the transcript, at the point it happened. */
function ToolEntry({ entry, width }: { entry: Extract<Entry, { kind: "tool" }>; width: number }) {
  const mark = entry.status === "failed" ? "✖" : entry.status === "ok" ? "✓" : "·";
  const markColor = entry.status === "failed" ? "red" : entry.status === "ok" ? "green" : "yellow";
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text color={markColor}>{mark}</Text>
        {/* Local calls touched this machine — worth telling apart at a glance. */}
        <Text color={entry.where === "local" ? "magenta" : "cyan"}>{` ${entry.title}`}</Text>
        {/* Only when it adds something. A successful call whose summary is just
            "<tool> ok" repeats the title and buries the ones that do say
            something — "4 results", "blocked: non-public address". */}
        {entry.detail && !isEmptySummary(entry.detail, entry.name) ? (
          <Text color="gray">{`  ${entry.detail}`}</Text>
        ) : null}
      </Text>
      {entry.diff ? (
        <DiffLines lines={entry.diff.hunks.flatMap((h) => h.lines).slice(0, 12)} width={width - 6} />
      ) : null}
    </Box>
  );
}

/** What the session is parked on. Rendered where the input normally is. */
function ApprovalPrompt({ pending, width }: { pending: Approval; width: number }) {
  if (pending.kind === "write") {
    const all = pending.diff.hunks.flatMap((h) => h.lines);
    const shown = all.slice(0, 16);
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold color="yellow">{`${pending.creating ? "Create" : "Change"} ${pending.path}`}</Text>
          <Text color="gray">{`  +${pending.diff.added} −${pending.diff.removed}`}</Text>
        </Text>
        <DiffLines lines={shown} width={width - 6} />
        {all.length > shown.length ? (
          <Text color="gray">{`    … ${all.length - shown.length} more lines`}</Text>
        ) : null}
        <Text color="gray">y apply · n decline · esc stop</Text>
      </Box>
    );
  }
  if (pending.kind === "ask_user") {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">{pending.prompt}</Text>
        {pending.options?.length ? <Text color="gray">{pending.options.join("  ·  ")}</Text> : null}
        <Text color="gray">type an answer, then enter</Text>
      </Box>
    );
  }
  if (pending.kind === "read") {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">{pending.title}</Text>
        {pending.detail ? <Text color="gray">{pending.detail}</Text> : null}
        <Text color="gray">y allow · n decline · esc stop</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold color={pending.kind === "confirm" ? "red" : "yellow"}>
        {pending.kind === "confirm" ? "Approve this action?" : "Approve this plan?"}
      </Text>
      {wrap(pending.prompt, width - 2)
        .slice(0, 8)
        .map((l, i) => (
          <Text key={i}>{l}</Text>
        ))}
      {pending.kind === "plan" && pending.steps
        ? pending.steps.slice(0, 6).map((s, i) => <Text key={i} color="gray">{`  · ${s.agent}: ${s.task}`}</Text>)
        : null}
      {pending.kind === "confirm" && pending.warning ? <Text color="red">{pending.warning}</Text> : null}
      <Text color="gray">y allow · n decline · esc stop</Text>
    </Box>
  );
}

export default function App({ session, cwd, toolsEnabled, model, git }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<SessionState>(() => session.snapshot());
  const [input, setInput] = useState("");
  const [size, setSize] = useState({ columns: stdout?.columns ?? 0, rows: stdout?.rows ?? 0 });

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    onResize();
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  useEffect(() => session.subscribe(setState), [session]);

  // `||` and not `??`: a pty created without a window size reports 0, not
  // undefined, so `?? 100` leaves the width at zero and the whole UI renders
  // invisibly with nothing to explain why. Some CI runners and multiplexers do
  // exactly that. The floors keep a genuinely tiny terminal usable.
  const cols = Math.max(40, size.columns || 100);
  const rows = Math.max(12, size.rows || 30);
  const width = cols - 2;

  const answering = state.pending?.kind === "ask_user";

  const submit = (text: string) => {
    const trimmed = text.trim();
    setInput("");
    if (answering) session.answer(true, trimmed);
    else if (trimmed) void session.send(trimmed);
  };

  useInput((char, key) => {
    if (key.escape) {
      if (state.status !== "idle") session.abort();
      return;
    }
    if (key.ctrl && char === "c") {
      if (state.status === "idle") exit();
      else session.abort();
      return;
    }
    // Parked on a yes/no: the keyboard answers rather than types.
    if (state.pending && !answering) {
      if (char === "y" || char === "Y") session.answer(true);
      else if (char === "n" || char === "N") session.answer(false);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
      return;
    }
    if (!char || key.ctrl || key.meta) {
      if (key.return) submit(input);
      return;
    }
    const { text: printable, submit: isSubmit } = readChunk(char);
    if (isSubmit || key.return) {
      submit(`${input}${printable}`);
      return;
    }
    if (printable) setInput((v) => v + printable);
  });

  // Only the tail is rendered, so a long session does not re-lay-out everything
  // on every frame. The approval takes more room, so the transcript yields it.
  const bodyHeight = Math.max(4, rows - (state.pending ? 14 : 5));
  const lines = useMemo(() => {
    const out: React.ReactNode[] = [];
    for (const e of state.entries) {
      if (e.kind === "user") {
        for (const l of wrap(e.text, width - 2)) {
          out.push(
            <Text key={`${e.id}-${out.length}`} color="cyan">{`› ${l}`}</Text>,
          );
        }
      } else if (e.kind === "agent") {
        for (const l of wrap(e.text, width)) out.push(<Text key={`${e.id}-${out.length}`}>{l}</Text>);
      } else {
        out.push(<ToolEntry key={e.id} entry={e} width={width} />);
      }
      out.push(<Text key={`gap-${e.id}-${out.length}`}> </Text>);
    }
    if (state.streaming) {
      for (const l of wrap(state.streaming, width)) out.push(<Text key={`s-${out.length}`}>{l}</Text>);
    }
    return out.slice(-bodyHeight);
  }, [state.entries, state.streaming, width, bodyHeight]);

  const project = path.basename(cwd);
  const dirty = git?.files ? ` ${git.files} changed` : "";
  const branch = git?.branch ? `  ⎇ ${git.branch}${dirty}` : "";
  const spent = state.costUsd > 0 ? ` · $${state.costUsd.toFixed(4)}` : "";
  const busy = state.status === "thinking" || state.status === "aborting";

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
        {lines.length === 0 ? (
          <Box flexDirection="column">
            <Text color="gray">
              {toolsEnabled
                ? `Reading and editing ${project}. Every change is shown before it is made.`
                : "No file access here — run inside a project, or pass --tools."}
            </Text>
            <Text color="gray">Esc stops a turn · Ctrl-C leaves</Text>
          </Box>
        ) : (
          lines
        )}
      </Box>

      <Box flexDirection="column" flexShrink={0} paddingX={1}>
        {state.error ? <Text color="red">{state.error}</Text> : null}

        {state.pending ? (
          <ApprovalPrompt pending={state.pending} width={width} />
        ) : (
          <Text>
            <Text color="cyan">{"› "}</Text>
            {input ? (
              <Text>{input}</Text>
            ) : (
              <Text color="gray">{busy ? state.statusLine || "working…" : "Ask anything"}</Text>
            )}
            {!busy ? <Text color="gray">▌</Text> : null}
          </Text>
        )}

        {/* Last line, always: the things you check without looking — where you
            are, what it has cost — belong in one fixed place. */}
        <Text color="gray" wrap="truncate">
          {`${model}${spent} · ${state.turns} turn${state.turns === 1 ? "" : "s"} · ${project}${branch}`}
          {toolsEnabled ? "" : " · read-only"}
          {busy ? " · esc to stop" : ""}
        </Text>
      </Box>
    </Box>
  );
}
