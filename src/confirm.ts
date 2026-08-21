import pc from "picocolors";

/**
 * Ask before doing something that cannot be taken back.
 *
 * Two rules make this safe rather than decorative:
 *
 * 1. `--yes` skips it, because CI has nobody to ask.
 * 2. A non-TTY stdin **refuses** rather than assuming yes. `curvet apps delete`
 *    in a pipeline with no `--yes` should stop, not destroy an app because
 *    nobody was there to answer. Defaulting to yes is how a confirmation
 *    prompt becomes a rubber stamp.
 */
export async function confirm(
  question: string,
  opts: { yes?: boolean; detail?: string } = {},
): Promise<void> {
  if (opts.yes) return;

  if (!process.stdin.isTTY) {
    throw new Error(
      `${question}\n  Refusing to assume an answer without a terminal. Re-run with --yes if you mean it.`,
    );
  }

  if (opts.detail) process.stderr.write(pc.dim(opts.detail) + "\n");
  process.stderr.write(`${question} ${pc.dim("[y/N]")} `);

  const answer = await readLine();
  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new Error("Cancelled.");
  }
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      stdin.off("data", onData);
      stdin.pause();
      resolve(chunk);
    };
    stdin.on("data", onData);
  });
}
