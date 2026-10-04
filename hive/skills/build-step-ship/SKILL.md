---
name: build-step-ship
description: Make the finished app actually start, and record what was built. Delegated by build-orchestrator as the last step.
---

# Ship it

Run the whole suite one more time, then start the app for real and confirm it
comes up.

Write `BUILT.md`: one numbered line per requirement, each saying the test that
covers it, or saying plainly that nothing does.

A line claiming a requirement is met with no test named against it is the one
thing this file must never contain. If you cannot name the test, write that
you cannot.

Then stop.
