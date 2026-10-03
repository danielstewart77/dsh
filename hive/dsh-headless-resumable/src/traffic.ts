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
  }
  const outstanding = new Set<string>()
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'tool/call') {
      traffic.emitted += 1
      bump(traffic.callsByTool, event.data.name)
      outstanding.add(String(event.data.callId))
      continue
    }
    if (event.type !== 'tool/result') continue
    traffic.answered += 1
    const error = event.data.error
    if (error === undefined) {
      traffic.succeeded += 1
    } else {
      traffic.failed += 1
      bump(traffic.failuresByCode, error.code)
    }
    // A result identifies its call through the message, not the event data, so
    // the oldest outstanding call is the one it closes: results arrive in call
    // order within a step, and the only use of the set is the final remainder.
    const oldest = outstanding.values().next()
    if (oldest.done !== true) outstanding.delete(oldest.value)
  }
  traffic.unanswered = outstanding.size
  return traffic
}
