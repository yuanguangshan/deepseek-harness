# @deepseek-ai/dsh-tool-companion

English | [中文](README.zh.md)

Model-facing companion tools over the dsh-memory and dsh-usage libraries: `memory` (record, read, remove, clear) and `usage_status` (current quota).

## What it does

Registers two tools on `ctx.tools`.

`memory(op, target, content?, needle?)` drives the five [dsh-memory](../memory/README.md) tracks — `memory`, `user`, `daily`, `project`, `key` — with four operations:

- `add` — record one entry (date-stamped where the store is configured).
- `entries` — read back the whole track, one numbered entry per line.
- `remove` — drop entries whose text contains `needle`.
- `clear` — empty the whole track (for `daily`, every historical log file).

`project`/`key` entries are pinned to the workspace directory (`exec.agent.session.header.cwd`, falling back to `process.cwd()`), matching the store's project-hash layout; `daily` uses it as its project tag.

`usage_status()` reads the [dsh-usage](../usage/README.md) ZCode config, queries opencode go and DeepSeek, and returns the compact quota line (`OC 99% 43% 65% ⇠3h · DS ¥21.4`) or an explanation when no quota data is available.

## Configuration

Both config keys are optional; omitted keys fall back to the library defaults (the same environment overrides apply: `DSH_REPL_MEMORY_DIR`, `DSH_REPL_ZCODE_CONFIG`).

- `memoryDir` — memory root directory (default `~/.dsh-repl/memory`).
- `zcodeConfigPath` — ZCode config path (default `~/.zcode/v2/config.json`).

## Validation

`schema` enforces `op`/`target` enums and requiredness. `execute` rejects a blank `content` on `add` and a blank `needle` on `remove` with stable errors; every other invalid input is rejected at the schema boundary.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `Config` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`memory` and `usage_status` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-companion) with their model-facing descriptions (track/op guidance for `memory`, window/balance semantics for `usage_status`).

#### Token effect

Fixed schema cost on every request where the tools are visible.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from these schemas.

### Tool-call history and result

#### What the model sees

Each `memory` call's operation and payload stays in its arguments; each result is the rendered text line (success or stable `Error: memory add requires a non-empty \`content\`` / `Error: memory remove requires a non-empty \`needle\``). `usage_status` returns the quota line, or `No quota providers found (...)`, or `Quota data unavailable (...)`.

#### Token effect

One rendered text line per successful call; rejected calls return a short stable error. `memory.entries` output grows with the track, so recall requests are bounded by the caller's own prompt budget.

#### KV Cache effect

Independent; these tools neither assemble nor send a provider request beyond the quota endpoints they query.

## Known Limitations and Deferred Work

- **Host-side state** — memory files and the ZCode config live on the host disk, not in the session log. The log reconstructs every call's inputs and outputs (`tool/call`, `tool/result`), but not the underlying file state; two deployments pointing at different directories see different memory.
- **No quota refresh control** — `usage_status` queries on every call; there is no caching or TTL. A deployment that calls it frequently pays a request per call.
