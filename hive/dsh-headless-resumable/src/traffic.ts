/**
 * The tool traffic of one turn, counted off the durable session log.
 *
 * For the first several nights of the training loop this is the only
 * measurement that means anything: a small model emits tool calls and either
 * the harness could run them or it could not, and the app's behaviour score
 * stays at zero throughout. The count therefore comes from the log the harness
 * itself wrote — `tool/call` and `tool/result` events — and never from parsing
 * the prose the model printed.
 *
 * @module @hive/dsh-headless-resumable/traffic
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** What one turn did with its tools. */
export interface ToolTraffic {
  /** Calls the model asked for. */
  emitted: number
  /** Calls that came back with a result of any kind. */
  answered: number
  /** Results carrying no error. */
  succeeded: number
  /** Results carrying an error. */
  failed: number
  /**
   * Calls with no result at all — the turn ended while they were outstanding.
   * Counted rather than folded into failures: a call nobody answered says the
   * run died, and a call answered with an error says the tool refused it.
   */
  unanswered: number
  /**
   * Failures by the error code the tool itself reported, and calls by tool
   * name. Reported as the codes and names that actually occurred rather than
   * sorted into buckets of our own invention — whether a failure is the model's
   * malformed arguments or the harness's missing capability is a question the
   * code answers, and inventing the taxonomy here would bury it.
   */
  failuresByCode: Record<string, number>
  callsByTool: Record<string, number>
  /**
   * The calls the harness could not serve, as the name the model asked for and
   * the argument names it supplied — a tool that is not registered under that
   * name, or one that is but rejected the arguments.
   *
   * This is the whole input to the fix. A model emits the tool names and
   * argument spellings its training put in it, and that is not ours to change:
   * the harness grows a tool matching the call instead. Reported from the run
   * rather than dug out of a session log by hand, because the next model speaks
   * a different dialect and the same work starts over. Names only — one
   * argument is an entire file, and this rides in a single result frame.
   */
  unservedCalls: UnservedCall[]
}

/** One call the harness refused, as the model spelled it. */
export interface UnservedCall {
  /** The tool name the model asked for. */
  name: string
  /** The argument names it supplied, in the order they arrived. */
  parameters: string[]
  /** How many times this exact call shape was refused in the interval. */
  count: number
}

/** Longest argument name reported, and the most names reported per call. */
const MAX_PARAMETER_NAME = 120
const MAX_PARAMETERS = 24

/**
 * The call a result closes. Every writer of a real `tool/result` — the agent
 * loop, the session repair pass, the compaction pruner — names it on the
 * message, and nothing else identifies it: position cannot, because one call
 * left unanswered by a drained dispatch offsets every attribution after it for
 * the rest of a forty-round run. A message carrying no source at all is not a
 * shape this harness writes, so it falls back to position rather than taking
 * the whole report down.
 * @param message - the result event's message.
 * @param outstanding - call ids still awaiting a result, in call order.
 * @returns the call id to attribute this result to.
 */
function resultCallId(message: unknown, outstanding: ReadonlySet<string>): string {
  if (message !== null && typeof message === 'object' && 'source' in message) {
    const source = (message as { source?: unknown }).source
    if (source !== null && typeof source === 'object' && 'callId' in source) {
      return String((source as { callId: unknown }).callId)
    }
  }
  const oldest = outstanding.values().next()
  return oldest.done === true ? '' : oldest.value
}

/** Failure codes that mean the call never reached a tool body. */
const UNSERVED_CODES: ReadonlySet<string> = new Set(['UNKNOWN_TOOL', 'INVALID_ARGS'])

/**
 * The argument names of a logged call, whose arguments are a JSON string.
 * @param raw - the `tool/call` event's `arguments` payload.
 * @returns the top-level keys, or an empty list for anything that is not an object.
 */
function argumentNames(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    // Capped in both directions. A model malformed enough to fail on arguments
    // is a model that can put a whole function body in key position, and this
    // rides in the single JSON line the run reports itself on.
    return Object.keys(parsed).slice(0, MAX_PARAMETERS).map(key => key.slice(0, MAX_PARAMETER_NAME))
  } catch {
    // Unparseable arguments are still a call worth reporting by name.
    return []
  }
}

/** One refused call, as the model spelled it and as the harness refused it. */
export interface FailedCall {
  /** The tool name the model asked for. */
  name: string
  /** The argument names it supplied. */
  parameters: string[]
  /** The code the tool refused it with. */
  code: string
  /** The error class the tool refused with, beside the code. */
  errorName: string
}

/**
 * The codes that mean the harness refused a call it should have served: the
 * arguments did not satisfy the schema, or the model named a tool that is not
 * there. Both are dialect gaps — the model asked for something coherent in the
 * dialect it knows and got nothing back — and both are fixed by widening the
 * harness rather than by the model trying again.
 */
export const DIALECT_REFUSAL_CODES: readonly string[] = ['INVALID_ARGS', 'UNKNOWN_TOOL']

/**
 * The first dialect refusal at or after `firstSeq`, if there is one.
 *
 * While the harness is being hardened, the first such refusal is the whole
 * result of a run: everything after it is the same model working around the
 * same gap. So a run can be stopped on it, which is why this is separate from
 * the tally — the tally answers what a finished run did, and this answers
 * whether to carry on at all.
 *
 * An ordinary tool failure is not one of these and does not appear here. A file
 * that is not there, an edit string that does not match, a command that exited
 * non-zero: the tool did its job, the result is the answer, and the model
 * recovers from it in a turn. Stopping a forty-round build on one of those
 * throws away the run to report something the harness already handled
 * correctly.
 * @param events - the session's durable events.
 * @param firstSeq - the sequence number the owned interval starts at.
 * @returns the call, or nothing while no call has been refused this way.
 */
export function firstDialectRefusal(
  events: readonly SessionEvent[], firstSeq: number,
): FailedCall | undefined {
  const outstanding = new Set<string>()
  const calls = new Map<string, { name: string; parameters: string[] }>()
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'tool/call') {
      outstanding.add(String(event.data.callId))
      calls.set(String(event.data.callId), {
        name: event.data.name,
        parameters: argumentNames(event.data.arguments),
      })
      continue
    }
    if (event.type !== 'tool/result') continue
    const callId = resultCallId(event.data.message, outstanding)
    outstanding.delete(callId)
    const error = event.data.error
    if (error === undefined) continue
    if (!DIALECT_REFUSAL_CODES.includes(error.code)) continue
    const call = calls.get(callId)
    return {
      name: call?.name ?? 'unnamed',
      parameters: call?.parameters ?? [],
      code: error.code,
      errorName: error.name,
    }
  }
  return undefined
}

/** An empty tally, so a turn that emitted nothing reports zeroes rather than nothing. */
export const NO_TRAFFIC: ToolTraffic = {
  emitted: 0,
  answered: 0,
  succeeded: 0,
  failed: 0,
  unanswered: 0,
  failuresByCode: {},
  callsByTool: {},
  unservedCalls: [],
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1
}

/**
 * Count the tool traffic in the events at or after `firstSeq`.
 * @param events - the session's durable events.
 * @param firstSeq - the sequence number the owned interval starts at, so a
 *   resumed conversation reports this turn's traffic and not the whole history's.
 * @returns the tally for that interval.
 */
export function toolTraffic(events: readonly SessionEvent[], firstSeq: number): ToolTraffic {
  const traffic: ToolTraffic = {
    ...NO_TRAFFIC,
    failuresByCode: {},
    callsByTool: {},
    unservedCalls: [],
  }
  const outstanding = new Set<string>()
  const calls = new Map<string, { name: string; parameters: string[] }>()
  // Keyed by call shape, not appended per occurrence: the failure this report
  // exists to catch is one untrained-away tool name emitted every round, and a
  // forty-round run would put forty identical entries on one line while
  // `failuresByCode` beside it already carries the count.
  const unserved = new Map<string, UnservedCall>()
  // Results seen, so a pruner's replacement event — compaction appends a second
  // `tool/result` per oversized result, error field and all — is tallied once.
  const answered = new Set<string>()
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'tool/call') {
      traffic.emitted += 1
      bump(traffic.callsByTool, event.data.name)
      outstanding.add(String(event.data.callId))
      calls.set(String(event.data.callId), {
        name: event.data.name,
        parameters: argumentNames(event.data.arguments),
      })
      continue
    }
    if (event.type !== 'tool/result') continue
    // A result names its own call on the message it carries, which is what the
    // session repair pass reads. Position does not identify it: one call left
    // unanswered by a drained dispatch offsets every later attribution, and a
    // compaction pruner appends a duplicate result that would consume a second
    // call's entry — so the dialect reported would be a tool that worked.
    const callId = resultCallId(event.data.message, outstanding)
    if (answered.has(callId)) continue
    answered.add(callId)
    traffic.answered += 1
    const error = event.data.error
    if (error === undefined) {
      traffic.succeeded += 1
    } else {
      traffic.failed += 1
      bump(traffic.failuresByCode, error.code)
    }
    outstanding.delete(callId)
    const call = calls.get(callId)
    if (error === undefined || !UNSERVED_CODES.has(error.code) || call === undefined) continue
    const key = `${call.name}\u0000${call.parameters.join('\u0000')}`
    const seen = unserved.get(key)
    if (seen === undefined) {
      unserved.set(key, { ...call, count: 1 })
    } else {
      seen.count += 1
    }
  }
  traffic.unanswered = outstanding.size
  traffic.unservedCalls = [...unserved.values()]
  return traffic
}
