/** Escalating a refused tool call to another mind, once, as it happens. */

import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { SessionId } from '@deepseek-ai/dsh-session'

import { Escalator, commsSender, harnessRefusal, refusalKey } from '../src/escalate.ts'
import type { EscalationMessage } from '../src/escalate.ts'
import { bench } from './support.ts'
import type { Script } from './support.ts'

const dirs: string[] = []
function markerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-escalate-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

let seq = 0
function event<T extends SessionEvent['type']>(type: T, data: unknown): SessionEvent {
  seq += 1
  return { seq, type, data, at: 0 } as unknown as SessionEvent
}

function call(callId: string, name: string, args = '{}'): SessionEvent {
  return event('tool/call', { turn: 1, step: 1, callId, name, arguments: args })
}

/** A result the agent loop wrote with a structured class and code. */
function coded(callId: string, code: string, message: string, name = 'ToolRefused'): SessionEvent {
  return event('tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', content: [{ type: 'text', text: `Error: ${message}`, isError: true }], source: { callId } },
    error: { name, code, message },
  })
}

/** A result carrying no class and no code: a tool body that threw a plain Error. */
function uncoded(callId: string, said: string): SessionEvent {
  return event('tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', content: [{ type: 'text', text: said, isError: true }], source: { callId } },
  })
}

function session(id: string, events: SessionEvent[]): Session {
  return { id, events } as unknown as Session
}

/** A recorder standing in for the transport, which is where the process stops being ours. */
function recorder(outcome: 'ok' | 'refused' | 'throws' = 'ok') {
  const sent: EscalationMessage[] = []
  const signals: AbortSignal[] = []
  return {
    sent,
    signals,
    send: async (body: EscalationMessage, signal: AbortSignal) => {
      sent.push(body)
      signals.push(signal)
      if (outcome === 'throws') throw new Error('gateway unreachable')
      return { ok: outcome === 'ok' }
    },
  }
}

const SKIPPY = '14cb820b-4a42-4f04-a593-54f532fd1d2f'
const CYPHER = '7b1f22c4-0000-4000-8000-0000000000ff'

function escalator(dir: string, send: ReturnType<typeof recorder>['send'], recipient = SKIPPY) {
  return new Escalator({
    recipientMindId: recipient,
    senderMindId: CYPHER,
    senderName: 'cypher',
    markerDir: dir,
    conversationId: 'conv-1',
    cwd: '/app/build',
    send,
    timeoutMs: 50,
  })
}

/** The denial the harness records when a policy declines a call before the body runs. */
function policyDenial(tool = 'write', args = '{"file_path":"/app/db.py","content":"x"}') {
  const events = [call('a', tool, args), coded('a', 'DENIED_BY_POLICY', 'write denied by sandbox policy')]
  const refusal = harnessRefusal(session('conv-1', events), events[1] as SessionEvent)
  if (refusal === undefined) throw new Error('fixture is not a harness refusal')
  return refusal
}

describe('what counts as a harness refusal', () => {
  it('reports a policy denial, and does not report a tool that ran and threw', () => {
    const refused = [call('a', 'write', '{"file_path":"/app/db.py"}'), coded('a', 'DENIED_BY_POLICY', 'denied')]
    const threw = [call('b', 'read', '{"file_path":""}'), uncoded('b', 'Error: file_path must be a non-empty string')]

    expect(harnessRefusal(session('c', refused), refused[1] as SessionEvent)).toMatchObject({ tool: 'write' })
    expect(harnessRefusal(session('c', threw), threw[1] as SessionEvent)).toBeUndefined()
  })

  it('names the call off the tool/call it closes, not off the newest one', () => {
    // The refused call is emitted FIRST and a later call follows it, which is
    // the ordinary shape of a parallel step. A lookup that took the newest
    // tool/call, or any call at all, would report the wrong tool's name and
    // argument names — and key the marker on them.
    const events = [
      call('a', 'write_file', '{"path":"/y","body":"z"}'),
      coded('a', 'UNKNOWN_TOOL', 'unknown tool "write_file"'),
      call('b', 'read', '{"file_path":"/x"}'),
    ]

    expect(harnessRefusal(session('conv-9', events), events[1] as SessionEvent)).toEqual({
      tool: 'write_file',
      parameters: ['path', 'body'],
      code: 'UNKNOWN_TOOL',
      errorName: 'ToolRefused',
      message: 'unknown tool "write_file"',
      sessionId: 'conv-9',
    })
  })

  it('reports a refusal whose call is not on the session rather than dropping it', () => {
    const orphan = coded('gone', 'DENIED_BY_POLICY', 'declined')

    expect(harnessRefusal(session('conv-9', [orphan]), orphan)).toMatchObject({
      tool: 'unnamed',
      parameters: [],
      code: 'DENIED_BY_POLICY',
    })
  })

  it('does not report a person declining, or a tool rejecting its own arguments', () => {
    const asked = [call('a', 'write', '{"file_path":"/x"}'), coded('a', 'DENIED_BY_APPROVAL', 'the user rejected tool "write"')]
    const fussy = [call('b', 'edit', '{"file_path":"/x","old_string":"y"}'), coded('b', 'TOOL_REJECTED_ARGS', 'old_string and new_string are identical')]

    expect(harnessRefusal(session('c', asked), asked[1] as SessionEvent)).toBeUndefined()
    expect(harnessRefusal(session('c', fussy), fussy[1] as SessionEvent)).toBeUndefined()
  })
})

describe('escalating a refusal', () => {
  it('sends it to the configured mind, from this one', async () => {
    const gateway = recorder()
    const escalate = escalator(markerDir(), gateway.send)

    escalate.report(policyDenial())
    await escalate.drain()

    expect(gateway.sent).toHaveLength(1)
    expect(gateway.sent[0]?.to_mind).toBe(SKIPPY)
    expect(gateway.sent[0]?.from_mind).toBe(CYPHER)
  })

  it('carries the call, the refusal and where it happened', async () => {
    const gateway = recorder()
    const escalate = escalator(markerDir(), gateway.send)

    escalate.report(policyDenial())
    await escalate.drain()

    const metadata = gateway.sent[0]?.metadata ?? {}
    expect(metadata).toMatchObject({
      tool: 'write',
      parameters: ['file_path', 'content'],
      code: 'DENIED_BY_POLICY',
      error_name: 'ToolRefused',
      refusal_message: 'write denied by sandbox policy',
      session_id: 'conv-1',
      cwd: '/app/build',
      mind: 'cypher',
    })
    expect(gateway.sent[0]?.conversation_id).toBe('conv-1')
    expect(gateway.sent[0]?.content).toContain('write(file_path, content)')
    expect(gateway.sent[0]?.content).toContain('write denied by sandbox policy')
  })

  it('sends nothing when no recipient is configured, and sends the same refusal when one is', async () => {
    const off = recorder()
    const on = recorder()
    const unconfigured = escalator(markerDir(), off.send, '')
    const configured = escalator(markerDir(), on.send)

    unconfigured.report(policyDenial())
    configured.report(policyDenial())
    await Promise.all([unconfigured.drain(), configured.drain()])

    expect(off.sent).toEqual([])
    expect(on.sent).toHaveLength(1)
  })
})

describe('reporting one gap once', () => {
  it('stays silent on a repeat through the same escalator', async () => {
    const gateway = recorder()
    const escalate = escalator(markerDir(), gateway.send)

    escalate.report(policyDenial())
    await escalate.drain()
    escalate.report(policyDenial())
    await escalate.drain()

    expect(gateway.sent).toHaveLength(1)
  })

  it('stays silent for a later run reading the directory cold', async () => {
    const dir = markerDir()
    const first = recorder()
    const second = recorder()

    const one = escalator(dir, first.send)
    one.report(policyDenial())
    await one.drain()

    const two = escalator(dir, second.send)
    two.report(policyDenial())
    await two.drain()

    expect(first.sent).toHaveLength(1)
    expect(second.sent).toEqual([])
  })

  it('treats the same call with its argument names in another order as one gap', async () => {
    const gateway = recorder()
    const escalate = escalator(markerDir(), gateway.send)

    escalate.report(policyDenial('write', '{"file_path":"/app/db.py","content":"x"}'))
    await escalate.drain()
    escalate.report(policyDenial('write', '{"content":"x","file_path":"/app/db.py"}'))
    await escalate.drain()

    expect(gateway.sent).toHaveLength(1)
  })

  it('reports two tools separately when only the tool differs', async () => {
    const gateway = recorder()
    const escalate = escalator(markerDir(), gateway.send)

    escalate.report(policyDenial('write', '{"file_path":"/x","content":"y"}'))
    escalate.report(policyDenial('edit', '{"file_path":"/x","content":"y"}'))
    await escalate.drain()

    expect(gateway.sent.map(message => message.metadata['tool'])).toEqual(['write', 'edit'])
  })

  it('reports the same tool and code again when the refusal itself differs', async () => {
    const gateway = recorder()
    const escalate = escalator(markerDir(), gateway.send)
    const refused = (said: string) => {
      const events = [call('a', 'bash', '{"command":"x"}'), coded('a', 'DENIED_BY_POLICY', said)]
      return harnessRefusal(session('conv-1', events), events[1] as SessionEvent) as never
    }

    // One tool, one argument name, one code, two entirely different fixes.
    escalate.report(refused('command rm is not permitted'))
    escalate.report(refused('network access is not permitted'))
    await escalate.drain()

    expect(gateway.sent).toHaveLength(2)
  })

  it('treats one gap whose text differs only in its numbers as one gap', async () => {
    const gateway = recorder()
    const escalate = escalator(markerDir(), gateway.send)
    const refused = (said: string) => {
      const events = [call('a', 'write', '{"file_path":"/x"}'), coded('a', 'INVALID_ARGS', said)]
      return harnessRefusal(session('conv-1', events), events[1] as SessionEvent) as never
    }

    escalate.report(refused('invalid arguments: content[0] is not a string'))
    escalate.report(refused('invalid arguments: content[7] is not a string'))
    await escalate.drain()

    expect(gateway.sent).toHaveLength(1)
  })

  it('reports the same tool again when the code differs', async () => {
    const gateway = recorder()
    const escalate = escalator(markerDir(), gateway.send)
    const events = [call('a', 'write', '{"file_path":"/x","content":"y"}'), coded('a', 'UNKNOWN_TOOL', 'unknown tool "write"')]
    const other = harnessRefusal(session('conv-1', events), events[1] as SessionEvent)

    escalate.report(policyDenial())
    escalate.report(other as never)
    await escalate.drain()

    expect(gateway.sent.map(message => message.metadata['code'])).toEqual(['DENIED_BY_POLICY', 'UNKNOWN_TOOL'])
  })

  it('reports it again once the marker has been cleared', async () => {
    const dir = markerDir()
    const gateway = recorder()
    const escalate = escalator(dir, gateway.send)

    escalate.report(policyDenial())
    await escalate.drain()
    unlinkSync(join(dir, `${refusalKey(policyDenial())}.json`))
    escalate.report(policyDenial())
    await escalate.drain()

    expect(gateway.sent).toHaveLength(2)
  })

  it('records the gap in a file a mind can read, named by digest rather than by the model text', async () => {
    const dir = markerDir()
    const gateway = recorder()
    const escalate = escalator(dir, gateway.send)
    // A tool the harness does not have is the primary trigger, so its name is
    // whatever the model invented — including a path out of the directory.
    const events = [call('a', '../../config.toml', '{"x":1}'), coded('a', 'UNKNOWN_TOOL', 'unknown tool')]
    const refusal = harnessRefusal(session('conv-1', events), events[1] as SessionEvent)

    escalate.report(refusal as never)
    await escalate.drain()

    expect(readdirSync(dir)).toEqual([`${refusalKey(refusal as never)}.json`])
  })

  it('writes the gap into the marker so a mind can find the one it just fixed', async () => {
    const dir = markerDir()
    const gateway = recorder()
    const escalate = escalator(dir, gateway.send)

    escalate.report(policyDenial())
    await escalate.drain()

    const key = refusalKey(policyDenial())
    const held = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8')) as Record<string, unknown>
    expect(held).toMatchObject({
      marker: key,
      tool: 'write',
      parameters: ['file_path', 'content'],
      code: 'DENIED_BY_POLICY',
      message: 'write denied by sandbox policy',
      cwd: '/app/build',
      mind: 'cypher',
      delivered: true,
    })
  })

  it('leaves a claim it never delivered saying so, rather than claiming it reported', () => {
    const dir = markerDir()
    // A send that neither resolves nor rejects: the shape an interrupt between
    // the claim and the answer leaves behind.
    const escalate = new Escalator({
      recipientMindId: SKIPPY,
      senderMindId: CYPHER,
      senderName: 'cypher',
      markerDir: dir,
      conversationId: 'conv-1',
      cwd: '/app/build',
      timeoutMs: 50,
      send: () => new Promise(() => {}),
    })

    escalate.report(policyDenial())

    const held = JSON.parse(readFileSync(join(dir, `${refusalKey(policyDenial())}.json`), 'utf8')) as Record<string, unknown>
    expect(held['delivered']).toBe(false)
  })

  it('reports every occurrence rather than none when the escalation path is a file', async () => {
    const dir = markerDir()
    const blocked = join(dir, 'escalations')
    writeFileSync(blocked, 'not a directory')
    const gateway = recorder()
    const escalate = escalator(blocked, gateway.send)

    escalate.report(policyDenial())
    await escalate.drain()

    expect(gateway.sent).toHaveLength(1)
  })

  it('bounds that repetition to once per gap while the process lives', async () => {
    const dir = markerDir()
    const blocked = join(dir, 'escalations')
    writeFileSync(blocked, 'not a directory')
    const gateway = recorder()
    const escalate = escalator(blocked, gateway.send)

    for (let round = 0; round < 5; round += 1) escalate.report(policyDenial())
    await escalate.drain()

    expect(gateway.sent).toHaveLength(1)
  })

  it('still suppresses the repeat when the escalation directory did not exist', async () => {
    const gateway = recorder()
    const escalate = escalator(join(markerDir(), 'not', 'yet'), gateway.send)

    escalate.report(policyDenial())
    await escalate.drain()
    escalate.report(policyDenial())
    await escalate.drain()

    expect(gateway.sent).toHaveLength(1)
  })
})

describe('the transport that decides whether it landed', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  it('posts the message to the broker and reports a 2xx as delivered', async () => {
    const seen: { url: string; method: string | undefined; body: unknown; auth: string | null }[] = []
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seen.push({
        url: String(url),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get('authorization'),
      })
      return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch
    const body = { from_mind: CYPHER, to_mind: SKIPPY, conversation_id: 'c', content: 'x', metadata: {} }

    // A trailing slash on the configured URL must not double up on the path.
    const outcome = await commsSender('http://comms.invalid:8426/', 'tok')(body, AbortSignal.timeout(50))

    expect(outcome).toEqual({ ok: true })
    expect(seen).toEqual([{
      url: 'http://comms.invalid:8426/broker/messages',
      method: 'POST',
      body,
      auth: 'Bearer tok',
    }])
  })

  it('reports the broker refusing an unresolvable recipient as not delivered', async () => {
    // The broker answers 404 for a to_mind it cannot resolve. A transport that
    // read only "no exception thrown" would call that a delivery, and the claim
    // kept over it would silence the gap permanently.
    globalThis.fetch = (async () => new Response(
      '{"error":"Mind \'skippy\' not found in broker.minds."}', { status: 404 },
    )) as typeof globalThis.fetch

    const outcome = await commsSender('http://comms.invalid:8426', undefined)(
      { from_mind: CYPHER, to_mind: 'skippy', conversation_id: 'c', content: 'x', metadata: {} },
      AbortSignal.timeout(50),
    )

    expect(outcome).toEqual({ ok: false })
  })

  it('sends no authorization header when this mind holds no service token', async () => {
    let auth: string | null = 'unset'
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      auth = new Headers(init?.headers).get('authorization')
      return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch

    await commsSender('http://comms.invalid:8426', undefined)(
      { from_mind: CYPHER, to_mind: SKIPPY, conversation_id: 'c', content: 'x', metadata: {} },
      AbortSignal.timeout(50),
    )

    expect(auth).toBeNull()
  })
})

describe('a gateway that does not take the message', () => {
  it('swallows a thrown send and leaves the gap reportable', async () => {
    const dir = markerDir()
    const broken = recorder('throws')
    const working = recorder()

    const escalate = escalator(dir, broken.send)
    escalate.report(policyDenial())
    await expect(escalate.drain()).resolves.toBeUndefined()

    const retry = escalator(dir, working.send)
    retry.report(policyDenial())
    await retry.drain()

    expect(working.sent).toHaveLength(1)
  })

  it('treats a refusing gateway as undelivered rather than as reported', async () => {
    const dir = markerDir()
    const refusing = recorder('refused')
    const working = recorder()

    const escalate = escalator(dir, refusing.send)
    escalate.report(policyDenial())
    await escalate.drain()

    const retry = escalator(dir, working.send)
    retry.report(policyDenial())
    await retry.drain()

    expect(working.sent).toHaveLength(1)
  })

  it('waits for a send still in flight, so a one-shot run cannot exit mid-message', async () => {
    const answered: string[] = []
    const held = Promise.withResolvers<{ ok: boolean }>()
    const escalate = new Escalator({
      recipientMindId: SKIPPY,
      senderMindId: CYPHER,
      senderName: 'cypher',
      markerDir: markerDir(),
      conversationId: 'conv-1',
      cwd: '/app/build',
      timeoutMs: 500,
      send: async () => {
        const outcome = await held.promise
        answered.push('sent')
        return outcome
      },
    })

    escalate.report(policyDenial())
    // Nothing has reached the gateway yet, which is the state an undrained
    // process would exit in.
    expect(answered).toEqual([])
    setTimeout(() => { held.resolve({ ok: true }) }, 20)
    await escalate.drain()

    expect(answered).toEqual(['sent'])
  })

  it('hands the send a deadline, so one that never answers cannot hold the run', async () => {
    const hanging: AbortSignal[] = []
    const escalate = new Escalator({
      recipientMindId: SKIPPY,
      senderMindId: CYPHER,
      senderName: 'cypher',
      markerDir: markerDir(),
      conversationId: 'conv-1',
      cwd: '/app/build',
      timeoutMs: 20,
      send: async (_body, signal) => {
        hanging.push(signal)
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }) })
        throw new Error('aborted')
      },
    })

    escalate.report(policyDenial())
    await escalate.drain()

    expect(hanging[0]?.aborted).toBe(true)
  })
})

describe('the escalation a real run sends', () => {
  const vars = ['DSH_ESCALATE_TO_MIND_ID', 'DSH_ESCALATION_DIR', 'COMMS_URL', 'COMMS_BEARER_TOKEN', 'MIND_ID', 'MIND_NAME']
  const saved = new Map(vars.map(name => [name, process.env[name]]))
  const realFetch = globalThis.fetch

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    globalThis.fetch = realFetch
  })

  /** A turn whose single tool call a policy declined. */
  const refusedTurn: Script = (sess, message, turn) => {
    sess.append('turn/start', { turn })
    sess.append('step/start', { turn, step: 1 })
    sess.append('user/message', message, { surfaceOp: 'append' })
    sess.append('tool/call', {
      turn, step: 1, callId: `call-${turn}` as never, name: 'write', arguments: '{"file_path":"/app/db.py","content":"x"}',
    })
    sess.append('tool/result', {
      turn,
      step: 1,
      message: {
        role: 'tool',
        content: [{ type: 'text', text: 'Error: write denied by sandbox policy', isError: true }],
        source: { kind: 'tool', callId: `call-${turn}` },
      } as never,
      error: { name: 'ToolRefused', code: 'DENIED_BY_POLICY', message: 'write denied by sandbox policy' },
    }, { surfaceOp: 'append' })
    sess.append('step/end', { turn, step: 1 })
    sess.append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  it('goes out while the turn is still running, off the committed event', async () => {
    const dir = markerDir()
    process.env.DSH_ESCALATE_TO_MIND_ID = SKIPPY
    process.env.DSH_ESCALATION_DIR = dir
    process.env.COMMS_URL = 'http://comms.invalid:8426/'
    process.env.COMMS_BEARER_TOKEN = 'service-token' // secret-guard: allow — invented fixture value
    process.env.MIND_ID = CYPHER
    process.env.MIND_NAME = 'cypher'

    const posted: { url: string; body: unknown; authorization: string | null; endedAlready: boolean }[] = []
    const test = await bench(refusedTurn)
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const live = test.sessions().get(SessionId('conv-refused'))
      posted.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get('authorization'),
        // The turn must not have finished yet: a refusal reported after the
        // fact is the tally this whole path exists to stop trusting.
        endedAlready: (live?.events ?? []).some(entry => entry.type === 'turn/end'),
      })
      return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch

    await test.run({ task: 'build the app', sessionId: 'conv-refused', mode: 'create' })

    expect(posted).toHaveLength(1)
    expect(posted[0]?.url).toBe('http://comms.invalid:8426/broker/messages')
    expect(posted[0]?.authorization).toBe('Bearer service-token')
    expect(posted[0]?.endedAlready).toBe(false)
    expect(posted[0]?.body).toMatchObject({
      to_mind: SKIPPY,
      from_mind: CYPHER,
      conversation_id: 'conv-refused',
      metadata: {
        tool: 'write',
        code: 'DENIED_BY_POLICY',
        request_type: 'harness_refusal',
        // Sourced here and nowhere else: the mind's own name off its
        // environment, and the directory the process is actually running in.
        mind: 'cypher',
        cwd: process.cwd(),
      },
    })
    expect(readdirSync(dir)).toHaveLength(1)
    await test.ctx.fiber.dispose()
  })

  it('sends nothing at all when this mind escalates to nobody', async () => {
    delete process.env.DSH_ESCALATE_TO_MIND_ID
    process.env.COMMS_URL = 'http://comms.invalid:8426/'
    process.env.MIND_ID = CYPHER
    let posts = 0
    globalThis.fetch = (async () => { posts += 1; return new Response('{}', { status: 200 }) }) as typeof globalThis.fetch

    const test = await bench(refusedTurn)
    const { report } = await test.run({ task: 'build the app', sessionId: 'conv-quiet', mode: 'create' })

    expect(posts).toBe(0)
    expect(report.traffic.failed).toBe(1)
    await test.ctx.fiber.dispose()
  })

  it('says so on stderr when it is told to escalate but cannot reach a gateway', async () => {
    process.env.DSH_ESCALATE_TO_MIND_ID = SKIPPY
    process.env.MIND_ID = CYPHER
    delete process.env.COMMS_URL
    let posts = 0
    globalThis.fetch = (async () => { posts += 1; return new Response('{}', { status: 200 }) }) as typeof globalThis.fetch

    const test = await bench(refusedTurn)
    const { err } = await test.run({ task: 'build the app', sessionId: 'conv-nogw', mode: 'create' })

    expect(posts).toBe(0)
    expect(err).toContain('DSH_ESCALATE_TO_MIND_ID is set but COMMS_URL or MIND_ID is not')
    await test.ctx.fiber.dispose()
  })
})
