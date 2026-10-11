/**
 * pi-ai assistant event translation into the Harness streaming protocol.
 *
 * pi-ai tool-call arguments are parsed objects while the Harness keeps their
 * raw JSON representation. pi-ai also reports failures as terminal stream
 * events, which this module maps into Harness finish chunks.
 *
 * @module dsh-llm-pi-ai/stream
 */

import { CallId, CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, isContextWindowExceededError, isQuotaExceededError, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { isContextOverflow } from '@earendil-works/pi-ai'
import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from '@earendil-works/pi-ai'
import { toPiReplayState } from './replay.ts'

/**
 * Map pi-ai usage (reasoning folded into output by pi-ai).
 * @param usage - cumulative usage from the terminal pi-ai event.
 * @returns harness counts; cache fields appear only when non-zero (pi-ai reports zeros, not absence).
 */
export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

/**
 * Wordings in which an endpoint says the model itself takes no image input.
 *
 * The subject has to sit inside the refusing clause, not merely somewhere in
 * the message. "model gpt-4-vision-preview does not support tool use" names a
 * vision model and refuses something else; "content filter does not allow
 * this image" refuses this one image and says nothing about the model. Each
 * alternative below is a wording a real endpoint returns.
 */
const IMAGE_INPUT_REFUSALS: readonly RegExp[] = [
  // "this model does not support image input", "cannot accept images"
  new RegExp(
    "(?:does\\s+not|doesn't|do\\s+not|don't|cannot|can't|is\\s+not|are\\s+not)"
    + '\\s+(?:currently\\s+)?(?:support|accept|allow|handle)s?\\s+'
    + '(?:\\w+\\s+){0,2}(?:images?|image_url|vision|multi-?modal)\\b',
    'i',
  ),
  // "image input is not supported", "multi-modal inputs are not supported"
  /\b(?:images?|image_url|vision|multi-?modal)\b(?:\s+\w+){0,3}\s+(?:is|are)\s+not\s+(?:supported|accepted|allowed)\b/i,
  // OpenAI: "Invalid content type. image_url is only supported by certain models."
  /\b(?:images?|image_url)\b(?:\s+\w+){0,3}\s+(?:is|are)\s+only\s+supported\b/i,
  // OpenRouter: "No endpoints found that support image input"
  /\bno\s+(?:endpoints?|models?|deployments?)\b.*\b(?:images?|vision|multi-?modal)\b/i,
  // "model 'x' has no vision capability", "no image support"
  /\bno\s+(?:images?|vision|multi-?modal)\s+(?:support|capability|capabilities)\b/i,
  // LiteLLM: "Model qwen3 is not multimodal"
  /\bis\s+not\s+multi-?modal\b/i,
  // Mistral: "Invalid model for image input"
  /\binvalid\s+model\b.*\b(?:images?|vision|multi-?modal)\b/i,
]

/**
 * Complaints about a particular image rather than about the model's capacity
 * for any image. Stripping on one of these discards pictures that were fine,
 * and — far worse — teaches this process that a model with eyes has none.
 */
const IMAGE_CONTENT_COMPLAINTS: readonly RegExp[] = [
  /\bimage\/[a-z0-9.+-]+/i,
  /\b\d+\s*x\s*\d+\b/,
  /\b(?:format|formats|mime|media\s+type|resolution|dimensions?|pixels?)\b/i,
  // A message naming concrete encodings is answering "which image", not
  // "whether images": "use JPEG or PNG" is advice about this file.
  /\b(?:jpe?g|png|gif|webp|avif|tiff?|bmp|heic|heif|svg)\b/i,
  /\b(?:too\s+large|exceeds?|limit|maximum|max|size|bytes|[kmg]b)\b/i,
  /\b(?:filter|moderation|nsfw|safety|policy|rejected|corrupt|decode|malformed|invalid\s+value)\b/i,
  /\bper\s+request\b/i,
]

/**
 * An endpoint refusing a request because the model takes no image input.
 *
 * The endpoint is the only party that knows. A gateway route serves whatever
 * model a request names, so nothing on this side can hold a current list of
 * which of them have eyes — and a list that went stale would either refuse an
 * image a vision model serves perfectly or send one to a model that cannot
 * read it. The refusal itself is the answer, always current and needing no
 * configuration, so it is read rather than merely reported.
 *
 * A match is not taken as proof: it causes one attempt without the images,
 * and only that attempt answering is treated as evidence about the model. So a
 * wording this misreads costs a round trip, and a wording it misses leaves the
 * turn exactly as it would have been.
 * @param message - the endpoint's flattened error text.
 * @returns whether the text says this model accepts no image input.
 */
export function isImageInputRefusal(message: string): boolean {
  if (IMAGE_CONTENT_COMPLAINTS.some(pattern => pattern.test(message))) return false
  return IMAGE_INPUT_REFUSALS.some(pattern => pattern.test(message))
}

// XXX(pi-ai upstream): pi-ai flattens the caught error to `error.message`
// (api/anthropic-messages.js: `errorMessage = error instanceof Error ?
// error.message : JSON.stringify(error)`), discarding the original Error and its
// `cause` chain before it reaches us. undici carries the actionable transport
// detail on `cause` (e.g. `SocketError: other side closed`) but hands the fetch
// wrapper a bare `terminated`, so we are left pattern-matching terse words here.
// If pi-ai ever forwards the original Error (or a fetch/dispatcher hook that lets
// us capture the cause ourselves), classify on `code`/`cause` instead of text.
function classifyPiAiError(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  // A stream truncated before the provider's terminal event: each pi-ai provider
  // throws its own wording when the wire closes mid-response without a terminal
  // event (`… stream ended before message_stop`, `… before a terminal response
  // event`, `… ended without a terminal event`, `Stream ended without
  // finish_reason`). The connection dropped mid-response, so this is a transport
  // truncation, not a model-level error.
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
    // undici renders a mid-stream socket drop as a bare `terminated` (its
    // `cause` — the real SocketError — was flattened away upstream); Node's
    // stream layer says `Premature close`.
    || /\bterminated\b|premature close/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'PI_AI_ERROR'
}

/**
 * Map a terminal pi-ai event to the harness finish reason.
 * @param message - the assistant message carried by the `done` or `error` event.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @returns the mapped harness reason. Recognized error text, `stop` usage above
 *   `contextWindow`, and zero-output `length` usage that fills the window map
 *   to `CONTEXT_WINDOW_EXCEEDED`; a `stop` with no content blocks maps to an
 *   `EMPTY_RESPONSE` error.
 */
export function mapStopReason(message: AssistantMessage, contextWindow?: number): FinishReason {
  const piAiOverflow = isContextOverflow(message, contextWindow)
  const harnessOverflow = message.stopReason === 'error'
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage)
  if (piAiOverflow || harnessOverflow) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }

  switch (message.stopReason) {
    case 'stop':
      // A terminal stop that produced no content blocks is a degenerate
      // provider completion, not a successful (empty) assistant message.
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'aborted': return {
      kind: 'aborted',
      failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' },
    }
    case 'error': {
      const text = message.errorMessage ?? 'pi-ai stream error'
      return { kind: 'error', failure: { message: text, code: classifyPiAiError(text) } }
    }
  }
}

/**
 * Translate the pi-ai event stream into StreamChunks. pi-ai never throws
 * mid-stream — failures arrive as `error` events, which become error/aborted
 * `finish` chunks (the harness protocol's other error-delivery style).
 * @param events - one assistant turn's pi-ai event stream.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @returns the harness chunks, ending with `usage` then `finish`; throws
 *   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event.
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
): AsyncGenerator<StreamChunk> {
  // pi-ai contentIndex ↔ our block index map 1:1 (both count blocks from 0
  // in stream order), but we track ids per index for tool calls.
  const toolIds = new Map<number, { id: string; name: string }>()

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        // The id/name live on the partial's content at this index.
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: CallId(known?.id ?? ''),
          ...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: CallId(event.toolCall.id),
            name: event.toolCall.name,
            // pi-ai hands back the PARSED arguments; the harness vocabulary
            // keeps the raw string.
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(event.message, contextWindow),
          replayState: toPiReplayState(event.message),
        }
        return
      case 'error':
        // In-stream error delivery (pi-ai's style) → error finish chunk
        // (the harness's other sanctioned error path besides throwing).
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield { type: 'finish', reason: mapStopReason(event.error, contextWindow) }
        return
      // no default: AssistantMessageEvent is pi-ai's closed union; a new
      // event type should fail compilation here via tsc's exhaustiveness
      // when one is added (switch covers all current variants).
    }
  }
  throw new LlmError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}
