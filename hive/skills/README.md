# The build skills

One orchestrator and one skill per step, for running a build on a model that
cannot be trusted to report on itself.

`build-orchestrator` owns the step order, the pass/fail decision and
`build-state.json`. Every other skill here does exactly one step and reports to
it. The orchestrator does not read those reports as evidence: it runs each
step's check command itself and records the exit code, because a model saying
"the tests pass" and a model whose tests pass are different claims and only one
of them is checkable.

A failed check is routed, not retried. `build-step-triage` reads the first
failure and names the fault as the implementation's or the test's, writing that
verdict to `build-triage.json` and editing nothing; the orchestrator sends the
step back to be implemented again, or sends `build-step-repair-test` at the one
test triage named. A repair is counted before and after — fewer tests collected
or one more skip marker fails the step — because the cheapest way to turn a red
suite green is to delete what is asking the question. One cycle per step, then
a person.

The step agents never decide whether to run. The orchestrator reads the state
file before it delegates anything, so a resumed run starts at the first step
that has not passed and a respawn cannot redo finished work.

Human steps — the two read-backs and the review — are real steps, not
decoration. A harness exists to be used with a person. They are delegated only
when `DSH_BUILD_MODE` is `interactive`; anything else records them as `skipped`,
which is how one of these runs goes unattended without pretending a sign-off
happened.

## Installing them on a mind

The harness reads `$DSH_HOME/skills`, not this directory. Copy them in:

```sh
install -d "$DSH_HOME/skills"
cp -r hive/skills/build-* "$DSH_HOME/skills/"
```

Nothing keeps the two sides in step, which is deliberate: a mind being tuned
for one job gets to carry a skill the repo does not.
