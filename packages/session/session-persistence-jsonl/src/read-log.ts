/**
 * Standalone reader for one session artifact, for a process that is not the
 * harness: a per-turn hook has a path and nothing else — no cordis Context, no
 * backend instance, no session id — and still has to read the conversation.
 *
 * It exists here rather than in the consumer because the physical encoding is
 * this package's own fact. A zstd artifact is a *concatenated* frame container
 * whose final frame is written with `ZSTD_e_flush` and left unterminated while
 * the conversation runs, so a one-shot `zstdDecompress` of the whole file
 * returns the header frame alone and a reader that stops at the last complete
 * frame is always one turn stale — and a Stop hook runs precisely while the
 * turn that triggered it is still being written. Frame magic also occurs
 * inside compressed payloads, so splitting the file on it is wrong.
 * @module dsh-session-persistence-jsonl/read-log
 */

import { readFile, stat } from 'node:fs/promises'
import { createZstdFrameDecoder, decompressZstdPrefix, scanZstdFrames } from './zstd.ts'

/** Artifacts whose bytes are a concatenated Zstandard frame container. */
const ZSTD_SUFFIX = '.zstd'

/**
 * Read the file only when two stats either side of the read agree, so a
 * reader racing a live append never decodes a buffer torn between two writes
 * at a boundary the frame scan cannot see.
 * @param path - the artifact to read.
 * @returns bytes that were stable for the duration of one read.
 */
async function readStableFile(path: string): Promise<Buffer> {
  for (;;) {
    const before = await stat(path, { bigint: true })
    const buffer = await readFile(path)
    const after = await stat(path, { bigint: true })
    if (before.mtimeNs === after.mtimeNs && before.size === after.size) return buffer
  }
}

/**
 * Everything decodable in one artifact, as newline-delimited JSON text.
 *
 * Complete frames decode in source order; an unterminated final frame has its
 * available plaintext recovered, which is what makes the newest turn visible.
 * A trailing partial line is dropped — a flush can land mid-event, and half an
 * event is not an event.
 *
 * @param path - the session artifact. A `.zstd` suffix selects the frame
 *   container; anything else is read as its own bytes.
 * @returns the artifact's event lines, each newline-terminated.
 */
export async function readSessionLogText(path: string): Promise<string> {
  const buffer = await readStableFile(path)
  if (!path.endsWith(ZSTD_SUFFIX)) return completeLines(buffer.toString('utf8'))

  const { frames, tornStart } = scanZstdFrames(buffer)
  const decoder = createZstdFrameDecoder()
  const parts: string[] = []
  try {
    for (const plaintext of decoder.decode(buffer, frames)) parts.push(plaintext.toString('utf8'))
  } finally {
    decoder.close()
  }
  if (tornStart !== undefined) {
    // A frame carrying no decodable block yet yields nothing rather than
    // failing the read: the alternative is a hook that cannot measure a
    // conversation for the moment either side of a flush.
    try {
      parts.push((await decompressZstdPrefix(buffer.subarray(tornStart))).toString('utf8'))
    } catch {
      // The torn tail is unreadable; the complete frames still are.
    }
  }
  return completeLines(parts.join(''))
}

/**
 * Keep whole lines only.
 * @param text - decoded plaintext, possibly ending mid-line.
 * @returns the newline-terminated prefix of `text`.
 */
function completeLines(text: string): string {
  const end = text.lastIndexOf('\n')
  return end === -1 ? '' : text.slice(0, end + 1)
}
