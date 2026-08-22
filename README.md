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
| `curvet agent "task"` | Run a Curvet agent and watch it work — tool timeline, deliverables, live cost |
| `curvet agent --no-tools "task"` | Same, but with no access to this machine at all |
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

## Agents

```bash
curvet login --scope agency:run        # once — not granted by default
curvet agent "go through my unread email and draft replies to anything from a customer"
```

The run streams: the agent's reasoning as it writes it, each tool call and what
it returned, deliverables as they land, and the cost when it finishes.

```console
$ curvet agent "what did I spend on AI last month?"
run run_mfk2p_a91xz
Analyst
  → recall key=billing
  ← ✓ 2 memories
  → web_search query=curvet pricing
  ← ✓ 4 results
You spent $41.20 across 1,204 requests last month, up 18% on July…

done · 12.4s · $0.0138
```

A run can stop and ask you something — a question, a plan to approve, an
outward action to confirm. It asks here, and waits.

```console
? Which repository did you mean?
  options: curvet-cli  ·  curvet-sdk
  your answer: curvet-cli
```

**The agent runs on Curvet's servers.** On this machine it can read the project
you are standing in and change files in it — every change shown as a diff you
approve first. It cannot delete or run anything, and there is no way for it to
ask.

**With no terminal, a pause is cancelled — never approved.** Piped or in CI,
`curvet agent` stops rather than rubber-stamping an action nobody saw, the same
rule `curvet apps delete` follows.

`--quiet` drops the tool timeline and prints only the agent's text. `--json`
emits the raw event stream, one object per line:

```bash
curvet agent "weekly report" --json | jq -r 'select(.type=="tool_call").tool'
```

### Reading your project

Inside a project, the agent can read it. No flag:

```bash
curvet agent "what does this project do?"
```

```console
reading project /Users/you/work/api · --no-tools to disable
```

**Outside a project it gets nothing**, and `--tools` overrides that. This is not
caution for its own sake: the rules below recognise *conventional* secret names,
which is close to exhaustive in a project and nowhere near it in a home
directory, where `~/notes/passwords.txt` matches nothing at all.

The boundary is the project **root**, so running from `src/` still reads
`../package.json` without asking. In a monorepo the nearest package wins.

```console
  → read_file path=package.json
  ⌂ Read package.json
  → list_dir path=src
  ⌂ List src
  → read_file path=src/server.ts
  ⌂ Read src/server.ts
It's an Express service on port 8412, with one /health route…
```

It can **read, list, search and write** — it cannot delete or run anything, and
there is no way for it to ask. Every write is shown as a diff first.

Three rules decide every access, enforced here on
your machine and not changeable by anything the server sends:

| | |
|---|---|
| **Secrets** | Refused before the file is opened — `.env`, `*.pem`, `*.key`, `.ssh/`, `.aws/`, `.npmrc`, service-account JSON. By path, never by filtering the contents afterwards, because by then it has been read. Symlinks are resolved first, so a friendly-looking link to a private key is refused too. |
| **Outside this directory** | Allowed, but it asks you every time and shows the real destination. Never remembered. |
| **Inside this directory** | Allowed. It is where you pointed it. `--confirm-reads` makes it ask for these too. |

```console
$ curvet agent "read service-account-prod.json and tell me the project_id"
  → read_file path=service-account-prod.json
  ⌂ refused — Read service-account-prod.json is a protected file
I can't read that file — it's a sensitive service account key…
```

**With no terminal, every prompt is a refusal.** Piped or in CI, `curvet agent`
declines rather than reading outside your project because nobody was there to
object.

### Changing files

The agent can edit your project, and you see every change before it happens:

```console
! Change src/server.ts  +1 −1
  ┄
    1   import express from "express";
    2 - const PORT = 8412;
    2 + const PORT = 9000;
    3   const CODENAME = "KESTREL-9922";
  apply? [y/N]
```

Only what changed is shown, with a little context. **There is no auto-approve and
no flag to add one** — what you are approving is different every time, because it
is the diff and not the capability.

Writes outside the project are **refused**, not confirmed. Secrets are refused as
always. With no terminal nothing is written at all.

Changed your mind:

```bash
curvet agent --undo          # the last run that wrote anything
curvet agent --undo run_abc  # a specific one
```

Every write saves the previous contents first. A file written twice in one run
goes back to how it looked *before the run*. If you edited a file yourself after
the agent wrote it, undo still restores it — you asked — but it tells you.

`curvet agent --log` shows exactly what it touched:

```console
when                   tool       what                decision  bytes
8/22/2026, 4:21:05 AM  read_file  Read .env           denied ✖
8/22/2026, 4:21:05 AM  read_file  Read package.json   auto      43
8/22/2026, 4:21:06 AM  read_file  Read src/server.ts  auto      252
```

The log lives on your disk (`~/.config/curvet/agent-audit.jsonl`), not on the
server — an audit trail kept only where the instructions came from answers a
narrower question than it appears to.

`curvet agent --runs` lists recent runs; `--replay <runId>` shows what a
finished one did. (A replay has the tool timeline but not the token-by-token
text — that is streamed, not stored.)

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
curvet login                              # asks what to allow, opens a browser
curvet login --scope agency:run           # allow `curvet agent`, no prompt
curvet login --all                        # every scope, no prompt
curvet login --no-browser                 # over SSH or in a container
curvet logout
```

It asks before it opens anything, because the defaults are apps-only and the
scope `curvet agent` needs is not among them:

```console
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

`agency:run` is kept out of the default deliberately: it is the only grant that
spends money on its own, so a token minted to rotate an app key should not also
be able to run agents. That is a reason to leave it out of the default, not a
reason to hide it — `curvet login --help` lists every scope, and `curvet auth
status` shows which ones your token actually holds.

With no terminal — piped, or in CI — nothing is asked and nothing extra is
granted. Use `--scope` there.

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
