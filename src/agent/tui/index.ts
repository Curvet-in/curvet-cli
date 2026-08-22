import type { AgentSession } from "../session.js";

/**
 * Start the full-screen session.
 *
 * Everything ink touches lives behind this dynamic import. ink pulls React and a
 * reconciler — roughly as much again as the rest of this CLI — and loading that
 * on `curvet balance` would make every command slower for a mode most runs never
 * open. Same pattern `curvet mcp` uses for the MCP SDK.
 */
export async function runTui(opts: {
  session: AgentSession;
  cwd: string;
  toolsEnabled: boolean;
  model: string;
  git: { branch: string | null; files: number } | null;
  onCommand: (name: string, arg: string) => Promise<string | null>;
}): Promise<void> {
  const [{ render }, React, { default: App }] = await Promise.all([
    import("ink"),
    import("react"),
    import("./App.js"),
  ]);

  // Declared first so onExit can close over it: the component needs a way to
  // quit, and the instance does not exist until render() returns.
  let instance: ReturnType<typeof render>;
  // eslint-disable-next-line prefer-const
  instance = render(
    React.createElement(App, {
      session: opts.session,
      cwd: opts.cwd,
      toolsEnabled: opts.toolsEnabled,
      model: opts.model,
      git: opts.git,
      onCommand: opts.onCommand,
      onExit: () => instance.unmount(),
    }),
    // The alternate screen is ink's default via its own fullscreen handling; we
    // let it own the terminal and simply wait for it to finish.
    { exitOnCtrlC: false },
  );

  await instance.waitUntilExit();
}
