/**
 * User-defined prompt macros: `/macro add review <text>` stores an alias the
 * user later types as `/review` (optionally followed by extra input appended
 * after the stored text). The store is one JSON file under the REPL's memory
 * directory; every operation takes the path so tests can use temp files.
 * @module @deepseek-ai/dsh-repl/macro
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** One stored macro: a short name and the prompt text it expands to. */
export interface MacroEntry {
  name: string
  text: string
}

/** Macro names stay composer-friendly: letters/digits/dash, 1–32 chars. */
export function isValidMacroName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9-]{0,31}$/.test(name)
}

/** Load the macro store; a missing or malformed file reads as empty. */
export function loadMacros(filePath: string): MacroEntry[] {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const entries: MacroEntry[] = []
    for (const item of parsed) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const rec = item as Record<string, unknown>
        if (typeof rec.name === 'string' && typeof rec.text === 'string') {
          entries.push({ name: rec.name, text: rec.text })
        }
      }
    }
    return entries
  } catch {
    return []
  }
}

/** Persist the macro store (creating parent directories on first save). */
export function saveMacros(filePath: string, entries: readonly MacroEntry[]): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
}

/** Add or replace one macro; reports which happened. */
export function upsertMacro(filePath: string, name: string, text: string): 'added' | 'replaced' {
  const existing = loadMacros(filePath)
  const replaced = existing.some(e => e.name === name)
  const next = [...existing.filter(e => e.name !== name), { name, text }]
  saveMacros(filePath, next)
  return replaced ? 'replaced' : 'added'
}

/** Remove one macro; returns whether it existed. */
export function removeMacro(filePath: string, name: string): boolean {
  const entries = loadMacros(filePath)
  const next = entries.filter(e => e.name !== name)
  if (next.length === entries.length) return false
  saveMacros(filePath, next)
  return true
}

/** Resolve a submitted `/name` line to its macro text, or undefined. */
export function resolveMacro(entries: readonly MacroEntry[], line: string): string | undefined {
  if (!line.startsWith('/')) return undefined
  const name = line.slice(1).split(/\s+/)[0] ?? ''
  const macro = entries.find(e => e.name === name)
  if (macro === undefined) return undefined
  const rest = line.slice(1 + name.length).trim()
  return rest === '' ? macro.text : `${macro.text} ${rest}`
}

/** Render `/macro list` output; the empty store renders a hint instead. */
export function formatMacroList(entries: readonly MacroEntry[]): string {
  if (entries.length === 0) {
    return '还没有宏。用法：/macro add <名称> <文本> · /<名称> [附加输入] 展开 · /macro rm <名称>'
  }
  return ['📝 已存宏（/名称 展开，输入追加在文本后）:',
    ...entries.map(e => `  /${e.name}  ${e.text.length > 60 ? `${e.text.slice(0, 60)}…` : e.text}`),
  ].join('\n')
}
