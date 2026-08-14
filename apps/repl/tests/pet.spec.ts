import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EXP_PER_TURN, addExp, defaultPetStats, expToNext, formatExpBar, formatPetCard, formatPetStatusLine,
  isLateNight, loadPetStatsFromDisk, parsePetStats, petMessage, petSprite, petStatePath, savePetStatsToDisk,
  serializePetStats, workingQuip,
} from '../src/pet.ts'

function mkPet(overrides: Partial<ReturnType<typeof defaultPetStats>> = {}) {
  return { ...defaultPetStats(1_000), ...overrides }
}

describe('expToNext', () => {
  it('grows 5 exp per level from a base of 10', () => {
    expect(expToNext(1)).toBe(15)
    expect(expToNext(2)).toBe(20)
    expect(expToNext(9)).toBe(55)
  })
})

describe('addExp', () => {
  it('returns the same stats for non-positive amounts', () => {
    const stats = mkPet()
    expect(addExp(stats, 0)).toEqual({ stats, levelsGained: 0 })
    expect(addExp(stats, -3)).toEqual({ stats, levelsGained: 0 })
  })
  it('accumulates exp without leveling below the threshold', () => {
    expect(addExp(mkPet(), EXP_PER_TURN)).toEqual({ stats: mkPet({ exp: 5 }), levelsGained: 0 })
  })
  it('levels up once and rolls excess exp into the next level', () => {
    // Lv.1 needs 15: grant 18 → Lv.2 with 3 exp carried.
    expect(addExp(mkPet(), 18)).toEqual({ stats: mkPet({ level: 2, exp: 3 }), levelsGained: 1 })
  })
  it('can gain multiple levels in one grant', () => {
    // Lv.1 needs 15, Lv.2 needs 20: grant 40 → Lv.3 with 5 exp carried.
    expect(addExp(mkPet(), 40)).toEqual({ stats: mkPet({ level: 3, exp: 5 }), levelsGained: 2 })
  })
  it('does not mutate the input stats', () => {
    const stats = mkPet({ exp: 10 })
    addExp(stats, 50)
    expect(stats.exp).toBe(10)
    expect(stats.level).toBe(1)
  })
})

describe('petStatePath', () => {
  it('honors DSH_REPL_PET_FILE when set', () => {
    expect(petStatePath({ DSH_REPL_PET_FILE: '/tmp/pet.json' })).toBe('/tmp/pet.json')
    expect(petStatePath({ DSH_REPL_PET_FILE: '  ' })).not.toBe('  ')
  })
  it('defaults into ~/.dsh-repl when unset', () => {
    expect(petStatePath({})).toMatch(/\.dsh-repl[/\\]pet\.json$/)
  })
})

describe('parsePetStats / serializePetStats', () => {
  it('round-trips a full stats object', () => {
    const stats = mkPet({ name: '鲸宝', level: 3, exp: 7, pats: 4, turns: 20, bornAt: 12345 })
    expect(parsePetStats(serializePetStats(stats))).toEqual(stats)
  })
  it('rejects malformed JSON', () => {
    expect(parsePetStats('not json')).toBeNull()
    expect(parsePetStats('')).toBeNull()
  })
  it('rejects non-object documents', () => {
    expect(parsePetStats('null')).toBeNull()
    expect(parsePetStats('[1]')).toBeNull()
  })
  it('rejects a foreign version', () => {
    const stats = mkPet()
    expect(parsePetStats(JSON.stringify({ ...JSON.parse(serializePetStats(stats)), version: 99 }))).toBeNull()
  })
  it('rejects invalid level/exp/bornAt and clamps negative counters', () => {
    const doc = (patch: Record<string, unknown>) => serializePetStats({ ...mkPet(), ...patch })
    expect(parsePetStats(doc({ level: 0 }))).toBeNull()
    expect(parsePetStats(doc({ level: '2' }))).toBeNull()
    expect(parsePetStats(doc({ exp: -1 }))).toBeNull()
    expect(parsePetStats(doc({ exp: NaN }))).toBeNull()
    expect(parsePetStats(doc({ bornAt: undefined }))).toBeNull()
    expect(parsePetStats(doc({ pats: -5, turns: -2 }))).toEqual(mkPet({ pats: 0, turns: 0 }))
  })
  it('falls back to the default name when blank or non-string', () => {
    expect(parsePetStats(serializePetStats({ ...mkPet(), name: '' }))?.name).toBe('小鲸娘')
    // Raw JSON bypasses the typed PetStats: a numeric name field is invalid.
    const raw = JSON.stringify({ version: 1, ...mkPet(), name: 5 })
    expect(parsePetStats(raw)?.name).toBe('小鲸娘')
  })
})

describe('disk round-trip', () => {
  it('loads what was saved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-'))
    try {
      const path = join(dir, 'pet.json')
      const stats = mkPet({ level: 4, exp: 2, pats: 1, turns: 9 })
      savePetStatsToDisk(stats, path)
      expect(loadPetStatsFromDisk(path)).toEqual(stats)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('hatches a fresh pet for a missing or corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-'))
    try {
      expect(loadPetStatsFromDisk(join(dir, 'missing.json')).level).toBe(1)
      const path = join(dir, 'pet.json')
      writeFileSync(path, 'corrupt{')
      expect(loadPetStatsFromDisk(path).level).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('creates the parent directory on save', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-'))
    try {
      const path = join(dir, 'a', 'b', 'pet.json')
      savePetStatsToDisk(mkPet(), path)
      expect(loadPetStatsFromDisk(path).name).toBe('小鲸娘')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('petSprite / petMessage', () => {
  it('cycles frames across ticks', () => {
    expect(petSprite('working', 0)).toBe('🐳➤')
    expect(petSprite('working', 1)).toBe('➤🐳')
    expect(petSprite('working', 2)).toBe('🐳➤')
    expect(petSprite('sleeping', 1)).toBe('🐳zZ')
  })
  it('handles negative ticks without crashing', () => {
    expect(typeof petSprite('idle', -1)).toBe('string')
    expect(typeof petMessage('idle', -7)).toBe('string')
  })
  it('yields a message for every mood', () => {
    for (const mood of ['idle', 'working', 'happy', 'sad', 'sleeping'] as const) {
      expect(petMessage(mood, 0).length).toBeGreaterThan(0)
    }
  })
})

describe('workingQuip', () => {
  it('cycles through the whole pool without repeating within one lap sequence', () => {
    const seen = new Set<string>()
    for (let round = 0; round < 15; round++) seen.add(workingQuip(round, 0, new Date('2026-08-15T12:00:00')))
    expect(seen.size).toBe(15)
  })
  it('advances one quip per lap and varies across turns via the seed', () => {
    const noon = new Date('2026-08-15T12:00:00')
    expect(workingQuip(0, 0, noon)).not.toBe(workingQuip(0, 3, noon))
    expect(workingQuip(1, 0, noon)).not.toBe(workingQuip(0, 0, noon))
  })
  it('appends overtime lines in the late-night window only', () => {
    const night = new Date('2026-08-15T23:30:00')
    const noon = new Date('2026-08-15T12:00:00')
    const nightPool = new Set<string>()
    for (let round = 0; round < 18; round++) nightPool.add(workingQuip(round, 0, night))
    expect([...nightPool].some(q => q.includes('这鱼是真的拼'))).toBe(true)
    const noonPool = new Set<string>()
    for (let round = 0; round < 15; round++) noonPool.add(workingQuip(round, 0, noon))
    expect([...noonPool].some(q => q.includes('这鱼是真的拼'))).toBe(false)
  })
})

describe('isLateNight', () => {
  it('spans 23:00 through 05:59 local', () => {
    expect(isLateNight(23)).toBe(true)
    expect(isLateNight(0)).toBe(true)
    expect(isLateNight(5)).toBe(true)
    expect(isLateNight(6)).toBe(false)
    expect(isLateNight(22)).toBe(false)
    expect(isLateNight(12)).toBe(false)
  })
})

describe('formatExpBar', () => {
  it('renders empty at 0 and full at the target', () => {
    expect(formatExpBar(1, 0, 4)).toBe('░░░░')
    expect(formatExpBar(1, expToNext(1), 4)).toBe('▓▓▓▓')
  })
  it('clamps out-of-range exp', () => {
    expect(formatExpBar(1, -5, 3)).toBe('░░░')
    expect(formatExpBar(1, 10_000, 3)).toBe('▓▓▓')
  })
  it('fills proportionally', () => {
    expect(formatExpBar(1, 3, 10)).toBe('▓▓░░░░░░░░')
  })
})

describe('formatPetStatusLine', () => {
  it('renders sprite, level, bar, and message', () => {
    const line = formatPetStatusLine(mkPet({ level: 2, exp: 4 }), 'idle', 0)
    expect(line).toContain('🐳')
    expect(line).toContain('Lv.2')
    expect(line).toContain('▓')
    expect(line).toContain('4/20')
  })
  it('prefers an explicit message over the mood default', () => {
    expect(formatPetStatusLine(mkPet(), 'idle', 0, undefined, '升级啦！')).toContain('升级啦！')
  })
})

describe('formatPetCard', () => {
  it('renders name, level, exp, counters, and age line', () => {
    const lines = formatPetCard(mkPet({ level: 3, exp: 5, pats: 2, turns: 8, bornAt: 0 }), 'idle', 2 * 86_400_000)
    expect(lines[0]).toContain('小鲸娘')
    expect(lines[0]).toContain('Lv.3')
    expect(lines[1]).toContain('5/25')
    expect(lines[2]).toContain('8 轮')
    expect(lines[2]).toContain('2 次')
    expect(lines[3]).toBe('相伴 2 天')
  })
  it('greets a same-day pet', () => {
    expect(formatPetCard(mkPet({ bornAt: 0 }), 'idle', 1000)[3]).toBe('今天刚认识的鲸~')
  })
})
