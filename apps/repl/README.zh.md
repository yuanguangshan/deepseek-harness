# `@deepseek-ai/dsh-repl`

[English](README.md) | 中文

面向 DeepSeek Harness JSON-RPC agent 运行时的交互式 TUI REPL 前端。它通过 stdio 驱动内置的 `dsh-jsonrpc-agent`，实时流式展示 assistant 文本、思考过程与工具卡片，并保留 agent 会话的 transcript 与跨会话记忆。它正是产品为取代已移除 `dsh-tui` 决策而需要的终端前端。

## 入口

二进制名为 `dsh-repl`，由 `apps/repl/tsdown.config.ts` 从 `lib/bin.js` 打包（[`src/bin.ts`](src/bin.ts) 是薄入口，`/* v8 ignore file */`）。在已构建的检出目录下，从仓库根目录运行（脚本委托给 `apps/repl`）：

```sh
pnpm run build
pnpm dsh-repl
```

启动时若存在最近一个持久化会话则打开它，否则新建。`/new` 新建会话，`/resume` 切换到历史会话（支持跨工作区，带 `cwd` 交接）。

## 命令

| 输入 | 用途 |
|---|---|
| `/model` | 通过可搜索过滤框切换模型，或重载运行时。 |
| `/resume` | 重开历史会话（跨工作区，带 `cwd` 交接）。 |
| `/new` | 新建会话。 |
| `/memory` | 显示下一次将被注入的记忆快照。 |
| `/memory remember <事实>` | 记入跨会话长期记忆条目。 |
| `/memory user <档案>` | 记入用户档案条目。 |
| `/memory key <事实>` | 记入项目关键记忆条目（按 git 分支过滤）。 |
| `/memory project <日志>`、`/memory daily <日志>` | 追加项目或每日日志条目。 |
| `/memory clear <all\|memory\|user\|key\|project\|daily>` | 清空指定轨道。 |
| `ESC` | 中断进行中的流式回合（作为 `session.cancel`）。 |

以 `@` 开头的 token 触发文件补全。`Ctrl+C` 退出进程。

## 长期记忆

五条纯 Markdown 轨道存储在 `~/.dsh-repl/memory` 下（`DSH_REPL_MEMORY_DIR` 可覆盖根目录）：

- `memory` → `MEMORY.md`（跨项目长期记忆）
- `user` → `USER.md`（跨项目用户档案）
- `daily` → `daily/YYYY-MM-DD.md`（每日日志，按项目打标）
- `project` → `projects/<hash>/MEMORY.md`（项目日志）
- `key` → `projects/<hash>/KEY.md`（项目关键记忆，按 git 分支过滤）

快照作为记忆上下文块拼到每次提示之前，为空时为无操作。详见[长期记忆 Agent Note](../../.agents/notes/implemented/feature/2026-08-15-repl-long-term-memory.md)；纯存储与渲染逻辑在 [`src/memory.ts`](src/memory.ts)。

## 架构

TUI 以 TypeScript 形式纳入仓库门禁，把纯逻辑与终端 I/O 分开：

- [`src/tui-repl.ts`](src/tui-repl.ts) — 终端 glue：pi-tui 组件、订阅循环、输入处理、提示注入。
- [`src/core.ts`](src/core.ts) 与 [`src/session-reducer.ts`](src/session-reducer.ts) — 纯逻辑与事件→效果映射（唯一值得断言的核）。
- [`src/memory.ts`](src/memory.ts) — 纯五轨记忆存储与快照渲染。
- [`src/pet.ts`](src/pet.ts)、[`src/usage.ts`](src/usage.ts)、[`src/model-picker.ts`](src/model-picker.ts)、[`src/atfile.ts`](src/atfile.ts)、[`src/history.ts`](src/history.ts) — 支撑性纯模块。

按 [REPL 采用 Note](../../.agents/notes/implemented/architecture/2026-08-14-repl-adoption-and-reducer.md)，`tui-repl.ts`、`bin.ts`、`dev.ts` 作为无法断言的 glue 被排除在覆盖率之外，而 `core.ts`、`session-reducer.ts`、`memory.ts` 受按文件的覆盖率门禁约束。

## 开发

生产运行需要先构建：先 `pnpm run build`，再 `pnpm dsh-repl <args...>`。单元套件用 `pnpm --filter @deepseek-ai/dsh-repl run test` 运行，并与仓库其余部分一样受 typecheck/lint/coverage 门禁约束。
