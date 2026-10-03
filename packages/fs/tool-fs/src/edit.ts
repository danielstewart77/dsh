/**
 * Model-facing literal edit, unique-match by default. It obtains an optional guard from the
 * single intent slot, calls `ctx.fs.editText` without a separate stat, then records the observed
 * version; no policy means an unconditional atomic edit.
 *
 * One body, registered under more than one name. A model emits the tool names
 * and argument spellings it was trained on, and that training is not ours to
 * change: `edit` with `old_string`/`new_string` and `str_replace` with
 * `old_str`/`new_str` are the same operation asked for in two dialects, so both
 * are real registered tools over this backend rather than one tool and a
 * translator the model never sees.
 * @module @deepseek-ai/dsh-tool-fs/src/edit
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { DiffCallView, DiffResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { computeHunkDiffs, diffsFromMeta } from './diff.ts'
import { remediateFsError } from './error.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import type { FsSandboxController } from './sandbox.ts'

/** Validated literal-edit arguments after defaulting. */
interface EditInput {
  filePath: string
  oldString: string
  newString: string
  replaceAll: boolean
}

/**
 * One registered name for the literal-edit body, and the argument spelling that
 * name declares. The pair is what differs between dialects; the path argument is
 * `file_path` in both, so it is not parameterized.
 */
interface EditDialect {
  /** The tool name the model calls. */
  name: string
  /** Argument key this name's guidance and its error messages speak in. */
  oldKey: 'old_string' | 'old_str'
  /** Replacement-text key this name's guidance and its error messages speak in. */
  newKey: 'new_string' | 'new_str'
  /** System-prompt section order, distinct per registration. */
  promptOrder: number
}

/**
 * Every spelling of the replacement pair, declared on every registration.
 *
 * Declared, not merely tolerated: the argument validator's object root is open,
 * so an undeclared key reaches `execute` with no type checked at all — a model
 * sending an object where a string belongs would get a bare `TypeError` out of
 * the filesystem rather than an `INVALID_ARGS` refusal. And a spelling absent
 * from the schema is a spelling no model reading that schema will ever send, so
 * tolerating one without declaring it buys nothing.
 */
const PAIR_KEYS = ['old_string', 'new_string', 'old_str', 'new_str'] as const

/** The `edit` registration: the spelling this harness has always declared. */
const EDIT_DIALECT: EditDialect = {
  name: 'edit',
  oldKey: 'old_string',
  newKey: 'new_string',
  promptOrder: 102,
}

/** The `str_replace` registration: the spelling Claude-trained models emit. */
const STR_REPLACE_DIALECT: EditDialect = {
  name: 'str_replace',
  oldKey: 'old_str',
  newKey: 'new_str',
  // 103 belongs to tool-fs-search's `glob`; this section sits with `edit`.
  promptOrder: 102.5,
}

/**
 * The literal-edit tools' validated arguments: the path, either spelling of the
 * replacement pair, and the two escalation fields advertised only under a
 * confining `ctx.fs` (absent from the schema otherwise, so the validator rejects
 * them before `execute`).
 *
 * Every spelling is optional in the schema because a tool accepting either pair
 * can require neither. `parseEditArgs` enforces that the pair arrived under at
 * least one spelling, and that two spellings of one argument do not disagree.
 */
interface EditToolArgs {
  file_path: string
  old_string?: string
  new_string?: string
  old_str?: string
  new_str?: string
  replace_all?: boolean
  sandbox_permissions?: string
  justification?: string
}

/** The literal text to replace, under whichever spelling the call used. */
function oldText(args: EditToolArgs): string | undefined {
  return args.old_string ?? args.old_str
}

/** The replacement text, under whichever spelling the call used. */
function newText(args: EditToolArgs): string | undefined {
  return args.new_string ?? args.new_str
}

/**
 * Both spellings of one half of the pair, when the call carried both.
 * @param args - the raw tool arguments.
 * @param keys - the two spellings of the same argument.
 * @returns the violation to report, or undefined when at most one arrived or they agree.
 */
function conflict(args: EditToolArgs, keys: readonly ['old_string', 'old_str'] | readonly ['new_string', 'new_str']): string | undefined {
  const [first, second] = keys
  const a = args[first]
  const b = args[second]
  if (a === undefined || b === undefined || a === b) return undefined
  return `${first} and ${second} are the same argument and disagree; send one`
}

/**
 * Validate value constraints the schema DSL can't express: a non-blank
 * `file_path`, a replacement pair present under one of its two spellings, a
 * non-empty old text, and old !== new (an equal pair would be a guaranteed
 * no-op edit).
 * @param args - the schema-validated raw tool arguments.
 * @returns the camelCased input with `replace_all` defaulted to false.
 */
export function parseEditArgs(args: EditToolArgs, dialect: EditDialect = EDIT_DIALECT): EditInput {
  const { oldKey, newKey } = dialect
  // Every refusal here is a ToolArgsError, never a bare Error: only a
  // HarnessError carries a code into `result.error.info`, and a result with no
  // info is written to the session log with no error field at all — so an
  // uncoded refusal is tallied as a SUCCEEDED tool call and never reaches the
  // unserved-call report. A dialect this harness cannot serve is the one thing
  // that report exists to name.
  const violations: string[] = []
  for (const keys of [['old_string', 'old_str'], ['new_string', 'new_str']] as const) {
    const found = conflict(args, keys)
    if (found !== undefined) violations.push(found)
  }
  if (violations.length > 0) throw new ToolArgsError(violations)
  if (args.file_path.trim().length === 0) throw new ToolArgsError(['file_path must be a non-empty string'])
  const oldValue = oldText(args)
  const newValue = newText(args)
  // Named together rather than one at a time: a model that sent neither is
  // speaking a dialect, and the remedy is the pair of spellings this tool takes.
  if (oldValue === undefined || newValue === undefined) {
    throw new ToolArgsError([`missing required property "${oldKey}"`, `missing required property "${newKey}"`])
  }
  if (oldValue.length === 0) throw new ToolArgsError([`${oldKey} must be a non-empty string`])
  if (oldValue === newValue) throw new ToolArgsError([`${oldKey} and ${newKey} must differ`])
  return {
    filePath: args.file_path,
    oldString: oldValue,
    newString: newValue,
    replaceAll: args.replace_all ?? false,
  }
}

/**
 * Format an edit success (single-match or replace-all) as a Claude-style model-facing message.
 * @param displayPath - the backend-resolved path shown to the model.
 * @param replaceAll - selects the all-occurrences wording over the single-replacement one.
 * @returns the confirmation sentence the model sees as the tool result.
 */
export function formatEditOutput(displayPath: string, replaceAll: boolean): string {
  return replaceAll
    ? `The file ${displayPath} has been updated. All occurrences were successfully replaced.`
    : `The file ${displayPath} has been updated successfully.`
}

/**
 * Register one literal-edit dialect and its system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param sandbox - the shared sandbox-escalation API (advertisement, mode stamping, denial mapping).
 * @param dialect - the tool name and argument spelling this registration declares.
 */
function applyLiteralEditTool(ctx: Context, sandbox: FsSandboxController, dialect: EditDialect): void {
  const { name, oldKey, newKey } = dialect
  ctx.systemPrompt.section({
    name: `tool:${name}`,
    order: dialect.promptOrder,
    text: `Use the ${name} tool for targeted changes to existing UTF-8 text files.`
      + ` It replaces literal ${oldKey} with ${newKey}; by default ${oldKey} must appear exactly once.`
      + ` If ${oldKey} appears multiple times, provide a more specific ${oldKey} or set replace_all to true.`
      + ' Read the file first (the default fs-observation-policy requires it),'
      + ' unless you just created or edited it in this session.',
  })

  ctx.tools.register(defineTool({
    name,
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend.' },
      [oldKey]: { type: 'string', description: 'Literal text to replace. Must match exactly.' },
      [newKey]: { type: 'string', description: 'Literal replacement text. Use an empty string to delete the match.' },
      ...Object.fromEntries(PAIR_KEYS.filter(key => key !== oldKey && key !== newKey).map(key => [
        key,
        { type: 'string', description: `Accepted alias of ${key.startsWith('old') ? oldKey : newKey}.` },
      ])),
      replace_all: { type: 'boolean', description: `Replace all matches. Defaults to false; when false, ${oldKey} must appear exactly once.` },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: formatEditOutput(value.path, args.replace_all ?? false),
      }],
      presentationMeta: (args, value) => ({
        diffs: computeHunkDiffs(args.file_path, value.before, value.after)
          .map(({ path, oldText: before, newText: after }) => ({ path, oldText: before, newText: after })),
      }),
    },
    async execute(args: EditToolArgs, exec) {
      const input = parseEditArgs(args, dialect)
      // Resolve the per-call sandbox policy (approved mode > session override
      // > backend default, plus the session cwd root) BEFORE anything executes.
      const sandboxPolicy = await sandbox.resolvePolicy(name, args, exec)
      const target = await ctx.fs.resolve(input.filePath, sessionResolveOptions(exec, input.filePath, sandboxPolicy?.workspaceRoot))
      // Single-slot decision: the policy plugin returns { version: vObserved } or
      // throws FS_NOT_OBSERVED; the bare default is undefined (unconditional edit).
      // No stat — the bare default never manufactures a version basis. The intent
      // slot itself can throw FS_NOT_OBSERVED for an unread target, so it sits
      // inside the try: both that refusal and the provider's guarded-mutation
      // failure get the model-facing remedy below.
      let outcome
      try {
        const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
        outcome = await ctx.fs.editText(
          target,
          { oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll },
          intent,
          exec.signal,
          sandboxPolicy,
        )
      } catch (error: unknown) {
        // A sandbox denial becomes the shared [sandbox: …] marker (the model
        // recognizes it from bash); stale/not-observed failures gain their
        // model-facing remedy; anything else passes through.
        throw remediateFsError(sandbox.mapError(error, sandboxPolicy))
      }
      // Record the present observation (a no-op when no policy plugin listens).
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return {
        path: target.displayPath,
        before: outcome.before,
        after: outcome.after,
      }
    },
    // Pure display: a diff card of the literal replacement (old → new), derived
    // from the call args. `oldText: old || null` matches claude-agent-acp's Edit arm.
    // Replay hands back raw logged args, which parseEditArgs does not see, so the
    // replacement text falls back to an empty string rather than printing undefined.
    presentCall(args): DiffCallView {
      return {
        card: 'diff',
        title: `Edit ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: oldText(args) || null, newText: newText(args) ?? '' }],
        locations: [{ path: args.file_path }],
      }
    },
    // Applied metadata replaces the call-time snippet; errors or malformed replay metadata use
    // the generic result rendering.
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
      if (diffs === undefined) return undefined
      return { card: 'diff', title: `Edit ${args.file_path}`, diffs }
    },
  }))
}

/**
 * Register the literal-edit body under every name a model may call it by.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param sandbox - the shared sandbox-escalation API (advertisement, mode stamping, denial mapping).
 */
export function applyEditTool(ctx: Context, sandbox: FsSandboxController): void {
  applyLiteralEditTool(ctx, sandbox, EDIT_DIALECT)
  applyLiteralEditTool(ctx, sandbox, STR_REPLACE_DIALECT)
}
