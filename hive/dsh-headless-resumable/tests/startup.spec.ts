/** The invocation's own validity: one conversation, one task, no inventing either. */

import { describe, expect, it } from 'vitest'

import { resolveInvocation, UsageError } from '../src/startup.ts'

describe('resolving an invocation', () => {
  it('opens a conversation under the id it was handed', () => {
    expect(resolveInvocation(['build', 'the', 'app'], { sessionId: 'conv-1' }))
      .toEqual({ task: 'build the app', sessionId: 'conv-1', mode: 'create' })
  })

  it('continues the conversation it was handed', () => {
    expect(resolveInvocation(['fix', 'it'], { resume: 'conv-1' }))
      .toEqual({ task: 'fix it', sessionId: 'conv-1', mode: 'resume' })
  })

  it('refuses an invocation that names no conversation, because it mints none', () => {
    expect(() => resolveInvocation(['build'], {})).toThrow(UsageError)
    expect(() => resolveInvocation(['build'], { resume: '   ' })).toThrow(UsageError)
  })

  it('refuses an invocation that both opens and continues', () => {
    expect(() => resolveInvocation(['build'], { sessionId: 'a', resume: 'b' })).toThrow(UsageError)
  })

  it('refuses an invocation with no task', () => {
    expect(() => resolveInvocation([], { resume: 'conv-1' })).toThrow(UsageError)
    expect(() => resolveInvocation(['   '], { resume: 'conv-1' })).toThrow(UsageError)
  })

  it('takes the task from a file, for a turn too large for argv to carry', () => {
    const turn = 'x'.repeat(200_000)
    expect(resolveInvocation([], { resume: 'conv-1', taskFile: '/tmp/turn.txt' },
      path => (path === '/tmp/turn.txt' ? turn : 'wrong file')))
      .toEqual({ task: turn, sessionId: 'conv-1', mode: 'resume' })
  })

  it('refuses a task named twice', () => {
    expect(() => resolveInvocation(['inline'], { resume: 'conv-1', taskFile: '/tmp/turn.txt' },
      () => 'from the file')).toThrow(UsageError)
  })

  it('refuses a task file it cannot read, rather than running an empty turn', () => {
    expect(() => resolveInvocation([], { resume: 'conv-1', taskFile: '/tmp/gone.txt' }, () => {
      throw new Error('ENOENT')
    })).toThrow(UsageError)
  })
})
