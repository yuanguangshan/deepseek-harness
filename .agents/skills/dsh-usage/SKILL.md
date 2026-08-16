---
name: dsh-usage
description: Use when you need API usage/quota status for the DeepSeek Harness — checking opencode go rolling-window usage percentages or DeepSeek account balance, reading credentials from the ZCode config, or rendering a quota status line. The capability is @deepseek-ai/dsh-usage, extracted from the dsh-repl TUI.
---

# DSH Usage

API usage/quota status for the DeepSeek Harness, packaged as `@deepseek-ai/dsh-usage` (source: `packages/companion/usage/`). Credentials come from `~/.zcode/v2/config.json` (override `DSH_REPL_ZCODE_CONFIG`); two provider kinds are discovered by matching the provider `baseURL`.

## The two providers

| Kind | Endpoint | Shows |
|---|---|---|
| `opencode` (baseURL contains `opencode.ai`) | `GET {baseURL}/usage` | Three rolling-window usage percentages (rolling / weekly / monthly) |
| `deepseek` (baseURL contains `deepseek.com`) | `GET {baseURL}/user/balance` | Total balance in CNY |

## Querying and rendering

```ts
import { fetchUsageSnapshot, formatUsageStatus, loadUsageProvidersFromDisk } from '@deepseek-ai/dsh-usage'

const providers = loadUsageProvidersFromDisk()      // [] when the config is missing/malformed
const snapshot = await fetchUsageSnapshot(providers) // both halves; a failed query leaves that half empty
const line = formatUsageStatus(snapshot)             // 'OC 99% 43% 65% ⇠3h · DS ¥21.4' or ''
```

`formatUsageStatus` accepts an injectable style set (`{ green, yellow, red, gray }`) for ANSI coloring; without one it renders plain text. opencode shows the *remaining* percent of each window plus the nearest reset countdown; DeepSeek shows its balance. The status line is empty when neither provider produced data, so a quota display can be a no-op until providers exist.

`usageSegments(snapshot)` returns the raw `{ text, tone }` segments if you want to render them yourself; `loadUsageProviders(configText)` parses a config string without touching disk.

## When to use it

- **Report quota** before or after an expensive run: query both providers and summarize the opencode windows (heat tone: green <50, yellow 50-79, red ≥80) and the DeepSeek balance.
- **Warn on low balance** — the DeepSeek segment turns red below ¥5 and yellow below ¥20; surface that before a long task.
- **Discover providers** — `loadUsageProvidersFromDisk` also serves as the canonical way to find opencode/deepseek credentials in the ZCode config.

## Known limitations

- Provider discovery is keyword-based: a custom gateway whose `baseURL` contains neither `opencode.ai` nor `deepseek.com` is not picked up.
- The default fetcher is `globalThis.fetch`; unit tests inject a stub because the endpoints are real network calls.
