# The build skills

One orchestrator and one skill per step, for building an app on a model that
cannot be trusted to report on itself.

The unit of work is a **story**, not a phase. `build-step-decompose` splits an
app description into small, composable, non-overlapping stories in their
correct hierarchy — each naming the stories that gate it and the deliverables
it owes — and `build-step-plan` writes each story's implementation plan against
the real repository.

`build-orchestrator` owns the graph and the verdicts. It dispatches every story
whose prerequisites are complete at once rather than walking a list, hands each
agent nothing but a story number, and reviews every handback.

The artifacts are the interface. An agent opens `stories/<n>/` and the folder
tells it what to do: a `CODE-REVIEW.md` means the code exists and something is
wrong with it, and no `CODE-REVIEW.md` means implement from
`IMPLEMENTATION.md`. That is also why the reviewer must clear a passed review
out of the folder — its presence is an instruction, not a record.

`build-step-code-review` runs on every handback, holds the work to that story's
own deliverables, and reads the code rather than trusting the suite: a function
returning a literal the requirement says to compute passes a test asserting the
shape of its payload, and that is exactly how a run ships nothing. When it
fails it prescribes the fix, which is the feedback that gets a small model from
most of the way there to actually done. Three rounds, then that story stops and
the rest of the graph carries on.

## Installing them on a mind

The harness reads `$DSH_HOME/skills`, not this directory. Copy them in:

```sh
install -d "$DSH_HOME/skills"
cp -r hive/skills/build-* "$DSH_HOME/skills/"
```

Nothing keeps the two sides in step, which is deliberate: a mind being tuned
for one job gets to carry a skill the repo does not.
