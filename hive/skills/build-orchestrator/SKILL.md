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
6. On `pass`, go to 2. On `fail`, stop and report the step, the command, and
   the command's output. Do not retry and do not continue.

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
| ship | `build-step-ship` | `python -m pytest -q && python -c "import app"` | exits zero |

`write-tests` passing on a non-zero exit is deliberate: a test suite that
passes before the code exists is not testing the code.

## Human steps

A human step is only real when a person is there. Read `DSH_BUILD_MODE`.
Unset or `autonomous` means record that step as `skipped` and move on. Only
`interactive` means delegate it and wait.

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
