import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EXP_PER_TURN, addExp, defaultPetStats, expToNext, festivalFor, formatExpBar, formatLastSeen, formatPetCard, formatPetStatusLine,
  isLateNight, isTopOfHour, liveThinkingQuip, loadPetStatsFromDisk, parsePetStats, petMessage, petSprite, petStatePath, savePetStatsToDisk,
  serializePetStats, soulQuote, stepPetMood, welcomeBackMessage, WELCOME_BACK_MIN_GAP_MS, workingQuip,
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
  it('mouth-slacks philosophically while working (WorkBuddy style)', () => {
    const noon = new Date('2026-08-15T12:00:00')
    const pool = new Set<string>()
    for (let round = 0; round < 30; round++) pool.add(workingQuip(round, 0, noon))
    expect([...pool].some(q => q.includes('思考人生'))).toBe(true)
    expect([...pool].some(q => q.includes('鲸生'))).toBe(true)
  })
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

describe('isTopOfHour', () => {
  it('is true only within the :00 minute window', () => {
    expect(isTopOfHour(new Date('2026-08-15T14:00:00'))).toBe(true)
    expect(isTopOfHour(new Date('2026-08-15T14:00:59'))).toBe(true)
    expect(isTopOfHour(new Date('2026-08-15T14:01:00'))).toBe(false)
    expect(isTopOfHour(new Date('2026-08-15T12:30:00'))).toBe(false)
  })
})

describe('festivalFor', () => {
  it('matches known festivals by month-day and skips ordinary days', () => {
    expect(festivalFor(new Date('2026-01-01T09:00:00'))).toContain('元旦')
    expect(festivalFor(new Date('2026-10-01T09:00:00'))).toContain('国庆')
    expect(festivalFor(new Date('2026-12-25T09:00:00'))).toContain('圣诞')
    expect(festivalFor(new Date('2026-08-15T09:00:00'))).toBeUndefined()
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
    // lastSeenAt defaults to 1000 (mkPet's birth tick) → 47h gap → "1 天前".
    expect(lines[3]).toBe('相伴 2 天 · 上次见面 1 天前')
  })
  it('greets a same-day pet', () => {
    expect(formatPetCard(mkPet({ bornAt: 0 }), 'idle', 1000)[3]).toBe('今天刚认识的小鲸娘~')
  })
  it('shows a soul quote line under the age line', () => {
    const lines = formatPetCard(mkPet({ turns: 8 }), 'idle', 86_400_000)
    expect(lines[4]).toContain('「')
    expect(lines[4]).toContain(soulQuote(8))
    expect(lines[5]).toContain('/pet pat')
  })
})

describe('soulQuote', () => {
  it('rotates deterministically with turns', () => {
    expect(soulQuote(0)).toBe(soulQuote(0))
    expect(soulQuote(0)).not.toBe(soulQuote(1))
    expect(soulQuote(3)).toBe(soulQuote(3))
  })
  it('cycles across the full quote pool', () => {
    const seen = new Set<string>()
    for (let turns = 0; turns < 5; turns++) seen.add(soulQuote(turns))
    expect(seen.size).toBe(5)
    expect(soulQuote(5)).toBe(soulQuote(0))
  })
})

describe('liveThinkingQuip', () => {
  it('returns null for empty or whitespace-only buffers', () => {
    expect(liveThinkingQuip('')).toBeNull()
    expect(liveThinkingQuip('\n\n  \n\t')).toBeNull()
  })
  it('picks the latest non-empty line and collapses whitespace', () => {
    expect(liveThinkingQuip('first thought\nsecond thought\n\n  third,  spaced  out \n')).toBe('third, spaced out')
  })
  it('tail-truncates long thoughts with a leading ellipsis', () => {
    const q = liveThinkingQuip('x'.repeat(200), 64)
    expect(q).not.toBeNull()
    expect(q![0]).toBe('…')
    expect(q!.length).toBe(65)
    expect(liveThinkingQuip('short', 64)).toBe('short')
  })
})

describe('welcomeBackMessage', () => {
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  it('stays silent for gaps within the just-left window (boundary inclusive)', () => {
    expect(welcomeBackMessage(0, 0)).toBeNull()
    expect(welcomeBackMessage(0, WELCOME_BACK_MIN_GAP_MS)).toBeNull()
  })
  it('recognizes a short absence (minutes to hours)', () => {
    const msg = welcomeBackMessage(0, WELCOME_BACK_MIN_GAP_MS + 1)
    expect(msg).toContain('回来啦')
    // Strictly below the 6h boundary; the boundary itself lands in the next tier.
    expect(welcomeBackMessage(0, 6 * HOUR - 1)).toContain('回来啦')
  })
  it('mentions remembered memory for a same-day return', () => {
    expect(welcomeBackMessage(0, 6 * HOUR)).toContain('pet.json')
    expect(welcomeBackMessage(0, 7 * HOUR)).toContain('pet.json')
  })
  it('counts days for a multi-day absence', () => {
    expect(welcomeBackMessage(0, 2 * DAY)).toContain('好久不见')
    expect(welcomeBackMessage(0, 3 * DAY)).toContain('终于回来了')
  })
  it('treats a future stamp as no absence', () => {
    expect(welcomeBackMessage(5 * MIN, 0)).toBeNull()
  })
})

describe('formatLastSeen', () => {
  it('says 刚刚 under two minutes', () => {
    expect(formatLastSeen(0, 0)).toBe('刚刚')
    expect(formatLastSeen(0, 119_999)).toBe('刚刚')
  })
  it('formats minutes, hours, and days', () => {
    expect(formatLastSeen(0, 30 * 60_000)).toBe('30 分钟前')
    expect(formatLastSeen(0, 5 * 3_600_000)).toBe('5 小时前')
    expect(formatLastSeen(0, 3 * 86_400_000)).toBe('3 天前')
  })
  it('clamps a future stamp to 刚刚', () => {
    expect(formatLastSeen(10 * 60_000, 0)).toBe('刚刚')
  })
})

describe('stepPetMood', () => {
  it('dozes off only after the idle budget elapses', () => {
    const base = 1_000_000
    expect(stepPetMood('idle', base, base + 3 * 60_000 - 1)).toBe('idle')
    expect(stepPetMood('idle', base, base + 3 * 60_000)).toBe('sleeping')
  })

  it('decays transient moods back to idle after the decay window', () => {
    const base = 1_000_000
    expect(stepPetMood('happy', base, base + 5_999)).toBe('happy')
    expect(stepPetMood('happy', base, base + 6_000)).toBe('idle')
    expect(stepPetMood('sad', base, base + 6_000)).toBe('idle')
  })

  it('can decay and doze off in a single step', () => {
    const base = 1_000_000
    // A happy pet left alone for 5 minutes decays to idle and immediately dozes.
    expect(stepPetMood('happy', base, base + 5 * 60_000)).toBe('sleeping')
  })

  it('never leaves the turn or lifecycle states', () => {
    const base = 1_000_000
    const far = base + 60 * 60_000
    expect(stepPetMood('working', base, far)).toBe('working')
    expect(stepPetMood('sleeping', base, far)).toBe('sleeping')
  })

  it('keeps a transient mood inside its window', () => {
    const base = 1_000_000
    expect(stepPetMood('happy', base, base + 1_000)).toBe('happy')
  })

  it('accepts custom windows', () => {
    const base = 1_000_000
    expect(stepPetMood('idle', base, base + 500, 400, 100)).toBe('sleeping')
    expect(stepPetMood('happy', base, base + 150, 400, 100)).toBe('idle')
  })
})
