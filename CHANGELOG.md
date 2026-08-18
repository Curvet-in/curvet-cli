# Changelog

All notable changes to `@curvet/cli` are documented here.

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
