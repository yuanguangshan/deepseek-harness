# dsh-memory

English | [中文](README.zh.md)

Long-term memory for the DeepSeek Harness, extracted from the dsh-repl TUI so any front-end or agent runtime can share one store.

## Tracks

Five markdown tracks live under `~/.dsh-repl/memory/` (override with `DSH_REPL_MEMORY_DIR`), so global tracks survive across sessions and projects:

| Track | File | Scope |
|---|---|---|
| `memory` | `MEMORY.md` | Long-term memory, cross-project |
| `user` | `USER.md` | User profile, cross-project |
| `daily` | `daily/YYYY-MM-DD.md` | Per-day log, project-tagged |
| `project` | `projects/<hash>/MEMORY.md` | Per-project log |
| `key` | `projects/<hash>/KEY.md` | Project key facts, branch-filtered on read |

Project tracks key on the workspace `cwd` via a stable SHA-1 hash; `key` entries may carry a `[branch:<names>]` tag and are filtered to the live git branch on read (detached HEAD conservatively disables the filter).

## Usage

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

Entries are date-stamped on add (idempotent) and deduplicated by exact text. `remove` deletes entries containing a needle; `clear` empties a whole track (including every historical daily file).

## Model Experience

Indirectly, through the caller that renders `renderMemorySnapshot` into a model prompt (the REPL's prompt injection).

#### KV Cache effect

Prefix-stable for the injected snapshot; a longer or reordered snapshot changes the prompt prefix and can invalidate reuse.

## Known Limitations and Deferred Work

- **Git tagging shells out to `git`** — `gitBranch` runs `git branch --show-current` via `execFileSync`; a missing git binary resolves to no branch (conservative: key filtering is disabled).
- **`daily` tracks use the local timezone** — `todayStamp`/`timeStamp` format the local date/time; entries written near midnight may land in the previous day's file by the reader's clock.
- **The default directory keeps the REPL name** — the store defaults to `~/.dsh-repl/memory` so existing dsh-repl user data keeps working; a future rename is a compatibility break and is not planned.
