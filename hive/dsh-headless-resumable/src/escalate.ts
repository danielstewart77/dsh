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
 * at its job, and waking another mind for it is a page nobody can action. Nor
 * does a person declining an approval prompt travel, which is the system
 * working rather than a gap in it. Which side refused is the `origin` on the
 * failure, which is why every refusing path in the harness now carries a code
 * of its own rather than being recognised by the absence of one.
 *
 * One class of noise gets through, knowingly. A tool that validates its own
 * arguments raises the same `ToolArgsError` with the same `INVALID_ARGS` as the
 * schema refusal before dispatch — `defineTool` runs the schema check as the
 * first statement of the body (`tools/src/schema.ts`), so there is no position
 * to tell them apart by either. `edit` refusing an `old_string` identical to
 * its `new_string` therefore pages once. Splitting them means a second error
 * class threaded through every tool that checks its own arguments, and the
 * dedupe below bounds the cost at one message for the life of the marker, so
 * the honest trade is to let it through and say so here.
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
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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
 * Longest tool name reported.
 *
 * `traffic.ts` caps the argument names and the failure text; the tool name was
 * uncapped, and it is the one component guaranteed to be model-authored — a
 * name the harness does not have is the primary trigger. A model malformed
 * enough to ask for a tool that is not there is malformed enough to put a
 * function body in the name position, and this rides in an HTTP body and a file
 * on disk.
 */
const MAX_TOOL_NAME = 120

/**
 * How long a send may take before it is abandoned.
 *
 * Node's `fetch` has no default timeout and a pending socket is a ref'd handle,
 * so a gateway that accepts the connection and never answers keeps a one-shot
 * run alive after its report has already been written and its exit code set.
 * The adapter then sees a finished report from a process that never exits,
 * which reads as a wedged mind rather than a wedged POST.
 *
 * Under the CLI's own force-exit fuse, deliberately. A deadline longer than
 * that fuse is not a deadline: an interrupt force-exits the process first and
 * the send is lost with a claim already on disk.
 */
export const ESCALATION_TIMEOUT_MS = 4_000

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
export function refusalKey(refusal: Pick<HarnessRefusal, 'tool' | 'parameters' | 'code' | 'message'>): string {
  const tuple = [
    refusal.tool,
    [...refusal.parameters].sort().join('\u0000'),
    refusal.code,
    stableReason(refusal.message),
  ].join('\u0000')
  return createHash('sha256').update(tuple, 'utf8').digest('hex').slice(0, KEY_LENGTH)
}

/**
 * What the refusal said, with the parts that vary between occurrences of one
 * gap taken out.
 *
 * The text has to be in the key, because tool, argument names and code together
 * do not identify a gap: `bash(command)` declined for naming `rm` and the same
 * call declined for reaching the network are one key and two entirely different
 * things to go and fix, so the second would be silenced by the first. But the
 * text also carries per-occurrence detail — a schema violation names the index
 * it failed at, a fence names the path — and keying on that raw would page the
 * recipient once per round for one gap. Digits collapse to `#`, which is what
 * nearly all of that detail is.
 * @param message - the refusal text.
 * @returns the text with its varying parts normalized away.
 */
function stableReason(message: string): string {
  return message.replaceAll(/\d+/g, '#')
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
    tool: (call?.name ?? 'unnamed').slice(0, MAX_TOOL_NAME),
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
   * The conversation every page is filed under.
   *
   * The gateway's own id, not the id of whichever session observed the refusal.
   * A subagent's refusal is observed here too — correctly, it is the same gap —
   * but its session id is harness-internal: no `sessions` row holds it and no
   * surface can reach it, so a page filed there arrives in a thread nobody can
   * reply into. The observed session is reported in the metadata instead.
   */
  conversationId: string
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

  /**
   * Keys this process reported and could NOT record on disk.
   *
   * A fallback, not a cache. The marker file is the authority, because deleting
   * one is how a mind re-arms a gap it has fixed and an in-process memo would
   * ignore that deletion for as long as the mind stays up. But when the
   * escalation directory cannot be written at all, the file records nothing and
   * every occurrence would page: a forty-round run emitting five refused calls
   * a round sends two hundred pages off a full disk. So this holds exactly the
   * keys with no marker behind them.
   */
  private readonly reported = new Set<string>()

  /** This process's claim on a marker, so it never releases somebody else's. */
  private readonly owner = `${process.pid}:${Math.random().toString(36).slice(2, 10)}`

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
    if (this.reported.has(key)) return
    // Claimed before the send, not after, because two runs sharing one
    // escalation directory would otherwise both read an absent marker and both
    // page the other mind for one gap. An exclusive create is the claim.
    const claim = this.claim(key, refusal)
    if (claim === 'held-by-another') return
    if (claim === 'unrecorded') this.reported.add(key)
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
      // nobody received. The converse — a gateway that took the message and
      // then failed to say so — costs a duplicate page, which is the side of
      // this trade worth being on.
      if (outcome.ok) this.confirm(key)
      else this.release(key)
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
      conversation_id: this.config.conversationId,
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
  private claim(key: string, refusal: HarnessRefusal): 'recorded' | 'unrecorded' | 'held-by-another' {
    try {
      mkdirSync(this.config.markerDir, { recursive: true })
    } catch (error: unknown) {
      // `mkdirSync` with `recursive` throws EEXIST when the path exists and is
      // NOT a directory, and that is indistinguishable from the exclusive
      // create's EEXIST unless the syscall is checked. Read as "already
      // claimed", a stray file at the escalation path turns escalation off for
      // the life of the process with no message, no marker and no log line —
      // every refusal skipped, every report downstream still looking normal.
      // Any failure to establish the directory is reported rather than
      // suppressed: repetition is recoverable and silence is not.
      return 'unrecorded'
    }
    try {
      writeFileSync(this.markerPath(key), `${JSON.stringify({
        marker: key,
        owner: this.owner,
        // Written false and rewritten true once the gateway has taken it. The
        // claim goes down before the send, so an interrupt in between leaves a
        // marker with nothing delivered — and a marker that calls itself
        // reported would be a lie a mind would act on.
        delivered: false,
        tool: refusal.tool,
        parameters: refusal.parameters,
        code: refusal.code,
        error_name: refusal.errorName,
        message: refusal.message,
        session_id: refusal.sessionId,
        cwd: this.config.cwd,
        mind: this.config.senderName,
        claimed_at: new Date().toISOString(),
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      return 'recorded'
    } catch (error: unknown) {
      // Already claimed: somebody has reported this gap and nobody else should.
      if ((error as { code?: string }).code === 'EEXIST') return 'held-by-another'
      // A directory we cannot write, or a full disk. Same reasoning as above.
      return 'unrecorded'
    }
  }

  /** Record that the gateway took this one, so the marker stops claiming otherwise. */
  private confirm(key: string): void {
    try {
      const path = this.markerPath(key)
      const held = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      if (held['owner'] !== this.owner) return
      writeFileSync(path, `${JSON.stringify({
        ...held, delivered: true, delivered_at: new Date().toISOString(),
      }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // The marker is gone or unreadable. The message landed either way, and a
      // marker that cannot be updated is not worth failing a delivered page for.
    }
  }

  /** Release a claim whose message did not land, so the next occurrence reports. */
  private release(key: string): void {
    try {
      const path = this.markerPath(key)
      // Only ever this process's own claim. Two writers share one escalation
      // directory — the long-lived mind and a headless run — and an unlink by
      // digest alone deletes whichever claim is there, including one somebody
      // else has already delivered against, which double-pages the next
      // occurrence.
      const held = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      if (held['owner'] !== this.owner || held['delivered'] === true) return
      unlinkSync(path)
      this.reported.delete(key)
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
export function escalatorFromEnv(
  conversationId: string, cwd: string, warn: (line: string) => void = () => {},
): Escalator | undefined {
  const recipient = (process.env.DSH_ESCALATE_TO_MIND_ID ?? '').trim()
  if (recipient.length === 0) return undefined
  const commsUrl = (process.env.COMMS_URL ?? '').trim()
  const senderMindId = (process.env.MIND_ID ?? '').trim()
  // Asked to escalate and unable to: said out loud, because the alternative is
  // a mind configured to report its refusals that silently reports none, and
  // the absence of a page is indistinguishable from a run that had no gaps.
  if (commsUrl.length === 0 || senderMindId.length === 0) {
    warn('dsh-hive: DSH_ESCALATE_TO_MIND_ID is set but COMMS_URL or MIND_ID is not; no refusal will be reported\n')
    return undefined
  }
  return new Escalator({
    recipientMindId: recipient,
    senderMindId,
    senderName: process.env.MIND_NAME ?? 'a mind',
    markerDir: process.env.DSH_ESCALATION_DIR ?? defaultMarkerDir(),
    conversationId,
    cwd,
    send: commsSender(commsUrl, process.env.COMMS_BEARER_TOKEN),
  })
}
