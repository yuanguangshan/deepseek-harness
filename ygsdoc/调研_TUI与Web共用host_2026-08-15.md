# 调研：让 TUI (dsh-repl) 与 web (dsh web) 共用同一 host 运行时进程

> 日期：2026-08-15 · 仓库：deepseek-harness
> 目标：evaluate 实现路径、改动范围、可行性，供后续决策。

## 背景

当前 TUI 与 web 通过「共享同一个会话存储根」实现读写互通（TUI 写入 `~/.dsh/sessions/.../session.jsonl.zstd`，web 重新打开该会话时 materialize 到最新），但属于**最终一致而非实时一致**：TUI 直接追加写 jsonl，web 进程不会实时追踪外部写入，需「重开会话 / 重启 web」才同步。本调研回答：技术上如何让两者**共用同一个 host 进程**，从而获得实时一致。

## 一、现状（代码事实）

### TUI（`apps/repl`）
- 入口：`src/bin.ts` → `runRepl`（`tui-repl.ts`）。
- 通过 `HarnessClient`（`packages/sdk/client/src/client.ts`）**spawn 一个独立 runtime 子进程**：
  - `command: process.execPath`
  - `args: [RUNTIME_BIN, CONFIG]`
  - `RUNTIME_BIN = packages/examples/jsonrpc-demo/lib/bin.js`
  - `CONFIG = examples/jsonrpc-agent/interactive.cordis.yml`
- 传输层：`JsonRpcLineTransport(child.stdout, child.stdin)` —— **硬编码在子进程 stdio 上**。
- 关键约束：`HarnessClient` **只支持 spawn 模式，无「连接已有 host」的网络模式**。
- `/model`、`/reload`、`/exit` 依赖「重启 runtime 子进程」。

### web（`apps/cli`）
- 入口：`node apps/cli/lib/bin.js web`（`--profile web`）。
- 启动**另一个独立 cordis host**（`$DSH_HOME/profiles/web/cordis.yml`），内置：
  - `dsh-host-webserver`（HTTP）
  - connection / WebSocket downlink（`/api` HTTP 桥 + WS）
  - 服务浏览器。
- 会话查询主要走 `session-query.db`（sqlite 索引）+ 运行时内存 session 对象。

## 二、为什么不能简单「连过去」

1. **协议栈不同**：
   - TUI 前端走 `dsh-sdk-protocol`（stdio 上的 JSON-RPC 行协议）。
   - web 前端走 `dsh-client-web`（HTTP + WebSocket）。
   - 两个不同纬度的前端协议。
2. **传输层均无网络实现**：
   - `HarnessClient`（客户端）：只 spawn stdio，无 socket/WS 连接构造。
   - `sdk-jsonrpc-server`（服务端，`packages/sdk/server/src/index.ts`）：默认 `process.stdin/stdout`。
3. **共同点（可行性基础）**：两者底层都是 `JsonRpcLineTransport`，其输入是**可注入的 `Readable`/`Writable` 流对**；server 侧配置暴露 `config.input`/`config.output` 可覆盖。→ 理论上可把 stdio 换成 socket/TCP/WS 流。

## 三、实现路径

**方向**：让 TUI 的 `HarnessClient` 连接到一个**已运行的 host**（web 那个），而不是各自 spawn 独立 runtime。

| 改动位置 | 内容 | 难度 |
|---|---|---|
| **web host 侧** | 在 web profile 额外装配 `sdk-jsonrpc-server`，把传输从 stdio 改为 **TCP/WebSocket**（复用 host WS 线路），暴露为 `dsh-sdk-protocol` 端点 | 中 |
| **TUI 侧 `HarnessClient`** | 新增「连接模式」：把 `JsonRpcLineTransport` 挂到 socket/WS 流而非 child.stdio；从「spawn runtime」改为「attach 到已运行 host 的 endpoint」 | 中偏上 |

### 核心难点
- `HarnessClient` 内部有完整进程生命周期管理（spawn / close / EOF→SIGTERM→SIGKILL ladder、runtimeEpoch 重建）。改为连接模式后：
  - `close` 语义、断线重连、`runtimeEpoch/restart` 都要重新设计。
  - TUI 的 `/model`、`/reload`、`/exit` 依赖「进程级重启」，共享 host 后这些路径的行为需重新定义（例如 `/model` 变为对共享 host 的配置变更而非重启子进程）。
- web host 目前**未暴露 sdk-protocol 服务端**，需新增装配。
- `session-query.db` / workspace 索引（`$DSH_HOME/storages/workspace.json`）在共享 host 后需统一由同一进程维护，避免两边索引分叉。

## 四、评估结论

- **可行性**：架构上**可行**，但**不是小改动** —— 需同时动 `sdk-jsonrpc-server`（加网络传输）与 `HarnessClient`（加连接模式 + 重构生命周期），并新增「web host 同时暴露 JSON-RPC 端点」的装配。
- **工作量**：中等偏上；涉及协议层（`dsh-sdk-protocol` / `dsh-sdk-server`）、运行时装配、TUI 生命周期，建议拆 1–2 次独立提交。
- **风险**：TUI 进程级运维路径（`/model` `/reload` `/exit`）在「共享 host」模型下语义变化，是最大耦合点。

## 五、建议

- **若目标仅是「能看、能同步」**：当前方案（共享存储根 + 手动/定时重载）已够用，不建议立即引入大改。
- **若目标是「真正实时同步」**：值得做，建议先做**最小可行原型**：
  1. 给 `sdk-jsonrpc-server` 增加 TCP 传输；
  2. 给 `HarnessClient` 增加 connect 模式；
  3. 跑通「TUI attach 到同一个 web host」验证实时性；
  4. 再按需完善 `/model`、`/reload` 在共享 host 下的语义。

## 关键代码位置速查
- TUI runRepl / runtime 启动：`apps/repl/src/tui-repl.ts`（~L813–867, L45 `RUNTIME_BIN`）
- TUI runtime bin / config：`apps/repl/src/core.ts` L22–29
- `HarnessClient`（仅 spawn stdio）：`packages/sdk/client/src/client.ts`
- 行协议 transport（流可注入）：`packages/sdk/protocol/src/transport.ts`
- `sdk-jsonrpc-server`（stdio、输入输出可覆盖）：`packages/sdk/server/src/index.ts`
- web profile：`$DSH_HOME/profiles/web/cordis.yml`
