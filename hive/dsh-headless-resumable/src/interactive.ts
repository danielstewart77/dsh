/** Persistent terminal driver for a gateway-owned DSH conversation. */

import { createInterface } from 'node:readline'

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/cordis-plugin-loader'

import type { SessionMode } from './startup.ts'

/** Identity and optional first-turn context for an interactive process. */
export interface InteractiveConfig {
  sessionId: string
  mode: SessionMode
  initialContext?: string
  /**
   * Answer the opening context instead of queueing it. A staged rotation's
   * seed is the carry-forward with the user's own typed message concatenated
   * on, so the successor owes them a reply; a fresh terminal's seed is
   * standing context and submits nothing.
   */
  contextAsTurn?: boolean
}

/** Terminal operations separated from readline so the lifecycle is testable. */
export interface InteractiveIo {
  readonly lines: AsyncIterable<string>
  write(text: string): void
  error(text: string): void
  prompt(): void
  close(): void
  onInterrupt(listener: () => void): () => void
  exit(code: number): void
}

/** The mind this process speaks for, as its pane labels and prompt it.
 *
 * The surface is shipped to every dsh mind, so naming one of them here is a
 * prompt that lies on every other machine running it. */
export function mindLabel(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MIND_NAME ?? '').trim() || 'dsh'
}

/** Build the real readline-backed terminal IO. */
export function terminalIo(exit: (code: number) => void): InteractiveIo {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY && process.stdout.isTTY,
    prompt: `${mindLabel()}> `,
    historySize: 200,
    removeHistoryDuplicates: true,
  })
  return {
    lines: rl,
    write: text => { process.stdout.write(text) },
    error: text => { process.stderr.write(text) },
    prompt: () => { rl.prompt() },
    close: () => { rl.close() },
    onInterrupt: (listener) => {
      rl.on('SIGINT', listener)
      return () => { rl.off('SIGINT', listener) }
    },
    exit,
  }
}

/** The opening turn a context file asks for, or nothing when it asked for none.
 *
 * `undefined?.trim() !== ''` is true, so testing the optional directly injects
 * a message whose text is `undefined` — which the session rejects as
 * non-JSON-serializable and takes the whole terminal down before it prints a
 * prompt. A terminal started with no context file is the common case. */
export function openingContextMessage(initialContext: string | undefined): UserMessage | undefined {
  const text = (initialContext ?? '').trim()
  if (text === '') return undefined
  return createUserMessage({
    content: [{ type: 'text', text: initialContext as string }],
    source: { kind: 'plugin', plugin: 'hive-terminal-context' },
  })
}

/** How an opening context reaches the conversation: queued, or answered. */
export interface OpeningContextDelivery {
  message: UserMessage
  /** True when the conversation owes this context a reply. */
  submit: boolean
}

/**
 * The opening context and whether it is a turn the successor has to answer.
 *
 * Injecting adds a message and starts nothing, which is right for standing
 * context and wrong for a rotation: the pane would open with the user's
 * question sitting in the conversation and no answer coming.
 * @param initialContext - the opening context, if any.
 * @param asTurn - whether this context is owed a reply.
 * @returns the message and its delivery, or undefined when there is nothing.
 */
export function openingContextDelivery(
  initialContext: string | undefined, asTurn: boolean,
): OpeningContextDelivery | undefined {
  const message = openingContextMessage(initialContext)
  if (message === undefined) return undefined
  return { message, submit: asTurn }
}

/** Text from one completed interval when no stream delta was rendered. */
function intervalText(events: readonly SessionEvent[], firstSeq: number): string {
  let text = ''
  for (const event of events) {
    if (event.seq < firstSeq || event.type !== 'assistant/message') continue
    const joined = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (joined !== '') text = joined
  }
  return text
}

/** Render new assistant prose and concise tool progress into the terminal. */
export function renderEvent(
  io: Pick<InteractiveIo, 'write' | 'error'>,
  event: SessionEvent,
  calls: Map<string, string>,
  state: { streamed: boolean },
): void {
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
    io.write(event.data.chunk.text)
    state.streamed = true
    return
  }
  if (event.type === 'tool/call') {
    calls.set(event.data.callId, event.data.name)
    io.write(`\n[tool] ${event.data.name}\n`)
    return
  }
  if (event.type === 'tool/result') {
    const name = calls.get(event.data.message.source.callId) ?? 'unknown'
    const failed = event.data.message.content.some(block => block.isError === true)
    io.write(`[tool ${failed ? 'failed' : 'done'}] ${name}\n`)
    return
  }
  if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
    io.error(`\n${event.data.reason.error.code}: ${event.data.reason.error.message}\n`)
  }
}

/** Open one supplied conversation and keep driving typed prompts until EOF. */
export async function runInteractive(
  ctx: Context,
  config: InteractiveConfig,
  io: InteractiveIo,
): Promise<void> {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  if (selection.model === undefined || selection.model === '') {
    io.error('dsh-hive: NO_MODEL: no model was named\n')
    io.exit(1)
    return
  }
  const setup = (agentCtx: Context): void => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
  const agentOptions = { provider: selection.provider, model: selection.model }
  const handle = config.mode === 'resume'
    ? await agents.resume({ resumeSessionId: SessionId(config.sessionId), agentOptions, setup })
    : await agents.create({
      sessionId: SessionId(config.sessionId),
      meta: { cwd: process.cwd() },
      agentOptions,
      setup,
    })
  const { agent } = handle
  await agent.whenIdle()
  const opening = openingContextDelivery(
    config.initialContext, config.contextAsTurn === true,
  )
  if (opening !== undefined && !opening.submit) agent.inject(opening.message)

  const calls = new Map<string, string>()
  const state = { streamed: false }
  const stopRendering = agent.ctx.on('session/event', (_session, event) => {
    renderEvent(io, event, calls, state)
  })
  let running: Agent | undefined
  const stopInterrupt = io.onInterrupt(() => {
    if (running !== undefined) {
      running.cancel({ kind: 'user' })
      io.write('\n[interrupted]\n')
      return
    }
    io.close()
  })

  io.write(`${mindLabel()} · DSH · ${selection.model}\nConversation ${config.sessionId}\nType /exit to close. Ctrl+C interrupts a running turn.\n\n`)
  // Taken before the opening turn, not at the `for await` below. The iterator
  // attaches readline's line listener when it is created, and lines emitted
  // before that are dropped — so a user typing during an opening turn, which
  // is a whole model turn long and comes right after a rotation when they are
  // most likely to be typing, would watch readline echo their follow-up and
  // then see it vanish.
  const lines = io.lines[Symbol.asyncIterator]()
  try {
    // A staged rotation opens owing the user an answer: its seed carries the
    // message they typed into the conversation this one replaced. Answered
    // here rather than queued, before the first prompt, so the reply is on
    // screen when they look at the pane. Inside the try, so a throw from the
    // turn or from the flush still tears the pane's listeners down rather
    // than leaving a prompt-less pane alive on a dead event loop.
    if (opening !== undefined && opening.submit) {
      const firstSeq = agent.session.seq
      state.streamed = false
      running = agent
      agent.followup(opening.message)
      await agent.whenIdle()
      running = undefined
      await sessions.flush(agent.session)
      if (!state.streamed) {
        const text = intervalText(agent.session.events, firstSeq)
        if (text !== '') io.write(text)
      }
      io.write('\n\n')
    }
    io.prompt()
    for (let next = await lines.next(); next.done !== true; next = await lines.next()) {
      const line = next.value
      const command = line.trim()
      if (command === '/exit' || command === '/quit') break
      if (command === '') {
        io.prompt()
        continue
      }
      const firstSeq = agent.session.seq
      state.streamed = false
      running = agent
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: line }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      running = undefined
      await sessions.flush(agent.session)
      if (!state.streamed) {
        const text = intervalText(agent.session.events, firstSeq)
        if (text !== '') io.write(text)
      }
      io.write('\n\n')
      io.prompt()
    }
  } finally {
    stopInterrupt()
    stopRendering()
    io.close()
  }
  io.exit(0)
}
