# `@hive/dsh-headless-resumable`

A one-shot `dsh` surface that runs a turn in a conversation **it did not mint**.

The hive's one invariant is that hive-comms mints the conversation id when it
writes the session row, and hands that id to every spawn: `--session-id` for the
conversation's first process, `--resume` for every process after it. A mind
handed no id raises rather than inventing one. That is what makes a Telegram
turn and a browser-terminal turn the same conversation.

`@deepseek-ai/dsh-headless` mints `session-${randomUUID()}` and exposes no way
to continue anything, so a mind built on it could answer exactly one turn and
never the turn after — and every feature downstream of that (rotation,
cross-surface pickup, late turns, carry-forward) is a statement about a
conversation persisting across processes.

Both halves it needs already exist in `@deepseek-ai/dsh-agent`: `create` takes
the session id it is given, and `resume` loads a persisted one. What was missing
was a surface exposing them. This is that surface, and nothing else.

## What it adds beyond resuming

- **The turn comes back as data.** One line of JSON on stdout: the session it
  ran in, how it stopped, the final assistant text, the error code if there was
  one, and the tool traffic. A process exit status can carry none of that, and
  the tool traffic is the only measurement the training loop's first phase has.
- **Every refusal is a refusal.** No id, both ids, no task, no model, or a
  session that cannot be loaded — each reported as itself. Asked to continue a
  conversation that is not there, it refuses instead of creating one: creating
  one would answer in a conversation with no history and leave the one that was
  meant untouched and unfindable.
- **No compaction.** The bundle patch disables `compaction-basic` and
  `command-compact`. A summarizer whose priorities we cannot inspect must not
  rewrite the history of a run we are measuring. The model-free tool-result
  pruner stays on.

## Why it lives in this checkout

It is meant to be out-of-tree, and it is — its own git repository, its own
package, no patch to any upstream file but one line in `pnpm-workspace.yaml`.
It sits *inside* the upstream checkout only because the npm-published
`@deepseek-ai` set cannot be installed on its own: `dsh-agent@0.1.0-rc.6` needs
`dsh-invariants@^0.1.0-rc.6` and the published invariants is `0.0.1-rc.1`. The
workspace is the only place those specifiers resolve.

## Tests

```sh
../../node_modules/.bin/vitest run
```

Fourteen, over the real `SessionStore` and `AgentRegistry` with a scripted agent
factory, as upstream's own bundle tests do. `corepack pnpm vitest` does not work
here — pnpm's pre-run dependency check shells out to a `pnpm` on `PATH`, which
corepack does not install.

## The command-line proof

The tests run the module in-process. This runs it the way a mind will: the real
`dsh` launcher, a profile directory, and a real model.

`profile/` is that profile — `package.json` naming the two bundle layers
(`@deepseek-ai/dsh-base`, then this package) and `cordis.patch.yml` pointing the
model seam at this host's inference proxy. Copy it to
`$DSH_HOME/profiles/hive/`, symlink this package into the profile's
`node_modules/@hive/`, and export `HIVE_PROXY_KEY` with the mind's proxy
credential. `dsh` resolves every in-box bundle from its own installation, so
only this package needs the link.

The upstream monorepo has to be built first, both faces:

```sh
./node_modules/.bin/tsc -b tsconfig.host.json
./node_modules/.bin/tsdown --config-loader tsx --env.DSH_BUILD_FACE host
./node_modules/.bin/tsc -b tsconfig.client.json
./node_modules/.bin/tsdown --config-loader tsx --env.DSH_BUILD_FACE client
```

`--config-loader tsx` is not optional: tsdown 0.22's default config loader is
`unrun`, which nothing in the lockfile installs, so `npm run build:lib:host`
fails before compiling anything. Both faces are needed because `dsh-base`
mounts `dsh-api-gateway`, whose `lib/index.js` is emitted by the client face.

What it shows, on `qwen35-131k` through the proxy:

- `--session-id <id> "..."` answers in the id it was handed and reports
  `{"mode":"create","outcome":"completed"}`.
- `--resume <id> "..."` in a **separate process** answers from the first
  process's history — the turn that asked what word it had been told to use
  answered with that word.
- `--resume` against an id nothing ever created reports
  `outcome: refused`, `NO_SUCH_SESSION`, and creates nothing.
- No id at all is refused by the command line, before an agent exists.
- A turn that reads a file reports `traffic: {emitted: 1, answered: 1,
  succeeded: 1, callsByTool: {read: 1}}`.
