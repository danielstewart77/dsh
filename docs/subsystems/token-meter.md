# Token Meter

English | [中文](token-meter.zh.md)

`@deepseek-ai/dsh-token-meter` exposes one detached replay snapshot for request pressure and positional surface pricing. `logRevision` is the number of durable events consumed for every field in the measurement.

Source: [`packages/llm/token-meter/src/types.ts`](../../packages/llm/token-meter/src/types.ts)

## `TokenMeasurement`

```ts type-equiv
/** Detached immutable request-pressure and surface snapshot at one consumed log revision. */
interface TokenMeasurement {
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
```

`baseline.kind === 'usage'` means the latest successful provider call has the same canonical request envelope and its total is no lower than that call's full heuristic anchor. `estimated` means no reusable conservative usage anchor exists, so the service priced the complete envelope and surface with its fixed heuristic. A later successful request replaces the earlier anchor; signed `surfaceDeltaTokens` preserves growth and shrinkage relative to a matching anchor. `totalTokens` remains request-and-response pressure, while `surfaceTokens` is the surface-only heuristic total and equals the sum of the node prices.

## `TokenSurfaceNode`

```ts type-equiv
/** One token-priced node in the current ordered session surface. */
interface TokenSurfaceNode {
  /** Durable sequence number of the surface event. */
  readonly seq: number
  /** Heuristic tokens for the exact message projected by this node. */
  readonly tokens: number
}
```

Surface order is authoritative; replacement nodes can have higher durable seqs than later positional nodes. The snapshot is immutable and does not grow when the underlying replay fold advances.

## `ContextMeasured`

```ts type-equiv
/**
 * How big the conversation was when a turn closed, and against what ceiling.
 * Appended as `context/measured` at the turn's stop boundary, before any
 * listener that reads it, so a hook deciding whether the conversation has
 * outgrown its model reads the same figure the log keeps.
 */
interface ContextMeasured {
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
```

The service appends one `context/measured` event at every turn's stop boundary, failed turns included, before the other `agent/turn-stopping` listeners run; the Claude Code and Codex hook bridges hand the same fields to a Stop hook as `context`. `measureTurn(session, turn)` computes it.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtokenmeter--tokenmeter"></a>

### `ctx.tokenMeter` — `TokenMeter`

Replay owner for one service-wide estimator and isolated per-session folds.

```ts cordis-catalog
/**
 * The conversation's size at a turn's close, labelled by where the figure
 * came from.
 *
 * The provider's count stands only when it is for the turn's own final call:
 * that call's input, cache reads and writes and output, with nothing added to
 * the conversation since. A call the provider counted as zero input, a turn
 * whose last call failed, or one that went on adding tool results is the
 * meter's estimate instead — the last trusted count plus the price of what
 * came after. A log that cannot be measured reports `none` rather than a
 * guess.
 * @param session - the conversation the turn ran in.
 * @param turn - the turn being closed.
 * @returns the measurement to record.
 */
measureTurn(session: Session, turn: number): ContextMeasured

/**
 * Measure current request pressure and surface through the durable tail.
 *
 * Provider usage is reused only when the latest successful call's canonical
 * request envelope matches `requestHeader` and its total is no lower than
 * that call's full heuristic anchor; otherwise the complete envelope and
 * surface are heuristically repriced.
 *
 * `requestHeader` affects request pressure only; surface fields always
 * describe the current session surface. Every call clones those positional
 * nodes, so measurement is O(surface).
 *
 * @param session - session to replay through its current durable tail.
 * @param requestHeader - optional effective request envelope replacing the latest logged header.
 * @returns a detached deeply immutable pressure and surface measurement.
 */
measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement

/**
 * Heuristically price one model-visible message (instance face of the pure
 * `estimateMessage` export from `estimate.ts`).
 * @param message - message to price without mutation.
 * @returns content and role-framing tokens under the fixed service heuristic.
 */
estimateMessage(message: Message): number
```

Types: [EpochHeader](session.md) · [Message](llm-streaming.md) · [Session](session.md)

Source: [`packages/llm/token-meter/src/index.ts:94`](../../packages/llm/token-meter/src/index.ts)
<!-- END GENERATED cordis-surface -->
