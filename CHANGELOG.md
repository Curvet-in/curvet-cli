# Changelog

All notable changes to `@curvet/cli` are documented here.

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
