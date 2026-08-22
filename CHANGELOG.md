# Changelog

All notable changes to `@curvet/cli` are documented here.

## Unreleased

- **Fixed: a write could escape the project through a symlinked parent.** The
  boundary check resolved paths with `fs.realpath`, which throws the moment any
  component is missing — so a path whose leaf did not exist yet was judged as the
  literal string it arrived as, and its parents were never resolved at all. With
  `escape` a link out of the project, `write_file` to `escape/new.txt` classified
  as an ordinary local write. A dangling link had the same effect on its own,
  since `open(O_CREAT)` follows one and creates the target.

  Existence was deciding the boundary, which is backwards: the paths that do not
  exist yet are exactly the writes. Paths are now resolved a component at a time,
  following links wherever they appear, so where a write would *land* is what
  gets classified. `..` is applied during that walk rather than collapsed
  beforehand, because `link/../x` lands beside wherever `link` pointed.

  Reads were mostly unaffected — an existing file resolved correctly — so this
  was a write escape. Verified against a real run: a write through a symlinked
  directory, and through a dangling link, are both refused and create nothing.

- A project reached through a symlink — `/tmp/x`, where `/tmp` is itself a link
  on macOS — no longer reports every file in it as outside the project.

- **A refusal no longer arrives as the user's answer.** With no terminal to ask,
  a pause is refused — correctly — but the refusal carried the note "no
  interactive terminal", and the server reads a pause's note as the ANSWER. The
  model was told *"The user answered: no interactive terminal"*: a sentence about
  this process, attributed to a person who was never at the keyboard. A refusal
  has no answer in it, so it no longer sends one. The explanation stays on your
  terminal, where it already was.

  Unreachable until now, because `ask_user` never actually paused in production.
  It does now.

- One-shot mode said "is a protected file" for every refusal. A write stopped by
  the project boundary is not a protected file, and describing it as one teaches
  a rule that does not exist. It now prints the reason that actually fired.

## 0.10.0

- **A home screen.** An empty session opens on the Curvet mark, a greeting, where
  you are, and the prompt — all together in the middle of the window rather than
  a blank transcript with the input a screen away at the bottom. Once you say
  something it becomes the conversation view, transcript first and prompt pinned
  where a prompt belongs.

- **Slash commands.** `/` lists them; typing narrows. Everything offered actually
  works, because a picker listing something the session answers "not implemented"
  to is worse than no picker.

  `/status` asks the SERVER what it has enabled — agents, memory, connectors,
  plan approval — rather than printing what the client assumed at startup. The
  two drift, and the client's copy is the one that is wrong.

  `/model` switches the orchestrator mid-session · `/tools` says what the agent
  may do on this machine · `/cost`, `/runs`, `/log`, `/undo`, `/clear`, `/help`,
  `/exit`.


- **`curvet agent` with no task opens a full-screen session.** Multi-turn, so a
  follow-up can say "now change that one" and be understood. Panes for the
  conversation, the tool timeline and the last diff, with the model, turn count,
  live cost and elapsed time in the header.

  ```
  › read src/server.ts and tell me the port
  ✓ Read src/server.ts
  The server listens on port 8412.

  › now change that port to 9300
  ✓ Write src/server.ts
    - const PORT = 8412;
    + const PORT = 9300;
  Done — updated 8412 → 9300.

  › Ask anything▌
  claude-sonnet-4-6 · $0.14 · 2 turns · demo-proj  ⎇ main 3 changed
  ```

  One column, with tool calls in the transcript at the point the agent made
  them — a call belongs in the conversation it was part of, not in a column
  beside it, and a side pane takes width from the only thing anyone reads.

  Approvals replace the input bar, so a diff appears exactly where your attention
  already is and there is nothing to type past. `y` applies it. Esc stops a turn,
  Ctrl-C leaves. The last line is always the status bar: model, spend, turns,
  project, branch and how many files are dirty.

  A task on the command line still runs one-shot and inline, unchanged — that is
  what pipes and CI use, and it should not open a UI. `--json` is unchanged too.

  ink is loaded through a dynamic import, so nothing else pays for React: only a
  session actually loads it.

- The session engine holds no rendering at all. That is what makes an approval
  work in a full-screen app — it is state the UI subscribes to, rather than a
  question written to stderr — and it is what a desktop client would reuse.

- **Pasting into the input works.** A paste arrives as one chunk rather than as
  keystrokes, and a trailing newline now submits instead of landing in the buffer
  as an invisible character that could never be typed out.

- **A terminal reporting a zero window size no longer renders an invisible UI.**
  Some CI runners and multiplexers report 0 rather than nothing, and `?? 80` does
  not catch 0. Narrow terminals drop the side pane instead of squeezing both.

## 0.9.0

- **`curvet login` now asks which scopes you want.** Before this, the only way to
  discover `agency:run` was to run an agent, be refused, and read the error —
  `--scope <scope>` never said which scopes exist, and the defaults are apps-only.

  ```
  Signing in will let this device:
    · see your apps and their usage
    · create, configure and delete your apps
    · rotate your app keys and read your app secrets

  Anything else?
    [1] run agents as you — spending your credits, and using tools that can send email…
        agency:run — needed for `curvet agent`
    [2] administer your organization, including minting enterprise API keys
        enterprise:admin — org admins only

    numbers to add, or Enter for none:
  ```

  Skipped when `--scope` or `--all` is given, and when there is no terminal — a
  scripted login must not block on a question, and silence is not consent to a
  wider token.

  `curvet login --help` lists every scope and what it is for, `--all` takes the
  lot, and an unknown `--scope` now names the valid ones instead of failing at
  the server.

- **`curvet login` on an already-signed-in device says what it cannot do**, and
  gives the command that fixes it. That is the moment people look for this: they
  ran `login` again because something refused them, and used to get "already
  signed in" with no way forward.

- **`curvet auth status` verifies the login instead of trusting the file.** The
  table read local config, so a token revoked from another machine — or replaced
  by a later login — still showed as "signed in". It now asks the server, shows
  which scopes the token actually holds, and names the ones it does not.


- **`write_file`** — the agent can now change files in your project, and every
  change is shown as a diff you approve before anything is written. There is no
  auto-approve, no "allow always", and no flag to add one: what you are approving
  is different every time, because it is the diff, not the capability.

  Only what changed is printed, with three lines either side. A prompt long
  enough to scroll is a prompt that gets approved unread.

  **Writes outside the project are refused, not confirmed.** Reading a sibling
  package is ordinary work in a monorepo; writing to one is not something an
  agent pointed at this repository should be doing, and a prompt would only be a
  way to say yes to it at 2am. Secrets are refused as before — it never asks.

  With no terminal, a write is refused. Piped or in CI, nothing gets written.

- **`curvet agent --undo`** — put back the files the agent changed. Every write
  saves the previous contents first, so undo exists before the first regret, and
  a file written twice in one run returns to how it looked *before the run*
  rather than to its state midway through.

  If you edited a file yourself after the agent wrote it, undo still restores it
  — you asked — but it says so rather than quietly overwriting your work.

  Deliberately not `git stash`: that mutates a repository you are also using,
  mid-session, and does nothing at all outside a git repo.

## 0.8.0

- **Reading your project is now the default.** `curvet agent` inside a project
  can read it; `--tools` is gone from the common path. A flag everybody passes is
  a flag that should not exist.

  It is off outside a project, and that is not a compromise — it is the condition
  the permission layer was written for. Its denylist recognises *conventional*
  names: `.env`, `*.pem`, `.ssh/`, `.aws/`. Inside a project that is close to
  exhaustive, because projects keep credentials in known places. A home directory
  does not: `~/notes/passwords.txt` matches nothing. So the rules that make reads
  safe hold inside a project and stop holding outside one.

  `--tools` now means "read here anyway", `--no-tools` means "stay off this
  machine", and every run says which it is doing on its first line.

- **The boundary is the project root, not the working directory.** Running from
  `src/` no longer asks permission to read `../package.json`. The nearest marker
  wins, so a package inside a monorepo is bounded by that package.

## 0.7.0

- **`curvet agent --tools`** — let the agent read the project you are standing
  in. `read_file`, `list_dir` and `grep`, executed here rather than on the
  server: the run suspends on each call, this machine answers it, and the run
  continues.

  It cannot write, delete or run anything, and there is no way for it to ask —
  those tools do not exist in this client yet.

  The permission layer lives here and cannot be relaxed by anything the server
  sends, because the thing being defended against is not a malicious server: it
  is that an agent run ingests untrusted text — scraped pages, emails, a README
  in the repo it is reading — and that text can steer tool calls.

  - **Secrets are refused before the file is opened**, by path: `.env`, `*.pem`,
    `*.key`, `.ssh/`, `.aws/`, `.npmrc`, service-account JSON. Not filtered from
    the contents afterwards, because by then it has been read. Symlinks resolve
    first, so a harmless-looking link to a private key is refused as well.
  - **Anything outside the directory asks you**, every time, showing the real
    destination rather than the name the agent used. Never remembered.
  - **With no terminal, every prompt is a refusal** — the rule `curvet apps
    delete` already follows.
  - `--confirm-reads` asks about files inside the directory too.

  `--confirm-reads` asks only about reads that would otherwise pass silently.
  Files outside the directory keep their own prompt, which is the better one —
  it names the real destination — and asking both would be two differently
  worded questions about one read.

- **`curvet agent --log`** — what the agent has actually read on this machine,
  with the decision for each. Stored on your disk rather than the server.

## 0.6.1

- **`curvet agent` has a proper palette.** Fifteen of its twenty-four colour
  decisions were `dim`, so a run came out as one grey wash and the deliverable —
  the thing you ran the command for — read as faintly as the run id. There are
  now four roles, defined in one place: the agent's own words unstyled (the only
  colour legible on a light terminal and a dark one), the deliverable bold with a
  marked, underlined link, the tool timeline coloured so it can be scanned, and
  ids/timings/cost in grey.

  `gray` rather than `dim` throughout: dim is a terminal attribute that many
  themes render at very low contrast and some ignore. No colour is nested inside
  a dim span any more either — the inner reset closed the span early, which is
  what washed out the ✓ and ✖.

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
