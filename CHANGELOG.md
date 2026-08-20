# Changelog

All notable changes to `@curvet/cli` are documented here.

## 0.4.0

One release covering three things: the distribution commands that let other
tools run on Curvet, enterprise administration, and a model-capability fix that
closes a live footgun.

Requires `@curvet/sdk` >= 0.7.0.

### Distribution — get Curvet into the tools people already use

- **`curvet init <tool>`** — writes a coding tool's config from the live model
  catalogue. `opencode` and `zed` are merged into on disk, `vscode` writes
  Copilot Chat's `chatLanguageModels.json`, and `cline` prints the values to
  type in. Ported from the emitters behind the developer-portal setup page, so
  the two surfaces cannot drift.
  - Merging is surgical: only the `curvet` subtree is written, the old file is
    kept as `.bak`, and a JSONC file (comments, trailing commas) is left
    untouched with the block printed instead — rewriting it would silently strip
    the comments.
  - The app key never reaches stdout unless `--inline-key` is passed. Configs
    reference `{env:CURVET_APP_KEY}` and the verification `curl` uses
    `$CURVET_APP_KEY`.
  - `--print`, `-o`, and `--prompt` (a prompt for an AI assistant, carrying the
    real model ids and rates as data).
- **`curvet proxy`** — a loopback OpenAI-compatible endpoint that injects your
  key, so any OpenAI client bills to Curvet without holding a credential.
  Serves `/chat/completions` and `/models` with or without the `/v1` prefix;
  streams are piped through as they arrive. Verified against the real `openai`
  npm package. `--host` widens the bind and warns that it does.
- **`curvet mcp`** — Curvet as an MCP server over stdio, so
  `claude mcp add curvet -- curvet mcp` is the whole setup. 14 tools covering
  models, chat, image/video/audio/3d, transcription, jobs, workflows, balance
  and analytics. Media tools return a `jobId` rather than holding a tool call
  open for minutes. Every tool declares an input schema and says whether it
  spends credits, and every result reports its cost.

  This is a server over the public API rather than a bridge to the platform's
  own MCP server, which imports backend services directly and only runs inside a
  checkout of that repo.

### Enterprise administration

`curvet ent` needs an enterprise key; everything below is unavailable with an
app key alone.

- `curvet ent overview` — pool balance, credits allocated to members, spend this
  month, seats, and the member table.
- `curvet ent members list|set-credits|set-limit|pool-access|set-role|remove`.
- `curvet ent invite create|bulk|list|revoke`.

Two things the API makes awkward and the CLI now handles for you:

- **Members are keyed by Firebase UID**, which nobody knows. Every member
  command takes an email and resolves it against the member list. A raw UID
  still works, so `--json` output from one command feeds the next. An address
  matching two members is an error, not a guess — acting on the wrong one moves
  someone else's credits.
- **Pool access is tri-state.** `on` and `off` set it explicitly; `inherit`
  clears the setting so the role decides (admins draw the pool, plain members
  don't). Listings show the effective value and mark it `(inherited)` when
  nothing was set.

`set-credits` takes a signed amount, so `set-credits ava@acme.com -- -100` and
`set-credits ava@acme.com -100` both reclaim. The bare form needs Commander to
stop reading a leading `-` as an option, which is opted into on that one
subcommand; a guard rejects any other unexpected token, so a mistyped flag on a
command that moves credits still fails loudly rather than being ignored.

`invite bulk` exists because a token is returned **once** — only a SHA-256 hash
is kept — so a bulk run that dies halfway has destroyed every link it created.
Each row is written to the output CSV and flushed before the next request goes
out, a failed row is recorded with its reason rather than aborting the rest, and
`--dry-run` parses the file without creating anything.

### Model capability, and speech-to-text

- `curvet stt <file>` — transcribe an audio file. Text on stdout, cost line on
  stderr, `-o` to write it to a file, `--json` for the full result with
  segments. `--language`, `--prompt`, `--provider` and `--allow-fallback` are
  passed through; when a fallback actually happens the CLI names the engine that
  ran instead of reporting the one you asked for. Files are size-checked against
  the 10 MB upload limit and labelled with a real audio MIME type, since the ASR
  providers branch on it.
- **`curvet models` shows what a model does, not just its modality.** A
  CAPABILITY column appears whenever a listing mixes `generation` and
  `transcription` — which an unfiltered list and `--type audio` both do, because
  `whisper-large-v3` and `ali-qwen3-asr-flash` are `type: audio` yet transcribe
  rather than speak. Filter with `--capability`.
- `curvet models --include all` — adds coming-soon and dashboard-only models,
  with a STATUS column saying which is which. The default listing is unchanged:
  only models this key can call right now.
- **Naming the wrong model now fails before the request, not after.**
  `curvet audio -m whisper-large-v3` used to submit a job that could not
  succeed. An explicit `-m` is checked against the catalogue and rejected with
  the command that would work — the same check catches a chat model passed to
  `curvet image`, a coming-soon model, and a dashboard-only one.


## 0.3.0

Workflow discovery — you no longer need the web builder to use workflows.

- `curvet workflows list` (alias `ls`) — the workflows this key can run, newest
  first, with `-q` title search and `-n` limit.
- `curvet workflows show <id>` — one workflow plus **the inputs it accepts**,
  each with its type, whether it is required, and the alias keys also accepted.
  Ends by printing the exact `curvet workflows run ...` command with the input
  flags filled in.

Requires `@curvet/sdk` >= 0.6.0 and the darkapp-haven backend >= 0.51.11.

## 0.2.0

Media generation, async jobs, workflows, and analytics.

- `curvet image` — generate an image; `-o` downloads it, otherwise the URL is printed.
- `curvet video|audio|3d` — async generation that polls to completion with a
  progress bar, `-o` to download, and `--no-wait` to get the job id instead.
- `curvet jobs get|wait <jobId>` — inspect or attach to an async job later.
- `curvet workflows run|status` — run a workflow with repeatable `-i key=value`
  inputs (parsed as JSON when possible, so numbers/booleans/arrays survive) and
  `-f field=./path` file uploads. Polls with per-node progress.
- `curvet analytics` — requests, cost, average latency, and breakdowns by model,
  category, and status. Reads the live payload shape (`overview`/`modelBreakdown`),
  which is richer than the SDK's declared `AnalyticsResult`.
- Progress bars render in place on a TTY and degrade to one line per 10% off-TTY,
  so CI logs stay readable. `--quiet` disables them; progress goes to stderr.
- Credit figures are rounded to 4 decimal places, so a balance no longer prints
  as `44.44359999999997`.

## 0.1.1

Fixed: streaming chat reported no cost at all.

- `curvet chat` now sends `stream_options.include_usage` and reads Curvet's
  `x_curvet` settlement chunk, so streamed calls report the credits actually
  charged, the token counts, and whether **token-metered or flat** pricing
  applied. Previously the streaming path printed nothing.
- The cost line is shown by default on stderr, including when stderr is not a
  TTY, so piped and CI runs still record spend. stdout stays clean for piping.
- Three ways to silence it, in precedence order: `--no-cost`, `CURVET_NO_COST=1`,
  or `curvet config set showCost false`. `--cost` forces it back on.
- New `curvet config list|get|set|unset` for `showCost` and `defaultModel`.
- The sync (non-streaming) path now also shows the `metered`/`flat` marker the
  API returns.

## 0.1.0

Initial release.

- `curvet auth login|status|use` — profile management in `~/.config/curvet/config.json`
  (owner-only permissions), no-echo key prompts, on-login key validation, and
  `CURVET_APP_KEY` / `CURVET_ENTERPRISE_KEY` / `CURVET_BASE_URL` env overrides.
- `curvet models` — keyless public catalogue with per-million-token pricing, or the
  app's own model list plus rate limits when logged in; `--type`, `--cheapest`, `--json`.
- `curvet chat` — streaming by default (OpenAI-compat SSE) with sync fallback, piped
  stdin support, system prompt/temperature/max-tokens flags, cost telemetry on stderr.
- `curvet balance` — enterprise-aware credit breakdown; `--watch` burn-rate mode.
- `curvet doctor` — config, key format/scope, connectivity, and limit diagnostics;
  exits non-zero when problems are found.
