/**
 * Public configuration and measurement vocabulary for replay token metering.
 *
 * @module @deepseek-ai/dsh-token-meter/types
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

export type { ContextBreakdownProjection, ContextPressureProjection, TokenUsageProjection } from './projection.ts'

/** Token-meter plugin configuration; the fixed estimator has no settings. */
export type TokenMeterConfig = Record<string, never>

/** The baseline from which a signed surface delta produces current pressure. */
export type TokenMeasurementBaseline =
  | { readonly kind: 'none'; readonly tokens: 0 }
  | { readonly kind: 'estimated'; readonly tokens: number }
  | { readonly kind: 'usage'; readonly tokens: number; readonly usage: Readonly<TokenUsage> }

/** Detached immutable request-pressure and surface snapshot at one consumed log revision. */
export interface TokenMeasurement {
  /** Number of durable events consumed; equal to the next unread event seq. */
  readonly logRevision: number
  /** Provider or heuristic anchor used for this measurement. */
  readonly baseline: TokenMeasurementBaseline
  /** Signed repricing of current surface content relative to the baseline anchor. */
  readonly surfaceDeltaTokens: number
  /** Non-negative current request-and-response pressure. */
  readonly totalTokens: number
  /** Total heuristic tokens across the current surface. */
  readonly surfaceTokens: number
  /** Current surface nodes in positional head-to-tail order. */
  readonly nodes: readonly TokenSurfaceNode[]
}

/** One token-priced node in the current ordered session surface. */
export interface TokenSurfaceNode {
  /** Durable sequence number of the surface event. */
  readonly seq: number
  /** Heuristic tokens for the exact message projected by this node. */
  readonly tokens: number
}

/**
 * Where a turn's conversation size came from: the provider's own count for the
 * turn's final call, the harness's estimate, or nothing to measure at all.
 */
export type ContextMeasurementKind = 'usage' | 'estimated' | 'none'

/**
 * How big the conversation was when a turn closed, and against what ceiling.
 * Appended as `context/measured` at the turn's stop boundary, before any
 * listener that reads it, so a hook deciding whether the conversation has
 * outgrown its model reads the same figure the log keeps.
 */
export interface ContextMeasured {
  /** The turn this measures. */
  readonly turn: number
  /** The model the turn's last request named, or null when no request was made. */
  readonly model: string | null
  /** Request-and-response tokens: the final call's input plus its output. */
  readonly tokens: number
  /**
   * `usage` only when the figure is the provider's count for the turn's own
   * final call and nothing has entered the conversation since; a count of zero,
   * one from an earlier call, or one with an estimate added is `estimated`.
   * `none` when there was nothing to measure.
   */
  readonly kind: ContextMeasurementKind
  /** The model's context window as its route advertised it, or null when none was. */
  readonly window: number | null
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Log-only: the conversation's size at a turn's stop boundary — including
     * a turn that failed. Not a surface event; it never reaches a model.
     */
    'context/measured': ContextMeasured
  }
}
