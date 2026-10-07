/**
 * A turn is observable while it is being written: the runner writes each
 * assistant delta to stdout as the provider produces it, so a chat surface
 * renders a long answer as it arrives rather than when the process exits.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { SessionId } from '@deepseek-ai/dsh-session'

import { streamDelta } from '../src/index.ts'
import { bench, drivingGoals, stdoutSoFar, streamingTurn } from './support.ts'
import type { Script } from './support.ts'

function event(type: SessionEvent['type'], data: unknown): SessionEvent {
  return { type, data, seq: 1, time: 1 } as SessionEvent
}

describe('a turn written as it happens', () => {
  it('writes each piece of prose while the model is still writing', async () => {
    // Asserting the order of collected lines proves nothing: an implementation
    // that buffered every delta and flushed them, in order, immediately before
    // the report would produce an identical list and leave the surface showing
    // nothing for the whole turn. So the script itself reads stdout mid-turn.
    const seen: string[] = []
    const observing: Script = (session, message, turn) => {
      streamingTurn(session, message, turn)
      seen.push(stdoutSoFar.out)
    }
    const test = await bench(observing)

    const { code, report, deltas } = await test.run({
      task: 'answer me', sessionId: 'conv-stream', mode: 'create',
    })

    expect(code).toBe(0)
    expect(deltas.filter(delta => delta.kind === 'text').map(delta => delta.text))
      .toEqual(['half ', 'an answer'])
    // Written before the turn had even ended, let alone before the report.
    expect(seen[0]).toContain('"text":"an answer"')
    expect(seen[0]).not.toContain('sessionId')
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

  it('keeps streaming through every goal round, not only the first', async () => {
    // A goal-driven build is forty model turns in one process, and they are the
    // longest turns there are. A subscription scoped to the opening turn would
    // stream round one and leave the surface dead for the rest of the job.
    const test = await bench(streamingTurn)
    test.ctx.provide('goals', drivingGoals('build the app', 3, 3) as never)

    const { deltas } = await test.run({
      task: 'build the app', sessionId: 'conv-goal-stream', mode: 'create', goalRounds: 3,
    })

    // The opening turn plus the driven rounds, each contributing its own prose.
    expect(deltas.filter(delta => delta.kind === 'text').length)
      .toBeGreaterThan(2)
    await test.ctx.fiber.dispose()
  })

  it('never streams a delegate\'s prose in the mind\'s own voice', async () => {
    // An in-process subagent runs on a context descended from this agent's, and
    // event admission extends upwards — so the parent's listener sees the
    // delegate's chunks unless it checks whose session they belong to.
    let tree: Awaited<ReturnType<typeof bench>> | undefined
    const delegating: Script = (session, message, turn) => {
      const other = tree!.sessions().create(SessionId(`delegate-${turn}`))
      other.append('turn/start', { turn })
      other.append('assistant/chunk', {
        turn, step: 1, chunk: { type: 'text-delta', index: 0, text: 'the delegate speaking' },
      })
      streamingTurn(session, message, turn)
    }
    tree = await bench(delegating)
    const test = tree

    const { deltas } = await test.run({
      task: 'delegate it', sessionId: 'conv-delegating', mode: 'create',
    })

    expect(deltas.map(delta => delta.text)).not.toContain('the delegate speaking')
    await test.ctx.fiber.dispose()
  })
})
