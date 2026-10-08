/** Terminal rendering keeps prose live and tool outcomes explicit. */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { mindLabel, openingContextDelivery, openingContextMessage, renderEvent } from '../src/interactive.ts'

function event(type: SessionEvent['type'], data: unknown): SessionEvent {
  return { type, data, seq: 1, time: 1 } as SessionEvent
}

describe('interactive rendering', () => {
  it('streams prose and pairs a tool result with the model call', () => {
    let out = ''
    let err = ''
    const io = { write: (text: string) => { out += text }, error: (text: string) => { err += text } }
    const calls = new Map<string, string>()
    const state = { streamed: false }

    renderEvent(io, event('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' },
    }), calls, state)
    renderEvent(io, event('tool/call', {
      turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}',
    }), calls, state)
    renderEvent(io, event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [], isError: false }],
        source: { kind: 'tool', callId: 'call-1' },
      },
    }), calls, state)

    expect(out).toBe('hello\n[tool] read\n[tool done] read\n')
    expect(err).toBe('')
    expect(state.streamed).toBe(true)
  })

  it('shows the harness error that ended a turn', () => {
    let err = ''
    renderEvent({ write: () => {}, error: text => { err += text } }, event('turn/end', {
      turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'try later' } },
    }), new Map(), { streamed: false })
    expect(err).toContain('RATE_LIMIT: try later')
  })
})

describe('the opening context turn', () => {
  it('asks for no opening turn when the pane was started without a context file', () => {
    expect(openingContextMessage(undefined)).toBeUndefined()
  })

  it('asks for no opening turn when the context file held only whitespace', () => {
    expect(openingContextMessage('  \n\t ')).toBeUndefined()
  })

  it('carries the context file verbatim as the opening user turn', () => {
    const message = openingContextMessage('you are mid-build on story 4')
    expect(message?.content).toEqual([
      { type: 'text', text: 'you are mid-build on story 4' },
    ])
    expect(message?.source).toEqual({ kind: 'plugin', plugin: 'hive-terminal-context' })
  })
})

describe('the mind the pane speaks for', () => {
  it('labels the prompt with the mind named in the environment', () => {
    expect(mindLabel({ MIND_NAME: 'mordecai' })).toBe('mordecai')
  })

  it('falls back to the harness name when no mind is named', () => {
    expect(mindLabel({})).toBe('dsh')
    expect(mindLabel({ MIND_NAME: '   ' })).toBe('dsh')
  })
})

describe('how an opening context reaches the conversation', () => {
  it('answers a staged rotation rather than queueing it', () => {
    const delivery = openingContextDelivery('the summary\n\nand what I typed', true)
    expect(delivery?.submit).toBe(true)
    expect(delivery?.message.content).toEqual([
      { type: 'text', text: 'the summary\n\nand what I typed' },
    ])
  })

  it('queues a fresh terminal\'s standing context rather than answering it', () => {
    // Standing context is not a question. Submitting it would make the pane
    // open by replying to its own system prompt.
    const delivery = openingContextDelivery('you are mid-build on story 4', false)
    expect(delivery?.submit).toBe(false)
  })

  it('has nothing to deliver when there is no opening context', () => {
    expect(openingContextDelivery(undefined, true)).toBeUndefined()
    expect(openingContextDelivery('  \n\t ', true)).toBeUndefined()
  })
})
