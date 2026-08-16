# dsh-usage

English | [中文](README.zh.md)

API usage/quota status for the DeepSeek Harness, extracted from the dsh-repl TUI so any front-end or agent runtime can reuse the same quota display.

## Providers

Credentials come from `~/.zcode/v2/config.json` (override with `DSH_REPL_ZCODE_CONFIG`). Two provider kinds are discovered by matching the provider `baseURL`:

| Kind | Endpoint | Shows |
|---|---|---|
| `opencode` (baseURL contains `opencode.ai`) | `GET {baseURL}/usage` | Three rolling-window usage percentages (rolling / weekly / monthly) |
| `deepseek` (baseURL contains `deepseek.com`) | `GET {baseURL}/user/balance` | Total balance in CNY |

## Usage

```ts
import { fetchUsageSnapshot, formatUsageStatus, loadUsageProvidersFromDisk } from '@deepseek-ai/dsh-usage'

const providers = loadUsageProvidersFromDisk()
const snapshot = await fetchUsageSnapshot(providers)          // both halves; failures leave that half empty
const line = formatUsageStatus(snapshot)                      // 'OC 99% 43% 65% ⇠3h · DS ¥21.4' or ''
```

`formatUsageStatus` takes an injectable style set (`{ green, yellow, red, gray }`) for ANSI coloring; without one it renders plain text. opencode shows the *remaining* percent of each window plus the nearest reset countdown; DeepSeek shows its balance. The status line is empty when neither provider produced data, so a quota display can be a no-op until providers exist.

## Model Experience

Indirectly, through the caller that renders the quota status line (the REPL status bar); nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Provider discovery is keyword-based** — a provider is classified opencode/deepseek by substring-matching its `baseURL`; a custom gateway or proxy that does not contain those substrings is not picked up.
- **`fetchImpl` is required for network tests** — the default fetcher is `globalThis.fetch`; unit tests inject a stub because the endpoints are real network calls.
- **The default config path keeps the REPL name** — the config defaults to `~/.zcode/v2/config.json` so existing dsh-repl quota data keeps working; the `DSH_REPL_ZCODE_CONFIG` override stays available.
