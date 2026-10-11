import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as HooksClaude from '@deepseek-ai/dsh-hooks-claude-code'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * What a turn's close hands the mind's Stop hook: whether the turn failed, and
 * how big the conversation was when it closed. A real loop, the real token
 * meter, the real bridge and a real shell hook; only the model is scripted.
 */

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The window the scripted model's route advertises. */
const WINDOW = 200_000

/** The mock model, on a route that advertises its context window. */
class WindowedAdapter extends MockAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { ...await super.resolveModel(provider, model), context: { contextWindow: WINDOW } }
  }
}

/** One text reply whose provider count is the one given. */
function reply(text: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Run one turn with a Stop hook capturing its payload, and return that payload. */
async function stopPayloadOf(
  script: ConstructorParameters<typeof MockAdapter>[0],
  before?: (ctx: Context) => void,
): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-close-'))
  dirs.push(dir)
  const capture = join(dir, 'stop.json')
  const hook = join(dir, 'stop.sh')
  writeFileSync(hook, `#!/usr/bin/env bash\ncat > "${capture}.tmp" && mv "${capture}.tmp" "${capture}"\n`)
  chmodSync(hook, 0o755)
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: 'command', command: hook }] }],
  } }))

  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksClaude, { configPath: join(dir, 'hooks.json') })
  ctx.llm.registerAdapter(['mock'], new WindowedAdapter(script))
  before?.(ctx)
  const agent = ctx.agentLoop.create(SessionId(`close-${Math.random()}`), { provider: 'mock', model: 'mock-model' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(existsSync(capture)).toBe(true)
  return JSON.parse(readFileSync(capture, 'utf8')) as Record<string, unknown>
}

describe('a turn that fails', () => {
  it('still reaches the Stop hook, marked as an error with its code', async () => {
    const payload = await stopPayloadOf([() => {
      throw new LlmError('maximum context length is 200000 tokens', CONTEXT_WINDOW_EXCEEDED_CODE)
    }])

    expect(payload['hook_event_name']).toBe('Stop')
    expect(payload['stop_reason']).toBe('error')
    expect(payload['error_code']).toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
  })
})

describe('the conversation size a Stop hook is handed', () => {
  it('is the provider count for the final call, input and cache and output together', async () => {
    const payload = await stopPayloadOf([reply('done', { inputTokens: 150_000, cacheReadTokens: 20_000, outputTokens: 500 })])

    expect(payload['context']).toEqual({ model: 'mock-model', tokens: 150_000 + 20_000 + 500, kind: 'usage', window: WINDOW })
  })

  it('is dsh\'s own estimate when the provider counted zero', async () => {
    const payload = await stopPayloadOf([reply('done', { inputTokens: 0, outputTokens: 0 })])

    const context = payload['context'] as { kind: string; tokens: number; model: string; window: number }
    expect(context.kind).toBe('estimated')
    expect(context.tokens).toBeGreaterThan(0)
    expect(context.model).toBe('mock-model')
    expect(context.window).toBe(WINDOW)
  })

  it('is an estimate on a failed turn, since the provider never counted the call that failed', async () => {
    const payload = await stopPayloadOf([() => {
      throw new LlmError('maximum context length is 200000 tokens', CONTEXT_WINDOW_EXCEEDED_CODE)
    }])

    const context = payload['context'] as { kind: string; tokens: number }
    expect(context.kind).toBe('estimated')
    expect(context.tokens).toBeGreaterThan(0)
  })

  it('is none when the turn failed before anything reached the conversation', async () => {
    const payload = await stopPayloadOf([], (ctx) => {
      ctx.on('agent/pre-step', () => { throw new Error('prompt assembly failed') })
    })

    expect(payload['context']).toEqual({ model: null, tokens: 0, kind: 'none', window: null })
    expect(payload['stop_reason']).toBe('error')
  })
})

describe('a measured conversation', () => {
  it('resumes in a later process, its measurements and all', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-measured-'))
    dirs.push(root)
    const mount = async (): Promise<Context> => {
      const ctx = new Context()
      contexts.push(ctx)
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(TokenMeter)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(JsonlSessionPersistence, { root })
      ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
      return ctx
    }
    const id = SessionId('measured')
    const first = await mount()
    const agent = first.agentLoop.create(id, { provider: 'mock', model: 'mock-model' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await first.sessions.flush(agent.session)
    await first.fiber.dispose()

    const later = await mount()
    const resumed = await later.agents.resume({ resumeSessionId: id })

    expect(resumed.agent.session.events.filter(event => event.type === 'context/measured')).toHaveLength(1)
  })
})
