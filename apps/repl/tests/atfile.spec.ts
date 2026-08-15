import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtFileProvider, type AtRow } from '../src/atfile.ts'

/** Build a temp workspace with a known file tree. */
function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-atfile-'))
  mkdirSync(join(root, 'src', 'tui'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'README.md'), 'x')
  writeFileSync(join(root, 'src', 'tui-repl.ts'), 'x')
  writeFileSync(join(root, 'src', 'tui', 'panel.ts'), 'x')
  writeFileSync(join(root, 'docs', 'guide.md'), 'x')
  return root
}

/** An AbortSignal for the provider's options arg. */
const signal = new AbortController().signal

const CMDS: readonly AtRow[] = [
  { value: 'resume', label: 'resume', description: '恢复历史会话' },
  { value: 'model', label: 'model', description: '切换模型' },
  { value: 'new', label: 'new', description: '新会话' },
]

async function suggest(p: AtFileProvider, line: string, col?: number): Promise<{ items: AtRow[]; prefix: string } | null> {
  return p.getSuggestions([line], 0, col ?? line.length, { signal, force: false })
}

describe('AtFileProvider @file fuzzy completion', () => {
  it('returns null when not in an @ context', async () => {
    const root = makeWorkspace()
    try {
      const p = new AtFileProvider(CMDS, root)
      expect(await suggest(p, 'plain text', 5)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fuzzy-matches workspace files by basename', async () => {
    const root = makeWorkspace()
    try {
      const p = new AtFileProvider(CMDS, root)
      const r = await suggest(p, 'see @tui-repl', 10)
      expect(r).not.toBeNull()
      const items = r!.items.map(i => i.value)
      expect(items.some(v => v.includes('tui-repl.ts'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('offers directory drill-down values that end with a slash', async () => {
    const root = makeWorkspace()
    try {
      const p = new AtFileProvider(CMDS, root)
      const r = await suggest(p, '@src/tui/', 10)
      expect(r).not.toBeNull()
      expect(r!.items.some(i => i.label === 'panel.ts')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('escapes paths with spaces into @\\"path\\" values', async () => {
    const root = makeWorkspace()
    try {
      mkdirSync(join(root, 'my folder'), { recursive: true })
      writeFileSync(join(root, 'my folder', 'note.md'), 'x')
      const p = new AtFileProvider(CMDS, root)
      const r = await suggest(p, '@note')
      expect(r).not.toBeNull()
      expect(r!.items.some(i => i.value.startsWith('@"my folder/note.md"')))
        .toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('applies a completion by replacing only the matched prefix', async () => {
    const root = makeWorkspace()
    try {
      const p = new AtFileProvider(CMDS, root)
      const r = await suggest(p, 'see @tu', 7)
      expect(r).not.toBeNull()
      const item = r!.items.find(i => i.value.endsWith('tui-repl.ts'))!
      const applied = p.applyCompletion(['see @tu'], 0, 7, item, r!.prefix)
      expect(applied.lines[0]).toContain('@')
      expect(applied.lines[0]).toContain('tui-repl.ts')
      // The original line-surrounding text survives (nothing before @tu is lost).
      expect(applied.lines[0]).toMatch(/^see @.*tui-repl\.ts$/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('AtFileProvider /command completion', () => {
  it('completes a bare slash command token', async () => {
    const root = makeWorkspace()
    try {
      const p = new AtFileProvider(CMDS, root)
      const r = await suggest(p, '/re')
      expect(r).not.toBeNull()
      expect(r!.items.map(i => i.value)).toContain('/resume')
      expect(r!.prefix).toBe('/re')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not complete a slash token mid-sentence', async () => {
    const root = makeWorkspace()
    try {
      const p = new AtFileProvider(CMDS, root)
      expect(await suggest(p, 'type /re later')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
