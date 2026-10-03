/** The tool traffic tally, which is the first phase's only real measurement. */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { toolTraffic } from '../src/traffic.ts'

let seq = 0
function event<T extends SessionEvent['type']>(type: T, data: unknown): SessionEvent {
  seq += 1
  return { seq, type, data, at: 0 } as unknown as SessionEvent
}

function call(callId: string, name: string): SessionEvent {
  return event('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
}

function result(error?: { name: string; code: string }): SessionEvent {
  return event('tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', content: [] },
    ...error === undefined ? {} : { error },
  })
}

describe('tool traffic', () => {
  it('tells an executed call from a refused one and from one nobody answered', () => {
    const events = [
      call('a', 'write_file'),
      result(),
      call('b', 'write_file'),
      result({ name: 'ToolRefused', code: 'REFUSED' }),
      call('c', 'shell'),
      result({ name: 'SyntaxError', code: 'BAD_ARGUMENTS' }),
      call('d', 'shell'),
    ]

    const traffic = toolTraffic(events, 0)

    expect(traffic.emitted).toBe(4)
    expect(traffic.answered).toBe(3)
    expect(traffic.succeeded).toBe(1)
    expect(traffic.failed).toBe(2)
    expect(traffic.unanswered).toBe(1)
    expect(traffic.failuresByCode).toEqual({ REFUSED: 1, BAD_ARGUMENTS: 1 })
    expect(traffic.callsByTool).toEqual({ write_file: 2, shell: 2 })
  })

  it('counts this turn only, so a resumed conversation does not re-report its history', () => {
    const history = [call('old', 'shell'), result()]
    const mine = [call('new', 'write_file'), result()]
    const events = [...history, ...mine]

    const traffic = toolTraffic(events, mine[0]!.seq)

    expect(traffic.emitted).toBe(1)
    expect(traffic.callsByTool).toEqual({ write_file: 1 })
  })

  it('reports zeroes for a turn that emitted nothing', () => {
    const traffic = toolTraffic([event('turn/start', { turn: 1 })], 0)

    expect(traffic).toMatchObject({ emitted: 0, answered: 0, unanswered: 0 })
    expect(traffic.failuresByCode).toEqual({})
  })
})
