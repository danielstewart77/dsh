/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * Credentials stay outside that collection. The harness resolves a route's key
 * through its own seam and passes it as the request's `apiKey` option, which
 * pi-ai treats as the highest-priority auth override — so `Models` never holds
 * a credential store and the harness keeps its fail-loud reference semantics.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type {
  Api,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  messagesWithoutImages,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmFailure,
  LlmModelInfo,
  TokenUsage,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import { isImageInputRefusal, toStreamChunks } from './stream.ts'

/** One stream call's frozen route, shared by every attempt it makes. */
interface ResolvedRoute {
  snapshot: PiAiSnapshot
  profile: ResolvedPiAiProviderProfile
  model: Model<Api>
  reasoning: ModelThinkingLevel | undefined
  apiKey: string | undefined
}

/**
 * Whether a chunk carries part of the answer, as opposed to ending or costing it.
 *
 * Exported for the test that pins `block-start`'s absence: the anthropic wire
 * is the only one that opens a block before any content exists, and the unit
 * fixtures cannot speak it.
 */
export function carriesContent(chunk: StreamChunk): boolean {
  // `block-start` is deliberately absent: the anthropic wire opens a text
  // block with an empty string before a single character exists, so treating
  // it as delivery would forfeit the recovery on that route entirely. An
  // empty delta is the same event by another name — an endpoint that opens
  // with `delta.content: ""` and then refuses must not be read as having
  // begun an answer.
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text.length > 0
  return chunk.type === 'tool-call-delta' || chunk.type === 'block-end'
}

/** Whether a usage reading accounts for anything. */
function usageCounted(usage: TokenUsage): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0
    || (usage.cacheReadTokens ?? 0) > 0 || (usage.cacheWriteTokens ?? 0) > 0
}

/** The message of whatever a failed attempt threw. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A retry's own failure, told alongside the refusal that caused the retry.
 *
 * The thrown error's code is kept: it is what decides whether the turn may be
 * retried again or compacted, and substituting the refusal's `INVALID_REQUEST`
 * would disable both remedies on the one turn that needs them.
 */
function retryFailed(refused: LlmFailure, error: unknown): LlmError {
  const code = error instanceof LlmError ? error.code : 'PI_AI_ERROR'
  return new LlmError(
    `${refused.message} (retried without images, which also failed: ${messageOf(error)})`,
    code,
    { cause: error },
  )
}

/**
 * A terminal chunk from a failed retry, carrying the refusal in its text.
 *
 * Only the message is rewritten. The failure's `code`, status and retry-after
 * belong to the attempt that actually failed — a transport drop squashed into
 * the refusal's `INVALID_REQUEST` stops being retryable, and a context
 * overflow so squashed stops being compactable, each reported as a problem
 * with images instead.
 */
function withRefusalNamed(
  chunk: Extract<StreamChunk, { type: 'finish' }>,
  refused: LlmFailure,
): StreamChunk {
  if (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') return chunk
  return {
    ...chunk,
    reason: {
      ...chunk.reason,
      failure: {
        ...chunk.reason.failure,
        message: `${refused.message} (retried without images, which also failed: ${chunk.reason.failure.message})`,
      },
    },
  }
}

/** One route/model pair, as the learned-refusal set keys them. */
function routeKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/**
 * The failure carried by a chunk that is an endpoint refusing image input.
 *
 * pi-ai never throws mid-stream: a failure arrives as a terminal `finish`
 * chunk, so the refusal has to be read off the chunk rather than caught.
 * @param chunk - one chunk from an attempt.
 * @returns the failure when the chunk refuses the request over an image.
 */
function imageRefusalOf(chunk: StreamChunk): LlmFailure | undefined {
  if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') return undefined
  return isImageInputRefusal(chunk.reason.failure.message) ? chunk.reason.failure : undefined
}

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
  /**
   * Descriptors built on demand for ids an open route never listed, keyed by
   * route and id. Held here rather than rebuilt per call so two requests naming
   * one model within a snapshot stream against the same descriptor, and so the
   * cache dies with the configuration that produced it.
   */
  materialized: Map<string, Model<Api>>
}

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined

  /**
   * Route/model pairs this process has seen the endpoint refuse for image
   * input, so each is paid for once rather than once per turn.
   *
   * Process memory, deliberately: the fact belongs to a deployment that can
   * change under us. A model upgraded to vision, or an id repointed at a
   * different deployment, would be refused images for as long as a durable
   * record outlived it, and the cost of being wrong the other way is a single
   * round trip after a restart.
   */
  private readonly imageRefusals = new Set<string>()

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    // A reconfiguration invalidates what the endpoint told us as surely as it
    // invalidates the descriptors: the route may now name a different
    // deployment, or the same one corrected. Without this the only way to
    // un-learn a refusal is to restart the process, and in a long-lived
    // service that memory is as durable as a file.
    this.imageRefusals.clear()
    const models: MutableModels = createModels()
    for (const profile of profiles.values()) models.setProvider(profile.piProvider)
    this.snapshot = { profiles, models, materialized: new Map() }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /**
   * The descriptor for one route/model pair within one snapshot.
   *
   * An **open** route — a gateway, whose profile lists no models because only
   * the gateway knows what it hosts — materializes the id as asked rather than
   * refusing it. Which models exist there is the endpoint's question to answer,
   * in the endpoint's own words; a refusal invented here would name a model the
   * credential can perfectly well address, and would have to be edited into
   * configuration before the gateway's newest deployment could be reached at
   * all. A route that does serve a catalog still refuses what it does not list,
   * because there the catalog is the truth.
   */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    const profile = this.profileOf(snapshot, provider)
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved !== undefined) return resolved
    if (profile.materialize !== undefined) {
      // Reported as the request's own fault, in the adapter's error shape. The
      // builder's refusals are configuration sentences about a models list this
      // route does not have, and they are plain `Error`s, so retry
      // classification and the error surface would both read one as unknown.
      if (model.length === 0) {
        throw new LlmError(`pi-ai provider "${provider}" was asked to stream with no model named`, 'UNKNOWN_MODEL')
      }
      const key = `${provider}\u0000${model}`
      const cached = snapshot.materialized.get(key)
      if (cached !== undefined) return cached
      const built = profile.materialize(model)
      snapshot.materialized.set(key, built)
      return built
    }
    throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
  }

  /**
   * The input modalities a route may actually be sent, which is the
   * descriptor's own set minus anything the endpoint has refused.
   *
   * Published rather than kept private so the refusal reaches the callers
   * that ask before acting — reading an image file off disk is refused with
   * its own clear message instead of attaching a picture this model will
   * never see, and a selector stops offering it.
   */
  private sendableInput(provider: string, model: string, declared: Model<Api>['input']): Model<Api>['input'][number][] {
    const input = [...declared]
    if (!this.imageRefusals.has(routeKey(provider, model))) return input
    return input.filter(modality => modality !== 'image')
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      this.profileOf(snapshot, provider)
      return snapshot.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: this.sendableInput(provider, model.id, model.input),
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      const resolvedModel = this.modelOf(snapshot, provider, model)
      const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
      // Only a cap the deployment configured is a request default; the
      // catalog's `maxTokens` sizes the model and stops there.
      const configuredMaxTokens = profile.configuredMaxTokens.get(model)
      return {
        provider,
        id: model,
        name: resolvedModel.name,
        inputModalities: this.sendableInput(provider, model, resolvedModel.input),
        context: { contextWindow: resolvedModel.contextWindow },
        ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
        ...reasoningInfo(resolvedModel, defaultLevel),
      }
    })
  }

  /**
   * One assistant turn, recovering from an endpoint that will not take the
   * images the turn carries.
   *
   * A conversation outlives the model it started on. An image read under a
   * model with eyes stays in the transcript and is replayed on every later
   * turn, so a switch to a text-only model does not fail one read — it fails
   * every message from then on, permanently, for a picture nobody is asking
   * about any more. The endpoint's refusal is therefore treated as an answer
   * about the model rather than as the turn's verdict: the images come out,
   * the turn goes again, and the route is remembered so the next turn sends
   * none.
   *
   * Only a refusal that arrives before any chunk has reached the caller is
   * recovered. Past that point part of the answer has been delivered, and a
   * second attempt would replay it.
   */
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await and shared by both
    // attempts: the profile, the model descriptor and the collection come from
    // the same immutable snapshot, and the credential freezes with them. A
    // configuration change mid-request builds a separate snapshot, so this
    // request — retry included — finishes under the one it started with, and
    // the credential is resolved once however many attempts it takes.
    const snapshot = this.current()
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const reasoning = resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)
    const apiKey = await this.config.resolveApiKey(options.provider, profile)
    const route: ResolvedRoute = { snapshot, profile, model, reasoning, apiKey }

    const key = routeKey(options.provider, options.model)
    let stripped = this.imageRefusals.has(key)
    let delivered = false
    let refused: LlmFailure | undefined

    for (;;) {
      let refusal: LlmFailure | undefined
      // An attempt reports usage before it reports a refusal. It is held so a
      // zero-token refusal cannot be mistaken for the turn being answered —
      // which would strand the retry — and so a retried turn does not report
      // one request's usage as the whole turn's. It is not discarded: an
      // endpoint that refuses after prefill really did bill those tokens.
      const held: StreamChunk[] = []
      try {
        for await (const chunk of this.streamAttempt(options, route, stripped)) {
          if (!delivered && !stripped) {
            refusal = imageRefusalOf(chunk)
            if (refusal !== undefined) break
          }
          if (!delivered && chunk.type === 'usage') {
            held.push(chunk)
            continue
          }
          if (refused !== undefined && chunk.type === 'finish' && chunk.reason.kind !== 'stop') {
            yield* held.splice(0)
            yield withRefusalNamed(chunk, refused)
            return
          }
          yield* held.splice(0)
          if (carriesContent(chunk)) delivered = true
          yield chunk
        }
      } catch (error: unknown) {
        // A retry that throws rather than finishing still has to say what it
        // was retrying: the refusal is why the turn went again, and losing it
        // leaves only a second failure with no account of the first.
        if (refused === undefined) throw error
        throw retryFailed(refused, error)
      }
      if (refusal === undefined) {
        // A stripped attempt that answered is the evidence that the images
        // were the obstacle. Only then is the route remembered — a refusal
        // about an image's format or size, which the detector cannot always
        // tell apart, otherwise convinces this process that a model with eyes
        // has none, for every later turn and every image read.
        if (refused !== undefined) this.imageRefusals.add(key)
        yield* held.splice(0)
        return
      }
      // Usage the refused attempt really incurred is still the caller's to
      // account for; a zero reading is noise and is dropped with the attempt.
      for (const chunk of held) if (chunk.type === 'usage' && usageCounted(chunk.usage)) yield chunk
      refused = refusal
      stripped = true
    }
  }

  /**
   * One request to the endpoint, carrying exactly the messages it is handed.
   *
   * Separate from {@link stream} so a turn the endpoint refused for naming an
   * image can be sent a second time without it. Each attempt builds its own
   * abort controller and idle watchdog: a retry that inherited the first
   * attempt's would start out already aborted.
   */
  private async * streamAttempt(
    options: GenerateOptions,
    route: ResolvedRoute,
    stripImages: boolean,
  ): AsyncIterable<StreamChunk> {
    const { snapshot, profile, model, reasoning, apiKey } = route

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      // The strip happens here rather than in the caller so that every read of
      // a message's content sits inside the classification below: a conversion
      // that throws while the caller aborts must still be reported as an
      // abort, and a read taken before this try escaped that entirely.
      const messages = stripImages ? messagesWithoutImages(options.messages) : options.messages
      const containsImage = messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const sending = messages === options.messages ? options : { ...options, messages }
      const context = attachments === undefined
        ? toPiContext(sending)
        : await toPiContext(sending, attachments)
      const events = snapshot.models.streamSimple(model, context, {
        ...profileOptions(profile, reasoning, apiKey),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        // Profile headers are deployment-owned; attribution names are
        // Harness-owned and therefore win collisions.
        headers: requestHeaders(profile.headers),
      })
      const iterator = toStreamChunks(events, model.contextWindow)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}
