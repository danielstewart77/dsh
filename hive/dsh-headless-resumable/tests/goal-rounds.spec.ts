/**
 * Driving a task as a goal: the harness, not the model, decides a job is over.
 *
 * A small model ends its turn the moment it feels a natural pause. The round
 * driver turns that stop into the end of a round rather than the end of the
 * job, and these are the behaviours the runner owes that arrangement.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { apply, armGoal, continuing, internals, waitForRound } from '../src/index.ts'
import type { GoalDriving, TurnReport } from '../src/index.ts'
import { resolveGoalRounds, resolveInvocation, UsageError } from '../src/startup.ts'
import { bench } from './support.ts'

/** A goal view shaped like the real service's, for the pure helpers. */
function view(over: Partial<{
  id: string; revision: number; phase: string; objective: string
  maxGoalRounds: number; roundsStarted: number; activation: string
}> = {}) {
  return {
    id: 'goal-1',
    revision: 1,
    phase: 'active',
    objective: 'build the app',
    maxGoalRounds: 10,
    roundsStarted: 0,
    activation: 'armed',
    ...over,
  }
}

/** Records what the runner asked the goal service to do. */
function spyGoals(current?: ReturnType<typeof view>): GoalDriving & { calls: string[] } {
  const calls: string[] = []
  let goal = current
  return {
    calls,
    get: () => goal,
    create: (_agent, request) => {
      calls.push(`create:${request.objective}:${request.maxGoalRounds}`)
      goal = view({ objective: request.objective, maxGoalRounds: request.maxGoalRounds })
      return goal as never
    },
    resume: (_agent, ref) => {
      calls.push(`resume:${ref.id}@${ref.revision}`)
      goal = { ...goal!, phase: 'active', activation: 'armed' }
      return goal as never
    },
    edit: (_agent, ref, request) => {
      calls.push(`edit:${ref.id}@${ref.revision}:${request.maxGoalRounds}`)
      goal = { ...goal!, revision: ref.revision + 1, maxGoalRounds: request.maxGoalRounds }
      return { id: goal.id, revision: goal.revision }
    },
  }
}

/**
 * A stand-in for the real round driver: it opens one further round each time the
 * runner reads goal state, and completes the goal once the given number of
 * rounds has been driven.
 */
function drivingGoals(objective: string, cap: number, completeAfterRounds: number): GoalDriving {
  let goal = view({ objective, maxGoalRounds: cap })
  let agent: { followup(message: unknown): void } | undefined
  return {
    get: (live) => {
      agent = live as never
      if (goal.phase === 'active' && goal.activation === 'armed'
        && goal.roundsStarted < goal.maxGoalRounds) {
        goal = { ...goal, roundsStarted: goal.roundsStarted + 1 }
        if (goal.roundsStarted >= completeAfterRounds) goal = { ...goal, phase: 'complete' }
        agent?.followup(createUserMessage({
          content: [{ type: 'text', text: `<goal_round>${goal.roundsStarted}</goal_round>` }],
          source: { kind: 'user' },
        }))
      }
      return goal
    },
    create: () => goal as never,
    resume: () => goal as never,
    edit: (_a, ref) => ref,
  }
}

describe('a dispatch that asks for goal rounds', () => {
  it('drives further model turns after the model stopped, and counts them', async () => {
    const test = await bench()
    test.ctx.provide('goals', drivingGoals('build the app', 10, 3) as never)

    const { report } = await test.run({
      task: 'build the app', sessionId: 'conv-goal', mode: 'create', goalRounds: 10,
    })

    // One turn for the task, then the driven rounds: the model's own stop after
    // the first turn did not end the process.
    expect(report.turns).toBeGreaterThan(1)
    expect(report.goalPhase).toBe('complete')
    // Every round's tool call is in one tally, which is the measurement.
    expect(report.traffic.emitted).toBe(report.turns)
    await test.ctx.fiber.dispose()
  })

  it('takes exactly one turn when no rounds were asked for', async () => {
    const test = await bench()

    const { report } = await test.run({
      task: 'build the app', sessionId: 'conv-single', mode: 'create',
    })

    expect(report.turns).toBe(1)
    expect(report.goalPhase).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('refuses rounds rather than silently taking one turn when no goal stack is mounted', async () => {
    const test = await bench()

    const { code, report, err } = await test.run({
      task: 'build the app', sessionId: 'conv-nogoal', mode: 'create', goalRounds: 40,
    })

    expect(code).toBe(1)
    expect(report.outcome).toBe('refused')
    expect(report.error?.code).toBe('NO_GOAL_SERVICE')
    expect(report.turns).toBe(0)
    expect(err).toContain('NO_GOAL_SERVICE')
    await test.ctx.fiber.dispose()
  })

  it('reports a goal still active when the cap ran out before the work did', async () => {
    const test = await bench()
    // Completion is never reached: the cap stops it first.
    test.ctx.provide('goals', drivingGoals('build the app', 2, 99) as never)

    const { report } = await test.run({
      task: 'build the app', sessionId: 'conv-capped', mode: 'create', goalRounds: 2,
    })

    expect(report.goalPhase).toBe('active')
    expect(report.turns).toBe(3)
    await test.ctx.fiber.dispose()
  })
})

describe('arming the goal for a dispatch', () => {
  it('creates one from the task when the conversation holds none', () => {
    const goals = spyGoals(undefined)

    armGoal(goals, undefined as never, 'build the app', 40)

    expect(goals.calls).toEqual(['create:build the app:40'])
  })

  it('resumes the conversation\'s own goal rather than replacing it', () => {
    const goals = spyGoals(view({ activation: 'disarmed', roundsStarted: 4 }))

    armGoal(goals, undefined as never, 'carry on', 3)

    expect(goals.calls).toEqual(['resume:goal-1@1'])
  })

  it('raises a spent cap before resuming, so a stale number cannot end the job', () => {
    const goals = spyGoals(view({ activation: 'disarmed', roundsStarted: 10, maxGoalRounds: 10 }))

    armGoal(goals, undefined as never, 'carry on', 5)

    expect(goals.calls).toEqual(['edit:goal-1@1:15', 'resume:goal-1@2'])
  })

  it('replaces a completed goal with a fresh one for the new task', () => {
    const goals = spyGoals(view({ phase: 'complete', activation: 'disarmed', roundsStarted: 7 }))

    armGoal(goals, undefined as never, 'a new job', 6)

    expect(goals.calls).toEqual(['create:a new job:6'])
  })

  it('leaves an already-armed active goal alone', () => {
    const goals = spyGoals(view({ roundsStarted: 2 }))

    armGoal(goals, undefined as never, 'carry on', 3)

    expect(goals.calls).toEqual([])
  })
})

describe('deciding whether another round is owed', () => {
  it('stops at the cap', () => {
    expect(continuing(view({ roundsStarted: 10, maxGoalRounds: 10 }))).toBe(false)
    expect(continuing(view({ roundsStarted: 9, maxGoalRounds: 10 }))).toBe(true)
  })

  it('stops on any phase but active, and on a disarmed goal', () => {
    for (const phase of ['paused', 'blocked', 'complete']) {
      expect(continuing(view({ phase }))).toBe(false)
    }
    expect(continuing(view({ activation: 'disarmed' }))).toBe(false)
    expect(continuing(undefined)).toBe(false)
  })

  it('waits out the driver\'s checkpoint rather than calling the job finished', async () => {
    let reads = 0
    const goals = {
      get: () => (reads++ < 4 ? view({ roundsStarted: 1 }) : view({ roundsStarted: 2 })),
    } as unknown as GoalDriving

    expect(await waitForRound(goals, undefined as never, 1, () => Promise.resolve())).toBe(true)
  })

  it('gives up when the round number never moves', async () => {
    const goals = { get: () => view({ roundsStarted: 1 }) } as unknown as GoalDriving

    expect(await waitForRound(goals, undefined as never, 1, () => Promise.resolve())).toBe(false)
  })
})

describe('the round cap on the command line', () => {
  it('refuses a value that is not a positive whole number', () => {
    for (const bad of ['0', '-3', '2.5', 'many']) {
      expect(() => resolveGoalRounds(bad)).toThrow(UsageError)
    }
  })

  it('is absent from the invocation when the flag was not given', () => {
    const values = resolveInvocation(['build it'], { sessionId: 'abc' })

    expect(values.goalRounds).toBeUndefined()
  })

  it('carries the cap through to the runner when it was', () => {
    const values = resolveInvocation(['build it'], { sessionId: 'abc', goalRounds: '40' })

    expect(values.goalRounds).toBe(40)
  })
})
