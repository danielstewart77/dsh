/**
 * Shared scaffolding for the runner suites: a real session store and agent
 * registry with a scripted agent, so a spec exercises the runner's own control
 * flow rather than a mock of it.
 */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'

import { apply, internals } from '../src/index.ts'
import type { Config, TurnReport } from '../src/index.ts'

/** What the scripted agent appends when a task arrives. */
export type Script = (session: Session, message: UserMessage, turn: number) => void

/** One completed turn with a final answer and one successful tool call. */
export const ordinaryTurn: Script = (session, message, turn) => {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('tool/call', {
    turn, step: 1, callId: `call-${turn}` as never, name: 'write_file', arguments: '{}',
  })
  session.append('tool/result', {
    turn, step: 1, message: { role: 'tool', content: [] } as never,
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `answer ${turn}` }],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/**
 * A tree holding the real session store and agent registry, with a scripted
 * factory that creates under the id it is given and resumes a session the store
 * already holds — which is what the two halves of the hive's invariant are.
 */
export async function bench(script: Script = ordinaryTurn): Promise<{
  ctx: Context
  sessions(): SessionStore
  run(config: Config): Promise<{ code: number; report: TurnReport; err: string }>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })

  let turn = 0
  const live: AgentHandle[] = []
  const attach = async (
    ownerCtx: Context,
    session: Session,
    options: { agentOptions?: unknown; setup?: (c: Context) => unknown },
  ): Promise<AgentHandle> => {
    let idle = Promise.resolve()
    const agent = {} as Agent
    const agentCtx = ownerCtx.extend({ agent })
    Object.assign(agent, {
      id: session.id,
      options: options.agentOptions ?? {},
      session,
      inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle',
      ctx: agentCtx,
      cancel: () => {},
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {},
      followup: (message: UserMessage) => {
        turn += 1
        const mine = turn
        agent.inbox.append('next-turn', message)
        idle = Promise.resolve().then(() => { script(session, message, mine) })
      },
      steer: () => {},
      inject: () => {},
      whenIdle: () => idle,
    } satisfies Partial<Agent>)
    await options.setup?.(agentCtx)
    const unregister = ctx.agents.register(agent)
    // Disposal unregisters, which is what the end of a real process does: one
    // tree here stands in for the several processes one conversation is run by.
    const handle: AgentHandle = {
      agent,
      dispose: () => { unregister(); return Promise.resolve() },
    }
    live.push(handle)
    return handle
  }

  ctx.agents.setFactory({
    createAgent: (ownerCtx: Context, options: CreateAgentOptions) => attach(
      ownerCtx,
      ctx.sessions.create(options.sessionId, {
        ...options.meta === undefined ? {} : { meta: options.meta },
      }),
      options,
    ),
    resume: (ownerCtx: Context, options: ResumeAgentOptions) => {
      const session = ctx.sessions.get(options.resumeSessionId)
      if (session === undefined) {
        // What the real persistence layer does with an id it cannot load.
        return Promise.reject(new Error(`no persisted session ${options.resumeSessionId}`))
      }
      return attach(ownerCtx, session, options)
    },
  })

  // One provider, swapped per run: `appExit` is declared once on a tree, and
  // re-declaring it would leave the second run awaiting the first run's promise.
  let exited: (code: number) => void = () => {}
  ctx.provide('appExit', (code: number) => { exited(code) })

  return {
    ctx,
    sessions: () => ctx.sessions,
    run: async (config: Config) => {
      let out = ''
      let err = ''
      internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
      internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
      const code = await new Promise<number>((resolve) => {
        exited = resolve
        apply(ctx, config)
      })
      // The process would have ended here, taking its agent with it.
      for (const handle of live.splice(0)) await handle.dispose()
      if (out === '') throw new Error(`no report written; exit ${code}; stderr ${err}`)
      return { code, report: JSON.parse(out) as TurnReport, err }
    },
  }
}

