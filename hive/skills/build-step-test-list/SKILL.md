---
name: build-step-test-list
description: Derive one numbered test per requirement. Delegated by build-orchestrator after the requirements exist.
---

# Write the test list

Read `REQUIREMENTS.md`. Write `TESTS.md` with one numbered line per test, at
least one for every requirement.

Each line is a sentence naming the behaviour the test guards, and must say
which requirement number it covers.

A test only earns a place if code outside the test decides whether it passes.
If a requirement cannot be reached that way — a colour, a wording, a removal —
write the line as `N. (no test: <why>) covers requirement M` rather than
inventing a test for something next to it.

Then stop. Do not write the tests themselves.
