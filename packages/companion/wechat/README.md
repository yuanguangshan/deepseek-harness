# @deepseek-ai/dsh-wechat

English | [中文](README.zh.md)

The model-facing `wechat_send` tool: send a plain-text message to WeChat through the local wechat-send skill script.

## What it does

Registers one tool, `wechat_send(text)`, on `ctx.tools`. Execution spawns `~/.pi/agent/skills/wechat-send/scripts/send.py` (Python 3) with the text as an argv argument and `--weclaw-first`: the WECLAW channel is tried first, falling back to the local weixinpush channel. The payload travels through the argv array with no shell interpolation, so quotes, newlines, hashes, and HTML stay safe. Any host or agent that mounts this plugin (web, dsh-tui, repl, or a headless profile that bundles the package) can let the model send a WeChat message.

The result is a short Chinese status line: `已发送到微信（channel=…）` on success, or the script's error text; an empty script output reports a failed send rather than pretending success.

## Prerequisites

The tool is a thin dispatcher over a host-side skill script. Sending works only when the host has:

- Python 3 (`python3`, or the `WECHAT_SEND_PY` override).
- The wechat-send skill at `~/.pi/agent/skills/wechat-send/scripts/send.py` (or the `WECHAT_SEND_SCRIPT` override), with at least one reachable WeChat channel.

## Configuration

The two host paths are read from the environment at module load, not from a validated `Config`:

- `WECHAT_SEND_SCRIPT` — the send script path (default `~/.pi/agent/skills/wechat-send/scripts/send.py`).
- `WECHAT_SEND_PY` — the Python interpreter (default `python3`).

A 30-second budget kills a stuck script; a kill reports the send as failed.

## Validation

`schema` requires a non-empty `text` string. `execute` rejects a whitespace-only message with `没有可发送的内容（空文本）`; every other failure surfaces as the script's error text instead of a silent success.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`wechat_send` schema](../../../docs/tool-catalog.md#deepseek-aidsh-wechat) with its model-facing description.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each call's `text` stays in its arguments; the result is the short status line, or the script's error text.

#### Token effect

One short text line per call.

#### KV Cache effect

Independent; the tool neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Host-side skill dependency** — the tool only dispatches; sending requires the host Python script and at least one configured WeChat channel. Without them every call reports a failure.
- **Environment-variable configuration** — the script and interpreter paths are read from the environment at module load instead of validated `Config` fields; a deployment that needs per-instance paths must set the variables before mounting the plugin.
- **Plain text only** — the tool sends the raw text as given; there is no image, file, or formatting support.
