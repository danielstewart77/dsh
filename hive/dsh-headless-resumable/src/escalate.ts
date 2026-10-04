/**
 * Escalate a refused tool call to another mind, once, as it happens.
 *
 * A run that reports its tool traffic at the end reports it to whoever reads the
 * report, and nothing reads a report at four in the morning. Worse, the report
 * is written by the same process whose machinery is broken: measured on a real
 * run, three refused `write` calls were tallied as successes, the model went on
 * building against two modules that were never on disk, and the only account of
 * any of it was a sentence the model itself wrote claiming verification it had
 * not done. So the signal does not come from the model and it does not come from
 * a tally. It comes off the durable event the instant the refusal is committed.
 *
 * Only the harness's own refusals travel. A tool body that ran and threw — an
 * empty `file_path`, an MCP server answering `isError` — is the model being bad
 * at its job, and waking another mind for it is a page nobody can action. Which
 * side refused is the `origin` on the failure, which is why every refusing path
 * in the harness now carries a code of its own rather than being recognised by
 * the absence of one.
 *
 * And it travels once. The second mind's job is to go and fix the harness, so a
 * gap reported every round would put several minds on one problem, each editing
 * the same files. One marker file per distinct refusal is the whole mechanism:
 * present means reported, and deleting it re-arms the report for when the fix
 * turns out not to have worked.
 *
 * @module @hive/dsh-headless-resumable/escalate
 */

import { createHash } from 'node:crypto'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { argumentNames, failureOrigin, resultFailure } from './traffic.ts'

/** One refused call, as the model spelled it and as the harness refused it. */
export interface HarnessRefusal {
  /** The tool name the model asked for. */
  tool: string
  /** The argument names it supplied, in the order they arrived. */
  parameters: string[]
  /** The code the harness refused it with. */
  code: string
  /** The error class recorded beside the code. */
  errorName: string
  /** What the refusal said, which is usually the whole fix. */
  message: string
  /** The conversation it happened in. */
  sessionId: string
}

/**
 * How long a send may take before it is abandoned.
 *
 * Node's `fetch` has no default timeout and a pending socket is a ref'd handle,
 * so a gateway that accepts the connection and never answers keeps a one-shot
 * run alive after its report has already been written and its exit code set.
 * The adapter then sees a finished report from a process that never exits,
 * which reads as a wedged mind rather than a wedged POST.
 */
export const ESCALATION_TIMEOUT_MS = 10_000

/** Characters of the key digest kept in a marker filename. */
const KEY_LENGTH = 24

/**
 * The identity of a refusal: the tool, the argument names and the code.
 *
 * Digested rather than spelled out, because every component is text the model
 * authored. A tool the harness does not have is the primary trigger, so the
 * name is one it invented — `../../config.toml` would put the marker outside
 * the escalation directory, a name with a path separator would fail to write at
 * all and re-report every round, and twenty-four argument names of a hundred
 * and twenty characters each exceed what any filesystem will accept as one
 * name. The readable tuple lives inside the file, which is where a mind looking
 * for the gap it just fixed can actually read it.
 *
 * Argument names are sorted here and only here. A model samples its JSON, so
 * `read({file_path, limit})` and `read({limit, file_path})` are the same gap
 * arriving in two orders; keying on arrival order pages the other mind twice
 * for one problem. The message keeps the order they came in, because that is
 * what the model actually emitted.
 * @param refusal - the refusal to key.
 * @returns the hex digest naming this refusal's marker.
 */
export function refusalKey(refusal: Pick<HarnessRefusal, 'tool' | 'parameters' | 'code'>): string {
  const tuple = [refusal.tool, [...refusal.parameters].sort().join('\u0000'), refusal.code].join('\u0000')
  return createHash('sha256').update(tuple, 'utf8').digest('hex').slice(0, KEY_LENGTH)
}

/**
 * The harness refusal a committed `tool/result` carries, if it carries one.
 *
 * The result does not name its own tool — only the `tool/call` it closes does —
 * so the call is found on the session the event was committed to. A result
 * whose call is not there at all is still reported, named `unnamed`: a refusal
 * nobody can attribute is worth more than silence.
 * @param session - the session the event was committed to.
 * @param event - the committed event.
 * @returns the refusal, or nothing for anything that is not one.
 */
export function harnessRefusal(session: Session, event: SessionEvent): HarnessRefusal | undefined {
  if (event.type !== 'tool/result') return undefined
  const data = event.data as Parameters<typeof resultFailure>[0]
  const failure = resultFailure(data)
  if (failure === undefined) return undefined
  if (failureOrigin(failure.code) !== 'harness') return undefined
  const callId = callIdOf(data.message)
  const call = callId === undefined ? undefined : findCall(session, callId)
  return {
    tool: call?.name ?? 'unnamed',
    parameters: call?.parameters ?? [],
    code: failure.code,
    errorName: failure.name,
    message: failure.message,
    sessionId: String(session.id),
  }
}

/** The call a result closes, as the agent loop names it on the message. */
function callIdOf(message: unknown): string | undefined {
  if (message === null || typeof message !== 'object' || !('source' in message)) return undefined
  const source = (message as { source?: unknown }).source
  if (source === null || typeof source !== 'object' || !('callId' in source)) return undefined
  return String((source as { callId: unknown }).callId)
}

/** The tool name and argument names of the call a result closes. */
function findCall(session: Session, callId: string): { name: string; parameters: string[] } | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index] as SessionEvent
    if (event.type !== 'tool/call') continue
    if (String(event.data.callId) !== callId) continue
    return { name: event.data.name, parameters: argumentNames(event.data.arguments) }
  }
  return undefined
}

/** What an escalation needs in order to reach another mind. */
export interface EscalationConfig {
  /**
   * The recipient's `mind_id`. A UUID, not a name: the broker resolves a
   * recipient through `get_mind_by_id`, so a short name is a 404 and the
   * message is never delivered. Absent means escalation is off.
   */
  recipientMindId?: string
  /** This mind's own `mind_id`, reported as the sender. */
  senderMindId: string
  /** This mind's display name, so the message reads as being from somebody. */
  senderName: string
  /** Where the markers live. */
  markerDir: string
  /** The working directory the refusal happened in. */
  cwd: string
  /** How the message is sent. Injected so the transport is the only stub a test needs. */
  send: (body: EscalationMessage, signal: AbortSignal) => Promise<{ ok: boolean }>
  /** How long a send may take. */
  timeoutMs?: number
}

/** The message one refusal becomes. */
export interface EscalationMessage {
  from_mind: string
  to_mind: string
  conversation_id: string
  content: string
  metadata: Record<string, unknown>
}

/** The default escalation directory, which a mind's own skill reads and prunes. */
export function defaultMarkerDir(): string {
  const home = process.env.DSH_HOME
  const root = home !== undefined && home.trim().length > 0 ? home : join(homedir(), '.dsh')
  return join(root, 'escalations')
}

/**
 * Reports a refused tool call to another mind, at most once per distinct
 * refusal, without ever delaying or failing the call it is reporting.
 */
export class Escalator {
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly config: EscalationConfig) {}

  /**
   * Report one refusal, if it has not been reported before.
   *
   * Returns nothing and never rejects. Observers of `session/event` run
   * synchronously inside `Session.append`, inside the window that is appending
   * a committed event: a throw from here would propagate out of the commit, and
   * an awaited send would hold the tool loop open for the length of an HTTP
   * round trip. So the work is detached and its failures are swallowed.
   * @param refusal - the refusal to report.
   */
  report(refusal: HarnessRefusal): void {
    const recipient = this.config.recipientMindId
    if (recipient === undefined || recipient.trim().length === 0) return
    const key = refusalKey(refusal)
    // Claimed before the send, not after, because two runs sharing one
    // escalation directory would otherwise both read an absent marker and both
    // page the other mind for one gap. An exclusive create is the claim.
    if (!this.claim(key, refusal)) return
    const work = this.send(recipient, refusal, key).finally(() => { this.pending.delete(work) })
    this.pending.add(work)
  }

  /**
   * Wait for the sends already in flight, so a one-shot run does not exit with
   * a message half-written. Bounded by the same deadline the sends are.
   */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  /** Send one claimed refusal, releasing the claim if it did not land. */
  private async send(recipient: string, refusal: HarnessRefusal, key: string): Promise<void> {
    const signal = AbortSignal.timeout(this.config.timeoutMs ?? ESCALATION_TIMEOUT_MS)
    try {
      const outcome = await this.config.send(this.message(recipient, refusal), signal)
      // A gateway that is up and refusing is as undelivered as one that is
      // down: the broker answers 404 for a recipient it cannot resolve, and a
      // claim kept over that would silence this gap permanently after a message
      // nobody received.
      if (!outcome.ok) this.release(key)
    } catch {
      this.release(key)
    }
  }

  /** The message body, carrying everything the fix needs and nothing more. */
  private message(recipient: string, refusal: HarnessRefusal): EscalationMessage {
    const { senderMindId, senderName, cwd } = this.config
    const call = `${refusal.tool}(${refusal.parameters.join(', ')})`
    return {
      from_mind: senderMindId,
      to_mind: recipient,
      conversation_id: refusal.sessionId,
      content: `${senderName} asked the harness for ${call} and the harness refused it `
        + `with ${refusal.code} (${refusal.errorName}): ${refusal.message}\n\n`
        + `The call is the dialect the model was trained on and is not ours to change — `
        + `the harness grows a tool or widens a policy to match it. `
        + `Conversation ${refusal.sessionId}, working directory ${cwd}. `
        + `This gap will not be reported again until the marker ${refusalKey(refusal)} is cleared.`,
      metadata: {
        request_type: 'harness_refusal',
        mind: senderName,
        mind_id: senderMindId,
        tool: refusal.tool,
        parameters: refusal.parameters,
        code: refusal.code,
        error_name: refusal.errorName,
        refusal_message: refusal.message,
        session_id: refusal.sessionId,
        cwd,
        marker: refusalKey(refusal),
      },
    }
  }

  /** The marker's path. */
  private markerPath(key: string): string {
    return join(this.config.markerDir, `${key}.json`)
  }

  /**
   * Claim this refusal, exclusively.
   * @param key - the refusal's digest.
   * @param refusal - the refusal, recorded inside the marker so a mind can read it.
   * @returns whether this process is the one that reports it.
   */
  private claim(key: string, refusal: HarnessRefusal): boolean {
    try {
      mkdirSync(this.config.markerDir, { recursive: true })
      writeFileSync(this.markerPath(key), `${JSON.stringify({
        marker: key,
        tool: refusal.tool,
        parameters: refusal.parameters,
        code: refusal.code,
        error_name: refusal.errorName,
        message: refusal.message,
        session_id: refusal.sessionId,
        cwd: this.config.cwd,
        mind: this.config.senderName,
        reported_at: new Date().toISOString(),
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      return true
    } catch (error: unknown) {
      // Already claimed: somebody has reported this gap and nobody else should.
      if ((error as { code?: string }).code === 'EEXIST') return false
      // Any other failure is a directory we cannot write. Reporting a gap twice
      // costs a duplicate message; not reporting it costs the run, so an
      // unusable marker directory degrades to repetition rather than silence.
      return true
    }
  }

  /** Release a claim whose message did not land, so the next occurrence reports. */
  private release(key: string): void {
    try {
      unlinkSync(this.markerPath(key))
    } catch {
      // Nothing to release, or a directory we cannot write. Either way the
      // refusal stays claimed, which is the same state a successful send leaves.
    }
  }
}

/**
 * Post an escalation to hive-comms.
 * @param commsUrl - the gateway's base URL.
 * @param token - the service bearer the gateway expects.
 * @returns a sender for {@link EscalationConfig.send}.
 */
export function commsSender(
  commsUrl: string, token: string | undefined,
): (body: EscalationMessage, signal: AbortSignal) => Promise<{ ok: boolean }> {
  return async (body, signal) => {
    const response = await fetch(`${commsUrl.replace(/\/+$/, '')}/broker/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...token === undefined ? {} : { authorization: `Bearer ${token}` },
      },
      body: JSON.stringify(body),
      signal,
    })
    return { ok: response.ok }
  }
}

/**
 * The escalator this mind's environment asks for, or nothing.
 *
 * Read from the environment rather than from the dispatch, because none of it
 * is a property of the turn: the recipient is a standing decision about who
 * fixes this harness, and the sender and the gateway are the mind's own
 * identity. `DSH_ESCALATE_TO_MIND_ID` absent means a mind that reports its
 * refusals to nobody, which is the default — a mind under repair wants this on,
 * and a mind in ordinary conversation does not need another mind woken every
 * time a policy declines something.
 *
 * The recipient is a `mind_id`. The broker resolves a message's destination
 * through `get_mind_by_id`, so a short name is a 404 and a message addressed by
 * one is never delivered.
 * @param cwd - the working directory to report the refusals against.
 * @returns the escalator, or nothing when this mind escalates to nobody.
 */
export function escalatorFromEnv(cwd: string): Escalator | undefined {
  const recipient = process.env.DSH_ESCALATE_TO_MIND_ID
  if (recipient === undefined || recipient.trim().length === 0) return undefined
  const commsUrl = process.env.COMMS_URL
  if (commsUrl === undefined || commsUrl.trim().length === 0) return undefined
  const senderMindId = process.env.MIND_ID
  if (senderMindId === undefined || senderMindId.trim().length === 0) return undefined
  return new Escalator({
    recipientMindId: recipient.trim(),
    senderMindId: senderMindId.trim(),
    senderName: process.env.MIND_NAME ?? 'a mind',
    markerDir: process.env.DSH_ESCALATION_DIR ?? defaultMarkerDir(),
    cwd,
    send: commsSender(commsUrl.trim(), process.env.COMMS_BEARER_TOKEN),
  })
}
