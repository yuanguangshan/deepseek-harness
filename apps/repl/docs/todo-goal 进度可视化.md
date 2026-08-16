# repl TUI 功能：todo/goal 进度可视化

> 记录日期：2026-08-16
> 状态：已实现并打包（含 `deepseek-ai-dsh-repl-0.1.0-rc.5.tgz`）

## 背景 / 动机

Agent 在干活时通过 dsh 内置的 `todo_write`（任务清单）和 `create_goal`/`update_goal`（目标）更新进度，这些数据通过 `todo/write`、`goal/change` 事件广播。但 repl TUI 之前**没有渲染它们**，导致用户看不到"Agent 进行到哪个任务 / 目标做到第几轮"，界面不清晰。

本功能让 repl TUI 在**底部状态行**实时显示 Agent 的 todo 清单 + 当前目标进度。

## 显示方案（用户确认）

- **显示位置（方案 C）**：底部状态行——在 `editor` 与 `statusBar` 之间新增一行 `todosView`。
- **也显示 goal**：显示目标 `objective`、阶段 `phase`、进度 `轮次/上限`、受阻原因。
- 无 todo/goal 时该行自动隐藏（不占布局）。

## 数据流

```
todo_write  工具 → session event "todo/write" { todos:[{content,status}] }
create/update_goal → session event "goal/change" { goal:{...}, roundsStarted }

  → reduceSessionEvent(state, event) 产出 effect:
       { kind:'todoWrite', todos:[TodoView] }
       { kind:'goalChange', goal:GoalView|undefined, roundsStarted }
  → applyEffects 更新 latestTodos/latestGoal → renderTodoBar()
  → todosView.setText(...) 渲染到底部
```

- `TodoView`: `{ content, status }`（status ∈ `pending|in_progress|completed`）
- `GoalView`: `{ objective, phase, maxGoalRounds, blockedReason }`

## 改动文件

| 文件 | 改动 |
|---|---|
| `apps/repl/src/session-reducer.ts` | 新增 effect 类型 `todoWrite` / `goalChange`；加 `case 'todo/write'`（提取 todos，trim 后过滤空项）、`case 'goal/change'`（提取 goal + roundsStarted）；定义 `TodoView`/`GoalView` |
| `apps/repl/src/tui-repl.ts` | 新增 `todosView` Text widget（VStack 里 editor 与 statusBar 之间）；`renderTodoBar()` 渲染 goal + todo；`applyEffects` 处理两个新 effect；import 类型 |
| `apps/repl/tests/session-reducer.spec.ts` | 新增 5 个测试（快照、空项过滤、goal 提取、受阻 reason、未知事件惰性）|

## 渲染样式

- 目标行：`🎯 <objective>  [轮次/上限] (phase)` + 受阻时 `受阻: <reason>`
- 待办行：`▸`（进行中，绿色）/ `·`（待办），已完成项**灰显**
- 最多显示 3 条待办（`MAX_TODO_ROWS`），超出的显示 `… 还有 N 项待办`
- 底部 `✓ 已完成 N 项`

示例：
```
🎯 集成todo可视化  [2/4]
▸ 等对方收尾
· 最终审查
✓ 已完成 2 项
```

## 验证

- `tsc -b` 通过
- `tsdown` 打包 `lib/bin.js`（182KB，含 `renderTodoBar`/`todoWrite`/`goalChange`）
- `session-reducer.spec.ts` **35/35**（含新增 5 个）
- repl 全测试回归 **242 通过 / 1 跳过**，无回归
- `pnpm pack` 出 `apps/repl/deepseek-ai-dsh-repl-0.1.0-rc.5.tgz`（65,554 B），解压验证含最新 `lib/bin.js`

## 备注

- `wechat_send` 不在 repl 的 bin.js 里（那是 `@deepseek-ai/dsh-wechat` 插件的 tool）；repl 自身用 `/weixin` 命令（`sendToWechat`）。
- 展示需用重新打包的 `dsh-repl` 启动才可见。
