# companion/ — personal companion capabilities

English | [中文](README.zh.md)

Capabilities extracted from the dsh-repl TUI so any front-end or agent runtime can reuse them. Each package is a pure logic library (no Cordis service): callers own the glue.

| Package | Role | ctx key |
|---|---|---|
| [`memory/`](memory/README.md) | Long-term memory store: five markdown tracks + prompt-snapshot rendering. | (library, no ctx key) |
| [`tool-companion/`](tool-companion/README.md) | Model-facing `memory` + `usage_status` tools over the two libraries. | `ctx.tools` |
| [`usage/`](usage/README.md) | API usage/quota status: opencode go windows + DeepSeek balance. | (library, no ctx key) |
| [`wechat/`](wechat/README.md) | Model-facing `wechat_send` tool over the host-side wechat-send skill script. | `ctx.tools` |

The child READMEs own the storage layout, endpoints, and rendering contracts.
