/**
 * Model-facing companion tools over the dsh-memory and dsh-usage libraries:
 * `memory` (add/entries/remove/clear over the five tracks) and `usage_status`
 * (opencode rolling-window remaining percents plus DeepSeek balance). Tools
 * keep host-side state on disk (memory files, the ZCode config) exactly like
 * the TUI they were extracted from; the session log reconstructs every call's
 * inputs and outputs via `tool/call` and `tool/result`. Named exports preserve
 * loader injection metadata.
 * @module @deepseek-ai/dsh-tool-companion
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MemoryStore, memoryDir } from '@deepseek-ai/dsh-memory'
import { fetchUsageSnapshot, formatUsageStatus, loadUsageProvidersFromDisk, usageConfigPath } from '@deepseek-ai/dsh-usage'

export const name = 'tool-companion'
export const inject = ['tools']

/** Model-facing tool-companion configuration. */
export interface Config {
  /**
   * Memory root directory override (defaults to `~/.dsh-repl/memory`, see
   * {@link memoryDir} in dsh-memory).
   */
  memoryDir?: string
  /**
   * ZCode config path override (defaults to `~/.zcode/v2/config.json`, see
   * {@link usageConfigPath} in dsh-usage).
   */
  zcodeConfigPath?: string
}

/** Schemastery configuration for the tool-companion consumer. */
export const Config: z<Config> = z.object({
  memoryDir: z.string(),
  zcodeConfigPath: z.string(),
})

/** The `memory` tool's track choices (mirrors {@link MemoryTarget}). */
const MEMORY_TRACKS = ['memory', 'user', 'daily', 'project', 'key'] as const

/** The `memory` tool's operation choices. */
const MEMORY_OPS = ['add', 'entries', 'remove', 'clear'] as const

/** Tracks that need the workspace directory (project/key to locate, daily for its project tag). */
const CWD_TRACKS: ReadonlySet<string> = new Set(['daily', 'project', 'key'])

/** Schema-validated `memory` tool arguments. */
export interface MemoryArgs {
  op: (typeof MEMORY_OPS)[number]
  target: (typeof MEMORY_TRACKS)[number]
  content?: string
  needle?: string
}

/**
 * Run one memory operation and render its result text. Pure enough to unit
 * test without a Cordis context; the plugin wires it to the tool's execute.
 * @param config - the plugin configuration (directory overrides).
 * @param args - the schema-validated operation.
 * @param cwd - the workspace directory for project/key/daily tracks.
 * @returns the model-facing result text.
 */
export function runMemoryOp(config: Config, args: MemoryArgs, cwd: string): string {
  const store = new MemoryStore({ dir: config.memoryDir ?? memoryDir() })
  const scope = CWD_TRACKS.has(args.target) ? cwd : undefined
  switch (args.op) {
    case 'add': {
      const content = args.content?.trim() ?? ''
      if (content.length === 0) throw new Error('memory add requires a non-empty `content`')
      store.add(args.target, content, scope)
      return `Recorded to ${args.target} track.`
    }
    case 'entries': {
      const entries = store.entriesOf(args.target, scope)
      if (entries.length === 0) return `No entries in ${args.target} track.`
      return entries.map((entry, index) => `${index + 1}. ${entry}`).join('\n')
    }
    case 'remove': {
      const needle = args.needle?.trim() ?? ''
      if (needle.length === 0) throw new Error('memory remove requires a non-empty `needle`')
      const removed = store.remove(args.target, needle, scope)
      if (removed === 0) return `No matching entries in ${args.target} track.`
      return `Removed ${removed} entr${removed === 1 ? 'y' : 'ies'} from ${args.target} track.`
    }
    case 'clear': {
      store.clear(args.target, scope)
      return `Cleared ${args.target} track.`
    }
  }
}

/**
 * Query the configured providers and render the quota status line. Network
 * access goes through the dsh-usage default fetch (globalThis.fetch), so
 * tests stub the global rather than threading a fetcher through config.
 * @param config - the plugin configuration (path overrides).
 * @returns the status line, or an explanation when no quota data is available.
 */
export async function runUsageStatus(config: Config): Promise<string> {
  const providers = loadUsageProvidersFromDisk(config.zcodeConfigPath ?? usageConfigPath())
  if (providers.length === 0) {
    return 'No quota providers found (no opencode.ai or deepseek.com provider in the ZCode config).'
  }
  const snapshot = await fetchUsageSnapshot(providers)
  const line = formatUsageStatus(snapshot)
  return line.length > 0 ? line : 'Quota data unavailable (queries failed or returned nothing).'
}

/** Shared output schema for both tools: one rendered text line. */
const textSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
  },
} as const

/**
 * Register the `memory` and `usage_status` tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's directory overrides (both optional).
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'memory',
    description: 'Record, read, remove, or clear cross-session memory. Tracks: '
      + '`memory` (general durable facts), `user` (facts about the user), `daily` '
      + '(`today\'s log entries`), `project` (facts about the current workspace), '
      + '`key` (branch-scoped project keys). Use `entries` to recall what was '
      + 'remembered before relying on it; record durable facts with `add`.',
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: [...MEMORY_OPS],
        description: 'add (record content) | entries (read back) | remove (by substring) | clear (whole track).',
      },
      target: {
        type: 'string',
        required: true,
        enum: [...MEMORY_TRACKS],
        description: 'memory | user | daily | project | key.',
      },
      content: {
        type: 'string',
        description: 'Entry text to record; required when op is `add`.',
      },
      needle: {
        type: 'string',
        description: 'Substring marking entries to remove; required when op is `remove`.',
      },
    },
    output: {
      schema: textSchema,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args: MemoryArgs, exec: ToolRunContext) {
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      return Promise.resolve({ text: runMemoryOp(config, args, cwd) })
    },
    presentCall: (args: MemoryArgs) => ({
      card: 'generic',
      title: 'Memory',
      kind: 'other',
      rawInput: `${args.op} ${args.target}`,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'usage_status',
    description: 'Check current API usage and quota: opencode go remaining '
      + 'percents for the rolling/weekly/monthly windows plus the nearest reset '
      + 'countdown, and the DeepSeek account balance. Returns a compact status '
      + 'line, or an explanation when no quota data is available.',
    parameters: {},
    output: {
      schema: textSchema,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(): Promise<{ text: string }> {
      return runUsageStatus(config).then(text => ({ text }))
    },
    presentCall: () => ({
      card: 'generic',
      title: 'Usage status',
      kind: 'other',
      rawInput: '',
    }),
  }))
}
