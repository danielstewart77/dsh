import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as HooksCodex from '@deepseek-ai/dsh-hooks-codex'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** A Codex-dialect Stop hook is handed the same turn-close facts as a Claude Code one. */

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function stopPayloadOf(script: ConstructorParameters<typeof MockAdapter>[0]): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-codex-close-'))
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
  await ctx.plugin(HooksCodex, { configPath: join(dir, 'hooks.json') })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const agent = ctx.agentLoop.create(SessionId(`close-${Math.random()}`), { provider: 'mock', model: 'mock-model' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(existsSync(capture)).toBe(true)
  return JSON.parse(readFileSync(capture, 'utf8')) as Record<string, unknown>
}

describe('hooks-codex at a turn\'s close', () => {
  it('runs the Stop hook for a failed turn, marked as an error with its code and the size it reached', async () => {
    const payload = await stopPayloadOf([() => {
      throw new LlmError('maximum context length is 200000 tokens', CONTEXT_WINDOW_EXCEEDED_CODE)
    }])

    expect(payload['stop_reason']).toBe('error')
    expect(payload['error_code']).toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
    expect(payload['context']).toMatchObject({ kind: 'estimated', model: 'mock-model' })
  })

  it('hands a completed turn the provider\'s count and no error', async () => {
    const payload = await stopPayloadOf([textResponse('done')])

    // textResponse counts 10 tokens in and one per character out.
    expect(payload['context']).toMatchObject({ kind: 'usage', tokens: 10 + 'done'.length })
    expect(payload['stop_reason']).toBeUndefined()
  })
})
