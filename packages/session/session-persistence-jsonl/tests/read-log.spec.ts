/**
 * Unit tests for the standalone session-log reader: the entry point a
 * non-harness process (a per-turn hook) uses to read one session artifact
 * without a cordis Context, a backend instance, or a session id.
 */

import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compressZstdFrame } from '../src/zstd.ts'
import { constants, zstdCompress } from 'node:zlib'
import { promisify } from 'node:util'
import { readSessionLogText } from '../src/read-log.ts'

const zstdCompressAsync = promisify(zstdCompress)

/** A flushed-but-unterminated frame, the shape a live writer leaves behind. */
async function tornFrame(text: string): Promise<Buffer> {
  return zstdCompressAsync(Buffer.from(text), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
    finishFlush: constants.ZSTD_e_flush,
  })
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'read-log-'))
}

describe('readSessionLogText', () => {
  it('returns events from every appended frame, not only the first', async () => {
    const dir = await scratch()
    const path = join(dir, 'session.jsonl.zstd')
    const frames = await Promise.all([
      compressZstdFrame('{"type":"session","seq":0}\n'),
      compressZstdFrame('{"type":"turn/start","seq":1}\n'),
      compressZstdFrame('{"type":"assistant/message","seq":2}\n{"type":"step/end","seq":3}\n'),
    ])
    await writeFile(path, Buffer.concat(frames))

    const text = await readSessionLogText(path)
    const seqs = text.trimEnd().split('\n').map(line => (JSON.parse(line) as { seq: number }).seq)

    expect(seqs).toEqual([0, 1, 2, 3])
  })

  it('recovers the newest turn from an unterminated final frame', async () => {
    const dir = await scratch()
    const path = join(dir, 'session.jsonl.zstd')
    const complete = await compressZstdFrame('{"type":"session","seq":0}\n')
    const live = await tornFrame('{"type":"assistant/message","seq":1}\n')
    await writeFile(path, Buffer.concat([complete, live]))

    const text = await readSessionLogText(path)
    const seqs = text.trimEnd().split('\n').map(line => (JSON.parse(line) as { seq: number }).seq)

    expect(seqs).toEqual([0, 1])
  })

  it('reads an uncompressed artifact as its own bytes', async () => {
    const dir = await scratch()
    const path = join(dir, 'session.jsonl')
    await writeFile(path, '{"type":"session","seq":0}\n{"type":"turn/start","seq":1}\n')

    const text = await readSessionLogText(path)

    expect(text.trimEnd().split('\n')).toHaveLength(2)
  })

  it('drops a trailing partial line rather than yielding invalid JSON', async () => {
    const dir = await scratch()
    const path = join(dir, 'session.jsonl.zstd')
    const complete = await compressZstdFrame('{"type":"session","seq":0}\n')
    const live = await tornFrame('{"type":"assistant/mess')
    await writeFile(path, Buffer.concat([complete, live]))

    const text = await readSessionLogText(path)

    for (const line of text.trimEnd().split('\n')) {
      expect(() => { JSON.parse(line) }).not.toThrow()
    }
  })
})
