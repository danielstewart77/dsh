---
name: build-step-readback-tests
description: Read the test list back to the person and get their sign-off. Delegated by build-orchestrator only when a human is present.
---

# Read the test list back

Print the numbered lines of `TESTS.md` verbatim and ask whether each one tests
the thing they actually care about.

Change the file to whatever they say, then ask again. Repeat until they agree.

Name out loud any requirement you could not write a test for, and why. Do not
hide it in the list.
