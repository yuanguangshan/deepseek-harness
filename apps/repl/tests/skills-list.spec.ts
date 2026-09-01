import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSkillRoots, formatSkillCatalog, scanSkillCatalog } from '../src/skills-list.ts'

function makeSkill(root: string, dir: string, skillMd?: string): string {
  const skillDir = join(root, dir)
  mkdirSync(skillDir, { recursive: true })
  if (skillMd !== undefined) writeFileSync(join(skillDir, 'SKILL.md'), skillMd, 'utf8')
  return skillDir
}

describe('scanSkillCatalog', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-skills-'))
  const project = join(base, 'project')
  const user = join(base, 'user')
  makeSkill(project, 'alpha', '---\nname: alpha\ndescription: 首个技能\n---\n正文')
  makeSkill(project, 'bare')
  makeSkill(user, 'beta', '# Beta\n第一段说明文字')
  afterAll(() => { rmSync(base, { recursive: true, force: true }) })

  it('reads frontmatter name/description and falls back to directory name', () => {
    const entries = scanSkillCatalog([
      { dir: project, source: '项目' },
      { dir: user, source: '用户' },
    ])
    const alpha = entries.find(e => e.name === 'alpha')
    expect(alpha?.description).toBe('首个技能')
    expect(alpha?.source).toBe('项目')
    const bare = entries.find(e => e.name === 'bare')
    expect(bare?.description).toBe('')
    expect(bare?.source).toBe('项目')
  })
  it('falls back to the first body line when frontmatter is absent', () => {
    const entries = scanSkillCatalog([{ dir: user, source: '用户' }])
    expect(entries.find(e => e.name === 'beta')?.description).toBe('第一段说明文字')
  })
  it('earlier roots shadow later duplicates and missing roots are skipped', () => {
    makeSkill(user, 'alpha', '---\ndescription: 被遮蔽\n---\n')
    const entries = scanSkillCatalog([
      { dir: join(base, 'missing'), source: '项目' },
      { dir: project, source: '项目' },
      { dir: user, source: '用户' },
    ])
    expect(entries.filter(e => e.name === 'alpha')).toHaveLength(1)
    expect(entries.find(e => e.name === 'alpha')?.description).toBe('首个技能')
  })
})

describe('formatSkillCatalog', () => {
  it('groups by source and renders a hint when empty', () => {
    expect(formatSkillCatalog([])).toContain('.dsh/skills')
    const out = formatSkillCatalog([
      { name: 'alpha', description: '首个技能', source: '项目', dir: '/p/alpha' },
      { name: 'beta', description: '', source: '用户', dir: '/u/beta' },
    ])
    expect(out).toContain('项目:')
    expect(out).toContain('alpha — 首个技能')
    expect(out).toContain('beta')
  })
})

describe('defaultSkillRoots', () => {
  it('covers project and user .dsh/.agents skill directories', () => {
    const roots = defaultSkillRoots('/work')
    expect(roots.map(r => r.dir)).toEqual([
      join('/work', '.dsh', 'skills'),
      join('/work', '.agents', 'skills'),
      expect.stringContaining('.dsh'),
      expect.stringContaining('.agents'),
    ])
    expect(roots[2]?.dir.startsWith('/Users/')).toBe(true)
  })
})
