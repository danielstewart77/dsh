---
name: build-step-requirements
description: Turn the handed task into a numbered requirements file. Delegated by build-orchestrator as the first step of a build.
---

# Write the requirements

Read the task you were given. Write `REQUIREMENTS.md` in the working directory.

One numbered line per requirement, starting at `1.` in column one. Each line
is one outcome a person could check by using the app, in plain language.

Not "add a GET /config route". That is how, not what. "The settings page shows
the current configuration" is a requirement.

Split anything that needs the word "and" to state. Write nothing else in the
file — no preamble, no notes, no headings.

Then stop. Do not write tests. Do not write code.
