/**
 * A goal run the hive says has outgrown its model.
 *
 * The rotation check is the mind's own Stop hook: dsh runs it at every round's
 * close and never rotates by itself. What it owes the hive is to stop paying for
 * rounds on a conversation the hook has called too big, and to say what is left
 * of the goal so it can be carried onto a fresh one.
 *
 * Everything here is real but the model: the agent loop, the goal service and
 * its round driver, the Claude Code hook bridge and the shell running the hook.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import * as HooksClaude from '@deepseek-ai/dsh-hooks-claude-code'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'

import { apply, internals } from '../src/index.ts'
import type { TurnReport } from '../src/index.ts'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A Stop hook that answers `rotate` from its `fire`th invocation on, the way the
 * mind's rotation check does once the conversation crosses its threshold.
 */
function rotatingStopHook(fire: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hive-rotate-'))
  dirs.push(dir)
  const count = join(dir, 'stops')
  const script = join(dir, 'stop.sh')
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'cat > /dev/null',
    `n=$(( $(cat "${count}" 2>/dev/null || echo 0) + 1 ))`,
    `echo "$n" > "${count}"`,
    `if [ "$n" -ge ${fire} ]; then echo '{"rotate": true}'; fi`,
    '',
  ].join('\n'))
  chmodSync(script, 0o755)
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: 'command', command: script }] }],
  } }))
  return join(dir, 'hooks.json')
}

/** Run one goal dispatch to its report over a real loop with only the model scripted. */
async function dispatch(
  hooksPath: string,
  rounds: number,
  script: ConstructorParameters<typeof MockAdapter>[0] = Array.from(
    { length: rounds + 2 }, (_, index) => textResponse(`worked on it ${index}`),
  ),
): Promise<TurnReport> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'mock', model: 'mock' })
  await ctx.plugin(GoalService)
  await ctx.plugin(GoalRoundDriver)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksClaude, { configPath: hooksPath })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))

  let out = ''
  internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
  internals.stderr = { write: () => true }
  await new Promise<number>((resolve) => {
    ctx.provide('appExit', resolve)
    apply(ctx, { task: 'build the app', sessionId: `conv-${Math.random()}`, mode: 'create', goalRounds: rounds })
  })
  const lines = out.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  return lines[lines.length - 1] as unknown as TurnReport
}

describe('a goal run whose Stop hook asks for rotation', () => {
  it('ends after the round the hook closed, reporting the goal unfinished with the rounds it never started', async () => {
    // The task's own turn is the first Stop; goal rounds one and two are the
    // second and third, so three of the five rounds were never started.
    const report = await dispatch(rotatingStopHook(3), 5)

    expect(report.outcome).toBe('rotation_needed')
    expect(report.turns).toBe(3)
    expect(report.goal).toEqual({ objective: 'build the app', roundsLeft: 5 - 2 })
  }, 30_000)

  it('reports an overflow in the round as the overflow, not as a rotation', async () => {
    // The round that hits the ceiling is the one whose Stop hook asks for rotation.
    const report = await dispatch(rotatingStopHook(2), 5, [
      textResponse('worked on it'),
      () => { throw new LlmError('maximum context length is 200000 tokens', CONTEXT_WINDOW_EXCEEDED_CODE) },
    ])

    expect(report.outcome).toBe('error')
    expect(report.error?.code).toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
    expect(report.goal).toBeUndefined()
  }, 30_000)
})
