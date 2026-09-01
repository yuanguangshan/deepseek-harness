/**
 * `/skills` catalog: list the skills visible to the runtime by scanning the
 * same on-disk sources the skill loader reads (project `.dsh/skills`,
 * project `.agents/skills`, and the user-home counterparts). Frontmatter is
 * parsed permissively — a skill directory without SKILL.md is listed by name
 * with no description rather than skipped, so a half-written skill is visible.
 * @module @deepseek-ai/dsh-repl/skills-list
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One discovered skill. */
export interface SkillCatalogEntry {
  name: string
  description: string
  /** Human label of the source root the skill was found under. */
  source: string
  /** Absolute skill directory. */
  dir: string
}

/** One scanned root directory with its display label. */
export interface SkillRoot {
  dir: string
  source: string
}

/** The default roots: project-level first, then user-home. */
export function defaultSkillRoots(cwd: string = process.cwd()): SkillRoot[] {
  const home = homedir()
  return [
    { dir: join(cwd, '.dsh', 'skills'), source: '项目' },
    { dir: join(cwd, '.agents', 'skills'), source: '项目' },
    { dir: join(home, '.dsh', 'skills'), source: '用户' },
    { dir: join(home, '.agents', 'skills'), source: '用户' },
  ]
}

/** Extract the `name`/`description` fields from a SKILL.md frontmatter block. */
function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (match === null || match[1] === undefined) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of match[1].split(/\r?\n/)) {
    const nameMatch = /^name:\s*(.+)$/.exec(line)
    if (nameMatch !== null && nameMatch[1] !== undefined) out.name = nameMatch[1].trim().replace(/^["']|["']$/g, '')
    const descMatch = /^description:\s*(.+)$/.exec(line)
    if (descMatch !== null && descMatch[1] !== undefined) out.description = descMatch[1].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

/** First prose line of the body as a description fallback (headings/skipped lines dropped). */
function firstBodyLine(raw: string): string {
  const withoutFrontmatter = raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').trim()
  for (const line of withoutFrontmatter.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('---')) continue
    return trimmed
  }
  return ''
}

/**
 * Scan the given roots for skill directories (one level deep). Order follows
 * root order, then alphabetical within a root; the same skill name in a later
 * root is shadowed by the earlier one, mirroring loader precedence.
 */
export function scanSkillCatalog(roots: readonly SkillRoot[]): SkillCatalogEntry[] {
  const seen = new Set<string>()
  const out: SkillCatalogEntry[] = []
  for (const root of roots) {
    let dirs: string[]
    try {
      if (!existsSync(root.dir)) continue
      dirs = readdirSync(root.dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
    } catch {
      continue
    }
    for (const dir of dirs) {
      if (seen.has(dir)) continue
      const skillDir = join(root.dir, dir)
      let name = dir
      let description = ''
      const skillMd = join(skillDir, 'SKILL.md')
      if (existsSync(skillMd)) {
        try {
          const raw = readFileSync(skillMd, 'utf8')
          const fm = parseFrontmatter(raw)
          name = fm.name ?? dir
          description = fm.description ?? firstBodyLine(raw)
        } catch {
          // unreadable SKILL.md: keep the directory name with no description
        }
      }
      seen.add(dir)
      out.push({ name, description, source: root.source, dir: skillDir })
    }
  }
  return out
}

/** Render the catalog grouped by source; empty input renders a discovery hint. */
export function formatSkillCatalog(entries: readonly SkillCatalogEntry[]): string {
  if (entries.length === 0) {
    return '没有发现技能。技能目录：项目 .dsh/skills · .agents/skills，用户 ~/.dsh/skills · ~/.agents/skills（每技能一个目录，含 SKILL.md）'
  }
  const bySource = new Map<string, SkillCatalogEntry[]>()
  for (const entry of entries) {
    const list = bySource.get(entry.source) ?? []
    list.push(entry)
    bySource.set(entry.source, list)
  }
  const lines: string[] = [`🧩 技能目录（${entries.length} 个）:`]
  for (const [source, list] of bySource) {
    lines.push(`  ${source}:`)
    for (const entry of list) {
      const desc = entry.description === '' ? '' : ` — ${entry.description.slice(0, 80)}`
      lines.push(`    ${entry.name}${desc}`)
    }
  }
  return lines.join('\n')
}
