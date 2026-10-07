/**
 * A turn is observable while it is being written: the runner writes each
 * assistant delta to stdout as the provider produces it, so a chat surface
 * renders a long answer as it arrives rather than when the process exits.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { streamDelta } from '../src/index.ts'
import { bench, streamingTurn } from './support.ts'

function event(type: SessionEvent['type'], data: unknown): SessionEvent {
  return { type, data, seq: 1, time: 1 } as SessionEvent
}

describe('a turn written as it happens', () => {
  it('writes each piece of prose to stdout before the turn report', async () => {
    const test = await bench(streamingTurn)

    const { code, report, deltas, order } = await test.run({
      task: 'answer me', sessionId: 'conv-stream', mode: 'create',
    })

    expect(code).toBe(0)
    expect(deltas.filter(delta => delta.kind === 'text').map(delta => delta.text))
      .toEqual(['half ', 'an answer'])
    // Every delta precedes the report, which is the whole point: a surface that
    // only ever saw them afterwards would still show nothing until turn end.
    expect(order[order.length - 1]).toBe('report')
    expect(order.indexOf('delta')).toBeLessThan(order.length - 1)
    expect(report.text).toBe('half an answer')
    await test.ctx.fiber.dispose()
  })

  it('writes the model reasoning too, labelled apart from its answer', async () => {
    const test = await bench(streamingTurn)

    const { deltas } = await test.run({
      task: 'answer me', sessionId: 'conv-reasoning', mode: 'create',
    })

    expect(deltas.map(delta => delta.kind)).toEqual(['reasoning', 'text', 'text'])
    expect(deltas[0]).toEqual({ kind: 'reasoning', text: 'weighing it' })
    await test.ctx.fiber.dispose()
  })

  it('writes nothing for a tool call being assembled, or for an empty fragment', () => {
    expect(streamDelta(event('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'tool-call-delta', index: 0, callId: 'call-1', name: 'write_file',
        arguments: '{"path": "a' },
    }))).toBeUndefined()
    expect(streamDelta(event('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '' },
    }))).toBeUndefined()
    expect(streamDelta(event('tool/call', {
      turn: 1, step: 1, callId: 'call-1', name: 'write_file', arguments: '{}',
    }))).toBeUndefined()
  })
})
