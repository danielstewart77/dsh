import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as Spawn from '../src/index.ts'

/**
 * The real thing: a model name that will never exist, named on a real
 * delegation, put on the wire to the real inference proxy, and the proxy's
 * refusal read back off the tool result the delegating model would see.
 *
 * Nothing here is a stand-in. The adapter is the one the hive profile loads
 * (`llm-pi-ai`, `openai-completions`), the endpoint is the mind's own proxy,
 * and the model is catalogued on purpose so the name reaches the endpoint
 * rather than being refused locally by the route's own model list — a local
 * refusal would prove the catalog works and say nothing about what happens
 * when the proxy is the one that does not have the model.
 */

/** The route key and endpoint the hive profile uses (`hive/cordis.patch.yml`). */
const ROUTE = 'hive-proxy'
const BASE_URL = process.env.DSH_PROXY_BASE_URL
/** The env name the hive profile's route resolves its credential through. */
const PROXY_KEY_ENV = 'HIVE_PROXY_KEY'
const PROXY_KEY = process.env[PROXY_KEY_ENV]

/** A name no deployment will ever register, unique per run so no cache can hold it. */
const ABSENT_MODEL = `no-such-model-${Date.now().toString(36)}`

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { persona: 'You are a coding agent.' },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmPiAi, {
    providers: {
      [ROUTE]: {
        api: 'openai-completions',
        baseURL: BASE_URL!,
        apiKeyEnv: PROXY_KEY_ENV, // secret-guard: allow -- an env var name, not a credential
        // Catalogued deliberately: the route accepts the name so the request
        // is actually made, and the proxy is what rejects it.
        models: [{ id: ABSENT_MODEL, contextWindow: 131_072 }],
      },
    },
  })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(ToolSubagent, { provider: 'spawn' })
  return ctx
}

// Key-gated like every other real-endpoint suite here: the proxy answers 401
// without a bearer, and an auth refusal is not the refusal under test.
describe.skipIf(BASE_URL === undefined || PROXY_KEY === undefined)('a delegation naming a model the proxy does not have', () => {
  it('fails the delegation and reports the proxy\'s own refusal to the caller', async () => {
    const ctx = await harness()
    const parent = ctx.agentLoop.create(SessionId('absent-model-parent'), {
      provider: ROUTE,
      model: ABSENT_MODEL,
    })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('absent-model-delegation'),
      name: 'subagent',
      agent: parent,
      arguments: {
        description: 'work that cannot start',
        prompt: 'Say OK.',
        model: ABSENT_MODEL,
      },
    })

    const text = result.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(result.isError).toBe(true)
    // The model named, in the sentence the caller reads: an error that does
    // not say which model is the problem sends its reader to the wrong fix.
    expect(text).toContain(ABSENT_MODEL)
  }, 120_000)
})
