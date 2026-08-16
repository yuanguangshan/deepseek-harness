---
name: dsh-memory
description: Use when you need cross-session long-term memory for the DeepSeek Harness — recording facts about the user, a project, or this workspace that should survive across sessions; reading back what was remembered; or injecting a memory snapshot into a prompt. The capability is @deepseek-ai/dsh-memory, extracted from the dsh-repl TUI.
---

# DSH Memory

Long-term memory for the DeepSeek Harness, packaged as `@deepseek-ai/dsh-memory` (source: `packages/companion/memory/`). Five markdown tracks persist under `~/.dsh-repl/memory/` (override `DSH_REPL_MEMORY_DIR`) and survive across sessions and projects.

## The five tracks

| Track | File | Scope |
|---|---|---|
| `memory` | `MEMORY.md` | Long-term memory, cross-project |
| `user` | `USER.md` | User profile, cross-project |
| `daily` | `daily/YYYY-MM-DD.md` | Per-day log, project-tagged |
| `project` | `projects/<hash>/MEMORY.md` | Per-project log |
| `key` | `projects/<hash>/KEY.md` | Project key facts, branch-filtered on read |

Project tracks key on the workspace `cwd` via a stable SHA-1 hash; `key` entries may carry a `[branch:<names>]` tag and are filtered to the live git branch on read.

## Using the store

```ts
import { MemoryStore, memoryDir, gitBranch, renderMemorySnapshot } from '@deepseek-ai/dsh-memory'

const memory = new MemoryStore({ dir: memoryDir() })

// Write: add stamps the entry (date/git) and dedupes by exact text.
memory.add('memory', 'the deploy runs on port 8080', cwd)          // cross-project fact
memory.add('user', 'prefers Chinese replies', undefined)           // user profile
memory.add('key', '[branch:main] auth uses JWT', cwd)              // project key fact
memory.add('project', 'built the migration tool', cwd)             // project log
memory.add('daily', 'finished the audit', cwd)                     // today's log

// Read: entriesOf returns raw entries (key is branch-filtered when keyBranchFilter is on).
memory.entriesOf('memory')              // all long-term entries
memory.entriesOf('key', cwd)            // branch-scoped key facts

// Inject: render the snapshot block to prepend to a model prompt ('' when empty).
const snapshot = renderMemorySnapshot({
  memory: memory.entriesOf('memory'),
  user: memory.entriesOf('user'),
  key: memory.entriesOf('key', cwd),
  branch: gitBranch(cwd),
})
```

## When to use it

- **Remember** a durable user preference, project fact, or decision so a later session (or another workspace) sees it: `memory.add(...)`.
- **Recall** what was remembered before answering a question that depends on prior context: `memory.entriesOf(...)`.
- **Inject** the snapshot into a prompt when the model should treat memory as standing context: prepend `renderMemorySnapshot(...)`.
- **Clean up**: `remove(target, needle)` deletes entries containing a needle; `clear(target)` empties a whole track (including every historical daily file).

## Known limitations

- `gitBranch` shells out to `git branch --show-current`; without git, branch filtering is conservatively disabled.
- `daily` tracks use the local timezone; entries written near midnight may land in the previous day's file.
- The default directory keeps the REPL name (`~/.dsh-repl/memory`) so existing dsh-repl user data keeps working.
