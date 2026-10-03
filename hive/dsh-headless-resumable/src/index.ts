/**
 * @hive/dsh-headless-resumable — a one-shot dsh surface that runs inside a
 * conversation it did not mint.
 *
 * The hive's one invariant is that hive-comms mints the conversation id when it
 * writes the session row, and hands that id to every spawn: `--session-id` for
 * the conversation's first process, `--resume` for every one after. A mind
 * handed no id raises rather than inventing one. dsh's own headless runner
 * mints `session-${randomUUID()}` and has no way to continue anything, so a mind
 * built on it could answer exactly one turn and never the turn after.
 *
 * Both halves already exist in `@deepseek-ai/dsh-agent`: `create` takes the
 * session id it is given, and `resume` loads a persisted one. What was missing
 * was a surface that exposes them. This is that surface.
 *
 * It also reports the turn as data rather than as an exit code, because the
 * adapter needs the session it ran in, why it stopped, and the tool traffic —
 * none of which fit in a process exit status.
 *
 * @module @hive/dsh-headless-resumable
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** dsh's own reason for a turn ending, whatever kinds it currently carries. */
type TurnEndReason = SessionEvent<'turn/end'>['data']['reason']
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'

import { NO_TRAFFIC, toolTraffic } from './traffic.ts'
import type { ToolTraffic } from './traffic.ts'
import type { SessionMode } from './startup.ts'

/** Stable Cordis plugin name. */
export const name = 'resumable-headless-runner'

/** Core services required before the turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config, resolved from this app's startup provider. */
export interface Config {
  task: string
  sessionId: string
  mode: SessionMode
}

export const Config: z<Config> = z.object({
  task: z.string().required(),
  sessionId: z.string().required(),
  mode: z.union(['create', 'resume'] as const).required(),
})

/** What the adapter reads off stdout: one line of JSON, whatever happened. */
export interface TurnReport {
  /** The conversation this turn ran in — the id we were handed, never a fresh one. */
  sessionId: string
  /** Whether this process opened the conversation or continued it. */
  mode: SessionMode
  /**
   * How the turn ended: dsh's own turn-end reason kind, or `refused` for an
   * invocation that never reached a model. Taken from their type rather than
   * spelled out here, because the set is theirs to extend -- and `max-tokens`
   * in particular is the context ceiling, which is a measurement this loop
   * wants recorded rather than a failure to explain away. `unknown` is an
   * interval holding no turn at all.
   */
  outcome: TurnEndReason['kind'] | 'refused' | 'unknown'
  /** The last non-empty assistant text of this turn's interval. */
  text: string
  /** The tool traffic of this turn's interval. */
  traffic: ToolTraffic
  /** Present when something refused or failed: the code and message. */
  error?: { code: string; message: string }
}

/** Process-facing effects: output streams plus the launcher's bounded exit request. */
interface RunnerIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  exit(code: number): void
}

/** The process streams the runner writes to; tests substitute captures. */
export const internals: { stdout: RunnerIo['stdout']; stderr: RunnerIo['stderr'] } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/** The last non-empty assistant text and the turn-end reason of one interval. */
function summarize(events: readonly SessionEvent[], firstSeq: number): {
  text: string
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
} {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/** Write one report and request the matching exit. A completed turn is the only zero. */
export function report(io: RunnerIo, turn: TurnReport): void {
  io.stdout.write(JSON.stringify(turn) + '\n')
  if (turn.error !== undefined) {
    io.stderr.write(`dsh-hive: ${turn.error.code}: ${turn.error.message}\n`)
  }
  io.exit(turn.outcome === 'completed' ? 0 : 1)
}

/**
 * Run one task in the conversation we were handed.
 * @param ctx - plugin context carrying the agent registry, default model and sessions.
 * @param config - the task and the conversation identity.
 * @param io - process-facing effects.
 */
export async function run(ctx: Context, config: Config, io: RunnerIo): Promise<void> {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  if (selection.model === undefined || selection.model === '') {
    // Never substituted. A mind quietly running a house favourite is how a
    // wrong model goes unnoticed for weeks, and in a training loop it is also a
    // score attributed to a model that never ran.
    report(io, {
      sessionId: config.sessionId,
      mode: config.mode,
      outcome: 'refused',
      text: '',
      traffic: NO_TRAFFIC,
      error: { code: 'NO_MODEL', message: 'no model was named and none is defaulted here' },
    })
    return
  }

  const setup = (agentCtx: Context): void => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
  const agentOptions = { provider: selection.provider, model: selection.model }

  let handle
  try {
    handle = config.mode === 'resume'
      ? await agents.resume({
        resumeSessionId: SessionId(config.sessionId),
        agentOptions,
        setup,
      })
      : await agents.create({
        // The id we were handed, not one we made. This is the whole point.
        sessionId: SessionId(config.sessionId),
        meta: { cwd: process.cwd() },
        agentOptions,
        setup,
      })
  } catch (error: unknown) {
    // No fallback to the other mode, deliberately. Asked to continue a
    // conversation that is not there, the honest answer is a refusal: creating
    // one instead would answer the user in a conversation with no history and
    // leave the one they meant untouched and unfindable.
    report(io, {
      sessionId: config.sessionId,
      mode: config.mode,
      outcome: 'refused',
      text: '',
      traffic: NO_TRAFFIC,
      error: {
        code: config.mode === 'resume' ? 'NO_SUCH_SESSION' : 'SESSION_NOT_CREATED',
        message: error instanceof Error ? error.message : String(error),
      },
    })
    return
  }

  const { agent } = handle
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: config.task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await sessions.flush(agent.session)

  const { text, reason } = summarize(agent.session.events, firstSeq)
  const traffic = toolTraffic(agent.session.events, firstSeq)
  const outcome: TurnReport['outcome'] = reason?.kind ?? 'unknown'
  report(io, {
    sessionId: config.sessionId,
    mode: config.mode,
    outcome,
    text,
    traffic,
    ...(reason?.kind === 'error'
      ? { error: { code: reason.error.code, message: reason.error.message } }
      : {}),
  })
}

/**
 * Mount the resumable one-shot driver.
 * @param ctx - plugin context carrying core services and the launcher's exit request.
 * @param config - validated task and conversation identity.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error(
      'resumable-headless-runner: the launcher must provide ctx.appExit before the tree mounts',
    )
  }
  const io: RunnerIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error: unknown) => {
    io.stderr.write(`dsh-hive: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
  })
}
