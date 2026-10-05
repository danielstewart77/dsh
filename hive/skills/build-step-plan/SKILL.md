---
name: build-step-plan
description: Write the implementation plan for a story against the real repo. Delegated by build-orchestrator after the stories exist.
---

# Plan one story

Parameters: `story` (default: every story with no plan yet), `repo` (default:
the working directory).

For each story you were given, read its entry in `STORIES.md` and then read the
actual repository — the modules that exist, the conventions in use, the tests
already written. A plan written without opening the repo is a guess.

Write `stories/<n>/IMPLEMENTATION.md`:

- what to build, in the order it has to be built
- the real paths it goes in, named exactly
- what proves it done, tied to that story's declared deliverables
- anything in the brief that is ambiguous or contradictory for this story, said
  out loud rather than decided silently

This document is the only thing the implementing agent is given. It is the
contract it will be held to at review, so what it does not say will not be
built, and what it says wrongly will be built wrongly.

Write no code.
