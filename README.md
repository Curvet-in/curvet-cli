# @curvet/cli

Curvet in your terminal — chat, image/video/audio generation, balances, and enterprise
administration for the [Curvet Unified Playground API](https://curvet.ai), built on
[`@curvet/sdk`](https://www.npmjs.com/package/@curvet/sdk).

```bash
npm install -g @curvet/cli
```

No account yet? The model catalogue works keyless:

```bash
npx @curvet/cli models
```

## Setup

```bash
curvet auth login          # prompts for an app key and/or enterprise key
curvet doctor              # verifies config, keys, connectivity, and limits
```

Keys are stored per-profile in `~/.config/curvet/config.json` (owner-only permissions).
Environment variables `CURVET_APP_KEY`, `CURVET_ENTERPRISE_KEY`, and `CURVET_BASE_URL`
override the active profile. Use `--profile <name>` (or `curvet auth use <name>`) to
switch between accounts or environments.

## Commands

| Command | What it does |
|---|---|
| `curvet models [--type chat] [--capability] [--include all]` | List models; keyless via the public catalogue, per-app (with rate limits) once logged in |
| `curvet chat "prompt"` | Chat with streaming output; add `-m`, `-s`, `-t`, `--max-tokens` |
| `curvet chat --repl` | Interactive session: switch models mid-conversation, track spend |
| `curvet commit` | Write a commit message for the staged diff, in your repo's own style |
| `curvet image "prompt" -o pic.png` | Generate an image; prints the URL when `-o` is omitted |
| `curvet video\|audio\|3d "prompt"` | Async generation with a progress bar; `--no-wait` prints the job id |
| `curvet stt clip.mp3` | Transcribe audio; prints the text, `-o` writes it to a file |
| `curvet jobs get\|wait <jobId>` | Inspect or poll an async job; `wait -o file` downloads the result |
| `curvet workflows list` | The workflows this key can run; `-q` search, `-n` limit |
| `curvet workflows show <id>` | One workflow and the inputs it accepts, with a ready-to-run command |
| `curvet workflows run <id>` | Run a workflow with `-i key=value` and `-f field=./file`; `status <runId>` to check one |
| `curvet analytics [--start] [--end]` | Requests, cost, and latency broken down by model, category, and status |
| `curvet balance [--watch]` | Credit balance breakdown; `--watch` polls and shows burn rate |
| `curvet ent overview\|invite\|members` | Enterprise admin: pool, invites, allotments, pool access (enterprise key) |
| `curvet login\|logout` | Sign in so the CLI can manage your apps and keys |
| `curvet apps list\|create\|update\|delete\|use` | Manage apps and their configuration |
| `curvet keys rotate\|show` | Rotate an app's credentials, or read its secret |
| `curvet auth login\|status\|use` | Manage profiles and credentials |
| `curvet config list\|get\|set\|unset` | Read and write CLI settings |
| `curvet doctor` | Diagnose config, key scopes, connectivity, and headroom |
| `curvet init <tool>` | Write a coding tool's config from the live model catalogue |
| `curvet proxy` | Local OpenAI-compatible endpoint that injects your key |
| `curvet mcp` | Run Curvet as an MCP server over stdio |

### Picking a model

`curvet models` lists only what your key can actually call. Each model also says
what it *does*, which matters most for audio: `type: audio` covers both
directions, so a speech-to-text model sits in the same list as a text-to-speech
one.

```console
$ curvet models --type audio
MODEL                 TYPE   CAPABILITY     PROVIDER    CREDITS  VISION
────────────────────  ─────  ─────────────  ──────────  ───────  ──────
ali-qwen3-tts-flash   audio  generation     dashscope   1
ali-qwen3-asr-flash   audio  transcription  dashscope   1
elevenlabs-scribe     audio  transcription  elevenlabs  2
whisper-large-v3      audio  transcription  deepinfra   1
```

Filter by it with `--capability generation` or `--capability transcription`, and
see what's coming with `--include all`, which adds a STATUS column marking
coming-soon and dashboard-only models.

Naming the wrong one is caught before the request is made, rather than after you
have paid for it:

```console
$ curvet audio -m whisper-large-v3 "hello there"
✘ whisper-large-v3 is a speech-to-text model — it transcribes audio rather than generating it.
  Use `curvet stt <file> -m whisper-large-v3` instead.
  List the right ones with `curvet models --capability generation`.
```

### Speech to text

```bash
curvet stt meeting.m4a                      # transcript on stdout
curvet stt call.wav -m elevenlabs-scribe    # choose the engine
curvet stt clip.mp3 --language en --prompt "Curvet, appKey, DeepInfra"
curvet stt clip.mp3 -o transcript.txt
curvet stt clip.mp3 --json | jq -r .text
```

Without `-m` the gateway picks its own engine. `--allow-fallback` lets it retry
elsewhere if the first provider is down, and the CLI says so when it does:

```console
$ curvet stt clip.mp3 -m whisper-large-v3 --allow-fallback
! deepinfra was unavailable — transcribed with elevenlabs.
The quick brown fox jumps over the lazy dog.
— whisper-large-v3 · 1 credit · 2522.32 left
```

## Interactive chat

```bash
curvet chat --repl
```

```console
› explain this stack trace
Sure — the failure is at line 40 of…
— gpt-5.5 · 0.4 credits (metered) · 2.1k in / 340 out · 3.2s

› /model claude-sonnet-4-6
  switched to claude-sonnet-4-6

› /cost
  6 messages · 2.8 credits · $0.028
```

| | |
|---|---|
| `/model [id]` | show or switch model, mid-conversation, with tab-completion |
| `/models` | chat models ranked by what a turn actually costs |
| `/cost` | what this session has spent |
| `/system <text>` | set the system prompt (resets the conversation) |
| `/clear` | start over, same model |
| `/save [file]` | write the transcript to a file |
| `/help`, `/exit` | |

Ctrl-C stops a reply in progress; on an empty line it exits. A line ending in
`\` continues on the next. History persists between sessions.

Replies stream inline rather than into a full-screen TUI, deliberately: an
alternate-screen app would take your scrollback with it when you quit, which is
exactly when you want to scroll up and copy an answer.

`/model` tells you when a model **can't** stream — 28 of the 43 chat models are
absent from the OpenAI-compatible surface and answer all at once.

## Commit messages

```bash
curvet commit                 # write a message for the staged diff, then commit
curvet commit -a              # stage tracked changes first
curvet commit --print         # print it and stop
curvet commit --hint "the 402 was a provider outage, not our bug"
```

It reads your last ten commits and **matches the style already there** —
conventional prefixes or prose, terse or explanatory. That's the one thing a
generic model reliably gets wrong, and your log already answers it.

Lockfiles, build output and binaries are excluded (they're most of the payload
and none of the meaning), and an oversized diff is cut at a file boundary with
the model told that it was — a truncated diff otherwise produces a confident
message about the half it happened to see.

The model is chosen by what *this* job costs: a commit is thousands of tokens in
and a handful out, so the input rate dominates. Typically under a hundredth of a
credit. If the catalogue offers a model that then fails, it moves to the next and
says so.

Nothing is committed until you've seen the message. `--yes` skips the prompt;
with no terminal it refuses rather than assuming yes.

### Pipes are first-class

```bash
cat error.log | curvet chat "explain this stack trace"
git diff | curvet chat "review this change" -m claude-sonnet-4-6
curvet chat --json "hello" | jq .usage.credits
curvet stt interview.mp3 | curvet chat "summarise this transcript in five bullets"
```

## Cost reporting

Every `curvet chat` call prints what it cost, on **stderr**, so stdout stays clean
for piping:

```
— gpt-5.5 · 0.05 credits (metered) · 1.2k in / 340 out · 2.1s
```

The `(metered)` / `(flat)` marker tells you which billing scheme actually charged:
token-metered dynamic pricing, or the flat per-model credit. Streamed calls read
this from Curvet's `x_curvet` settlement chunk, so the number shown is the amount
the wallet actually moved.

It is on by default, including when stderr is not a terminal — a CI job's log
should still record what it spent. To silence it, in precedence order:

```bash
curvet chat "hi" --no-cost          # one call
CURVET_NO_COST=1 curvet chat "hi"   # one environment, e.g. a CI image
curvet config set showCost false    # persistently
```

`--cost` forces it back on for a single call.

## Long-running jobs

Video, audio, 3D, and workflow runs poll to completion with a progress bar on a
terminal. Off-TTY the bar degrades to one line per 10% so CI logs stay readable,
and `--quiet` removes it entirely. Progress goes to stderr; results go to stdout.

```bash
curvet video "a paper plane over a city" -o clip.mp4      # wait, with progress
JOB=$(curvet video "..." --no-wait)                       # returns immediately
curvet jobs wait "$JOB" -o clip.mp4                       # attach later
```

Find a workflow and learn its inputs without opening the builder — `show` prints
the run command with the input flags already filled in:

```bash
curvet workflows list -q digest
curvet workflows show 6a7b6760e6c28f717dba4ec6
# INPUTS
# NAME        TYPE   REQUIRED  ALSO ACCEPTS
# Transcribe  audio  yes       url, audioUrl
#
# run it with: curvet workflows run 6a7b… -i Transcribe=<value>
```

Workflow inputs are parsed as JSON when they can be, so types survive:

```bash
curvet workflows run wf_123 -i topic=otters -i count=3 -i draft=true -f doc=./brief.pdf
```

## Point your tools at Curvet

### `curvet init` — write a coding tool's config

```bash
curvet init                 # what each tool needs, and where it goes
curvet init opencode        # writes ~/.config/opencode/opencode.json
curvet init zed             # merges into ~/.config/zed/settings.json
curvet init vscode          # VS Code Copilot Chat's chatLanguageModels.json
curvet init cline           # prints the values to type into its settings UI
```

Everything is generated from the **live** `/v1/models`, because the two ways this
goes wrong are both literals in a doc that the code can't keep true: a model id
we don't serve (404 on every request), and a missing price block (OpenCode
reporting `$0.00` for a 16,705-token session — the charge was real either way).

Existing settings are merged, not replaced: only the `curvet` subtree is
written, the previous file is saved as `.bak`, and a file with comments or
trailing commas is **left alone** with the block printed for you to paste — a
JSONC settings file can't be rewritten without destroying the comments.

Your key never reaches stdout unless you ask: configs reference
`{env:CURVET_APP_KEY}`, and the verification `curl` uses `$CURVET_APP_KEY`. Pass
`--inline-key` to embed the real one. `--print` and `-o` are there when you'd
rather place the file yourself, and `--prompt` emits a prompt for an AI
assistant, with the real ids and rates as data.

### `curvet proxy` — a local OpenAI endpoint that bills to Curvet

```bash
curvet proxy                 # http://127.0.0.1:4141/v1
```

Anything that speaks OpenAI now works, and never sees a key:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:4141/v1
export OPENAI_API_KEY=unused
```

```python
client = OpenAI(base_url="http://127.0.0.1:4141/v1", api_key="unused")
```

Serves `/chat/completions` and `/models`, with or without the `/v1` prefix,
since tools disagree about whether they append it. Streaming is piped through
untouched, so tokens arrive as they're generated. The client's own
`Authorization` header is dropped and replaced with yours.

It binds to **loopback only**. `--host` widens that and says so loudly — every
request the proxy accepts is billed to your account.

### `curvet mcp` — Curvet as an MCP server

```bash
claude mcp add curvet -- curvet mcp
```

14 tools over stdio: `list_models`, `chat`, `generate_image`,
`generate_video|audio|3d`, `get_job`, `transcribe_audio`, `list_workflows`,
`describe_workflow`, `run_workflow`, `get_workflow_run`, `get_balance`,
`get_analytics`.

Media generation returns a `jobId` immediately and is polled with `get_job`,
rather than holding a tool call open for minutes; pass `wait: true` if you'd
rather block. Every result carries what it cost, and every tool description says
whether it spends credits — an agent driving this can see its own spend.

## Signing in

`curvet login` signs the CLI in to your account, so it can manage apps and keys —
things an app key cannot do, because an app key authenticates an *app*, and
letting one mint or rotate another would make revoking it meaningless.

```bash
curvet login                              # opens a browser, prints a code
curvet login --scope enterprise:admin     # also administer your org
curvet login --no-browser                 # over SSH or in a container
curvet logout
```

```console
$ curvet login

  Your code is BCDF-GHJK

  https://curvet.in/cli?code=BCDF-GHJK

This device is asking to:
  · see your apps and their usage
  · create, configure and delete your apps
  · rotate your app keys and read your app secrets

Waiting for approval… (Ctrl-C to cancel)
✔ signed in as you@example.com
✔ created your first app "CLI" and saved its key
  app_9f2c11…4d81 — try `curvet chat "hello"`
```

The code is printed **before** the browser opens, so the flow works when no
browser can open at all. Running `curvet login` again on a machine that is
already signed in costs one request and no browser — it checks the token it has
and stops. `--force` re-authorises.

A brand-new account gets an app created for it, because otherwise a successful
login is followed one second later by "no app key". If you already have apps,
nothing is created.

The login lasts 90 days and is revocable on its own, per machine.

## Apps and keys

```bash
curvet apps list
curvet apps create "Nightly Digest" --models gpt-4o-mini --rate-limit 250 --use
curvet apps show <appId>
curvet apps update <appId> --cost-cap 5
curvet apps use <appId>            # point this profile at that app's key
curvet apps delete <appId>         # asks first

curvet keys rotate <appId>         # asks first
curvet keys show <appId>           # asks first
```

Anything that hands over or destroys a credential asks before doing it:

```console
$ curvet keys rotate app_67818127
The current key stops working the moment this completes. Anything still
using it starts failing, including anything you have deployed.
Rotate the key for "Nightly Digest"? [y/N]
```

`--yes` skips the prompt for CI. With no terminal to ask, the command **refuses
rather than assuming yes** — a piped `curvet apps delete` should stop, not
destroy an app because nobody was there to answer.

With `--scope enterprise:admin`, every `curvet ent` command works from your
login, with no enterprise key to create or store.

## Enterprise

Needs an **enterprise key** (`cvent_ent_…`), not an app key — save one with
`curvet auth login` or set `CURVET_ENTERPRISE_KEY`.

```bash
curvet ent overview                                  # pool, seats, per-member usage
curvet ent members list
curvet ent members set-credits ava@acme.com 1000     # negative reclaims to the pool
curvet ent members set-limit ava@acme.com 0          # 0 = uncapped
curvet ent members pool-access ava@acme.com on       # on | off | inherit
curvet ent members set-role ava@acme.com admin
curvet ent members remove ava@acme.com --yes
```

Members are keyed by Firebase UID in the API, so every command takes an **email**
and resolves it for you. A raw UID works too — `--json` output contains them, so
one command's output feeds the next. An address matching two members is an error
rather than a guess.

**Pool access is three states, not two.** `on` and `off` set it explicitly;
`inherit` clears the setting so the role decides — admins draw the pool, plain
members don't. Listings show what actually applies, marking the inherited case:

```console
$ curvet ent members list
EMAIL           ROLE    ALLOTTED  USED  CAP       REMAINING  POOL            STATUS
──────────────  ──────  ────────  ────  ────────  ─────────  ──────────────  ──────
ava@acme.com    admin   0         120   uncapped  —          on (inherited)
ben@acme.com    member  500       310   2000      1690       off (inherited)
cleo@acme.com   member  0         840   5000      4160       on
```

### Bulk invites

An invite token is shown **once** — only a hash is stored — so `bulk` writes each
link to disk as it is created, before the next request goes out. A run that dies
halfway has still saved everything it created.

```bash
curvet ent invite bulk ./team.csv --dry-run     # parse and check, create nothing
curvet ent invite bulk ./team.csv               # → ./team-invites.csv
```

The CSV takes an optional header (columns in any order) or the positional layout
`email,credits,role,limit,label`; blank lines and `#` comments are skipped, and
only `email` is required:

```csv
# design team
email,credits,role,limit,label
ava@acme.com,1000,admin,0,Design lead
ben@acme.com,500,member,2000,"Smith, Ben"
cleo@acme.com
```

A row that fails is recorded in the output CSV with its reason and the run
continues; the command exits non-zero if any failed.

## Roadmap


## Development

```bash
npm install
npm run dev -- models      # run from source
npm test
npm run build
```

MIT © Curvet
