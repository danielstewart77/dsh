/** The tool traffic tally, which is the first phase's only real measurement. */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { firstFailedCall, toolTraffic, UNCODED_REFUSAL } from '../src/traffic.ts'

let seq = 0
function event<T extends SessionEvent['type']>(type: T, data: unknown): SessionEvent {
  seq += 1
  return { seq, type, data, at: 0 } as unknown as SessionEvent
}

function call(callId: string, name: string, args = '{}'): SessionEvent {
  return event('tool/call', { turn: 1, step: 1, callId, name, arguments: args })
}

// A result names its own call on the message, the way the agent loop writes it.
function result(callId: string, error?: { name: string; code: string; message?: string }): SessionEvent {
  return event('tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', content: [], source: { callId } },
    ...error === undefined ? {} : { error },
  })
}

// A call the runtime refused before any tool ran: no structured error at all,
// only isError on the content the model reads.
function refusedResult(callId: string, said: string): SessionEvent {
  return event('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      content: [{ type: 'text', text: said, isError: true }],
      source: { callId },
    },
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

describe('a refusal carrying no code of its own', () => {
  // Measured on a real run: three `write` calls were refused with "invalid
  // escalation: justification is only valid together with sandbox_permissions"
  // and the run reported 54 of 54 served.
  it('counts as a failure rather than a success in the tally', () => {
    const events = [
      call('a', 'write', '{"file_path":"/app/db.py","content":"x"}'),
      refusedResult('a', 'Error: invalid escalation: justification is only valid together with sandbox_permissions'),
      call('b', 'read', '{"file_path":"/app/db.py"}'),
      result('b'),
    ]

    const traffic = toolTraffic(events, 0)

    expect(traffic.emitted).toBe(2)
    expect(traffic.succeeded).toBe(1)
    expect(traffic.failed).toBe(1)
    expect(traffic.failuresByCode).toEqual({ [UNCODED_REFUSAL]: 1 })
  })

  it('is reported as a call the harness never served', () => {
    const events = [
      call('a', 'write', '{"file_path":"/app/db.py","content":"x"}'),
      refusedResult('a', 'Error: invalid escalation'),
    ]

    expect(toolTraffic(events, 0).unservedCalls).toEqual([
      { name: 'write', parameters: ['file_path', 'content'], count: 1 },
    ])
  })

  it('stops the run, naming the harness and quoting what it said', () => {
    const events = [
      call('a', 'write', '{"file_path":"/app/db.py"}'),
      refusedResult('a', 'Error: invalid escalation: justification is only valid together with sandbox_permissions'),
    ]

    const failure = firstFailedCall(events, 0)

    expect(failure?.origin).toBe('harness')
    expect(failure?.code).toBe(UNCODED_REFUSAL)
    expect(failure?.message).toContain('invalid escalation')
  })
})

describe('the first failed call', () => {
  it('names the harness as the origin when the arguments were refused', () => {
    const events = [
      call('a', 'read', '{"file_path":"/app/db.py"}'),
      result('a'),
      call('b', 'bash', '{"command":"pytest"}'),
      result('b', { name: 'ToolArgsError', code: 'INVALID_ARGS', message: 'invalid arguments: command' }),
    ]

    expect(firstFailedCall(events, 0)).toEqual({
      name: 'bash',
      parameters: ['command'],
      code: 'INVALID_ARGS',
      errorName: 'ToolArgsError',
      origin: 'harness',
      message: 'invalid arguments: command',
    })
  })

  it('names the harness as the origin for a tool it does not have', () => {
    const events = [
      call('a', 'str_replace', '{"old_str":"a"}'),
      result('a', { name: 'UnknownToolError', code: 'UNKNOWN_TOOL', message: 'no tool named str_replace' }),
    ]

    expect(firstFailedCall(events, 0)?.origin).toBe('harness')
  })

  it('stops on a tool that ran and failed, naming the tool as the origin', () => {
    const events = [
      call('a', 'str_replace_editor', '{"file_path":"/app/notes.md","old_str":"## Status"}'),
      result('a', { name: 'FsError', code: 'FS_EDIT_NOT_FOUND', message: 'no match for "## Status"' }),
    ]

    const failure = firstFailedCall(events, 0)

    expect(failure?.origin).toBe('tool')
    expect(failure?.code).toBe('FS_EDIT_NOT_FOUND')
  })

  it('carries what the failure said, which is usually the whole fix', () => {
    const events = [
      call('a', 'str_replace_editor', '{"command":"create","file_path":"/app/stub.py"}'),
      result('a', {
        name: 'Error',
        code: 'TOOL_FAILED',
        message: 'Parameter `file_text` is required for command: create',
      }),
    ]

    expect(firstFailedCall(events, 0)?.message).toContain('`file_text` is required')
  })

  it('trims a message long enough to be a file, since the report is one line', () => {
    const events = [
      call('a', 'read', '{"file_path":"/app/db.py"}'),
      result('a', { name: 'FsError', code: 'FS_TOO_LARGE', message: 'x'.repeat(5000) }),
    ]

    expect(firstFailedCall(events, 0)?.message.length).toBe(400)
  })

  it('reports the first failure, not a later one', () => {
    const events = [
      call('a', 'read', '{"file_path":"/app/gone.py"}'),
      result('a', { name: 'FsError', code: 'FS_NOT_FOUND', message: 'not found' }),
      call('b', 'glob', '{"pattern":"**/*.py"}'),
      result('b', { name: 'ToolArgsError', code: 'INVALID_ARGS', message: 'invalid' }),
    ]

    expect(firstFailedCall(events, 0)?.name).toBe('read')
  })

  it('looks at this turn only, so a resumed conversation does not stop on its history', () => {
    const history = [
      call('old', 'bash', '{"command":"ls"}'),
      result('old', { name: 'ToolArgsError', code: 'INVALID_ARGS', message: 'invalid' }),
    ]
    const mine = [call('new', 'read', '{"file_path":"/app/db.py"}'), result('new')]

    expect(firstFailedCall([...history, ...mine], mine[0]!.seq)).toBeUndefined()
  })

  it('reports nothing while every result has come back clean', () => {
    const events = [call('a', 'read', '{"file_path":"/app/db.py"}'), result('a')]

    expect(firstFailedCall(events, 0)).toBeUndefined()
  })
})
