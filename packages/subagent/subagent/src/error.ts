/**
 * Typed failures shared by subagent service and provider operations.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'

/** Typed failure for the subagent seam. */
export class SubagentError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SubagentError'
  }
}

/**
 * The child's own failure detail from the turn that ended its run, for
 * {@link SubagentResult.failure}. A provider rejecting a model name, a 401
 * from a proxy and a crashed child all end a turn as `error`, and only this
 * payload tells them apart — so every provider that flattens a turn reason to
 * a stop reason reads the detail through here rather than dropping it.
 * @param reason - the child's final durable turn reason, absent when it
 *   settled without ever closing a turn.
 * @returns the failure, or `undefined` when the turn did not end in one.
 */
export function turnEndFailure(reason: TurnEndReason | undefined): LlmFailure | undefined {
  return reason?.kind === 'error' ? reason.error : undefined
}

/**
 * The failure detail for a run flattened from a thrown transport or spawn
 * error, which carries no {@link LlmFailure} of its own.
 * @param error - the thrown value, already normalized to an `Error`.
 * @returns the failure carrying that error's message, and its code when the
 *   throw was one of the harness's own typed errors.
 */
export function thrownFailure(error: Error): LlmFailure {
  return { message: error.message, code: error instanceof HarnessError ? error.code : 'UNKNOWN' }
}
