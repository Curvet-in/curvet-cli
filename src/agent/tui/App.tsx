import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { AgentSession, SessionState, Approval } from "../session.js";
import type { DiffLine } from "../diff.js";

/**
 * The full-screen session.
 *
 * Purely a renderer: everything it shows comes from AgentSession, and everything
 * it does goes back through `send`, `answer` and `abort`. That separation is
 * what lets the same engine sit behind a desktop app later, and it is also why
 * approvals are state here rather than a stdin read — the session parks and
 * publishes what it is waiting for, and this decides how to ask.
 *
 * Colours are chosen for the same reasons as the inline renderer's: the default
 * foreground for what the agent says (the only colour legible on a light
 * terminal and a dark one), weight rather than hue for what matters, and the
 * ACP-ish notion that a call should read by what it DOES.
 */

interface Props {
  session: AgentSession;
  cwd: string;
  toolsEnabled: boolean;
  model: string;
}

/** Rough wrap so a pane's text does not spill past its column. */
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
        // A single word longer than the pane (a URL, a path) is cut rather than
        // allowed to break the layout.
        line = word.length > width ? word.slice(0, width) : word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function DiffView({ lines, width }: { lines: DiffLine[]; width: number }) {
  return (
    <>
      {lines.map((l, i) => {
        const body = l.text.length > width - 3 ? `${l.text.slice(0, width - 4)}…` : l.text;
        if (l.kind === "add") return <Text key={i} color="green">{`+ ${body}`}</Text>;
        if (l.kind === "del") return <Text key={i} color="red">{`- ${body}`}</Text>;
        return <Text key={i} dimColor>{`  ${body}`}</Text>;
      })}
    </>
  );
}

/** What the session is parked on, and how to answer it. */
function ApprovalPrompt({ pending, width }: { pending: Approval; width: number }) {
  if (pending.kind === "write") {
    const shown = pending.diff.hunks.flatMap((h) => h.lines).slice(0, 14);
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          {pending.creating ? "Create" : "Change"} {pending.path}
          <Text dimColor>{`  +${pending.diff.added} −${pending.diff.removed}`}</Text>
        </Text>
        <DiffView lines={shown} width={width} />
        <Text dimColor>{"y to apply · n to decline · esc to stop"}</Text>
      </Box>
    );
  }
  if (pending.kind === "ask_user") {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          {pending.prompt}
        </Text>
        {pending.options?.length ? <Text dimColor>{pending.options.join("  ·  ")}</Text> : null}
        <Text dimColor>type an answer and press enter</Text>
      </Box>
    );
  }
  if (pending.kind === "read") {
    // A read the policy would otherwise wave through, or one outside the project.
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          {pending.title}
        </Text>
        {pending.detail ? <Text dimColor>{pending.detail}</Text> : null}
        <Text dimColor>{"y to allow · n to decline · esc to stop"}</Text>
      </Box>
    );
  }

  const warning = pending.kind === "confirm" ? pending.warning : undefined;
  return (
    <Box flexDirection="column">
      <Text bold color={pending.kind === "confirm" ? "red" : "yellow"}>
        {pending.kind === "confirm" ? "Approve this action?" : "Approve this plan?"}
      </Text>
      {wrap(pending.prompt, width).slice(0, 8).map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
      {pending.kind === "plan" && pending.steps
        ? pending.steps.slice(0, 6).map((s, i) => (
            <Text key={i} dimColor>{`  · ${s.agent}: ${s.task}`}</Text>
          ))
        : null}
      {warning ? <Text color="red">{warning}</Text> : null}
      <Text dimColor>{"y to allow · n to decline · esc to stop"}</Text>
    </Box>
  );
}

export default function App({ session, cwd, toolsEnabled, model }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<SessionState>(() => session.snapshot());
  const [input, setInput] = useState("");
  const [started] = useState(Date.now());
  const [now, setNow] = useState(Date.now());

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
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // `||` and not `??`: a pty created without a window size reports 0, not
  // undefined, so `?? 100` leaves width at zero and the whole UI renders
  // invisibly with nothing to explain why. Some CI runners and multiplexers do
  // exactly this. Floors keep a genuinely tiny terminal usable rather than
  // broken.
  const cols = Math.max(40, size.columns || 100);
  const rows = Math.max(12, size.rows || 30);
  // Below this the two-column layout leaves nothing readable in either column,
  // so the side pane goes and the conversation gets the whole width.
  const wide = cols >= 76;
  const sideWidth = wide ? Math.max(24, Math.min(38, Math.floor(cols * 0.34))) : 0;
  const mainWidth = Math.max(20, cols - sideWidth - 4);
  const bodyHeight = Math.max(6, rows - 6);

  const answering = state.pending?.kind === "ask_user";

  const submit = (text: string) => {
    const trimmed = text.trim();
    setInput("");
    if (answering) session.answer(true, trimmed);
    else if (trimmed) void session.send(trimmed);
  };

  useInput((char, key) => {
    if (key.escape) {
      if (state.status === "thinking" || state.status === "awaiting-approval") session.abort();
      return;
    }
    if (key.ctrl && char === "c") {
      if (state.status === "idle") exit();
      else session.abort();
      return;
    }

    // While parked on a yes/no, the keyboard answers it rather than typing.
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

    // A keypress is not always one key. Typing delivers one character at a time,
    // but PASTING delivers the whole clipboard in a single chunk — and so does
    // anything driving this over a pty. ink reports Enter as key.return only for
    // a lone CR, so a pasted line ending in a newline would otherwise land in the
    // buffer as an invisible character and never submit, leaving a UI you cannot
    // send anything from with nothing on screen to say why.
    //
    // So: split the chunk on newlines. Everything before the last one is typed;
    // a trailing newline submits.
    const endsWithNewline = /[\r\n]$/.test(char);
    const printable = [...char.replace(/[\r\n]+/g, " ")]
      .filter((c) => c >= " " && c !== "\u007f")
      .join("")
      .trimEnd();

    if (endsWithNewline || key.return) {
      submit(`${input}${printable}`);
      return;
    }
    if (printable) setInput((v) => v + printable);
  });

  // The conversation, flattened to lines and windowed to what fits. Rendering
  // only the tail is what keeps a long session from re-laying-out every frame.
  const transcript = useMemo(() => {
    const lines: { text: string; role: "user" | "agent" }[] = [];
    for (const m of state.messages) {
      for (const l of wrap(m.text, mainWidth)) lines.push({ text: l, role: m.role });
      lines.push({ text: "", role: m.role });
    }
    if (state.streaming) {
      for (const l of wrap(state.streaming, mainWidth)) lines.push({ text: l, role: "agent" });
    }
    return lines.slice(-bodyHeight);
  }, [state.messages, state.streaming, mainWidth, bodyHeight]);

  const elapsed = Math.floor((now - started) / 1000);
  const clock = `${Math.floor(elapsed / 60)}m${String(elapsed % 60).padStart(2, "0")}s`;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Text bold color="cyan">
          curvet agent
        </Text>
        <Text dimColor>
          {model} · {state.turns} turn{state.turns === 1 ? "" : "s"} · ${state.costUsd.toFixed(4)} · {clock}
        </Text>
      </Box>

      <Box flexGrow={1}>
        <Box flexDirection="column" width={mainWidth + 2} paddingX={1} overflow="hidden">
          {transcript.length === 0 ? (
            <Box flexDirection="column">
              <Text dimColor>{toolsEnabled ? `reading ${cwd}` : "no file access — run inside a project, or --tools"}</Text>
              <Text dimColor>Ask for something. Esc stops a turn, Ctrl-C leaves.</Text>
            </Box>
          ) : (
            transcript.map((l, i) =>
              l.role === "user" ? (
                <Text key={i} color="cyan">{l.text ? `› ${l.text}` : ""}</Text>
              ) : (
                <Text key={i}>{l.text}</Text>
              ),
            )
          )}
        </Box>

        {wide ? (
        <Box flexDirection="column" width={sideWidth} borderStyle="round" borderColor="gray" paddingX={1}>
          <Text dimColor>TOOLS</Text>
          {state.tools.length === 0 ? (
            <Text dimColor>—</Text>
          ) : (
            state.tools.slice(-Math.max(4, Math.floor(bodyHeight / 2))).map((t) => (
              <Text key={t.id} wrap="truncate">
                <Text color={t.status === "failed" ? "red" : t.status === "ok" ? "green" : "yellow"}>
                  {t.status === "failed" ? "✖" : t.status === "ok" ? "✓" : "·"}
                </Text>
                <Text color={t.where === "local" ? "magenta" : undefined}>{` ${t.title}`}</Text>
              </Text>
            ))
          )}

          {state.lastDiff ? (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>DIFF · {state.lastDiff.path}</Text>
              <DiffView
                lines={state.lastDiff.diff.hunks.flatMap((h) => h.lines).slice(0, Math.max(3, Math.floor(bodyHeight / 3)))}
                width={sideWidth - 2}
              />
            </Box>
          ) : null}
        </Box>
        ) : null}
      </Box>

      <Box
        borderStyle="round"
        borderColor={state.pending ? "yellow" : state.error ? "red" : "gray"}
        paddingX={1}
        flexDirection="column"
      >
        {state.error ? <Text color="red">{state.error}</Text> : null}
        {state.pending ? (
          <ApprovalPrompt pending={state.pending} width={cols - 6} />
        ) : (
          <Text>
            <Text color="cyan">› </Text>
            {input}
            <Text dimColor>{state.status === "idle" ? "▌" : ""}</Text>
          </Text>
        )}
        {!state.pending && state.status !== "idle" ? (
          <Text dimColor>{state.statusLine || "working…"} — esc to stop</Text>
        ) : null}
      </Box>
    </Box>
  );
}
