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

import { escalatorFromEnv, harnessRefusal } from './escalate.ts'
import { firstFailedCall, NO_TRAFFIC, toolTraffic } from './traffic.ts'
import type { FailedCall, ToolTraffic } from './traffic.ts'
import type { SessionMode } from './startup.ts'
import { runInteractive, terminalIo } from './interactive.ts'

/** Stable Cordis plugin name. */
export const name = 'resumable-headless-runner'

/** Core services required before the turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/**
 * How long to wait for the goal-round driver to queue the next round after the
 * agent reaches idle. The driver checkpoints durable goal state and flushes the
 * session before it reserves, so the round lands a moment after `whenIdle()`
 * resolves rather than inside it. Waiting is what separates "the driver has not
 * got there yet" from "the goal is finished"; without it every goal would stop
 * after its first round and the cap would be decoration.
 */
export const ROUND_SETTLE_MS = 5_000

/** How often that wait re-reads goal state. */
export const ROUND_POLL_MS = 25

/** Plugin config, resolved from this app's startup provider. */
export interface Config {
  task?: string
  sessionId: string
  mode: SessionMode
  interactive?: boolean
  initialContext?: string
  /** Round cap when this dispatch wants the task driven as a goal. */
  goalRounds?: number
  /** The goal's objective, when the composed task is not what to repeat. */
  goalObjective?: string
  /**
   * End the run at the first refused tool call rather than driving the rest of
   * the rounds.
   *
   * For the nights the harness itself is the thing under repair, the first
   * refusal is the whole result: the rounds after it are the same model working
   * around the same gap, and they cost an hour to tell us what the first one
   * already did. Off by default, because once the dialect gaps are closed the
   * run is measuring the app, and throwing away a finished build over one late
   * refusal measures nothing.
   */
  stopOnFailedCall?: boolean
}

export const Config: z<Config> = z.object({
  task: z.string(),
  sessionId: z.string().required(),
  mode: z.union(['create', 'resume'] as const).required(),
  interactive: z.boolean(),
  initialContext: z.string(),
  goalRounds: z.number(),
  goalObjective: z.string(),
  stopOnFailedCall: z.boolean(),
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
  /**
   * How many model turns this process actually drove. One unless the dispatch
   * asked for goal rounds. Reported because a build that stopped at round two
   * of forty and one that burned all forty are different failures, and the
   * traffic tally alone cannot tell them apart.
   */
  turns: number
  /** The goal's durable phase when the process finished, when a goal was armed. */
  goalPhase?: string
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

/** The last non-empty assistant text, the turn-end reason, and the turn count. */
function summarize(events: readonly SessionEvent[], firstSeq: number): {
  text: string
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  turns: number
} {
  let started = false
  let text = ''
  let turns = 0
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      turns += 1
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
  return { text, reason, turns }
}


/** The slice of `ctx.goals` this runner uses; typed here so tests can stand one in. */
export interface GoalDriving {
  get(agent: never): { id: string; revision: number; phase: string; objective: string
    maxGoalRounds: number; roundsStarted: number; activation: string } | undefined
  create(agent: never, request: { objective: string; maxGoalRounds: number }): {
    id: string; revision: number; phase: string; roundsStarted: number }
  resume(agent: never, ref: { id: string; revision: number }): { phase: string }
  edit(agent: never, ref: { id: string; revision: number },
    request: { maxGoalRounds: number }): { id: string; revision: number }
}

/** Whether a goal still entitles the driver to open another round. */
export function continuing(
  goal: { phase: string; activation: string; roundsStarted: number; maxGoalRounds: number } | undefined,
): boolean {
  return goal !== undefined
    && goal.phase === 'active'
    && goal.activation === 'armed'
    && goal.roundsStarted < goal.maxGoalRounds
}

/**
 * Arm a goal for this dispatch's task, whatever the conversation already holds.
 *
 * A fresh conversation creates one. A resumed conversation finds its own goal
 * disarmed — dsh drops process-local activation on every session start, by
 * design — so it is resumed rather than replaced, which keeps one objective and
 * one round history across a conversation that spans processes. A goal whose
 * cap is already spent has the cap raised by this dispatch's allowance first,
 * because the alternative is a resume that throws and a build that stops
 * forever at the number somebody typed days ago.
 * @param goals - the goal service.
 * @param agent - the live agent.
 * @param task - this dispatch's task, used as the objective of a new goal.
 * @param rounds - how many rounds this dispatch is paying for.
 */
export function armGoal(goals: GoalDriving, agent: never, task: string, rounds: number): void {
  const current = goals.get(agent)
  if (current === undefined || current.phase === 'complete') {
    goals.create(agent, { objective: task, maxGoalRounds: rounds })
    return
  }
  let ref = { id: current.id, revision: current.revision }
  if (current.roundsStarted + rounds > current.maxGoalRounds) {
    ref = goals.edit(agent, ref, { maxGoalRounds: current.roundsStarted + rounds })
  }
  if (current.phase === 'active' && current.activation === 'armed') return
  goals.resume(agent, ref)
}

/**
 * Wait for the driver to open the next round, or decide it never will.
 *
 * The driver reserves at whole-agent idle and only after awaiting a session
 * flush, so the round appears a moment after `whenIdle()` resolves. Polling
 * goal state is what tells the two apart: a round number that moved means
 * carry on waiting for that round to finish, and a deadline that passes with
 * the number unmoved means the agent is genuinely done.
 * @param goals - the goal service.
 * @param agent - the live agent.
 * @param before - the round count observed before the wait.
 * @param sleep - how a wait is taken; substituted in tests.
 * @returns true when a further round opened.
 */
export async function waitForRound(
  goals: GoalDriving,
  agent: never,
  before: number,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => { setTimeout(resolve, ms) }),
): Promise<boolean> {
  for (let waited = 0; waited < ROUND_SETTLE_MS; waited += ROUND_POLL_MS) {
    const goal = goals.get(agent)
    if (goal !== undefined && goal.roundsStarted > before) return true
    if (!continuing(goal)) return false
    await sleep(ROUND_POLL_MS)
  }
  return false
}

/**
 * One line of stdout per completed goal round, so a long dispatch is observable
 * while it runs.
 *
 * A goal-driven dispatch is one HTTP response that can last an hour, and the
 * gateway caps the socket on time since the last byte rather than on total
 * elapsed. A process that writes nothing until the end is therefore read as a
 * mind that stopped answering, and the turn is lost even though the work is
 * still going. It carries no `sessionId`: that field is what identifies the
 * report, and a progress line mistaken for one would end the turn early.
 * @param io - process-facing effects.
 * @param progress - the round just finished and the traffic so far.
 */
export function reportProgress(
  io: Pick<RunnerIo, 'stdout'>,
  progress: { round: number; turns: number; toolCalls: number },
): void {
  io.stdout.write(JSON.stringify({ progress }) + '\n')
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
export async function run(
  ctx: Context, config: Config, io: RunnerIo, escalator?: { drain(): Promise<void> },
): Promise<void> {
  if (config.task === undefined) throw new Error('one-shot mode requires a task')
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
      turns: 0,
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
      turns: 0,
      error: {
        code: config.mode === 'resume' ? 'NO_SUCH_SESSION' : 'SESSION_NOT_CREATED',
        message: error instanceof Error ? error.message : String(error),
      },
    })
    return
  }

  const { agent } = handle
  await agent.whenIdle()

  // A dispatch asking for more than one round needs the goal stack mounted. A
  // run that silently took one turn instead would report a tool-call rate and a
  // build percentage about a harness nobody configured.
  const rounds = config.goalRounds ?? 1
  const goals = rounds > 1 ? ctx.get('goals') as GoalDriving | undefined : undefined
  if (rounds > 1 && goals === undefined) {
    report(io, {
      sessionId: config.sessionId,
      mode: config.mode,
      outcome: 'refused',
      text: '',
      traffic: NO_TRAFFIC,
      turns: 0,
      error: {
        code: 'NO_GOAL_SERVICE',
        message: `--goal-rounds ${rounds} needs the goal stack; this profile mounts no ctx.goals`,
      },
    })
    return
  }

  const firstSeq = agent.session.seq
  if (goals !== undefined) {
    // Armed before the task is submitted, so the human message is already in
    // the inbox when the driver first looks: it yields to human work, and the
    // task therefore opens the conversation rather than racing a goal round.
    armGoal(goals, agent as never, config.goalObjective ?? config.task, rounds)
  }
  // Armed before the task is sent, so a failure in the opening turn stops the run
  // as readily as one in round thirty.
  const watch = config.stopOnFailedCall === true
    ? watchForFailedCall(agent as never, firstSeq)
    : undefined
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: config.task }],
    source: { kind: 'user' },
  }))
  await (watch === undefined
    ? agent.whenIdle()
    : Promise.race([agent.whenIdle(), watch.settled]))

  // The goal rounds. Each one is a fresh model turn the harness opened, not the
  // model's own decision to carry on — which is the whole point: a small model
  // that stops early stops a round, not the job.
  if (goals !== undefined && watch?.check() === undefined) {
    for (;;) {
      const goal = goals.get(agent as never)
      if (!continuing(goal)) break
      if (!await waitForRound(goals, agent as never, goal?.roundsStarted ?? 0)) break
      await (watch === undefined
        ? agent.whenIdle()
        : Promise.race([agent.whenIdle(), watch.settled]))
      if (watch?.check() !== undefined) break
      const sofar = summarize(agent.session.events, firstSeq)
      reportProgress(io, {
        round: goals.get(agent as never)?.roundsStarted ?? 0,
        turns: sofar.turns,
        toolCalls: toolTraffic(agent.session.events, firstSeq).emitted,
      })
    }
  }
  watch?.stop()
  await sessions.flush(agent.session)
  // Awaited before the report, so a one-shot process does not exit with an
  // escalation half-written. Each send carries its own deadline, so a gateway
  // that never answers costs that deadline and not the run.
  await escalator?.drain()

  const refusal = watch?.check()
  const { text, reason, turns } = summarize(agent.session.events, firstSeq)
  const traffic = toolTraffic(agent.session.events, firstSeq)
  const outcome: TurnReport['outcome'] = reason?.kind ?? 'unknown'
  const finalGoal = goals?.get(agent as never)
  report(io, {
    sessionId: config.sessionId,
    mode: config.mode,
    outcome,
    text,
    traffic,
    turns,
    ...(finalGoal === undefined ? {} : { goalPhase: finalGoal.phase }),
    ...(refusal === undefined
      ? reason?.kind === 'error'
        ? { error: { code: reason.error.code, message: reason.error.message } }
        : {}
      : {
        error: {
          code: 'STOPPED_ON_FAILED_CALL',
          // The call as the model spelled it, which side turned it away, and what
          // it said. That is the whole input to the fix, so none of it is dropped.
          message: `${refusal.name}(${refusal.parameters.join(', ')}) failed at the `
            + `${refusal.origin} with ${refusal.code} (${refusal.errorName}): ${refusal.message}`,
        },
      }),
  })
}

/**
 * How often a stopping run re-reads the session for a refusal. The session's
 * event array grows in memory, so this is a walk over a list and not IO.
 */
export const FAILURE_POLL_MS = 250

/** A watch that resolves the moment a tool call fails, and can be dropped. */
interface FailureWatch {
  /**
   * Resolves with the failure; never resolves while the run stays clean. This is
   * what cuts a round short, since a round is minutes long and nothing else wakes
   * up inside one.
   */
  readonly settled: Promise<FailedCall>
  /**
   * Read the session now rather than waiting for the next poll. A round
   * boundary is a decision point, and a refusal that landed microseconds
   * earlier must not buy another round for want of a timer tick.
   */
  check(): FailedCall | undefined
  /** Stop polling, so a finished run leaves no timer behind. */
  stop(): void
}

/**
 * Watch one run's own interval for its first failed tool call.
 * @param agent - the live agent, read for its session events.
 * @param firstSeq - the sequence number this run's interval starts at.
 * @returns the watch.
 */
export function watchForFailedCall(
  agent: { session: { events: readonly SessionEvent[] } }, firstSeq: number,
): FailureWatch {
  let found: FailedCall | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const settled = new Promise<FailedCall>((resolve) => {
    timer = setInterval(() => {
      const failure = firstFailedCall(agent.session.events, firstSeq)
      if (failure === undefined) return
      found = failure
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      resolve(failure)
    }, FAILURE_POLL_MS)
    // A poll that keeps the process alive would outlive the run it watches.
    timer.unref?.()
  })
  return {
    settled,
    check: () => {
      found ??= firstFailedCall(agent.session.events, firstSeq)
      return found
    },
    stop: () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
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
  if (config.interactive === true) {
    void runInteractive(ctx, {
      sessionId: config.sessionId,
      mode: config.mode,
      ...(config.initialContext === undefined ? {} : { initialContext: config.initialContext }),
    }, terminalIo(exit)).catch((error: unknown) => {
      internals.stderr.write(`dsh-hive: ${error instanceof Error ? error.message : String(error)}\n`)
      exit(1)
    })
    return
  }
  // Subscribed before the turn is driven, so the opening round's refusals
  // escalate as readily as round thirty's. Every committed event passes here,
  // including a subagent's: a delegate refused the same tool for the same
  // reason is the same gap, and reporting it under its own conversation is
  // what makes one marker cover both.
  const escalator = escalatorFromEnv(config.sessionId, process.cwd(), line => io.stderr.write(line))
  if (escalator !== undefined) {
    ctx.on('session/event', (session, event) => {
      const refusal = harnessRefusal(session, event)
      if (refusal !== undefined) escalator.report(refusal)
    })
  }
  void run(ctx, config, io, escalator).catch((error: unknown) => {
    io.stderr.write(`dsh-hive: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
  })
}
