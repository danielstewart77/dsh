---
name: build-step-decompose
description: Break an app description into small composable stories in their correct hierarchy. Delegated by build-orchestrator as the first step of a build.
---

# Decompose the app into stories

Parameters: `brief` (default `BRIEF.md`), `out` (default `STORIES.md`). Both
relative to the working directory.

Read the brief and everything it points at. Write `out`.

A story is small enough that one agent can hold all of it, and it is finished
or it is not — there is no half. Stories do not overlap: two stories editing
the same behaviour is one story.

Prerequisites are a **graph, not an order**. A story names the stories that
must be complete before it can start, and nothing else. One story may gate
several; a story late in the file is a prerequisite of nothing merely by being
late. If two stories can honestly be built at the same time, neither names the
other.

Each story gets, in `out`:

- a number, used as its folder name from here on
- a one-line statement of what a person gets from it
- `prerequisites:` the numbers that gate it, or `none`
- `deliverables:` what must exist and be true for this story to be done — the
  files, the behaviour, the tests, and **whether the app starting is one of
  them**. This is what the reviewer will hold the work to, so a deliverable
  nobody can check is not a deliverable.
- `writes:` every file this story will create or modify, including the ones
  that are scaffolding rather than subject matter — the package initialiser,
  the project and dependency declaration, the shared test fixtures. The
  orchestrator dispatches stories concurrently and uses this list to keep two
  agents off one file, so a file left off it is a file two agents will
  overwrite in turn.

**Every file has exactly one owner.** If two stories would write the same file,
that file does not belong to either of them: make it the subject of its own
story, earlier in the graph, and name that story in the prerequisites of both.
The common case is the scaffolding — the empty package, the project
declaration, the test harness — which is nobody's subject matter and
everybody's precondition, so it goes out first as a story of its own rather
than being assumed into existence.

The file also opens with a short statement of the app as a whole, because
every later agent reads this file and nothing else about the wider job.

Write no plan and no code. That is the next step and it is not yours.
