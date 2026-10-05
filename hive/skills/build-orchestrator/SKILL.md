---
name: build-orchestrator
description: Build an app from a description by decomposing it into stories and running them against their dependency graph. Use when asked to build, implement, or finish a software project. Owns the graph, the dispatch and the verdicts; does none of the work itself.
---

# Build an app, one story at a time, as many at once as the graph allows

You delegate. You write no code, you write no plan, and you judge nothing.
The two files you write yourself are `build-state.json` and nothing else.

Parameters: the run directory (default: the working directory). Every path
below is relative to it.

## The models

`build-models.json` maps a step name to a model. Pass that model as the `model`
argument of the `subagent` call for that step. A step the file does not name
runs on the default. You never choose a model and you never write that file.

## Your steps

**0. Read state.** `build-state.json`, and `STORIES.md` if it exists. Absent
state means nothing has run. This is the only thing you read to decide
anything — not your memory of the turn, not an agent's report.

**1. Decompose**, if `STORIES.md` does not exist. Delegate
`build-step-decompose`. It writes `STORIES.md`: every story, its prerequisites,
its deliverables.

**2. Plan every story**, if any story has no `stories/<n>/IMPLEMENTATION.md`.
Delegate `build-step-plan`.

**3. Select the wave.** Every story that is not complete and whose
prerequisites are *all* complete. That set is the wave. It is not one story and
it is not the file order — if six stories have no prerequisites, six stories go
out. A wave that comes up empty while stories remain outstanding means the
graph is blocked or a story has stopped: say which stories remain, which are
blocking them, and stop.

Then cut the wave down by **write ownership**, which the graph does not
capture. Two stories with no prerequisite relationship can still write the
same thing, and concurrency is only safe over a resource exactly one agent
writes. Usually that resource is a file — `STORIES.md` declares the files each
story writes — but the rule is the same for a database, a port, a branch, a
lockfile, or `build-state.json`, which is why that one has a named single
writer. So take the wave in story order and admit a story only if nothing
already admitted writes what it writes; a story held back that way is not
blocked and is not a failure, it goes out in the next wave. Say which stories
you held back and what they collided on. If a story's writes are not declared,
read its `IMPLEMENTATION.md` for the files it names and treat that as the
declaration.

**4. Dispatch the wave.** One `subagent` call per story in the wave, all of
them, concurrently. The prompt is exactly:

`Follow the skill named build-agent-story. The working directory is <cwd>. Work story <n>.`

Nothing else goes in the prompt — not the plan, not the review, not the app
description. The folder carries all of it, which is what makes the dispatch the
same whether the story is new or coming back from a review.

**5. Code review.** When a story hands back, delegate `build-step-code-review`
for that story. Every handback, without exception — it is a step on the line,
not a branch off it. The agent's own report of its work is not evidence.

**6. Record the verdict.** After the review returns, look at the story folder
yourself: `stories/<n>/CODE-REVIEW.md` present means the review did not pass;
absent means it did. That file is the verdict, not what either agent said about
it. Write the result into `build-state.json` with the story number, the round,
and the model each delegation ran on.

A story that did not pass goes back out — step 4, same story, same skill, and
the review in its folder is what the agent will read. **Three rounds.** A story
that has failed review three times stops: record it, leave its review in place,
and carry on with the rest of the graph. Its dependents stay blocked; nothing
else does.

When every story is complete, say so and stop.

## The shape of the state file

One JSON object, `{ "stories": [ ... ] }`, each entry `{ "story", "verdict",
"round", "model", "at" }`, verdict `complete`, `in-review`, `rework` or
`stopped`. You are the only writer. An agent that writes it is out of contract.
