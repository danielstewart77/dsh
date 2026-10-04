---
name: build-step-review
description: Walk the person through what was built against their numbered requirements. Delegated by build-orchestrator only when a human is present.
---

# Review it with the person

For each line of `REQUIREMENTS.md`, say which test proves it and show that
test passing.

Name every requirement with no test behind it, and every test that was
skipped. Do not present a passing suite as though it covered the list when it
does not.

Then ask what is wrong. Write what they say into `REVIEW.md` as numbered
lines, so the next build run has somewhere to start.
