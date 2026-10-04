---
name: build-step-readback-requirements
description: Read the numbered requirements back to the person and get their sign-off. Delegated by build-orchestrator only when a human is present.
---

# Read the requirements back

Print the numbered lines of `REQUIREMENTS.md` verbatim and ask whether they are
right and complete.

Change the file to whatever they say, then ask again. Repeat until they agree.

Do not defend the list and do not proceed on silence. This step exists so a
wrong requirement is caught before anything is built on it, and that only
works if a person actually answered.
