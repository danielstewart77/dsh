import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { CallId, createUserMessage, CONTEXT_WINDOW_EXCEEDED_CODE, IMAGE_OMITTED_TEXT, LlmError, ReasoningEffortId, userAgent } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { carriesContent } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { isImageInputRefusal } from '../src/stream.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
}

async function harness(baseURL: string, overrides: Record<string, unknown> = {}): Promise<Context> {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: { deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL, ...overrides } },
  })
  return ctx
}

/** Direct adapter over the real profile resolver, with a fixed key per call. */
function adapterOf(
  providers: Record<string, LlmPiAi.PiAiProviderProfile>,
  apiKey: string | undefined = 'test-key',
): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles(providers),
    resolveApiKey: () => Promise.resolve(apiKey),
  })
}

beforeEach(() => {
  // Configuration carries only the reference; these mounts resolve it from
  // the environment, which is the whole credential plane without a seam.
  vi.stubEnv('PI_TEST_KEY', 'test-key')
})

describe('PiAiAdapter provider routing', () => {
  it('resolves a catalog model dynamically and uses a private endpoint', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 })
    expect(server.paths).toEqual(['/chat/completions'])
  })

  it('merges profile headers with Harness attribution winning', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, {
      headers: { 'x-company': 'private', 'User-Agent': 'wrong' },
    })
    await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[0]?.['x-company']).toBe('private')
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
  })

  it('forwards common stream options and profile reasoning', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, {
      reasoning: 'max',
      cacheRetention: 'none',
      transport: 'sse',
      timeoutMs: 5000,
      websocketConnectTimeoutMs: 3000,
      streamIdleTimeoutMs: 10_000,
      thinkingBudgets: { high: 2048 },
    })
    await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [],
      temperature: 0.2,
      maxTokens: 77,
      sessionId: 'session-for-pi' as never,
    })
    expect(server.requests[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      temperature: 0.2,
      max_completion_tokens: 77,
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    })
  })

  it('uses a dynamic request effort and reports unsupported efforts before network I/O', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = await harness(server.url, { reasoning: 'max' })

    await assemble(ctx, {
      model: 'deepseek-v4-flash',
      reasoningEffort: ReasoningEffortId('high'),
      messages: [],
    })
    expect(server.requests[0]).toMatchObject({ reasoning_effort: 'high' })

    await assemble(ctx, {
      model: 'deepseek-v4-flash',
      reasoningEffort: ReasoningEffortId('off'),
      messages: [],
    })
    expect(server.requests[1]).toMatchObject({ thinking: { type: 'disabled' } })
    expect(server.requests[1]).not.toHaveProperty('reasoning_effort')

    const unsupported = await assemble(ctx, {
      model: 'deepseek-v4-flash',
      reasoningEffort: ReasoningEffortId('xhigh'),
      messages: [],
    })
    expect(unsupported.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'UNSUPPORTED_REASONING_EFFORT' },
    })
    expect(server.requests).toHaveLength(2)
  })

  it('preserves omitted profile options when constructing the adapter directly', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['deepseek'], adapterOf({
      deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url },
    }))

    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })

    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('names a route by its displayName, and by its own key once the profiles drop it', () => {
    const adapter = adapterOf({ 'acme-gateway': {
      displayName: 'Acme Gateway',
      api: 'openai-completions',
      baseURL: 'https://acme.test/v1',
      models: [{ id: 'acme-large' }],
    } })
    expect(adapter.providerInfo('acme-gateway')).toEqual({ id: 'acme-gateway', name: 'Acme Gateway' })

    // The registry and the profiles can disagree for a moment: a refused
    // registration swap leaves the previous routes serving while resolution
    // has already moved on, so a selector may ask about a route the current
    // profiles no longer describe. It gets the key rather than nothing.
    expect(adapter.providerInfo('departed')).toEqual({ id: 'departed', name: 'departed' })
  })

  it('reports unsupported stop sequences rather than silently ignoring them', async () => {
    const server = await mockServer([])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [], stop: ['END'] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'UNSUPPORTED_OPTION' } })
    expect(server.requests).toEqual([])
  })

  it('reports unknown catalog models before network I/O', async () => {
    const server = await mockServer([])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'not-in-the-catalog', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'UNKNOWN_MODEL' } })
    expect(server.requests).toEqual([])
  })

  it('uses the catalog API implementation, including OpenAI Responses', async () => {
    const server = await mockServer([{ status: 401, body: JSON.stringify({ error: { message: 'expected mock failure' } }) }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: { openai: { apiKeyEnv: 'PI_TEST_KEY', baseURL: `${server.url}/v1` } },
    })
    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(result.finish.kind).toBe('error')
    expect(server.paths).toEqual(['/v1/responses'])
  })

  it('resolves an attachment service mounted after the adapter when dispatching an image', async () => {
    const server = await mockServer([{ status: 401, body: JSON.stringify({ error: { message: 'expected mock failure' } }) }])
    const attachmentId = AttachmentId(`sha256:${'a'.repeat(64)}`)
    const ref: ImageAttachmentRef = {
      attachmentId,
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const readImage = vi.fn((_ref: ImageAttachmentRef): Promise<StoredImageAttachment> =>
      Promise.resolve({ ref, data: Uint8Array.of(1) }))

    class LateAttachmentStore extends AttachmentStore {
      readonly imageLimits: ImageAttachmentLimits = {
        maxImageBytes: 1,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1,
        maxImagePixels: 1,
        mediaTypes: ['image/png'],
      }

      validateImage(_input: SaveImageAttachment): Promise<void> {
        return Promise.reject(new Error('not used'))
      }

      saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        return Promise.reject(new Error('not used'))
      }

      readImage(value: ImageAttachmentRef): Promise<StoredImageAttachment> {
        return readImage(value)
      }
    }

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: { openai: { apiKeyEnv: 'PI_TEST_KEY', baseURL: `${server.url}/v1` } },
    })
    await ctx.plugin(LateAttachmentStore)

    const result = await assemble(ctx, {
      provider: 'openai',
      model: 'gpt-4.1',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: ref }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })

    expect(result.finish.kind).toBe('error')
    expect(readImage).toHaveBeenCalledWith(ref)
    expect(server.paths).toEqual(['/v1/responses'])
  })

  it('forces one wire request for an SDK-retryable provider failure', async () => {
    const server = await mockServer([
      {
        status: 429,
        headers: { 'retry-after-ms': '1' },
        body: JSON.stringify({ error: { message: 'retryable provider failure' } }),
      },
      { status: 500, body: JSON.stringify({ error: { message: 'hidden SDK retry' } }) },
      { status: 500, body: JSON.stringify({ error: { message: 'second hidden SDK retry' } }) },
    ])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: { openai: { apiKeyEnv: 'PI_TEST_KEY', baseURL: `${server.url}/v1` } },
    })

    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error' })
    expect(server.paths).toEqual(['/v1/responses'])
  })

  it('uses OpenAI Responses against an Azure project v1 path with its API key header', async () => {
    const server = await mockServer([{ status: 401, body: JSON.stringify({ error: { message: 'expected mock failure' } }) }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        openai: {
          apiKeyEnv: 'PI_TEST_KEY',
          baseURL: `${server.url}/api/projects/openai/openai/v1`,
          headers: { 'api-key': 'test-key', Authorization: '' },
        },
      },
    })
    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-5.5', messages: [] })
    expect(result.finish.kind).toBe('error')
    expect(server.paths).toEqual(['/api/projects/openai/openai/v1/responses'])
    expect(server.headers[0]?.['api-key']).toBe('test-key')
    expect(server.headers[0]?.authorization).toBe('')
  })

  it.each([
    [401, 'AUTH'],
    [400, 'INVALID_REQUEST'],
    [429, 'RATE_LIMIT'],
    [500, 'SERVER'],
  ] as const)('maps HTTP %s failures to %s', async (status, code) => {
    const server = await mockServer([{ status, body: JSON.stringify({ error: { message: `provider ${status}` } }) }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code } })
    expect(server.paths).toEqual(['/chat/completions'])
  })

  it('uses the resolved catalog context window for usage-based overflow detection', async () => {
    const model = getBuiltinModels('deepseek').find(candidate => candidate.id === 'deepseek-v4-flash')
    if (model === undefined) throw new Error('deepseek-v4-flash missing from pi-ai test catalog')
    const events = [
      '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
      JSON.stringify({
        choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
        usage: { prompt_tokens: model.contextWindow + 1, completion_tokens: 0 },
      }),
      '[DONE]',
    ]
    const server = await mockServer([{ events }])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, { model: model.id, messages: [] })

    expect(result.finish).toEqual({
      kind: 'error',
      failure: {
        message: `pi-ai detected context overflow for model "${model.id}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    })
  })

  it('stops the SDK request when the adapter idle watchdog expires', async () => {
    const server = await mockServer([{ events: textEvents, delayMs: 200 }])
    const ctx = await harness(server.url, { streamIdleTimeoutMs: 20 })

    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'TIMEOUT' } })
    await Promise.race([
      server.responseClosed,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => { reject(new Error('SDK request did not close after idle timeout')) }, 1_000)
      }),
    ])

    expect(server.paths).toEqual(['/chat/completions'])
    expect(server.closedResponses).toBe(1)
  })
})

describe('provider profile lifecycle', () => {
  it('keeps adapter helpers off the package root', () => {
    for (const helper of [
      'resolveProfiles',
      'toPiContext',
      'toPiReplayState',
      'toPiAssistant',
      'mapStopReason',
      'mapUsage',
      'toStreamChunks',
    ]) expect(LlmPiAi).not.toHaveProperty(helper)
  })

  it('registers every profile atomically and unregisters on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(LlmPiAi, {
      providers: {
        openai: {
          retryPolicy: {
            mode: 'always',
            backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 },
          },
        },
        anthropic: {},
      },
    })
    expect(ctx.llm.listProviders()).toEqual([
      { id: 'openai', name: 'openai' },
      { id: 'anthropic', name: 'anthropic' },
    ])
    expect(ctx.llm.providerRetryPolicy('openai')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(ctx.llm.providerRetryPolicy('anthropic')).toMatchObject({
      mode: 'normal',
      maxRetries: 2,
    })
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('exposes the installed pi-ai model catalog through provider-neutral metadata', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { openai: {} } })
    const models = await ctx.llm.listModels('openai')
    expect(models.find(model => model.id === 'gpt-4.1')).toEqual({
      provider: 'openai', id: 'gpt-4.1', name: 'GPT-4.1',
      inputModalities: ['text', 'image'],
    })
    expect(models.every(model => model.provider === 'openai')).toBe(true)
    const info = await ctx.llm.resolveModelInfo('openai', 'gpt-4.1')
    expect(typeof info.context?.contextWindow).toBe('number')
  })

  it('exposes pi-ai model thinking levels verbatim without inventing a provider default', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: { deepseek: {}, openai: {} },
    })

    await expect(ctx.llm.resolveModelInfo('deepseek', 'deepseek-v4-flash'))
      .resolves.toMatchObject({
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('off'), name: 'Off' },
            { id: ReasoningEffortId('high'), name: 'High' },
            { id: ReasoningEffortId('max'), name: 'Max' },
          ],
        },
      })
    const extended = await ctx.llm.resolveModelInfo('openai', 'gpt-5.6-sol')
    expect(extended.reasoning?.efforts.map(effort => effort.id)).toEqual([
      ReasoningEffortId('off'),
      ReasoningEffortId('low'),
      ReasoningEffortId('medium'),
      ReasoningEffortId('high'),
      ReasoningEffortId('xhigh'),
      ReasoningEffortId('max'),
    ])
    // A catalog model without reasoning is the same case as a hand-declared
    // one: pi-ai reports the single level `off`, which translates to omitting
    // the reasoning option — exactly what naming no effort already does. The
    // capability is reported unavailable rather than offering that control.
    expect((await ctx.llm.resolveModelInfo('openai', 'gpt-4.1')).reasoning).toBeUndefined()
  })

  it('uses a supported profile reasoning value as the model default and rejects an unsupported one', async () => {
    const supported = new Context()
    await supported.plugin(LlmRuntime)
    await supported.plugin(LlmPiAi, {
      providers: { deepseek: { reasoning: 'max' } },
    })
    await expect(supported.llm.resolveModelInfo('deepseek', 'deepseek-v4-flash'))
      .resolves.toMatchObject({ reasoning: { defaultEffort: ReasoningEffortId('max') } })

    // A profile level this model cannot take DESCRIBES as no default rather
    // than failing: resolveModelInfo builds the model catalog, and a catalog
    // that throws takes its whole provider out of every picker — one mis-set
    // field would hide every model on the route, including the ones that do
    // support the level. The request path below is where it is refused.
    const unsupported = new Context()
    await unsupported.plugin(LlmRuntime)
    await unsupported.plugin(LlmPiAi, {
      providers: { deepseek: { reasoning: 'medium' } },
    })
    const described = await unsupported.llm.resolveModelInfo('deepseek', 'deepseek-v4-flash')
    expect(described.reasoning?.defaultEffort).toBeUndefined()
    expect(described.reasoning?.efforts.length).toBeGreaterThan(0)
    await expect(assemble(unsupported, {
      provider: 'deepseek', model: 'deepseek-v4-flash', messages: [],
    })).resolves.toMatchObject({
      finish: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } },
    })

    const disabled = new Context()
    await disabled.plugin(LlmRuntime)
    await disabled.plugin(LlmPiAi, {
      providers: { deepseek: { reasoning: 'off' } },
    })
    await expect(disabled.llm.resolveModelInfo('deepseek', 'deepseek-v4-flash'))
      .resolves.toMatchObject({ reasoning: { defaultEffort: ReasoningEffortId('off') } })
  })

  it('serves declared reasoning efforts to selectors and honours the profile default', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: 'https://acme.test/v1',
          reasoning: 'high',
          models: [{
            id: 'acme-think',
            contextWindow: 65_536,
            maxTokens: 4096,
            reasoningEfforts: { off: null, low: 'low', high: 'high' },
          }],
        },
      },
    })

    // Declared levels reach the same seam catalog metadata does, so the
    // effort picker works for a model pi-ai has never heard of.
    await expect(ctx.llm.resolveModelInfo('acme-gateway', 'acme-think')).resolves.toMatchObject({
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('off'), name: 'Off' },
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    })
  })

  it('sends the declared wire spelling and refuses undeclared levels before network I/O', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          models: [{
            id: 'acme-think',
            contextWindow: 65_536,
            maxTokens: 4096,
            reasoningEfforts: { off: null, high: 'ultra' },
          }],
        },
      },
    })

    await assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-think',
      reasoningEffort: ReasoningEffortId('high'),
      messages: [],
    })
    // The declared value, not the canonical level name, goes on the wire.
    expect(server.requests[0]).toMatchObject({ reasoning_effort: 'ultra' })

    const undeclared = await assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-think',
      reasoningEffort: ReasoningEffortId('max'),
      messages: [],
    })
    expect(undeclared.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'UNSUPPORTED_REASONING_EFFORT' },
    })
    expect(server.requests).toHaveLength(1)
  })

  it('dispatches the compat-switched dialect on a declared route', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          // Without the switch pi-ai guesses the dialect from the endpoint
          // URL, and a private gateway's URL says nothing.
          compat: { thinkingFormat: 'deepseek' },
          models: [{
            id: 'acme-think',
            contextWindow: 65_536,
            maxTokens: 4096,
            reasoningEfforts: { off: null, high: 'high' },
          }],
        },
      },
    })
    const prompt = (effort: string): Promise<unknown> => assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-think',
      reasoningEffort: ReasoningEffortId(effort),
      messages: [],
    })

    await prompt('high')
    expect(server.requests[0]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })

    await prompt('off')
    expect(server.requests[1]).toMatchObject({ thinking: { type: 'disabled' } })
    expect(server.requests[1]).not.toHaveProperty('reasoning_effort')
  })

  it('sends a declared off value as the effort parameter instead of omitting it', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          models: [{
            id: 'acme-think',
            contextWindow: 65_536,
            maxTokens: 4096,
            reasoningEfforts: { off: 'none', high: 'high' },
          }],
        },
      },
    })

    // The adapter strips a selected Off to "no reasoning option", and pi-ai's
    // dispatch reads thinkingLevelMap.off exactly then — so the declared value
    // still reaches the wire, which is the README's promise for `off: none`.
    await assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-think',
      reasoningEffort: ReasoningEffortId('off'),
      messages: [],
    })
    expect(server.requests[0]).toMatchObject({ reasoning_effort: 'none' })
  })

  it('holds back reasoning_effort when the endpoint cannot take it', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          compat: { supportsReasoningEffort: false },
          models: [{
            id: 'acme-think',
            contextWindow: 65_536,
            maxTokens: 4096,
            reasoningEfforts: { off: null, high: 'high' },
          }],
        },
      },
    })

    await assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-think',
      reasoningEffort: ReasoningEffortId('high'),
      messages: [],
    })
    expect(server.requests[0]).not.toHaveProperty('reasoning_effort')
  })

  it('accepts absent credentials for pi-ai ambient authentication', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'ambient-key')
    const server = await mockServer([{ events: textEvents }])
    // A profile that names no reference at all is the one case that defers to
    // pi-ai's own provider-native discovery.
    const ctx = await harness(server.url, { apiKeyEnv: undefined })
    await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer ambient-key')
  })

  it('falls back to the ambient environment for apiKeyEnv without the credentials seam', async () => {
    vi.stubEnv('PI_CUSTOM_REF_KEY', 'custom-ref-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, { apiKey: undefined, apiKeyEnv: 'PI_CUSTOM_REF_KEY' })
    await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer custom-ref-key')
  })

  it('fails a named-but-missing apiKeyEnv instead of using another ambient key', async () => {
    // The exact confusion this guards: the named reference is empty while an
    // unrelated provider key sits in the environment. Deferring to pi-ai's own
    // discovery here would authenticate as another tenant.
    vi.stubEnv('PI_CUSTOM_REF_KEY', '')
    vi.stubEnv('DEEPSEEK_API_KEY', 'ambient-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, { apiKey: undefined, apiKeyEnv: 'PI_CUSTOM_REF_KEY' })
    const first = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(first.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    const second = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(second.finish.kind).toBe('error')
    if (second.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(second.finish.failure.message).toMatch(/provider route "deepseek".*PI_CUSTOM_REF_KEY/s)
    expect(server.requests).toHaveLength(0)
  })

  it('validates empty, underspecified, legacy-shaped, and explicitly blank profiles', () => {
    // Empty and omitted dicts are the dormant zero-route posture, not errors.
    expect(resolveProfiles({}).size).toBe(0)
    expect(resolveProfiles(undefined).size).toBe(0)
    expect(() => resolveProfiles({ '': {} })).toThrow(/non-empty/)
    // A route the installed catalog does not ship and that lists no models
    // serves whatever a request names, so it needs no catalog — but it has no
    // defaults to fall back on either, so it must say how to reach the
    // endpoint, and both halves are named while the key can still be pointed at.
    expect(() => resolveProfiles({ 'not-real': {} })).toThrow(/set the route's api/)
    expect(() => resolveProfiles({ 'not-real': { api: 'openai-completions' } }))
      .toThrow(/set the route's baseURL/)
    // And it must size them, since one number sizes every model it serves.
    expect(() => resolveProfiles({ 'not-real': { api: 'openai-completions', baseURL: 'https://x.test/v1' } }))
      .toThrow(/sized by defaultContextWindow/)
    // The pre-release array shape and its per-profile provider field fail
    // loud with migration directions instead of half-working.
    expect(() => resolveProfiles([{ provider: 'openai' }] as never)).toThrow(/dict keyed by provider/)
    expect(() => resolveProfiles({ openai: { provider: 'openai' } as never })).toThrow(/moved to the providers dict key/)
    expect(() => resolveProfiles({ openai: { baseURL: '' } })).toThrow(/empty baseURL/)
    expect(() => resolveProfiles({ openai: { apiKeyEnv: 'not-a-var!' } })).toThrow(/must match/)
  })

  it.each(['maxRetries', 'maxRetryDelayMs'] as const)(
    'rejects removed profile field %s instead of silently restoring hidden SDK retries',
    async (field) => {
      const legacy = { [field]: 2 }
      expect(() => resolveProfiles({ openai: legacy })).toThrow(/removed.*agent recovery/i)
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await expect(ctx.plugin(LlmPiAi, { providers: { openai: legacy } }))
        .rejects.toThrow(/removed.*agent recovery/i)
    },
  )

  it('rejects invalid stream tunables at plugin load', async () => {
    const invalid = [
      { timeoutMs: -1 },
      { websocketConnectTimeoutMs: -1 },
      { streamIdleTimeoutMs: 0 },
      { streamIdleTimeoutMs: Number.NaN },
      { streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 },
    ]
    for (const entry of invalid) {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await expect(ctx.plugin(LlmPiAi, { providers: { openai: { ...entry } } }))
        .rejects.toThrow()
    }
  })

  it('rejects invalid nested retryPolicy at the provider-profile boundary', async () => {
    expect(() => resolveProfiles({
      openai: { retryPolicy: { mode: 'always', backoff: { jitterRatio: -1 } } },
    })).toThrow(/retryPolicy\.backoff\.jitterRatio/)

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmPiAi, {
      providers: { openai: { retryPolicy: { mode: 'normal', maxRetries: -1 } } },
    })).rejects.toThrow(/retryPolicy/)
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('constructs the adapter directly and rejects routes it does not own', async () => {
    const adapter = adapterOf({ openai: {} })
    await expect(adapter.listModels('anthropic')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    await expect(adapter.resolveModel('anthropic', 'claude-sonnet-4'))
      .rejects.toMatchObject({ code: 'NO_ADAPTER' })
    await expect(adapter.resolveModel('openai', 'not-a-catalog-model'))
      .rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    await expect((async () => {
      for await (const _chunk of adapter.stream({ provider: 'anthropic', model: 'claude-sonnet-4', messages: [] })) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect(new LlmError('x', 'X')).toBeInstanceOf(Error)
  })

  it('rejects unsupported or unresolved image input before provider I/O', async () => {
    const adapter = adapterOf({ openai: {}, deepseek: {} })
    const drain = async (options: Parameters<PiAiAdapter['stream']>[0]): Promise<void> => {
      for await (const _chunk of adapter.stream(options)) { /* drain */ }
    }

    await expect(drain({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: IMAGE_REF }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(drain({
      provider: 'openai',
      model: 'gpt-4.1',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: IMAGE_REF }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(drain({
      provider: 'openai',
      model: 'gpt-4.1',
      messages: [createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: 'call-outer' as never,
          content: [{
            type: 'tool-result',
            toolCallId: 'call-inner' as never,
            content: [{ type: 'image', attachment: IMAGE_REF }],
          }],
        }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('validates profiles at the shared resolver boundary', () => {
    expect(() => resolveProfiles({
      openai: { streamIdleTimeoutMs: 0 },
    })).toThrow(/streamIdleTimeoutMs.*positive finite/)
    expect(() => resolveProfiles({
      openai: { streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 },
    })).toThrow(/streamIdleTimeoutMs.*no greater/)
  })
})

describe('abort wiring', () => {
  it('preserves an unknown pre-dispatch adapter Error exactly', async () => {
    const original = new Error('SDK context conversion exploded')
    const message = Object.defineProperty({}, 'content', {
      get() { throw original },
    })
    const adapter = adapterOf({ deepseek: {} })
    const drain = async (): Promise<void> => {
      for await (const _chunk of adapter.stream({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        messages: [message as never],
      })) { /* drain */ }
    }

    await expect(drain()).rejects.toBe(original)
  })

  it('lets a concurrent caller abort classify a pre-dispatch adapter failure', async () => {
    const controller = new AbortController()
    const original = new Error('conversion lost its caller')
    const message = Object.defineProperty({}, 'content', {
      get() {
        controller.abort('caller cancelled during conversion')
        throw original
      },
    })
    const adapter = adapterOf({ deepseek: {} })
    const drain = async (): Promise<void> => {
      for await (const _chunk of adapter.stream({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        messages: [message as never],
        signal: controller.signal,
      })) { /* drain */ }
    }

    await expect(drain()).rejects.toMatchObject({ code: 'ABORTED', cause: original })
  })

  it('resolves catalog endpoints without an override before honoring pre-abort', async () => {
    const adapter = adapterOf({ deepseek: {} })
    const controller = new AbortController()
    controller.abort('already stopped')
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [],
      signal: controller.signal,
    })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
  })

  it('honors a pre-aborted caller signal', async () => {
    const server = await mockServer([{ events: textEvents, delayMs: 20 }])
    const ctx = await harness(server.url)
    const controller = new AbortController()
    controller.abort('already stopped')
    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [], signal: controller.signal })
    expect(result.finish.kind).toBe('aborted')
  })

  it('forwards an abort that arrives while provider streaming is active', async () => {
    const server = await mockServer([{ events: textEvents, delayMs: 30 }])
    const ctx = await harness(server.url)
    const controller = new AbortController()
    const resultPromise = assemble(ctx, {
      model: 'deepseek-v4-flash', messages: [], signal: controller.signal,
    })
    setTimeout(() => { controller.abort('stopped during stream') }, 10)
    const result = await resultPromise
    expect(result.finish.kind).toBe('aborted')
  })

  it('aborts upstream when a consumer stops early', async () => {
    const server = await mockServer([{ events: textEvents, delayMs: 30 }])
    const ctx = await harness(server.url)
    for await (const chunk of ctx.llm.stream({ provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })) {
      if (chunk.type === 'block-start') break
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(server.requests).toHaveLength(1)
  })
})

describe('a gateway route that lists no models', () => {
  /** The shape the hive bundle ships: a route pi-ai never heard of, listing nothing. */
  async function gateway(baseURL: string, overrides: Record<string, unknown> = {}): Promise<Context> {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'hive-proxy': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL,
          defaultContextWindow: 131_072,
          ...overrides,
        },
      },
    })
    return ctx
  }

  it('sends a model id nothing declared to the endpoint verbatim', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await gateway(server.url)
    const result = await assemble(ctx, {
      provider: 'hive-proxy',
      model: 'gpt-6-sol',
      messages: [],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.requests[0]).toMatchObject({ model: 'gpt-6-sol' })
  })

  it('resolves a model id nothing declared, which is the path a turn prepares on', async () => {
    const adapter = adapterOf({
      'hive-proxy': {
        apiKeyEnv: 'PI_TEST_KEY',
        api: 'openai-completions',
        baseURL: 'https://proxy.test/v1',
        defaultContextWindow: 131_072,
      },
    })
    // The agent loop resolves the model before it streams; an adapter that only
    // materialized inside `stream` would refuse every turn while the streaming
    // test above still passed.
    await expect(adapter.resolveModel('hive-proxy', 'qwen35-131k')).resolves.toMatchObject({
      provider: 'hive-proxy',
      id: 'qwen35-131k',
      name: 'qwen35-131k',
    })
  })

  it('carries the endpoint\'s own refusal of a model it does not host', async () => {
    const server = await mockServer([{
      status: 404,
      body: JSON.stringify({ error: { message: "Model 'nope' is not registered", code: 'UNKNOWN_MODEL' } }),
    }])
    const ctx = await gateway(server.url)
    const result = await assemble(ctx, { provider: 'hive-proxy', model: 'nope', messages: [] })
    expect(result.finish.kind).toBe('error')
    // Which models exist is the endpoint's answer, so the endpoint's words are
    // what reaches the operator — a local refusal would name a model the
    // credential may well be able to address.
    expect(JSON.stringify(result.finish)).toContain("Model 'nope' is not registered")
    expect(server.requests[0]).toMatchObject({ model: 'nope' })
  })

  it('sends a reasoning effort for a model id nothing declared', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await gateway(server.url)
    const result = await assemble(ctx, {
      provider: 'hive-proxy',
      model: 'gpt-6-sol',
      messages: [],
      reasoningEffort: ReasoningEffortId('high'),
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.requests[0]).toMatchObject({ model: 'gpt-6-sol', reasoning_effort: 'high' })
  })
})

describe('an endpoint that will not take the images a turn carries', () => {
  /** What the hive inference proxy answers a text-only model with, verbatim. */
  const PROXY_REFUSAL_TEXT = 'this model does not support image input (ref: 4324a6e9-a191-4bc3-b1af-8ce03a8b8323)'

  /** That refusal in the error envelope an OpenAI-compatible endpoint returns. */
  const REFUSAL_BODY = JSON.stringify({
    error: { message: PROXY_REFUSAL_TEXT, type: 'invalid_request_error' },
  })

  const attachments = {
    readImage: () => Promise.resolve({ ref: IMAGE_REF, data: Uint8Array.of(1) }),
  } as unknown as AttachmentStore

  /** The route a hive mind declares: a gateway serving models it does not list. */
  const openRoute = (
    baseURL: string,
    overrides: Partial<LlmPiAi.PiAiProviderProfile> = {},
  ): Record<string, LlmPiAi.PiAiProviderProfile> => ({
    'hive-proxy': {
      api: 'openai-completions',
      apiKeyEnv: 'PI_TEST_KEY',
      baseURL,
      models: [],
      defaultInput: ['text', 'image'],
      defaultContextWindow: 128_000,
      ...overrides,
    },
  })

  interface OpenRoute {
    adapter: PiAiAdapter
    /** Replace the configuration, as a settings edit does. */
    reconfigure: (next: Record<string, LlmPiAi.PiAiProviderProfile>) => void
    keyResolutions: () => number
    profileResolutions: () => number
    /** Arrange for a settings edit to land right after the route is resolved. */
    reconfigureAfterFirstResolution: (next: Record<string, LlmPiAi.PiAiProviderProfile>) => void
  }

  /**
   * An adapter over an open route, memoizing `profiles` the way the plugin
   * does — the identity of that map is what the adapter reads as "unchanged
   * configuration", so a helper rebuilding it per call would be testing an
   * adapter that is reconfigured on every operation.
   */
  function openRouteAdapter(
    baseURL: string,
    overrides: Partial<LlmPiAi.PiAiProviderProfile> = {},
  ): OpenRoute {
    let raw = openRoute(baseURL, overrides)
    let memoized = resolveProfiles(raw)
    let keyResolutions = 0
    let profileResolutions = 0
    let swapAfterFirstResolution: Record<string, LlmPiAi.PiAiProviderProfile> | undefined
    const adapter = new PiAiAdapter({
      profiles: () => {
        profileResolutions += 1
        const current = memoized
        if (swapAfterFirstResolution !== undefined) {
          // A settings edit landing the instant after this call resolved its
          // route: a second resolution would see it, a frozen one cannot.
          raw = swapAfterFirstResolution
          memoized = resolveProfiles(raw)
          swapAfterFirstResolution = undefined
        }
        return current
      },
      resolveApiKey: () => {
        keyResolutions += 1
        return Promise.resolve('test-key')
      },
      resolveAttachments: () => attachments,
    })
    return {
      adapter,
      reconfigure: (next) => {
        raw = next
        memoized = resolveProfiles(raw)
      },
      keyResolutions: () => keyResolutions,
      profileResolutions: () => profileResolutions,
      reconfigureAfterFirstResolution: (next) => { swapAfterFirstResolution = next },
    }
  }

  /** A turn whose history holds a screenshot a tool read, beside its envelope. */
  function turnCarryingAScreenshot(): GenerateOptions['messages'] {
    return [createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: CallId('call-read-image'),
        content: [
          { type: 'text', text: '<path>/tmp/nav_issue.png</path>\nimage/png image, 1400x1000 px, 79117 bytes' },
          { type: 'image', attachment: IMAGE_REF },
        ],
      }],
      source: { kind: 'plugin', plugin: 'test' },
    })]
  }

  async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
  }

  const textOf = (chunks: StreamChunk[]): string => chunks
    .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
    .map(chunk => chunk.text)
    .join('')

  const failureOf = (chunks: StreamChunk[]): LlmFailure | undefined => {
    const finish = chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
    return finish?.reason.kind === 'error' ? finish.reason.failure : undefined
  }

  /** Images on the wire: this API carries each as an `image_url` part. */
  const imagesIn = (body: unknown): number =>
    JSON.stringify(body).split('"type":"image_url"').length - 1

  it('sends the turn again without its images and completes', async () => {
    const server = await mockServer([
      { status: 400, body: REFUSAL_BODY },
      { events: textEvents },
    ])
    const { adapter } = openRouteAdapter(server.url)

    const chunks = await collect(adapter.stream({
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      messages: turnCarryingAScreenshot(),
    }))

    expect(textOf(chunks)).toBe('hello')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(server.requests).toHaveLength(2)
    expect(imagesIn(server.requests[0])).toBe(1)
    expect(imagesIn(server.requests[1])).toBe(0)
  })

  it('keeps the text that sat beside the image it stripped', async () => {
    const server = await mockServer([
      { status: 400, body: REFUSAL_BODY },
      { events: textEvents },
    ])
    const { adapter } = openRouteAdapter(server.url)

    await collect(adapter.stream({
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      messages: turnCarryingAScreenshot(),
    }))

    expect(JSON.stringify(server.requests[1])).toContain('1400x1000 px, 79117 bytes')
    expect(imagesIn(server.requests[1])).toBe(0)
  })

  it('stops sending images to a model that has refused them once', async () => {
    const server = await mockServer([
      { status: 400, body: REFUSAL_BODY },
      { events: textEvents },
      { events: textEvents },
    ])
    const { adapter } = openRouteAdapter(server.url)
    const turn = {
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      messages: turnCarryingAScreenshot(),
    }

    await collect(adapter.stream(turn))
    const second = await collect(adapter.stream(turn))

    expect(textOf(second)).toBe('hello')
    // The second turn costs one request, not another refusal and retry.
    expect(server.requests).toHaveLength(3)
    expect(imagesIn(server.requests[2])).toBe(0)
  })

  it('reports no image modality for a model that has refused images', async () => {
    const server = await mockServer([
      { status: 400, body: REFUSAL_BODY },
      { events: textEvents },
    ])
    const { adapter } = openRouteAdapter(server.url)

    const before = await adapter.resolveModel('hive-proxy', 'gpt-oss:120b-cloud')
    expect(before.inputModalities).toContain('image')

    await collect(adapter.stream({
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      messages: turnCarryingAScreenshot(),
    }))

    const after = await adapter.resolveModel('hive-proxy', 'gpt-oss:120b-cloud')
    expect(after.inputModalities).not.toContain('image')
    expect(after.inputModalities).toContain('text')
  })

  it('surfaces the original refusal when the retry fails too', async () => {
    const server = await mockServer([
      { status: 400, body: REFUSAL_BODY },
      { status: 500, body: JSON.stringify({ error: { message: 'upstream exploded' } }) },
    ])
    const { adapter } = openRouteAdapter(server.url)

    const chunks = await collect(adapter.stream({
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      messages: turnCarryingAScreenshot(),
    }))

    const failure = failureOf(chunks)
    expect(failure?.message).toContain('does not support image input')
    expect(failure?.message).toContain('upstream exploded')
  })

  it('does not retry a refusal that arrives after part of the answer', async () => {
    const server = await mockServer([{
      events: [
        '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
        '{"choices":[{"delta":{"content":"partial"},"index":0,"finish_reason":null}]}',
        `{"error":{"message":${JSON.stringify(PROXY_REFUSAL_TEXT)}}}`,
        '[DONE]',
      ],
    }])
    const { adapter } = openRouteAdapter(server.url)

    const chunks = await collect(adapter.stream({
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      messages: turnCarryingAScreenshot(),
    }))

    expect(textOf(chunks)).toContain('partial')
    expect(server.requests).toHaveLength(1)
  })

  it('leaves a body in a tool result the strip would have emptied', async () => {
    const server = await mockServer([
      { status: 400, body: REFUSAL_BODY },
      { events: textEvents },
    ])
    const { adapter } = openRouteAdapter(server.url)

    const chunks = await collect(adapter.stream({
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      messages: [createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-image-only'),
          content: [{ type: 'image', attachment: IMAGE_REF }],
        }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))

    expect(textOf(chunks)).toBe('hello')
    expect(imagesIn(server.requests[1])).toBe(0)
    expect(JSON.stringify(server.requests[1])).toContain(IMAGE_OMITTED_TEXT)
  })

  it('learns nothing from a refusal whose stripped retry also failed', async () => {
    // The detector cannot always tell a capability refusal from a complaint
    // about one picture. A retry that answers is the evidence; a retry that
    // fails is not, and must leave a vision model's eyes alone.
    const server = await mockServer([
      { status: 400, body: REFUSAL_BODY },
      { status: 500, body: JSON.stringify({ error: { message: 'upstream exploded' } }) },
      { events: textEvents },
    ])
    const { adapter } = openRouteAdapter(server.url)
    const turn = {
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      messages: turnCarryingAScreenshot(),
    }

    await collect(adapter.stream(turn))

    expect((await adapter.resolveModel('hive-proxy', 'gpt-oss:120b-cloud')).inputModalities)
      .toContain('image')
    // The next turn still sends its images, rather than dropping them on a
    // conclusion that was never reached.
    await collect(adapter.stream(turn))
    expect(imagesIn(server.requests[2])).toBe(1)
  })

  it('keeps the retry failure own code so the turn can still be retried or compacted', async () => {
    // A transport drop squashed into the refusal's INVALID_REQUEST stops being
    // retryable, and a context overflow so squashed stops being compactable —
    // each reported as a problem with images.
    const server = await mockServer([
      { status: 400, body: REFUSAL_BODY },
      { status: 503, body: JSON.stringify({ error: { message: 'upstream unavailable' } }) },
    ])
    const { adapter } = openRouteAdapter(server.url)

    const failure = failureOf(await collect(adapter.stream({
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      messages: turnCarryingAScreenshot(),
    })))

    expect(failure?.code).toBe('SERVER')
    expect(failure?.message).toContain('does not support image input')
    expect(failure?.message).toContain('upstream unavailable')
  })

  it('still names the refusal when the retry throws instead of finishing', async () => {
    // Not every failure arrives as a terminal chunk: a connection that closes
    // without a terminal event throws, and so do an idle timeout and a
    // credential that stops resolving. The caller is left with a second
    // failure and no account of why the turn was sent twice.
    const server = await mockServer([
      { status: 400, body: REFUSAL_BODY },
      // The retry's connection goes quiet mid-stream; the idle watchdog throws.
      { events: textEvents, delayMs: 400 },
    ])
    const { adapter } = openRouteAdapter(server.url, { streamIdleTimeoutMs: 50 })

    await expect(collect(adapter.stream({
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      messages: turnCarryingAScreenshot(),
    }))).rejects.toMatchObject({
      message: expect.stringContaining('does not support image input') as unknown as string,
      code: 'TIMEOUT',
    })
    expect(server.requests).toHaveLength(2)
  })

  it('forgets a learned refusal when the configuration is replaced', async () => {
    // In a long-lived service the process is the durable record. A route
    // repointed at a different deployment, or corrected, must not stay blinded
    // by what the old one said.
    const server = await mockServer([
      { status: 400, body: REFUSAL_BODY },
      { events: textEvents },
    ])
    const route = openRouteAdapter(server.url)

    await collect(route.adapter.stream({
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      messages: turnCarryingAScreenshot(),
    }))
    expect((await route.adapter.resolveModel('hive-proxy', 'gpt-oss:120b-cloud')).inputModalities)
      .not.toContain('image')

    route.reconfigure(openRoute(server.url))

    expect((await route.adapter.resolveModel('hive-proxy', 'gpt-oss:120b-cloud')).inputModalities)
      .toContain('image')
  })

  it('leaves a body in a user message the strip would have emptied', async () => {
    // A screenshot pasted with no caption is the whole message. Stripped to
    // nothing it becomes an empty user turn, which endpoints drop or refuse —
    // the same dead conversation, arriving a second time.
    const server = await mockServer([
      { status: 400, body: REFUSAL_BODY },
      { events: textEvents },
    ])
    const { adapter } = openRouteAdapter(server.url)

    const chunks = await collect(adapter.stream({
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: IMAGE_REF }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))

    expect(textOf(chunks)).toBe('hello')
    expect(imagesIn(server.requests[1])).toBe(0)
    expect(JSON.stringify(server.requests[1])).toContain(IMAGE_OMITTED_TEXT)
  })

  it('resolves the route and its credential once however many attempts it takes', async () => {
    // Both attempts belong to one request: a second resolution can pick up a
    // half-applied settings edit, reach a different endpoint, or pay an
    // interactive credential prompt twice.
    const server = await mockServer([
      { status: 400, body: REFUSAL_BODY },
      { events: textEvents },
    ])
    const route = openRouteAdapter(server.url)

    await collect(route.adapter.stream({
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      messages: turnCarryingAScreenshot(),
    }))

    expect(server.requests).toHaveLength(2)
    expect(route.keyResolutions()).toBe(1)
  })

  it('blinds only the model that refused, not every model on the route', async () => {
    // A gateway route serves many models. Keying the learned fact by route
    // alone would let one text-only model's refusal take the eyes off every
    // vision model behind the same endpoint.
    const server = await mockServer([
      { status: 400, body: REFUSAL_BODY },
      { events: textEvents },
    ])
    const { adapter } = openRouteAdapter(server.url)

    await collect(adapter.stream({
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      messages: turnCarryingAScreenshot(),
    }))

    expect((await adapter.resolveModel('hive-proxy', 'gpt-oss:120b-cloud')).inputModalities)
      .not.toContain('image')
    expect((await adapter.resolveModel('hive-proxy', 'qwen3-vl:32b')).inputModalities)
      .toContain('image')
  })

  it('places the note only where the strip left nothing', async () => {
    // The note stands in for a body the strip emptied. Attaching one wherever
    // an image was would make it a running commentary on a transcript, and
    // would make the guard it exists for dead code.
    const server = await mockServer([
      { status: 400, body: REFUSAL_BODY },
      { events: textEvents },
    ])
    const { adapter } = openRouteAdapter(server.url)

    await collect(adapter.stream({
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      // This tool result keeps its envelope, so nothing was emptied.
      messages: turnCarryingAScreenshot(),
    }))

    expect(imagesIn(server.requests[1])).toBe(0)
    expect(JSON.stringify(server.requests[1])).not.toContain(IMAGE_OMITTED_TEXT)
  })

  it('sends the retry to the endpoint the call started on', async () => {
    // Both attempts belong to one request. A settings edit landing in the gap
    // must not move the second attempt onto a different endpoint, credential
    // or model descriptor than the first.
    const first = await mockServer([
      { status: 400, body: REFUSAL_BODY },
      { events: textEvents },
    ])
    const second = await mockServer([{ events: textEvents }])
    const route = openRouteAdapter(first.url)
    route.reconfigureAfterFirstResolution(openRoute(second.url))

    // The edit lands after this call resolved `first`. Its retry belongs to
    // the same request and must stay on the endpoint it started on.
    await collect(route.adapter.stream({
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      messages: turnCarryingAScreenshot(),
    }))

    expect(first.requests).toHaveLength(2)
    expect(second.requests).toHaveLength(0)
    expect(route.profileResolutions()).toBe(1)
  })

  it('still reports tokens a refused attempt really cost', async () => {
    // An endpoint that reads the prompt and then refuses has billed for it.
    // Dropping that reading with the attempt bills the caller nothing for
    // work that was paid for.
    const server = await mockServer([
      {
        events: [
          '{"choices":[{"delta":{},"index":0,"finish_reason":null}],"usage":{"prompt_tokens":120,"completion_tokens":0}}',
          `{"error":{"message":${JSON.stringify(PROXY_REFUSAL_TEXT)}}}`,
          '[DONE]',
        ],
      },
      { events: textEvents },
    ])
    const { adapter } = openRouteAdapter(server.url)

    const chunks = await collect(adapter.stream({
      provider: 'hive-proxy',
      model: 'gpt-oss:120b-cloud',
      messages: turnCarryingAScreenshot(),
    }))

    expect(textOf(chunks)).toBe('hello')
    const inputTokens = chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'usage' }> => chunk.type === 'usage')
      .map(chunk => chunk.usage.inputTokens)
    expect(inputTokens).toContain(120)
  })

  it('strips nothing for a 400 that is not the model refusing an image', async () => {
    // Each of these carries one half of a capability refusal and not the
    // other: a refusal of something that is not an image, and an image
    // complaint that is not a refusal. Acting on half would strip the images
    // out of a turn whose images were never the problem.
    const notAnImageRefusal = 'this model does not support tool use'
    const notARefusal = 'image attachment exceeds the 20 MB limit'
    for (const message of [notAnImageRefusal, notARefusal]) {
      const server = await mockServer([{ status: 400, body: JSON.stringify({ error: { message } }) }])
      const { adapter } = openRouteAdapter(server.url)

      const chunks = await collect(adapter.stream({
        provider: 'hive-proxy',
        model: 'gpt-oss:120b-cloud',
        messages: turnCarryingAScreenshot(),
      }))

      expect(failureOf(chunks)?.message).toContain(message)
      expect(server.requests).toHaveLength(1)
      expect(imagesIn(server.requests[0])).toBe(1)
    }
  })
})

describe('reading an endpoint refusal as a statement about the model', () => {
  // Wordings real endpoints return. The ones below the divider are complaints
  // about one picture, not about the model: acting on them strips images that
  // were fine and, worse, teaches this process that a model with eyes has none.
  it('tells a capability refusal from a complaint about one image', () => {
    const saysTheModelTakesNoImages = [
      'this model does not support image input (ref: 4324a6e9)',
      '400: {"message":"this model does not support image input","type":"invalid_request_error"}',
      'Invalid content type. image_url is only supported by certain models.',
      'No endpoints found that support image input',
      'Multi-modal inputs are not supported for this model',
      'Model qwen3 is not multimodal',
      'Invalid model for image input',
      "model 'qwen3:32b' has no vision capability",
      'this model cannot accept images',
      'image input is not supported',
    ]
    const saysSomethingElse = [
      "You uploaded an unsupported image. Please make sure your image has one of the following formats: ['png','jpeg','gif','webp']",
      'unsupported image format: image/avif',
      'Could not process image: unsupported media type image/gif',
      'image/png: Unsupported MIME type',
      'The image you provided is not supported by this endpoint; use JPEG or PNG',
      'unsupported image dimensions: 12000x12000',
      'image resolution not supported; max 2048x2048',
      'tool_choice is not supported with images',
      'Your image was rejected: NSFW content is not supported',
      'content filter does not allow this image',
      'this endpoint does not accept more than 1 image per request',
      "unsupported value for 'image_url.detail'",
      // A vision model named in the message, refusing something that is not an image.
      'registry.ollama.ai/library/llama3.2-vision:11b does not support tools',
      'model gpt-4-vision-preview does not support tool use',
      'image attachment exceeds the 20 MB limit',
      'this model does not support tool use',
      'temperature must be between 0 and 2',
      // Each of these says a refusal about images in so many words, and is
      // still a complaint about one picture. Without the exclusions they read
      // as the model having no eyes, and a vision model loses them for good.
      // A media type this does not otherwise name: only the type itself says
      // this is about one picture.
      'images are not supported in image/x-icon',
      'images are not supported above 2048x2048',
      'images are not supported in this format',
      'images are not supported beyond the 20 MB maximum',
      'images are not supported by the content filter',
      'images are not supported more than 4 per request',
    ]

    expect(saysTheModelTakesNoImages.filter(text => !isImageInputRefusal(text))).toEqual([])
    expect(saysSomethingElse.filter(text => isImageInputRefusal(text))).toEqual([])
  })
})

describe('what counts as part of an answer already delivered', () => {
  it('does not count a block that has been opened but not written to', () => {
    // The anthropic wire opens a text block from `content_block_start` with an
    // empty string, before a single character exists. Counting that as
    // delivery forfeits the image recovery on every anthropic route: the
    // refusal arrives after the opened block and is never read.
    expect(carriesContent({ type: 'block-start', index: 0, blockType: 'text' })).toBe(false)
    expect(carriesContent({ type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } })).toBe(false)
    expect(carriesContent({ type: 'finish', reason: { kind: 'stop' } })).toBe(false)

    // An endpoint that opens with an empty delta and then refuses has begun
    // nothing: the same event as an opened block, under another name.
    expect(carriesContent({ type: 'text-delta', index: 0, text: '' })).toBe(false)
    expect(carriesContent({ type: 'reasoning-delta', index: 0, text: '' })).toBe(false)

    expect(carriesContent({ type: 'text-delta', index: 0, text: 'a' })).toBe(true)
    expect(carriesContent({ type: 'reasoning-delta', index: 0, text: 'a' })).toBe(true)
    expect(carriesContent({
      type: 'tool-call-delta',
      index: 0,
      id: CallId('call-1'),
      argumentsDelta: '{',
    })).toBe(true)
    expect(carriesContent({
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'a' },
    })).toBe(true)
  })
})
