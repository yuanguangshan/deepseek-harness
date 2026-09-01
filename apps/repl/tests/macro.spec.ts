import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatMacroList, isValidMacroName, loadMacros, removeMacro, resolveMacro, saveMacros, upsertMacro,
} from '../src/macro.ts'

function tempStore(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-macro-')), 'macros.json')
}

describe('macro store', () => {
  it('reads a missing or malformed file as an empty store', () => {
    expect(loadMacros(join(tmpdir(), `dsh-macro-none-${Date.now()}`, 'macros.json'))).toEqual([])
    const file = tempStore()
    saveMacros(file, [{ name: 'a', text: 'x' }])
    expect(loadMacros(file)).toEqual([{ name: 'a', text: 'x' }])
  })
  it('upserts report added vs replaced', () => {
    const file = tempStore()
    expect(upsertMacro(file, 'review', '请审查这段代码')).toBe('added')
    expect(upsertMacro(file, 'review', '请深度审查')).toBe('replaced')
    expect(loadMacros(file)).toEqual([{ name: 'review', text: '请深度审查' }])
  })
  it('removes only existing macros', () => {
    const file = tempStore()
    upsertMacro(file, 'a', 'x')
    expect(removeMacro(file, 'a')).toBe(true)
    expect(removeMacro(file, 'a')).toBe(false)
  })
  it('appends extra input after the stored text on expansion', () => {
    const entries = [{ name: 'review', text: '请审查' }]
    expect(resolveMacro(entries, '/review src/app.ts')).toBe('请审查 src/app.ts')
    expect(resolveMacro(entries, '/review')).toBe('请审查')
    expect(resolveMacro(entries, '/other')).toBeUndefined()
    expect(resolveMacro(entries, 'plain text')).toBeUndefined()
  })
  it('keeps the empty list render as a usage hint', () => {
    expect(formatMacroList([])).toContain('/macro add')
    expect(formatMacroList([{ name: 'review', text: 'x'.repeat(80) }])).toContain('…')
  })
  it('validates names as composer-friendly identifiers', () => {
    expect(isValidMacroName('review')).toBe(true)
    expect(isValidMacroName('code-review2')).toBe(true)
    expect(isValidMacroName('2fast')).toBe(false)
    expect(isValidMacroName('has space')).toBe(false)
    expect(isValidMacroName('')).toBe(false)
  })
})

describe('macro store cleanup', () => {
  const dirs: string[] = []
  it('creates parent directories on first save', () => {
    const file = tempStore()
    dirs.push(file)
    upsertMacro(file, 'a', 'x')
    expect(loadMacros(file)).toEqual([{ name: 'a', text: 'x' }])
  })
})
