# dsh-memory

[English](README.md) | 中文

DeepSeek Harness 的长期记忆，从 dsh-repl TUI 抽取，任何前端或 agent 运行时都可复用同一份存储。

## 轨道

五个 markdown 轨道存放在 `~/.dsh-repl/memory/`（可用 `DSH_REPL_MEMORY_DIR` 覆盖），全局轨道天然跨会话、跨项目存活：

| 轨道 | 文件 | 范围 |
|---|---|---|
| `memory` | `MEMORY.md` | 长期记忆，跨项目 |
| `user` | `USER.md` | 用户档案，跨项目 |
| `daily` | `daily/YYYY-MM-DD.md` | 按日日志，带项目标签 |
| `project` | `projects/<hash>/MEMORY.md` | 按项目日志 |
| `key` | `projects/<hash>/KEY.md` | 项目关键事实，读取时按分支过滤 |

项目轨道以工作区 `cwd` 的稳定 SHA-1 哈希为键；`key` 条目可带 `[branch:<names>]` 标签，读取时按当前 git 分支过滤（detached HEAD 时保守地关闭过滤）。

## 用法

```ts
import { MemoryStore, memoryDir, renderMemorySnapshot } from '@deepseek-ai/dsh-memory'

const memory = new MemoryStore({ dir: memoryDir() })
memory.add('memory', 'the deploy runs on port 8080', cwd)
memory.add('key', '[branch:main] auth uses JWT', cwd)

// Build the markdown block to prepend to the next model prompt ('' when empty).
const snapshot = renderMemorySnapshot({
  memory: memory.entriesOf('memory'),
  user: memory.entriesOf('user'),
  key: memory.entriesOf('key', cwd),
  branch: gitBranch(cwd),
})
```

条目在添加时打日期戳（幂等），并按完全相同的文本去重。`remove` 删除包含指定文本的条目；`clear` 清空整个轨道（包括所有历史日志文件）。

## Model Experience

间接通过调用方把 `renderMemorySnapshot` 渲染进模型 prompt（如 REPL 的 prompt 注入）。

#### KV Cache effect

注入的快照前缀稳定；更长或重排的快照会改变 prompt 前缀，可能使复用失效。

## 已知限制与待办

- **git 标签依赖 `git` 命令** —— `gitBranch` 通过 `execFileSync` 执行 `git branch --show-current`；缺少 git 时按无分支处理（保守：关闭 key 过滤）。
- **`daily` 轨道使用本地时区** —— `todayStamp`/`timeStamp` 按本地日期/时间格式化；接近午夜写入的条目可能落在读者时钟的"前一天"文件里。
- **默认目录保留 REPL 名称** —— 存储默认在 `~/.dsh-repl/memory`，以保持既有 dsh-repl 用户数据可用；未来改名是破坏性变更，暂无计划。
