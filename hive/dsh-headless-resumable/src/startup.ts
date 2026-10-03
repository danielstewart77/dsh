/**
 * The resumable one-shot app's command line.
 *
 * Mirrors `@deepseek-ai/dsh-headless/startup` — parse, then provide an ordinary
 * Cordis service the runner consumes — but the conversation id is required and
 * the two ways of supplying it mean different things, because the hive mints
 * conversation ids outside this process and hands one to every spawn.
 *
 * The task itself may arrive as the positional or, when it is too large for
 * argv to carry, as `--task-file <path>`: a composed system prompt plus a
 * user message runs to tens of thousands of characters, and Linux caps one
 * argv entry at `MAX_ARG_STRLEN` (128 KiB) regardless of how much room the
 * whole command line has.
 *
 * `--session-id <id>` is the conversation's first process: create the session
 * under that id. `--resume <id>` is every process after it: continue the
 * session already persisted under that id. Neither is a fallback for the other.
 * A harness that quietly creates where it was told to continue is how a week of
 * context disappears with nothing logged, and one that continues where it was
 * told to create would answer a new conversation with an old one's history.
 *
 * @module @hive/dsh-headless-resumable/startup
 */

import { readFileSync } from 'node:fs'

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'resumable-headless-startup'

/** Services required before the task can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the runner. */
export const RESUMABLE_STARTUP_SERVICE = 'resumableHeadlessStartup'

/** Whether this invocation opens the conversation or continues it. */
export type SessionMode = 'create' | 'resume'

/** What the runner row reads from {@link RESUMABLE_STARTUP_SERVICE}. */
export interface ResumableStartupValues {
  /** The task text this invocation asked for. */
  task: string
  /** The conversation id, minted elsewhere and never by this process. */
  sessionId: string
  /** Create the session under that id, or continue the one already there. */
  mode: SessionMode
  /**
   * How many goal rounds this dispatch is willing to pay for. Absent means one
   * physical turn — today's behaviour and the only thing a chat surface wants.
   * A number above one arms a goal whose objective is this task, so the
   * harness re-enters the model at every idle checkpoint until it produces
   * evidence of completion or the cap runs out.
   */
  goalRounds?: number
  /**
   * End the run at the first refused tool call. For the nights the harness is
   * itself under repair: the rounds after a refusal are the same model working
   * around the same gap, and waiting for them costs an hour to learn what the
   * first one already said.
   */
  stopOnFailedCall?: boolean
  /**
   * The objective a goal is armed with, when it differs from the task.
   *
   * The task a conversation opens with is the composed system prompt and the
   * user's message together, tens of thousands of characters. The round driver
   * quotes the objective into every round prompt, so arming a goal with that
   * whole blob spends the context window on forty copies of a soul. The
   * objective is the user's own request alone.
   */
  goalObjective?: string
}

/**
 * This app's command: the task positional and the two mutually exclusive ways
 * to name the conversation.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
export function resumableCommand(): Command {
  return new Command()
    .name('dsh --profile hive')
    .description('Answer one task in a named conversation, report the turn as JSON, and exit.')
    .helpOption('-h, --help', 'show this help')
    .argument('[task...]', 'the task text; multiple words are joined by spaces')
    .option('--session-id <id>', 'create the conversation under this id (its first process)')
    .option('--resume <id>', 'continue the conversation already persisted under this id')
    .option('--task-file <path>', 'read the task from this file instead of the positional')
    .option('--goal-rounds <n>', 'drive the task as a goal for up to this many rounds (default: one turn)')
    .option('--stop-on-failed-call', 'end the run at the first refused tool call instead of driving the remaining rounds')
    .option('--goal-objective-file <path>', 'read the goal objective from this file (default: the task)')
    .addHelpText('after', `
Examples:
  dsh --profile hive --session-id abc "build the app"   open conversation abc
  dsh --profile hive --resume abc "now fix the chart"   continue conversation abc
  dsh --profile hive --resume abc --task-file turn.txt  a task argv cannot carry
`)
}

/**
 * Resolve the round cap, or refuse the invocation.
 *
 * A cap that cannot be read is refused rather than quietly taken as one. A
 * measured run told to pay for forty rounds and silently given a single turn
 * reports a number about a harness nobody ran.
 * @param raw - the flag as typed, or undefined when it was not given.
 * @returns the cap, or undefined when no cap was asked for.
 * @throws UsageError when the value is not a positive integer.
 */
export function resolveGoalRounds(raw: string | undefined): number | undefined {
  const text = raw?.trim() ?? ''
  if (text === '') return undefined
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UsageError(`--goal-rounds ${text} must be a positive whole number`)
  }
  return value
}

/** A usage error: the invocation itself is wrong, before anything has started. */
export class UsageError extends Error {}

/**
 * Resolve one invocation, or refuse it.
 *
 * Every refusal happens here, before the runner activates and therefore before
 * any agent exists or any request reaches a model: no task, no id, both ids, or
 * an id that is only whitespace.
 * @param words - the task positional, already split into words.
 * @param options - the parsed flags.
 * @param readTask - reads `--task-file`; defaults to the filesystem.
 * @returns the task and the conversation identity.
 * @throws UsageError when the invocation cannot name one conversation and one task.
 */
export function resolveInvocation(
  words: readonly string[],
  options: {
    sessionId?: string; resume?: string; taskFile?: string
    goalRounds?: string; goalObjectiveFile?: string; stopOnFailedCall?: boolean
  },
  readTask: (path: string) => string = path => readFileSync(path, 'utf8'),
): ResumableStartupValues {
  const positional = words.join(' ')
  const taskFile = options.taskFile?.trim() ?? ''
  if (taskFile !== '' && positional.trim() !== '') {
    throw new UsageError('name the task once: either the positional or --task-file, not both')
  }
  let task = positional
  if (taskFile !== '') {
    try {
      task = readTask(taskFile)
    } catch (error: unknown) {
      // A task we cannot read is not an empty task. Running the turn on ''
      // would spend a model request to answer nothing and report it as a
      // completed turn, which in a measured run is worse than a refusal.
      throw new UsageError(
        `--task-file ${taskFile} could not be read: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const created = options.sessionId?.trim() ?? ''
  const resumed = options.resume?.trim() ?? ''
  if (task.trim() === '') {
    throw new UsageError('a task is required, for example: dsh --profile hive --resume abc "fix the chart"')
  }
  if (created !== '' && resumed !== '') {
    throw new UsageError('--session-id opens a conversation and --resume continues one; name only one')
  }
  if (created === '' && resumed === '') {
    throw new UsageError('a conversation id is required; this process does not mint one')
  }
  const goalRounds = resolveGoalRounds(options.goalRounds)
  const objectiveFile = options.goalObjectiveFile?.trim() ?? ''
  let goalObjective = ''
  if (objectiveFile !== '') {
    try {
      goalObjective = readTask(objectiveFile).trim()
    } catch (error: unknown) {
      throw new UsageError(
        `--goal-objective-file ${objectiveFile} could not be read: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (goalObjective === '') {
      throw new UsageError(`--goal-objective-file ${objectiveFile} holds no objective`)
    }
  }
  const stopping = options.stopOnFailedCall === true ? { stopOnFailedCall: true } : {}
  const identity = resumed !== ''
    ? { task, sessionId: resumed, mode: 'resume' as const, ...stopping }
    : { task, sessionId: created, mode: 'create' as const, ...stopping }
  if (goalRounds === undefined) return identity
  return goalObjective === ''
    ? { ...identity, goalRounds }
    : { ...identity, goalRounds, goalObjective }
}

/**
 * Parse and provide the task and conversation identity as a Cordis service.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = resumableCommand()
  program.action(() => {
    try {
      const values = resolveInvocation(program.args, program.opts())
      ctx.provide(RESUMABLE_STARTUP_SERVICE, values)
    } catch (error: unknown) {
      if (!(error instanceof UsageError)) throw error
      // Nothing is provided on a usage error, so the runner never activates.
      program.error(`error: ${error.message}`)
    }
  })
  parseCmdline(ctx, program)
}
