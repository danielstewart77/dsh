/** The tool traffic tally, which is the first phase's only real measurement. */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { toolTraffic } from '../src/traffic.ts'

let seq = 0
function event<T extends SessionEvent['type']>(type: T, data: unknown): SessionEvent {
  seq += 1
  return { seq, type, data, at: 0 } as unknown as SessionEvent
}

function call(callId: string, name: string, args = '{}'): SessionEvent {
  return event('tool/call', { turn: 1, step: 1, callId, name, arguments: args })
}

// A result names its own call on the message, the way the agent loop writes it.
function result(callId: string, error?: { name: string; code: string }): SessionEvent {
  return event('tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', content: [], source: { callId } },
    ...error === undefined ? {} : { error },
  })
}

describe('tool traffic', () => {
  it('tells an executed call from a refused one and from one nobody answered', () => {
    const events = [
      call('a', 'write_file'),
      result('a'),
      call('b', 'write_file'),
      result('b', { name: 'ToolRefused', code: 'REFUSED' }),
      call('c', 'shell'),
      result('c', { name: 'SyntaxError', code: 'BAD_ARGUMENTS' }),
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
    const history = [call('old', 'shell'), result('old')]
    const mine = [call('new', 'write_file'), result('new')]
    const events = [...history, ...mine]

    const traffic = toolTraffic(events, mine[0]!.seq)

    expect(traffic.emitted).toBe(1)
    expect(traffic.callsByTool).toEqual({ write_file: 1 })
  })

  // What the harness could not serve is the whole input to the fix: a model
  // emits the tool names and argument spellings its training put in it, and the
  // harness grows a tool matching the call. These guard the report that names
  // them, which is the only place that evidence surfaces from a run.
  it('names the tool and the argument names of a call it could not serve', () => {
    const events = [
      call('a', 'str_replace_based_edit_tool', '{"path":"x.py","old":"a","new":"b"}'),
      result('a', { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' }),
    ]

    const traffic = toolTraffic(events, 0)

    expect(traffic.unservedCalls).toEqual([
      { name: 'str_replace_based_edit_tool', parameters: ['path', 'old', 'new'], count: 1 },
    ])
  })

  it('counts one repeated refusal once rather than once per round', () => {
    const events = [
      call('a', 'apply_patch', '{"patch":"..."}'),
      result('a', { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' }),
      call('b', 'apply_patch', '{"patch":"..."}'),
      result('b', { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' }),
    ]

    const traffic = toolTraffic(events, 0)

    expect(traffic.unservedCalls).toEqual([{ name: 'apply_patch', parameters: ['patch'], count: 2 }])
  })

  it('names the refused call even when an earlier call was never answered', () => {
    const events = [
      call('stranded', 'bash', '{"command":"pnpm build"}'),
      call('later', 'apply_patch', '{"patch":"..."}'),
      result('later', { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' }),
    ]

    const traffic = toolTraffic(events, 0)

    expect(traffic.unanswered).toBe(1)
    expect(traffic.unservedCalls).toEqual([{ name: 'apply_patch', parameters: ['patch'], count: 1 }])
  })

  it('tallies a pruner\'s replacement result once, not twice', () => {
    const pruned = { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' }
    const events = [
      call('a', 'apply_patch', '{"patch":"..."}'),
      result('a', pruned),
      // compaction-tool-result-pruner appends a second result per oversized
      // one, copying the error with it.
      result('a', pruned),
    ]

    const traffic = toolTraffic(events, 0)

    expect(traffic.answered).toBe(1)
    expect(traffic.failuresByCode).toEqual({ UNKNOWN_TOOL: 1 })
    expect(traffic.unservedCalls).toEqual([{ name: 'apply_patch', parameters: ['patch'], count: 1 }])
  })

  it('caps an argument name long enough to be a file, and how many it reports', () => {
    const longKey = 'x'.repeat(500)
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 1]))
    const events = [
      call('a', 'write_file', JSON.stringify({ [longKey]: 1 })),
      result('a', { name: 'ToolArgsError', code: 'INVALID_ARGS' }),
      call('b', 'write_file', JSON.stringify(many)),
      result('b', { name: 'ToolArgsError', code: 'INVALID_ARGS' }),
    ]

    const traffic = toolTraffic(events, 0)

    expect(traffic.unservedCalls[0]!.parameters[0]!.length).toBe(120)
    expect(traffic.unservedCalls[1]!.parameters).toHaveLength(24)
  })

  it('reports zeroes for a turn that emitted nothing', () => {
    const traffic = toolTraffic([event('turn/start', { turn: 1 })], 0)

    expect(traffic).toMatchObject({ emitted: 0, answered: 0, unanswered: 0 })
    expect(traffic.failuresByCode).toEqual({})
  })
})
