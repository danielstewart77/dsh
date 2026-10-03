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

## Where it lives

In the tree, at `hive/dsh-headless-resumable`, a workspace member named in
`pnpm-workspace.yaml`. This harness is maintained independently of the
DeepSeek developer preview it was forked from, so there is no upstream to stay
out of the way of and nothing is gained by keeping the surface at arm's length.

A published copy of this one package lives at
`github.com/danielstewart77/dsh-headless-resumable`, MIT, for anyone running
the preview itself. The tree here is the working copy.

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
model seam at this host's inference proxy. Nothing in it is defaulted: the
model, its provider route, that route's endpoint and the model's context window
all come from the spawn's environment (`DSH_MODEL`, `DSH_PROVIDER`,
`DSH_PROXY_BASE_URL`, `DSH_MODEL_CONTEXT_WINDOW`), because the gateway resolves
the model per session and a profile holding a house favourite is how a wrong
model goes unnoticed for weeks. Copy it to
`$DSH_HOME/profiles/hive/`, symlink this package into the profile's
`node_modules/@hive/`, and export `HIVE_PROXY_KEY` with the mind's proxy
credential. `dsh` resolves every in-box bundle from its own installation, so
only this package needs the link.

This package is compiled by the host TypeScript project — it is a reference of
`tsconfig.host.json`, and its `exports` point at that emit (`lib/types/*.js`)
rather than at `src/*.ts`. Plain `node` cannot load a `.ts` entry, so a profile
symlinking the source tree would die at its first import with
`ERR_UNKNOWN_FILE_EXTENSION`. It is deliberately **not** in `tsdown`'s
workspace list: a bundled `lib/index.js` buys nothing for a plugin that is only
ever resolved from the tree it was built in.

The monorepo has to be built first, both faces:

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

- `--task-file <path>` carries a turn argv cannot: a composed system prompt
  plus a user message runs past `MAX_ARG_STRLEN` (128 KiB), which is a limit on
  one argv entry regardless of total command-line room.
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
