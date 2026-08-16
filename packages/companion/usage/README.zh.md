# dsh-usage

[English](README.md) | 中文

DeepSeek Harness 的 API 用量/配额状态，从 dsh-repl TUI 抽取，任何前端或 agent 运行时都可复用同一套配额展示。

## 提供方

凭证来自 `~/.zcode/v2/config.json`（可用 `DSH_REPL_ZCODE_CONFIG` 覆盖）。按 provider 的 `baseURL` 关键字匹配发现两类提供方：

| 类型 | 端点 | 展示 |
|---|---|---|
| `opencode`（baseURL 含 `opencode.ai`） | `GET {baseURL}/usage` | 三个滚动窗口用量百分比（rolling / weekly / monthly） |
| `deepseek`（baseURL 含 `deepseek.com`） | `GET {baseURL}/user/balance` | 总余额（CNY） |

## 用法

```ts
import { fetchUsageSnapshot, formatUsageStatus, loadUsageProvidersFromDisk } from '@deepseek-ai/dsh-usage'

const providers = loadUsageProvidersFromDisk()
const snapshot = await fetchUsageSnapshot(providers)          // both halves; failures leave that half empty
const line = formatUsageStatus(snapshot)                      // 'OC 99% 43% 65% ⇠3h · DS ¥21.4' or ''
```

`formatUsageStatus` 接受可注入的样式集（`{ green, yellow, red, gray }`）做 ANSI 着色；不传则输出纯文本。opencode 展示每个窗口的*剩余*百分比和最近的重置倒计时；DeepSeek 展示余额。当两个提供方都没有数据时状态行返回空串，因此配额展示在提供方出现前可以是 no-op。

## Model Experience

间接通过调用方渲染配额状态行（如 REPL 的状态栏）；本包不接触任何模型请求。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## 已知限制与待办

- **提供方发现基于关键字** —— 按 `baseURL` 子串匹配分类 opencode/deepseek；不含这些子串的自定义网关或代理不会被识别。
- **网络测试需要 `fetchImpl`** —— 默认 fetcher 是 `globalThis.fetch`；由于端点是真实网络调用，单测注入桩函数。
- **默认配置路径保留 REPL 名称** —— 配置默认在 `~/.zcode/v2/config.json`，以保持既有 dsh-repl 配额数据可用；`DSH_REPL_ZCODE_CONFIG` 覆盖仍然有效。
