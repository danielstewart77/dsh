/**
 * Running a turn inside a conversation this process did not mint: the id is
 * honoured on creation, continued on resume, and never invented.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'

import { apply, internals } from '../src/index.ts'
import type { TurnReport } from '../src/index.ts'
import { bench } from './support.ts'

describe('a turn in a conversation the hive minted', () => {
  it('creates the session under the id it was handed, not one of its own', async () => {
    const test = await bench()

    const { code, report } = await test.run({
      task: 'build the app', sessionId: 'conv-abc', mode: 'create',
    })

    expect(code).toBe(0)
    expect(report.sessionId).toBe('conv-abc')
    expect(test.sessions().get(SessionId('conv-abc'))).toBeDefined()
    await test.ctx.fiber.dispose()
  })

  it('continues the conversation on a second task rather than starting a new one', async () => {
    const test = await bench()
    await test.run({ task: 'build the app', sessionId: 'conv-abc', mode: 'create' })

    const { code, report } = await test.run({
      task: 'now fix the chart', sessionId: 'conv-abc', mode: 'resume',
    })

    expect({ code, error: report.error }).toEqual({ code: 0, error: undefined })
    expect(report.mode).toBe('resume')
    const session = test.sessions().get(SessionId('conv-abc'))!
    const asked = session.events
      .filter(event => event.type === 'user/message')
      .map(event => JSON.stringify(event.data))
    expect(asked.some(text => text.includes('build the app'))).toBe(true)
    expect(asked.some(text => text.includes('now fix the chart'))).toBe(true)
    // This turn's traffic only: the first turn's tool call is history now.
    expect(report.traffic.emitted).toBe(1)
    expect(report.text).toBe('answer 2')
    await test.ctx.fiber.dispose()
  })

  it('refuses a conversation it cannot continue instead of quietly creating one', async () => {
    const test = await bench()

    const { code, report, err } = await test.run({
      task: 'fix the chart', sessionId: 'conv-missing', mode: 'resume',
    })

    expect(code).toBe(1)
    expect(report.outcome).toBe('refused')
    expect(report.error?.code).toBe('NO_SUCH_SESSION')
    expect(err).toContain('NO_SUCH_SESSION')
    expect(test.sessions().get(SessionId('conv-missing'))).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('refuses a turn with no model rather than substituting one', async () => {
    const ctx = new Context()
    let out = ''
    internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
    internals.stderr = { write: () => true }
    let created = 0
    const exited = new Promise<number>((resolve) => { ctx.provide('appExit', resolve) })
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'p', model: '' }),
    } as never)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('agents', {
      create: () => { created += 1; return Promise.reject(new Error('unused')) },
    } as never)

    apply(ctx, { task: 'build it', sessionId: 'conv-abc', mode: 'create' })

    expect(await exited).toBe(1)
    const report = JSON.parse(out) as TurnReport
    expect(report.error?.code).toBe('NO_MODEL')
    expect(created).toBe(0)
    await ctx.fiber.dispose()
  })

  it('reports a completed turn as data, not as an exit code', async () => {
    const test = await bench()

    const { report } = await test.run({ task: 'build it', sessionId: 'conv-abc', mode: 'create' })

    expect(report).toMatchObject({
      sessionId: 'conv-abc',
      mode: 'create',
      outcome: 'completed',
      text: 'answer 1',
    })
    expect(report.traffic).toMatchObject({ emitted: 1, succeeded: 1, failed: 0, unanswered: 0 })
    await test.ctx.fiber.dispose()
  })

  it('reports a failed turn with the error the harness itself recorded', async () => {
    const test = await bench((session, message, turn) => {
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 1 })
      session.append('user/message', message, { surfaceOp: 'append' })
      session.append('tool/call', {
        turn, step: 1, callId: 'c1' as never, name: 'write_file', arguments: 'not json',
      })
      session.append('tool/result', {
        turn,
        step: 1,
        message: { role: 'tool', content: [] } as never,
        error: { name: 'SyntaxError', code: 'BAD_ARGUMENTS' },
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', {
        turn,
        reason: { kind: 'error', error: { code: 'SERVER', message: 'provider unavailable' } },
      })
    })

    const { code, report } = await test.run({
      task: 'build it', sessionId: 'conv-abc', mode: 'create',
    })

    expect(code).toBe(1)
    expect(report.outcome).toBe('error')
    expect(report.error).toEqual({ code: 'SERVER', message: 'provider unavailable' })
    expect(report.traffic).toMatchObject({ emitted: 1, failed: 1, succeeded: 0 })
    expect(report.traffic.failuresByCode).toEqual({ BAD_ARGUMENTS: 1 })
    await test.ctx.fiber.dispose()
  })
})
