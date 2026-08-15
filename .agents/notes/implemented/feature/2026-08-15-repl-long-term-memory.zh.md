# Agent Note: TUI REPL 的跨会话长期记忆

Status: implemented

[English](2026-08-15-repl-long-term-memory.md) | 中文

## 问题

交互式 TUI REPL（`apps/repl/src/tui-repl.ts`）是驱动 agent 会话的终端前端。随着它逐渐成熟，用户每次会话都要重新录入同样的固定事实——姓名、语言偏好、项目的关键不变量。没有持久化，这些上下文在会话结束时就会丢失，每次新会话都从零开始。Web 产品和计划中的终端前端需要一种能跨会话、跨项目存活的记忆，而不是仅限当前终端的"上下文拐杖"。

## 决定

在 REPL 中新增一个五轨道、纯 Markdown 的长期记忆，作为一个自包含、零依赖的模块 `apps/repl/src/memory.ts`，并把记忆快照注入到每次提示中。该实现是对 `dsh-memory-evolve` 记忆核心的移植，适配了 TUI（无 `agent` 对象；项目轨道以工作区 `cwd` 作为键）。

- **五条轨道**，存储在 `~/.dsh-repl/memory` 下（可用 `DSH_REPL_MEMORY_DIR` 覆盖）：
  - `memory` → `MEMORY.md`（长期记忆，跨项目）
  - `user` → `USER.md`（用户档案，跨项目）
  - `daily` → `daily/YYYY-MM-DD.md`（每日日志，按项目打标）
  - `project` → `projects/<hash>/MEMORY.md`（项目日志）
  - `key` → `projects/<hash>/KEY.md`（项目关键记忆，按分支过滤，注入）
- **`MemoryStore`**（`memory.ts`）：纯 Markdown 分层存储，条目用 `\n§\n` 分隔，幂等 `[YYYY-MM-DD]` 日期戳（`add()` 跳过完全重复），可选的 git 分支标签，按分支过滤 `key` 轨道（`[branch:main,other]` 作用域标签；detached HEAD 保守放行全部），以及可移植的并发写入路径。纯逻辑且完全单元测试覆盖。
- **`renderMemorySnapshot`**：生成在下一轮提示之前注入的 markdown 块，让 agent 能跨会话看到记住的事实。memory/user/key 分别上限 12/8/12 条，每条截断到 160 字符。区块标题：`## 长期记忆（跨会话，始终遵守）`、`## 用户档案`、`## 本项目的关键记忆`。
- **TUI 集成**（`tui-repl.ts`）：快照拼接到 `client.prompt` 之前（为空时不注入），回合结束时自动追加 project/daily 日志，并提供一个 `/memory` 命令家族（`remember / user / key / project / daily / clear / view`）。项目身份是对规范化 `cwd` 做稳定 SHA-1、截取前 12 位 hex。

## 备选方案

**仅用"上下文"内存** — 拒绝。它会随终端销毁而消失，没有跨项目、跨会话的价值；重点在于持久化的耐用性。

**结构化存储（SQLite/JSON）** — 拒绝。纯 Markdown 文件人类可读，可用任意编辑器查看，且零依赖；五条轨道天然适合用独立文件表示，在此规模下性能无关紧要。

**全部用单个全局文件** — 拒绝。项目轨道会跨工作区泄漏，按分支过滤的 key 轨道也无处栖身；按项目 hash 的目录把状态按工作区隔离。

## 后果

现在 REPL 能跨会话、跨项目记住固定事实，数据来自磁盘承载的五轨 Markdown 存储。全局轨道（`memory`、`user`）跨会话、跨项目存活；项目轨道按 `cwd` hash 按工作区隔离，`key` 轨道再按当前 git 分支过滤。注入在记忆存在之前是无操作的，因此从不使用该功能的用户不会产生上下文或延迟成本。该模块零依赖、完全单元测试覆盖（`apps/repl/tests/memory.spec.ts` 30 个用例），与 REPL 其余核心逻辑一样受纯逻辑覆盖率门禁约束。

## 验证

`apps/repl/tests/memory.spec.ts`（30 个测试）覆盖 parse/serialize 往返、幂等日期戳、分支作用域过滤（含 detached HEAD 保守放行）、跨 `cwd` 项目隔离、完全重复去重、`remove` 计数，以及快照区块渲染。完整套件通过（`pnpm --filter @deepseek-ai/dsh-repl run test`）；TUI 集成经 `pnpm run build` 产出，并做交互验证。快照文本被逐字拼进提示，其精确区块标题由 spec 断言。
