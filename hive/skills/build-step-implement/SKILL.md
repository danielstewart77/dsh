---
name: build-step-implement
description: Write the code until the existing tests pass. Delegated by build-orchestrator after the tests exist and fail.
---

# Make the tests pass

Run `python -m pytest -q`. Read the first failure. Write the code that fixes
that one failure. Run it again. Repeat.

Work one failure at a time. Do not write a module nobody's test asked for.

Never edit a file under `tests/` in this step. If a test looks wrong, say so in
your report and leave it failing — changing the test to match the code is how a
suite stops meaning anything, and the orchestrator runs the same command you
do, so it will see what you saw.

Verify nothing by reading your own code. `python -m pytest -q` exiting zero is
the only finish line, and `python -c "import <module>"` is how you find out
whether a file you wrote actually loads.

Stop when it exits zero.
