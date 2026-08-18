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
| `curvet models [--type chat] [--cheapest]` | List models; keyless via the public catalogue, per-app (with rate limits) once logged in |
| `curvet chat "prompt"` | Chat with streaming output; add `-m`, `-s`, `-t`, `--max-tokens` |
| `curvet balance [--watch]` | Credit balance breakdown; `--watch` polls and shows burn rate |
| `curvet auth login\|status\|use` | Manage profiles and credentials |
| `curvet config list\|get\|set\|unset` | Read and write CLI settings |
| `curvet doctor` | Diagnose config, key scopes, connectivity, and headroom |

### Pipes are first-class

```bash
cat error.log | curvet chat "explain this stack trace"
git diff | curvet chat "review this change" -m claude-sonnet-4-6
curvet chat --json "hello" | jq .usage.credits
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

## Roadmap

- `curvet video|audio|3d` with live progress bars, `curvet jobs`, `curvet workflows`
- `curvet ent` — invites, members, credits, pool access
- `curvet init <opencode|cline|zed|copilot>` — point your coding tool at Curvet
- `curvet proxy` — local OpenAI-compatible proxy
- `curvet login` — browser device flow for app management and key rotation

## Development

```bash
npm install
npm run dev -- models      # run from source
npm test
npm run build
```

MIT © Curvet
