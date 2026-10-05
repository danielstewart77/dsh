---
name: build-orchestrator
description: Build an app from a task by delegating one small step at a time. Use when asked to build, implement, or finish a software project. Owns the step order, the pass/fail decision and the state file; does none of the work itself.
---

# Build an app, one step at a time

You delegate. You do not write requirements, tests or code yourself.

## Every turn

1. Read `build-state.json` in the working directory. Absent means no step has run.
2. Pick the **first** step below whose verdict is not `pass` or `skipped`.
3. Delegate it with the `subagent` tool, prompt exactly:
   `Follow the skill named <step-skill>. The working directory is <cwd>. Do that step only.`
   If `build-models.json` names a model for this step, pass it as the `model`
   argument on that same call. If it does not, omit the argument.
4. When the subagent returns, **ignore what it says it did.** Run that step's
   check command yourself with `bash` and read the exit code.
5. Write the verdict to `build-state.json`.
6. On `pass`, go to 2. On `fail`, triage it — below — and never simply retry.

A subagent's own report is not evidence. The check command is.

## The steps

| step | skill | check command | passes when |
|---|---|---|---|
| requirements | `build-step-requirements` | `grep -c '^[0-9]' REQUIREMENTS.md` | at least 1 |
| requirements-readback | `build-step-readback-requirements` | human | see below |
| test-list | `build-step-test-list` | `grep -c '^[0-9]' TESTS.md` | at least as many as REQUIREMENTS.md |
| test-list-readback | `build-step-readback-tests` | human | see below |
| write-tests | `build-step-write-tests` | `python -m pytest -q` | exits **non-zero**, and collects at least one test |
| implement | `build-step-implement` | `python -m pytest -q` | exits zero |
| review | `build-step-review` | human | see below |
| ship | `build-step-ship` | `python -m pytest -q && python -c "$IMPORTS"` | exits zero |

`write-tests` passing on a non-zero exit is deliberate: a test suite that
passes before the code exists is not testing the code.

`$IMPORTS` in the `ship` check stands for this, which imports every package the
run actually built rather than a module name guessed in advance:

```py
import importlib, pathlib, sys
pkgs = [p.name for p in pathlib.Path('.').iterdir()
        if (p / '__init__.py').exists() and p.name != 'tests']
if not pkgs:
    sys.exit('ship: no importable package in the run directory')
for name in pkgs:
    importlib.import_module(name)
```

A suite can pass while a module is unimportable outside pytest's own path
handling, which is the whole reason `ship` imports anything. What it must not
do is demand a name the brief never specified — a failure there is the check
being wrong, not the build.

When `write-tests` passes, record alongside its verdict what the suite looked
like at that moment:

```sh
python -m pytest --collect-only -q | grep -c '::'   # -> "collected"
grep -roE --include='*.py' 'skip|xfail' tests/ | wc -l   # -> "skips"
```

Those two numbers are what makes a later repair checkable.

## When a check fails

A failing suite does not say whose fault it is. The code may be wrong, or the
test may be unpassable — and retrying the same step on a test that cannot pass
is how a model ends up writing a module to satisfy a typo.

So on a `fail` of `write-tests`, `implement` or `ship`:

1. Delegate `build-step-triage` and read `build-triage.json` yourself. The
   verdict you act on is the file's, not the agent's prose.
2. `"fault": "implementation"` — re-delegate the step that failed, once.
3. `"fault": "test"` — delegate `build-step-repair-test`, then run both count
   commands above. Collected fewer than `collected`, or more than `skips`
   skip markers, is `repair-test` failing: stop and report, because the suite
   was made quieter rather than correct. Otherwise re-delegate the step that
   failed, once.
4. `"fault": "check"` — stop and report, naming the check command and its
   output. The build is not the thing that failed, and no step agent can fix a
   check command.
5. `"fault": "unclear"`, or no `build-triage.json` at all — stop and report.

**One cycle per step, ever.** If the step fails its check again after a triage
and a repair, stop and report the step, the command, its output and the triage
verdict. Do not triage a second time. A fault that survives one honest
diagnosis needs a person.

Record `triage` and `repair-test` in `build-state.json` as steps of their own,
with the step they were run for, so the run shows what was corrected and on
whose say-so.

## Human steps

A human step is only real when a person is there. The environment variable
`DSH_BUILD_MODE` says whether one is — it is an environment variable, not a
file, and it is normally unset. Unset or `autonomous` means record that step as
`skipped` and move on. Only `interactive` means delegate it and wait.

## Which model runs a step

Optional. `build-models.json` in the working directory, one JSON object of step
name to model name, any subset of the steps:

```json
{ "write-tests": "qwen3-coder", "implement": "glm-5", "review": "claude-opus-5" }
```

A step the file does not name runs on the default model, which is what the
whole run uses when the file is absent. You never choose a model yourself and
you never write this file.

## The state file

One JSON object, `{ "steps": [ ... ] }`, each entry
`{ "step", "verdict", "checked_with", "exit_code", "at" }`, plus `"model"`
when you passed one, so the run records which model each step was given.
Verdict is `pass`, `fail` or `skipped`.

You are the only writer. A step agent that writes it is out of contract —
overwrite what it wrote with your own measured verdict.
