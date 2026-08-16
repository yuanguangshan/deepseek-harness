# @deepseek-ai/dsh-tool-companion

[English](README.md) | 中文

面向模型的伴侣工具，基于 dsh-memory 和 dsh-usage 两个库：`memory`（记录、读取、移除、清空）和 `usage_status`（当前配额）。

## 功能

在 `ctx.tools` 上注册两个工具。

`memory(op, target, content?, needle?)` 驱动 [dsh-memory](../memory/README.md) 的五条轨道 — `memory`、`user`、`daily`、`project`、`key` — 提供四个操作：

- `add` — 记录一条（按 store 配置加日期前缀）。
- `entries` — 读回整条轨道，每行一条带序号。
- `remove` — 删除文本包含 `needle` 的条目。
- `clear` — 清空整条轨道（`daily` 会删除所有历史日志文件）。

`project`/`key` 条目锚定到工作目录（`exec.agent.session.header.cwd`，回退到 `process.cwd()`），与 store 的 project-hash 布局一致；`daily` 用它作为项目标签。

`usage_status()` 读取 [dsh-usage](../usage/README.md) 的 ZCode 配置，查询 opencode go 和 DeepSeek，返回紧凑配额行（`OC 99% 43% 65% ⇠3h · DS ¥21.4`）；没有配额数据时返回说明文字。

## 配置

两个配置键都可选；省略时回退到库默认（同样的环境变量覆盖生效：`DSH_REPL_MEMORY_DIR`、`DSH_REPL_ZCODE_CONFIG`）。

- `memoryDir` — 记忆根目录（默认 `~/.dsh-repl/memory`）。
- `zcodeConfigPath` — ZCode 配置路径（默认 `~/.zcode/v2/config.json`）。

## 校验

`schema` 强制 `op`/`target` 枚举与必填项。`execute` 以稳定的错误拒绝 `add` 的空白 `content` 和 `remove` 的空白 `needle`；其余非法输入都在 schema 边界被拒。

## 导出形态

函数/命名空间插件：导出 `name` / `inject` / `Config` / `apply`，无 default 导出。多余的 `export default` 会让 Loader 的 `unwrapExports` 折叠模块并丢掉 `inject`（见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## Model Experience

### Tool schema

#### What the model sees

模型看到生成的 [`memory` 与 `usage_status` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-companion) 及其面向模型的描述（`memory` 的轨道/操作指引，`usage_status` 的窗口/余额语义）。

#### Token effect

工具可见时每次请求的固定 schema 成本。

#### KV Cache effect

定义与可见性不变时前缀稳定。插件生命周期或作用域限制可能使这些 schema 的复用失效。

### Tool-call history and result

#### What the model sees

每次 `memory` 调用的操作与载荷保留在参数里；结果都是渲染后的文本行（成功，或稳定的 `Error: memory add requires a non-empty \`content\`` / `Error: memory remove requires a non-empty \`needle\``）。`usage_status` 返回配额行、`No quota providers found (...)` 或 `Quota data unavailable (...)`。

#### Token effect

每次成功调用一行渲染文本；被拒调用返回一行短错误。`memory.entries` 的输出随轨道增长，因此召回请求由调用方自己的 prompt 预算约束。

#### KV Cache effect

独立；除查询的配额端点外，这些工具不组装也不发送 provider 请求。

## 已知限制与待办

- **宿主侧状态** — 记忆文件与 ZCode 配置在宿主磁盘上，不在会话日志里。日志可重建每次调用的输入输出（`tool/call`、`tool/result`），但无法重建底层文件状态；指向不同目录的两个部署看到不同的记忆。
- **无配额刷新控制** — `usage_status` 每次调用都查询；没有缓存或 TTL。频繁调用的部署每次调用都要付一次请求。
