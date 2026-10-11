/** Content-block structure helpers. @module @deepseek-ai/dsh-llm/content */

import type { ContentBlock } from './types.ts'

/**
 * True when typed model content contains an image block, walking nested
 * tool-result content. This is the one recursive image walk shared by every
 * image policy (capability gating, text-only serialization, compaction
 * survey), so a consumer cannot silently diverge on nesting depth.
 * @param content - typed model content blocks.
 * @returns whether any nested block is an image.
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image'
    || (block.type === 'tool-result' && contentHasImage(block.content)))
}

/**
 * The placeholder standing in for an image this route could not carry. The
 * model is told an image was there rather than silently handed a turn with a
 * hole in it — and a block that would otherwise be empty keeps a body, since
 * an empty tool result is itself a request some endpoints refuse.
 */
export const IMAGE_OMITTED_TEXT = '[image omitted: this model does not accept image input]'

/**
 * The same recursive walk as {@link contentHasImage}, dropping what it finds.
 *
 * Only the image blocks go: the text beside one — the envelope naming the
 * path, media type and dimensions — is what remains of the image for a model
 * that cannot see it, and is worth more than nothing. A block emptied by the
 * strip is given {@link IMAGE_OMITTED_TEXT} instead of being left bodiless.
 * @param content - typed model content blocks.
 * @returns the content with every nested image block removed.
 */
export function contentWithoutImages(content: readonly ContentBlock[]): ContentBlock[] {
  const kept: ContentBlock[] = []
  for (const block of content) {
    if (block.type === 'image') continue
    if (block.type === 'tool-result') {
      const inner = contentWithoutImages(block.content)
      kept.push({
        ...block,
        content: inner.length === 0 ? [{ type: 'text', text: IMAGE_OMITTED_TEXT }] : inner,
      })
      continue
    }
    kept.push(block)
  }
  return kept
}

/**
 * Every message with its images dropped, each left with a body.
 *
 * A message stripped to nothing is not the same as a message that was always
 * empty: a user who pasted a screenshot with no caption has their whole turn
 * erased, and the conversion then sends an empty user turn that endpoints
 * refuse — which is the failure the strip exists to recover from, arriving a
 * second time. So an emptied message says what was taken out.
 * @param messages - the turn's messages.
 * @returns the messages with every nested image removed.
 */
export function messagesWithoutImages<M extends { content: readonly ContentBlock[] }>(
  messages: readonly M[],
): M[] {
  return messages.map((message) => {
    if (!contentHasImage(message.content)) return message
    const content = contentWithoutImages(message.content)
    return {
      ...message,
      content: content.length === 0 ? [{ type: 'text', text: IMAGE_OMITTED_TEXT }] : content,
    }
  })
}
