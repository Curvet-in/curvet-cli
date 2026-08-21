# Changelog

All notable changes to `@curvet/cli` are documented here.

## 0.6.1

- **`curvet agent` no longer prints the answer twice.** `run_end` carries the
  run's final text in full, and it had just been streamed word for word. The
  summary now appears only when nothing was streamed — a tool-only run, or
  `--quiet` — and then as one line. Found on a real run, where a long answer
  scrolled past twice.
- **`--replay` no longer prints the task twice**, once from the command and once
  from the persisted `run_start` it replays.

## 0.6.0

- **`curvet agent`** — run a Curvet agent from the terminal and watch it work.
  Streams the run: the agent's text token by token, a tool timeline, deliverables
  as they land, and the cost when it finishes. A run that pauses for a human —
  a question, a plan to approve, an outward action to confirm — gets asked here.

  Needs a scope the default login does not request: `curvet login --scope
  agency:run`. It is withheld deliberately, because it is the only grant that
  spends credits by itself and reaches tools that can send email as you.

  Inline rather than full-screen, for the same reasons as `--repl` above, and
  because there is nothing yet that a persistent pane would hold. `--json` emits
  the raw event stream one object per line, so a run can be piped into `jq`.

  **The agent runs on Curvet's servers and cannot touch this machine.** No files,
  no shell, and no way for it to ask. Local tools are a later phase with a
  permission model of their own.

  With no terminal — piped, or in CI — a pause is **cancelled, never approved**.
  The same rule `curvet apps delete` follows: nobody there to answer is not a yes.

- **`curvet chat --repl`** — an interactive session. Replies stream inline,
  `/model` switches mid-conversation with tab-completion, `/cost` tracks the
  session, `/save` writes a transcript, and history persists between runs.
  Ctrl-C stops a reply in progress rather than the session; a partial reply
  stays in context, because the next thing you say usually refers to it.

  Readline rather than a full-screen TUI, deliberately: an alternate-screen app
  takes your terminal scrollback with it when you quit — exactly when you want
  to scroll up and copy an answer — and it would have added ~6MB of dependencies
  to a tool whose pitch is `npm i -g`.

  `/model` reports when a model cannot stream, since 28 of 43 chat models are
  absent from the OpenAI-compatible surface and silently answer all at once.

- **`curvet commit`** — writes a commit message for the staged diff.
  - Reads your last ten commits and matches the style already there, rather than
    imposing conventional-commits on a repo that does not use them. Detected,
    not configured.
  - Excludes lockfiles, build output and binaries, and cuts an oversized diff at
    a file boundary while telling the model it was truncated — otherwise the
    message confidently describes whichever half survived.
  - Picks the model by what a *commit-shaped* turn costs: thousands of tokens in,
    a handful out, so the input rate dominates. Ranking by the headline output
    price picks differently, and worse.
  - If the catalogue offers a model that then fails, it falls back to the next
    and says which it skipped. Two models are currently advertised as available
    and fail every call.
  - `--print` emits the message alone on stdout, so `curvet commit --print |
    git commit -F -` works. Nothing is committed unprompted; `--yes` for scripts,
    and with no terminal it refuses rather than assuming yes.

## 0.5.0

`curvet login` — sign in from the terminal, and manage apps and keys without a
browser.

- **`curvet login` / `curvet logout`** — device-code sign-in (RFC 8628). Prints
  a code, opens the approval page, polls until you approve. The code is printed
  *before* the browser opens so the flow works over SSH and in containers, and
  `--no-browser` never opens one. Logins last 90 days and are revocable per
  machine.
  - Running it again on a machine that is already signed in costs one request
    and no browser: it validates the token it has and stops. `--force`
    re-authorises, and lands on the same device's record rather than adding
    another.
  - A brand-new account gets its first app created and its key saved, because
    otherwise a successful login is followed one second later by "no app key".
    Nothing is created if you already have apps.
- **`curvet apps list|show|create|update|delete|use`** — full app management,
  including `--models`, `--categories`, `--rate-limit` and `--cost-cap`.
  `--use` points the active profile at a new app's key.
- **`curvet keys rotate|show`** — rotate an app's credentials, or read its
  secret.
- **Anything that hands over or destroys a credential asks first.** `--yes`
  skips it for CI, and with no terminal to ask the command refuses rather than
  assuming yes — a piped `curvet apps delete` should stop, not destroy an app
  because nobody was there to answer.
- `curvet ent` now works from a login carrying `enterprise:admin`, with no
  enterprise key to create or store.
- `curvet auth status` reports the login alongside any pasted keys.

Requires `@curvet/sdk` >= 0.9.0 and the darkapp-haven backend that ships the
`/api/v1/auth/cli` endpoints.

## 0.4.0

One release covering three things: the distribution commands that let other
tools run on Curvet, enterprise administration, and a model-capability fix that
closes a live footgun.

Requires `@curvet/sdk` >= 0.8.0.

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
