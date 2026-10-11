#!/usr/bin/env node
/**
 * Print one session artifact's events as newline-delimited JSON on stdout.
 *
 * The entry point for a reader outside this process tree: a per-turn hook is a
 * short-lived python or bash process with a path from its payload, and the
 * frame container it has to read is this package's own fact. Shipping the
 * reader as a command keeps every consumer — this harness's hooks, a
 * gateway-side tool — off a second implementation of it.
 * @module dsh-session-persistence-jsonl/read-log-cli
 */

import { readSessionLogText } from './read-log.ts'

const path = process.argv[2]
if (path === undefined) {
  process.stderr.write('usage: read-log-cli <session-artifact>\n')
  process.exit(2)
}
try {
  process.stdout.write(await readSessionLogText(path))
} catch (error: unknown) {
  // A missing or unreadable artifact is the hook's normal first-turn state, so
  // it is named on stderr and exits distinctly from a malformed container —
  // a caller must be able to tell "nothing yet" from "this is not a log".
  process.stderr.write(`read-log-cli: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
