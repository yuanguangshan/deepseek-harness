import { describe, expect, it } from 'vitest'
import { formatAgentsPanel, formatDuration, recordSubagentNotification } from '../src/agents-panel.ts'

const START = { parentSessionId: 'p1', childSessionId: 'c1' }
const FINISH = { agentId: 'c1', provider: 'deepseek' }

describe('recordSubagentNotification', () => {
  it('opens a run on start and closes it on finish with duration data', () => {
    let runs = recordSubagentNotification([], 'subagent.started', START, 1_000)
    expect(runs).toEqual([{ agentId: 'c1', parentSessionId: 'p1', startedAt: 1_000 }])
    runs = recordSubagentNotification(runs, 'subagent.finished', FINISH, 3_500)
    expect(runs).toEqual([{ agentId: 'c1', parentSessionId: 'p1', provider: 'deepseek', startedAt: 1_000, endedAt: 3_500 }])
  })
  it('keeps a finished-first delivery visible', () => {
    const runs = recordSubagentNotification([], 'subagent.finished', FINISH, 2_000)
    expect(runs).toEqual([{ agentId: 'c1', provider: 'deepseek', startedAt: 2_000, endedAt: 2_000 }])
  })
  it('ignores malformed params and unknown methods', () => {
    expect(recordSubagentNotification([], 'subagent.started', null, 1)).toEqual([])
    expect(recordSubagentNotification([], 'subagent.started', {}, 1)).toEqual([])
    expect(recordSubagentNotification([], 'session.event', START, 1)).toEqual([])
  })
})

describe('formatDuration', () => {
  it('formats ms, seconds, and minutes', () => {
    expect(formatDuration(850)).toBe('850ms')
    expect(formatDuration(12_340)).toBe('12.3s')
    expect(formatDuration(242_000)).toBe('4m02s')
  })
})

describe('formatAgentsPanel', () => {
  it('renders the empty hint', () => {
    expect(formatAgentsPanel([], 0)).toContain('没有后台代理记录')
  })
  it('lists newest first and marks live runs', () => {
    let runs = recordSubagentNotification([], 'subagent.started', { childSessionId: 'older' }, 1_000)
    runs = recordSubagentNotification(runs, 'subagent.finished', { agentId: 'older' }, 2_000)
    runs = recordSubagentNotification(runs, 'subagent.started', { childSessionId: 'newest' }, 9_000)
    const out = formatAgentsPanel(runs, 10_000)
    expect(out.indexOf('newest')).toBeLessThan(out.indexOf('older'))
    expect(out).toContain('● 运行中')
    expect(out).toContain('✓ 完成')
  })
})
