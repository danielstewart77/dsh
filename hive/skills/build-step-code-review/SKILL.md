---
name: build-step-code-review
description: Review one story's handback against its own deliverables, and prescribe the fix when it falls short. Delegated by build-orchestrator after every handback, without exception.
---

# Review story `<n>`

Parameters: `story` (required), `rounds` (default 3 — which round this is).

Every handback is reviewed. There is no path around this step and no verdict
that skips it.

Read that story's deliverables in `STORIES.md` and its plan in
`stories/<n>/IMPLEMENTATION.md`. Those two say what this story owed. Judge the
work against them and against nothing else — "the app starts" is a criterion
only where that story owed it, and a story that owed only a data layer is not
failed for having no views.

Run its tests. Then **read the code**, because a green suite is not a pass:

- a function returning a literal that the requirement says should be computed
- arguments accepted and ignored
- a test asserting the shape of a payload rather than a value derived from input
- a test that would pass against an empty implementation
- a deliverable claimed in the handback with nothing on disk behind it

**It passes.** Say so, and move `stories/<n>/CODE-REVIEW.md` into
`stories/<n>/reviews/round-<k>.md` if one is there. The folder must be left with
no `CODE-REVIEW.md` in it — its presence is what tells the next agent there is
something to fix, so leaving a passed review behind puts the story in a loop.

**It does not pass.** Write `stories/<n>/CODE-REVIEW.md`: what is wrong, where
it is, and the prescription — what to do about it. Write it to be acted on by
an agent that will see nothing else: name files and functions, not impressions.
Be specific about what "close, but not quite" means here, because that sentence
is the entire value of this step.

You do not fix anything yourself, and you do not edit the implementation. Your
output is a verdict and, when it fails, a document.
