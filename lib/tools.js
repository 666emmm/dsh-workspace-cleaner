/**
 * The model-facing tools. Three, and each is the same operation the settings
 * page performs — one implementation, two callers.
 *
 * `workspace_cleaner_plan` is the deterministic pass: it answers with the same
 * inventory and refusals the page shows, so a model reasoning about the
 * workspace and a person looking at the table see the same facts.
 *
 * `workspace_cleaner_submit_plan` is the return channel for the AI-judgement
 * flow. A judging session cannot hand a structured result back through prompt
 * text, so it calls this tool, and the page reads what it stored.
 *
 * Registration shape follows the registry contract this Harness enforces: an
 * `output` declaration with a schema and a render function, and `execute`
 * returning the canonical JSON value — not content blocks.
 */

import { buildPlan, applyPlan, errorMessage } from './cleaner.js'
import { acceptJudgedPlan, linkSessionFolder } from './routes.js'

/** Declared output schema shared by the JSON-answering tools. */
const OBJECT_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/** Tool definitions plus the metadata registration needs. */
export const TOOLS = [
  {
    name: 'workspace_cleaner_plan',
    description:
      'Inventory a workspace folder and return a tidying plan WITHOUT moving anything: every root-level '
      + 'entry classified as a loose file, a user-made directory, or a tool-fixed directory; which files '
      + 'are safe to move and where; which are refused and why; plus the dependency scan (files that '
      + 'mention a path, and config-declared directories that must not be touched). '
      + 'Use it before proposing any file organisation, and call it again right before applying, because '
      + 'the folder may have changed since the last look.',
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'Absolute path of the workspace directory. Omit to use the session working directory.',
        },
      },
      additionalProperties: false,
    },
    output: OBJECT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const root = rootOf(args, exec)
      const plan = buildPlan(root, { settings: runtimeOf(exec).settings() })
      if (!plan.ok) throw new Error(plan.error)
      return plan
    },
  },
  {
    name: 'workspace_cleaner_apply',
    description:
      'Move files into subfolders in one workspace. Pass groups of {folder, files}. Every file must be a '
      + 'loose file at the workspace root; directories are never moved or renamed. Nothing is deleted '
      + 'except a directory this run emptied, and only when that is enabled. '
      + 'Run with dryRun first, show the user the plan, and only then run it for real.',
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'Absolute path of the workspace directory. Omit to use the session working directory.',
        },
        groups: {
          type: 'array',
          description: 'Destination groups. Each entry moves its files into its folder.',
          items: {
            type: 'object',
            properties: {
              folder: { type: 'string', description: 'Destination folder, one or more segments, relative to the workspace root.' },
              files: { type: 'array', items: { type: 'string' }, description: 'File names at the workspace root.' },
              reason: { type: 'string', description: 'One line on why these files belong there.' },
            },
            required: ['folder', 'files'],
            additionalProperties: false,
          },
        },
        removeEmptyDirs: {
          type: 'array',
          description: 'Directory names this run may remove if they end up empty.',
          items: { type: 'string' },
        },
        dryRun: {
          type: 'boolean',
          description: 'Report what would happen without touching the filesystem. Defaults to true.',
        },
      },
      required: ['groups'],
      additionalProperties: false,
    },
    output: OBJECT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const root = rootOf(args, exec)
      const runtime = runtimeOf(exec)
      const dryRun = args?.dryRun !== false
      const groups = Array.isArray(args?.groups) ? args.groups : []
      if (groups.length === 0) throw new Error('groups must contain at least one destination')
      const result = applyPlan(
        root,
        { groups, emptyDirs: Array.isArray(args?.removeEmptyDirs) ? args.removeEmptyDirs : [] },
        { settings: runtime.settings(), dryRun, actor: 'agent' },
      )
      if (!dryRun) runtime.record({ kind: 'apply', root, actor: 'agent', moved: result.moved.length })
      return result
    },
  },
  {
    name: 'workspace_cleaner_submit_plan',
    description:
      'Return a finished tidying judgement to the plugin. Use this INSTEAD of describing the plan in '
      + 'your reply when the plugin handed you an inventory to judge: the settings page is waiting for '
      + 'this structured answer and cannot read your message text. Files you leave out count as keep. '
      + 'Do not call this to trigger more work — it only stores the judgement.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'The workspace path the judgement is about.' },
        groups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              folder: { type: 'string' },
              files: { type: 'array', items: { type: 'string' } },
              reason: { type: 'string' },
            },
            required: ['folder', 'files'],
            additionalProperties: false,
          },
        },
        notes: { type: 'string', description: 'Optional one-line summary for the user.' },
      },
      required: ['root', 'groups'],
      additionalProperties: false,
    },
    output: OBJECT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const result = acceptJudgedPlan(runtimeOf(exec).raw(), args ?? {})
      if (!result.ok) throw new Error(result.error)
      return { accepted: true, groups: result.groups.length, rejected: result.rejected }
    },
  },
  {
    name: 'workspace_cleaner_link_folder',
    description:
      'Remember that a folder in a workspace belongs to a session, so the folder follows that session '
      + 'when it is renamed. Call it right after creating a per-session output folder, using the session '
      + 'title as the folder name — a folder named after the session is what makes the workspace readable '
      + 'later.',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Absolute workspace path.' },
        folder: { type: 'string', description: 'Folder name relative to the workspace root.' },
        sessionId: { type: 'string', description: 'Session id. Omit to use the current session.' },
        title: { type: 'string', description: 'Session title the folder is named after.' },
      },
      required: ['folder'],
      additionalProperties: false,
    },
    output: OBJECT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const runtime = runtimeOf(exec)
      const result = linkSessionFolder(runtime.raw(), {
        root: rootOf(args, exec),
        folder: args?.folder,
        sessionId: args?.sessionId ?? exec?.agent?.session?.id,
        title: args?.title,
      })
      return { linked: true, links: Object.keys(result.links).length }
    },
  },
]

/** The workspace a tool call operates on: explicit argument, else the session cwd. */
function rootOf(args, exec) {
  const explicit = typeof args?.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : null
  if (explicit) return explicit
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('this session has no working directory, so pass `workspace` explicitly')
  }
  return cwd
}

/**
 * Tools reach the Host runtime through one accessor registered by the plugin,
 * which keeps these definitions free of closure state and safe to register on
 * any context.
 */
let runtimeAccessor = null

/** Bind the runtime the tools read. Called once from the Host `apply`. */
export function bindToolRuntime(accessor) {
  runtimeAccessor = accessor
  return () => { runtimeAccessor = null }
}

function runtimeOf(exec) {
  if (!runtimeAccessor) throw new Error('workspace cleaner runtime is not initialised')
  return runtimeAccessor(exec)
}

export { errorMessage }
