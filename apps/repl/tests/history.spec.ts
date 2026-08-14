import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, constants as zc } from 'node:zlib'
import {
  SESSION_LOG_FILE, decodeHeaderFrame, describeSession, encodeSessionId, findTitle,
  formatCreatedAt, listAllSessions, listSessions, listSessionsIn, parseSessionHeader, projectKey,
  readSessionEvents, sessionRoot, userMessageText,
} from '../src/history.ts'

/** Build a checksummed, independently decodable Zstandard frame (matches the runtime layout). */
function compressFrame(text: string): Buffer {
  return zstdCompressSync(Buffer.from(text, 'utf8'), { params: { [zc.ZSTD_c_checksumFlag]: 1 } })
}

/** A frame without a checksum tail (exercises the frame parser's no-checksum path). */
function compressFrameNoChecksum(text: string): Buffer {
  return zstdCompressSync(Buffer.from(text, 'utf8'))
}

/** Write a single session artifact: a header frame plus optional title/session events. */
function writeSession(root: string, cwd: string, id: string, createdAt: number, title?: string): string {
  const dir = join(root, projectKey(cwd), encodeSessionId(id))
  mkdirSync(dir, { recursive: true })
  const header = JSON.stringify({ type: 'session', version: 0, id, createdAt, cwd })
  const frames: Buffer[] = [compressFrame(header + '\n')]
  if (title !== undefined) {
    const titleEvent = `{"type":"session/title","seq":2,"time":${createdAt + 1},"data":{"title":${JSON.stringify(title)}}}\n`
    frames.push(compressFrame(titleEvent))
  }
  const artifact = Buffer.concat(frames)
  writeFileSync(join(dir, SESSION_LOG_FILE), artifact)
  return join(dir, SESSION_LOG_FILE)
}

describe('encodeSessionId', () => {
  it('keeps printable ASCII safe chars', () => {
    expect(encodeSessionId('repl-abc.123_DEF')).toBe('repl-abc.123_DEF')
  })
  it('escapes unsafe chars as ~XXXX hex', () => {
    expect(encodeSessionId('a/b')).toBe('a~002Fb')
    expect(encodeSessionId('😀')).toMatch(/^~/)
  })
  it('maps dot segments to their escapes', () => {
    expect(encodeSessionId('.')).toBe('~002E')
    expect(encodeSessionId('..')).toBe('~002E~002E')
  })
  it('throws on an empty id', () => {
    expect(() => encodeSessionId('')).toThrow('empty path segment')
  })
})

describe('projectKey', () => {
  it('collapses separators and wraps in --…--', () => {
    expect(projectKey('/Users/ygs/ygs/deepseek-harness')).toBe('--Users-ygs-ygs-deepseek-harness--')
  })
  it('escapes unsafe units and handles empties', () => {
    expect(projectKey('/a~b/c')).toBe('--a~007Eb-c--')
    expect(projectKey('/')).toBe('--root--')
  })
  it('throws on an empty path', () => {
    expect(() => projectKey('')).toThrow('empty project path')
  })
  it('collapses a run of separators into one dash', () => {
    expect(projectKey('a//b')).toBe('--a-b--')
    expect(projectKey('/:')).toBe('--root--')
  })
})

describe('parseSessionHeader', () => {
  it('parses the canonical header record', () => {
    const m = parseSessionHeader('{"type":"session","version":0,"id":"repl-x","createdAt":123,"cwd":"/a"}')
    expect(m).toEqual({ id: 'repl-x', createdAt: 123, cwd: '/a' })
  })
  it('returns empty fields for malformed / non-mapping input', () => {
    expect(parseSessionHeader('not json')).toEqual({ id: undefined, createdAt: undefined, cwd: undefined })
    expect(parseSessionHeader('')).toEqual({ id: undefined, createdAt: undefined, cwd: undefined })
    expect(parseSessionHeader('[1,2]')).toEqual({ id: undefined, createdAt: undefined, cwd: undefined })
    expect(parseSessionHeader('null')).toEqual({ id: undefined, createdAt: undefined, cwd: undefined })
  })
})

describe('decodeHeaderFrame', () => {
  it('decodes the first frame of a multi-frame artifact', () => {
    const buf = Buffer.concat([
      compressFrame('{"id":"a","createdAt":1}\n'),
      compressFrame('{"type":"session/title","data":{"title":"later"}}\n'),
    ])
    expect(decodeHeaderFrame(buf)).toBe('{"id":"a","createdAt":1}\n')
  })
  it('returns empty on a non-zstd / torn buffer', () => {
    expect(decodeHeaderFrame(Buffer.from('garbage'))).toBe('')
    expect(decodeHeaderFrame(Buffer.from(''))).toBe('')
  })
  it('returns empty when the header frame fails to decompress', () => {
    const buf = compressFrame('not really json\n')
    // Force a decode failure despite a structurally valid frame.
    expect(decodeHeaderFrame(buf, () => { throw new Error('boom') })).toBe('')
  })
  it('tolerates truncated / corrupt first frames (returns empty)', () => {
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]) // ZSTD magic, no descriptor
    // magic only → no descriptor byte
    expect(decodeHeaderFrame(magic)).toBe('')
    // magic + descriptor with a reserved frame-header bit (0x18) set
    expect(decodeHeaderFrame(Buffer.concat([magic, Buffer.from([0x10])]))).toBe('')
    // descriptor demands more header bytes than present (single-segment content size)
    expect(decodeHeaderFrame(Buffer.concat([magic, Buffer.from([0x21, 0x03])]))).toBe('')
    // a valid frame followed by a torn invalid continuation decodes only the header
    expect(decodeHeaderFrame(Buffer.concat([compressFrame('{"type":"session","id":"a"}\n'), magic.subarray(0, 3)])))
      .toContain('"id":"a"')
  })
  it('parses a single frame spanning multiple zstd blocks', () => {
    // node:zlib splits a ~256KiB payload across blocks; the frame parser must walk them all.
    const big = compressFrame('{"type":"session","id":"a"}\n' + 'x'.repeat(256 * 1024))
    expect(decodeHeaderFrame(big)).toContain('"id":"a"')
  })
  it('parses a frame without a checksum tail', () => {
    expect(decodeHeaderFrame(compressFrameNoChecksum('{"type":"session","id":"nc"}\n'))).toContain('"id":"nc"')
  })
})

describe('findTitle', () => {
  it('picks the last session/title seen within budget', () => {
    const buf = Buffer.concat([
      compressFrame('{"type":"session/title","data":{"title":"first"}}\n'),
      compressFrame('{"type":"session/title","data":{"title":"second"}}\n'),
    ])
    expect(findTitle(buf)).toBe('second')
  })
  it('ignores non-title lines and malformed events', () => {
    const buf = Buffer.concat([
      compressFrame('{"type":"assistant/message","data":{}}\n'),
      compressFrame('{"type":"session/title","data":{"title":"ok"}}\n'),
    ])
    expect(findTitle(buf)).toBe('ok')
  })
  it('returns undefined when no title exists', () => {
    const buf = compressFrame('{"type":"session","id":"a"}\n')
    expect(findTitle(buf)).toBeUndefined()
  })
  it('stops scanning when a frame fails to decompress', () => {
    const buf = Buffer.concat([
      compressFrame('{"type":"session/title","data":{"title":"first"}}\n'),
      compressFrame('{"type":"session/title","data":{"title":"second"}}\n'),
    ])
    // First call decodes frame 0 normally; the second frame throws and ends the scan.
    let calls = 0
    const decode = (): Buffer => {
      calls += 1
      if (calls === 1) return Buffer.from('{"type":"session/title","data":{"title":"first"}}\n')
      throw new Error('boom')
    }
    expect(findTitle(buf, 512, decode)).toBe('first')
  })
  it('ignores a malformed JSON line inside a frame', () => {
    const buf = compressFrame('{this is not json}\n')
    expect(findTitle(buf)).toBeUndefined()
  })
  it('keeps a found title when trailing bytes form a torn frame', () => {
    const buf = Buffer.concat([
      compressFrame('{"type":"session/title","data":{"title":"kept"}}\n'),
      Buffer.from([0x28, 0xb5]), // torn: less than a full frame follows
    ])
    expect(findTitle(buf)).toBe('kept')
  })
  it('ignores valid-but-empty JSONL lines (non-object)', () => {
    const buf = compressFrame('null\nnull\n')
    expect(findTitle(buf)).toBeUndefined()
  })
  it('ignores a title event whose data is missing or not an object', () => {
    const buf = compressFrame('{"type":"session/title"}\n')
    expect(findTitle(buf)).toBeUndefined()
  })
  it('ignores a blank title value', () => {
    const buf = compressFrame('{"type":"session/title","data":{"title":"   "}}\n')
    expect(findTitle(buf)).toBeUndefined()
  })
})

describe('listSessionsIn', () => {
  it('lists sessions newest-first with title/createdAt/cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repl-hist-'))
    const cwd = '/tmp/proj'
    try {
      writeSession(root, cwd, 'repl-old', 100, 'older')
      writeSession(root, cwd, 'repl-new', 300, 'newer')
      writeSession(root, cwd, 'repl-untitled', 200)
      const sessions = listSessionsIn(root, cwd)
      expect(sessions.map(s => s.sessionId)).toEqual(['repl-new', 'repl-untitled', 'repl-old'])
      const newer = sessions[0]
      expect(newer).toBeDefined()
      expect(newer!.title).toBe('newer')
      expect(newer!.createdAt).toBe(300)
      expect(newer!.cwd).toBe(cwd)
      expect(sessions[1]!.title).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('skips non-session entries and returns [] on a missing store', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repl-hist-'))
    const cwd = '/tmp/proj2'
    try {
      mkdirSync(join(root, projectKey(cwd), 'not-a-session'), { recursive: true })
      writeFileSync(join(root, projectKey(cwd), 'stray-file'), 'x')
      expect(listSessionsIn(root, cwd)).toEqual([])
      expect(listSessionsIn(root, '/no/such/proj')).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('skips sessions whose header carries an empty id', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repl-hist-'))
    const cwd = '/tmp/proj-empty'
    try {
      const dir = join(root, projectKey(cwd), 'repl-empty')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, SESSION_LOG_FILE), compressFrame('{"type":"session","id":""}\n'))
      expect(listSessionsIn(root, cwd)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('falls back to the directory name when the header lacks an id', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repl-hist-'))
    const cwd = '/tmp/proj-noid'
    try {
      const dir = join(root, projectKey(cwd), 'repl-named')
      mkdirSync(dir, { recursive: true })
      // No id and no createdAt → the header lacks both; dir name and ?? 0 sort path cover it.
      writeFileSync(join(dir, SESSION_LOG_FILE), compressFrame('{"type":"session","cwd":"/x"}\n'))
      const sessions = listSessionsIn(root, cwd)
      expect(sessions.map(s => s.sessionId)).toEqual(['repl-named'])
      expect(sessions[0]?.createdAt).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('listSessions scans the env-configured store for the given cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repl-hist-'))
    const cwd = '/tmp/proj3'
    try {
      writeSession(root, cwd, 'repl-a', 50)
      const sessions = listSessions({ DSH_SESSION_ROOT: root }, cwd)
      expect(sessions.map(s => s.sessionId)).toEqual(['repl-a'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('sorts sessions with and without a createdAt', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repl-hist-'))
    const cwd = '/tmp/proj-mixed'
    try {
      writeSession(root, cwd, 'repl-dated1', 300)
      writeSession(root, cwd, 'repl-dated2', 100)
      const noDate = join(root, projectKey(cwd), 'repl-undated')
      mkdirSync(noDate, { recursive: true })
      writeFileSync(join(noDate, SESSION_LOG_FILE), compressFrame('{"type":"session","id":"repl-undated"}\n'))
      const sessions = listSessionsIn(root, cwd)
      // two dated sessions (300 then 100) plus one undated → undated sorts to 0
      expect(sessions.map(s => s.sessionId)).toEqual(['repl-dated1', 'repl-dated2', 'repl-undated'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('sorts equally when every session lacks a createdAt', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repl-hist-'))
    const cwd = '/tmp/proj-node'
    try {
      for (const id of ['repl-n1', 'repl-n2']) {
        const dir = join(root, projectKey(cwd), id)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, SESSION_LOG_FILE), compressFrame(`{"type":"session","id":"${id}"}\n`))
      }
      const sessions = listSessionsIn(root, cwd)
      expect(sessions.every(s => s.createdAt === undefined)).toBe(true)
      expect(sessions.map(s => s.sessionId).sort()).toEqual(['repl-n1', 'repl-n2'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('listAllSessions', () => {
  it('scans every workspace and crops the newest-first, labelling each cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repl-hist-'))
    const wa = '/tmp/proj-a'
    const wb = '/tmp/proj-b'
    try {
      writeSession(root, wa, 'a-new', 300, 'A newer')
      writeSession(root, wa, 'a-old', 100, 'A older')
      writeSession(root, wb, 'b-new', 200, 'B newer')
      const sessions = listAllSessions({ DSH_SESSION_ROOT: root })
      // Newest first across all workspaces; each row carries its own workspace.
      expect(sessions.map(s => s.sessionId)).toEqual(['a-new', 'b-new', 'a-old'])
      expect(sessions.map(s => s.cwd)).toEqual([wa, wb, wa])
      expect(sessions[0]!.title).toBe('A newer')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('skips stray files and non-workspace dirs, and returns [] on a missing store', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repl-hist-'))
    try {
      writeSession(root, '/tmp/proj-c', 'c-1', 10)
      // A stray top-level file and an unrelated dir are not workspace keys.
      writeFileSync(join(root, 'notes.txt'), 'x')
      mkdirSync(join(root, 'sub'), { recursive: true })
      expect(listAllSessions({ DSH_SESSION_ROOT: root }).map(s => s.sessionId)).toEqual(['c-1'])
      expect(listAllSessions({ DSH_SESSION_ROOT: join(root, 'missing') })).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('skips workspaces whose key is not a --…-- dir, only trusting recorded headers', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repl-hist-'))
    // A real workspace underneath a dir named arbitrarily (not a valid --…-- key)
    // is deliberately NOT scanned: `listAllSessions` only walks project-key dirs,
    // and cross-workspace handoff routes on the recorded header cwd.
    try {
      const dir = join(root, 'custom-ws')
      const sessionDir = join(dir, 'repl-real')
      mkdirSync(sessionDir, { recursive: true })
      const header = JSON.stringify({ type: 'session', version: 0, id: 'repl-real', createdAt: 7, cwd: '/real/ws' })
      writeFileSync(join(sessionDir, SESSION_LOG_FILE), compressFrame(header + '\n'))
      expect(listAllSessions({ DSH_SESSION_ROOT: root })).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('sessionRoot', () => {
  it('honors DSH_SESSION_ROOT (absolute) and resolves relative against cwd', () => {
    expect(sessionRoot({ DSH_SESSION_ROOT: '/abs/root' })).toBe('/abs/root')
    expect(sessionRoot({ DSH_SESSION_ROOT: 'sub/dir' })).toMatch(/sub[/\\]dir$/)
  })
  it('defaults to <cwd>/.sessions', () => {
    expect(sessionRoot({})).toMatch(/\.sessions$/)
  })
})

describe('formatCreatedAt', () => {
  it('formats a millisecond epoch as YYYY-MM-DD HH:mm', () => {
    const ms = Date.UTC(2026, 7, 15, 3, 32)
    expect(formatCreatedAt(ms)).toMatch(/2026-08-15 \d{2}:32/)
  })
  it('falls back for missing/invalid input', () => {
    expect(formatCreatedAt(undefined)).toBe('未知时间')
    expect(formatCreatedAt(Number.NaN)).toBe('未知时间')
  })
})

describe('describeSession', () => {
  it('prefers a title when known, else shows the id', () => {
    expect(describeSession({ sessionId: 'repl-x', createdAt: 0, cwd: undefined, title: 'hello' }))
      .toContain('hello')
    expect(describeSession({ sessionId: 'repl-x', createdAt: 0, cwd: undefined, title: undefined }))
      .toContain('repl-x')
  })
})

describe('readSessionEvents', () => {
  function writeLog(root: string, cwd: string, id: string, lines: string[]): void {
    const dir = join(root, projectKey(cwd), encodeSessionId(id))
    mkdirSync(dir, { recursive: true })
    const frames = lines.map(compressFrame)
    // A multi-line frame is also covered by joining two lines in one frame.
    const artifact = Buffer.concat([
      ...frames.slice(0, 1),
      compressFrame([...lines.slice(1, 3), ''].join('\n')),
      ...frames.slice(3),
    ])
    writeFileSync(join(dir, SESSION_LOG_FILE), artifact)
  }

  it('decodes a persisted session log in order, preserving type/time/data', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repl-events-'))
    const cwd = '/tmp/proj'
    try {
      const lines = [
        JSON.stringify({ type: 'session', id: 'repl-x', createdAt: 1, cwd }),
        JSON.stringify({ type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } }),
        JSON.stringify({ type: 'assistant/chunk', seq: 1, time: 11, data: { chunk: { type: 'text-delta', text: 'hi' } } }),
        JSON.stringify({ type: 'turn/end', seq: 2, time: 12, data: { turn: 1, reason: { kind: 'completed' } } }),
      ]
      writeLog(root, cwd, 'repl-x', lines)
      const events = readSessionEvents('repl-x', { DSH_SESSION_ROOT: root }, cwd)
      expect(events.map(e => e.type)).toEqual(['session', 'turn/start', 'assistant/chunk', 'turn/end'])
      expect(events[1]).toEqual({ type: 'turn/start', time: 10, data: { turn: 1 } })
      expect(events[2]?.data).toEqual({ chunk: { type: 'text-delta', text: 'hi' } })
      expect(events[3]?.time).toBe(12)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns [] for an unknown or unreadable session', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repl-events-'))
    try {
      expect(readSessionEvents('nope', { DSH_SESSION_ROOT: root }, '/tmp/proj')).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('userMessageText', () => {
  const ev = (data: unknown): { type: string; time: number; data?: unknown } => ({ type: 'user/message', time: 1, data })

  it('returns the human user text from a source.kind=user message', () => {
    expect(userMessageText(ev({
      content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' there' }],
      source: { kind: 'user' },
    }))).toBe('hello there')
  })

  it('skips system injections such as skill catalogs', () => {
    expect(userMessageText(ev({
      content: [{ type: 'text', text: 'big catalog' }],
      source: { kind: 'skill-catalog' },
    }))).toBeUndefined()
  })

  it('returns undefined for empty, non-object, or non-user records', () => {
    expect(userMessageText(ev({ content: [{ type: 'text', text: '   ' }], source: { kind: 'user' } }))).toBeUndefined()
    expect(userMessageText(ev({ content: 'nope', source: { kind: 'user' } }))).toBeUndefined()
    expect(userMessageText(ev({ content: [], source: { kind: 'user' } }))).toBeUndefined()
    expect(userMessageText(ev(null))).toBeUndefined()
    expect(userMessageText(ev(42))).toBeUndefined()
  })
})
