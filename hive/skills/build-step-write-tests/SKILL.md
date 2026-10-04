---
name: build-step-write-tests
description: Write the tests from the test list, before any implementation exists. Delegated by build-orchestrator after the test list is agreed.
---

# Write the tests

Read `TESTS.md`. Write one real test per numbered line, under `tests/`.

Every test must import the module it is about and call the function it is
about. `python -m pytest -q` must collect them and must **fail**, because the
code they call does not exist yet. That failure is this step passing.

Forbidden outright, and the reason this step has a check command:

- `assert True`, a bare `pass`, or a body that asserts nothing
- a test that imports nothing from the app
- `try`/`except ImportError` around the import, or a skip marker
- asserting a literal against the same literal

If you cannot write a test for a line that `TESTS.md` marked `(no test: ...)`,
skip that line. Those are the only lines you may skip.

Then stop. Do not write the implementation.
