/** The invocation's own validity: one conversation, one task, no inventing either. */

import { readFileSync } from 'node:fs'

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

  it('opens an interactive conversation without inventing an opening turn', () => {
    expect(resolveInvocation([], {
      sessionId: 'conv-1', interactive: true, contextFile: '/tmp/context.txt',
    }, path => (path === '/tmp/context.txt' ? 'standing context' : 'wrong file')))
      .toEqual({
        interactive: true,
        initialContext: 'standing context',
        sessionId: 'conv-1',
        mode: 'create',
      })
  })

  it('carries a staged rotation as context the successor answers, not context it queues', () => {
    // A rotation seed is the carry-forward with the user's own typed message
    // concatenated on. Queued, the pane opens with their question sitting
    // unanswered in the conversation and nothing on screen; the successor has
    // to take it as a turn and reply to it.
    expect(resolveInvocation([], {
      sessionId: 'conv-1', interactive: true, contextFile: '/tmp/seed.txt',
      contextAsTurn: true,
    }, () => 'the summary\n\nand what I typed')).toEqual({
      interactive: true,
      initialContext: 'the summary\n\nand what I typed',
      contextAsTurn: true,
      sessionId: 'conv-1',
      mode: 'create',
    })
  })

  it('opens unseeded when the context file cannot be read, rather than refusing', () => {
    // A refusal here exits the process, and by then the caller has already
    // respawned the pane and recorded the rotation as done — so the refusal
    // is a dead pane. An unseeded conversation is recoverable: the gateway
    // holds the same text on the session row and hands it back on the next
    // attach.
    expect(resolveInvocation([], {
      sessionId: 'conv-1', interactive: true, contextFile: '/tmp/gone.txt',
      contextAsTurn: true,
    }, () => { throw new Error('ENOENT') })).toEqual({
      interactive: true,
      sessionId: 'conv-1',
      mode: 'create',
    })
  })

  it('opens unseeded when the context file holds nothing to answer', () => {
    expect(resolveInvocation([], {
      sessionId: 'conv-1', interactive: true, contextFile: '/tmp/blank.txt',
      contextAsTurn: true,
    }, () => '  \n\t ')).toEqual({
      interactive: true,
      sessionId: 'conv-1',
      mode: 'create',
    })
  })

  it('refuses to answer an opening context when there is none to answer', () => {
    expect(() => resolveInvocation([], {
      sessionId: 'conv-1', interactive: true, contextAsTurn: true,
    })).toThrow(UsageError)
  })

  it('refuses a positional task and goal driving in interactive mode', () => {
    expect(() => resolveInvocation(['task'], { resume: 'conv-1', interactive: true }))
      .toThrow(UsageError)
    expect(() => resolveInvocation([], {
      resume: 'conv-1', interactive: true, goalRounds: '2',
    })).toThrow(UsageError)
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

describe('the bundle patch that hands startup values to the runner', () => {
  it('maps every value the startup provider resolves, so none is silently dropped', () => {
    // The gap this guards is invisible to every other test here: the runner's
    // own tests construct its config directly, so a field present on the
    // provider and absent from this YAML type-checks, passes, and reaches the
    // runner as undefined — a flag parsed off the command line and then
    // quietly ignored.
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const mapped = [...patch.matchAll(/ctx\.resumableHeadlessStartup\.(\w+)/g)].map(m => m[1])
    // Every option supplied, so every field the provider can carry is present:
    // a field that only materializes sometimes is exactly the one a patch drops.
    const batch = Object.keys(resolveInvocation([], {
      sessionId: 'abc', taskFile: 'task', goalRounds: '40', goalObjectiveFile: 'objective',
      stopOnFailedCall: true,
    }, () => 'text'))
    const interactive = Object.keys(resolveInvocation([], {
      sessionId: 'abc', interactive: true, contextFile: 'context',
      contextAsTurn: true,
    }, () => 'text'))
    const resolved = [...new Set([...batch, ...interactive])]

    expect([...mapped].sort()).toEqual([...resolved].sort())
  })
})
