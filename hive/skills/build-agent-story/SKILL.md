---
name: build-agent-story
description: Work one story to completion. Dispatched by build-orchestrator with nothing but a story number.
---

# Work story `<n>`

Parameter: `story` — required, no default. You were given a number and nothing
else. Everything you need is in `stories/<n>/`.

Open that folder first and look at what is in it:

- **`CODE-REVIEW.md` is there** — the implementation already exists and a
  reviewer found something wrong with it. Read the review. Fix exactly what it
  names, in the code, not in the review. Do not start over, and do not go
  looking for other work.
- **`CODE-REVIEW.md` is not there** — implement the story from
  `IMPLEMENTATION.md`.

Either way, `stories/<n>/IMPLEMENTATION.md` is the contract and
`STORIES.md` is where that story's deliverables are stated. Build what they
say, including its tests, and nothing they do not ask for — another story owns
that, and two agents editing one behaviour is how a wave corrupts itself.

The code does not live in `stories/<n>/`. That folder holds this story's
plan and its review and nothing else; the application itself — packages,
modules, `tests/`, the project declaration — is built at the run directory
root, alongside `STORIES.md`, because every story contributes to one
application rather than to a folder of its own.

Do not edit any other story's folder, `STORIES.md`, or `build-state.json`.

Hand back when you believe the story's deliverables are met. Saying so does not
make it so — every handback is reviewed — so a plain report of what you did and
what you could not do is worth more than a confident one.
