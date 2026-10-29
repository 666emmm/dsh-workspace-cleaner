/**
 * The plugin's HTTP surface. One prefix, one dispatch table, one envelope shape:
 *
 *   { ok: true, result: <json> }
 *   { ok: false, error: "<human readable>", code: "<stable-code>" }
 *
 * The client branches on `code`; `error` is only ever shown to a person. A
 * plugin needs no generated client for this — `ctx.webServer.register` is the
 * hand-written route API, and it is stable across the versions this bundle
 * targets.
 */

import { buildPlan, applyPlan, renameSessionFolder, errorMessage, normalizePath } from './cleaner.js'
import {
  loadSettings, saveSettings, loadLinks, setLink, appendJournal, readJournal,
  loadAiSession, saveAiSession, statePaths,
} from './store.js'
import { requestJudgement } from './ai.js'
import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Everything this plugin serves lives under one prefix. */
export const PREFIX = '/workspace-cleaner/api'

/** Plugin id, matching the bundle row and the Client module id. */
export const PLUGIN_ID = 'dsh-workspace-cleaner'

/** Response helpers. */
function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(payload)
}
const ok = (res, result) => send(res, 200, { ok: true, result })
const fail = (res, status, code, message) => send(res, status, { ok: false, error: message, code })

/** Read and parse a JSON body; an empty body is `{}`. */
async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('request body too large'), { code: 'bad-request' })
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { code: 'bad-request' })
  }
}

/**
 * Build the route handler. It closes over a small runtime object the host fills
 * in `apply`, so a handler never reaches for a service that may not be mounted.
 * @param {object} runtime host-provided accessors.
 * @returns {(req, res) => Promise<void>} the handler.
 */
export function createHandler(runtime) {
  return async function handle(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return fail(res, 400, 'bad-request', 'unparsable request URL')
    }
    if (!url.pathname.startsWith(PREFIX)) return fail(res, 404, 'not-found', 'outside this plugin')

    const route = url.pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, '')
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      if (method === 'GET' && (route === 'state' || route === '')) {
        return ok(res, await readState(runtime))
      }
      if (method === 'POST' && route === 'scan') {
        const body = await readBody(req)
        const root = resolveRoot(runtime, body.root)
        const settings = loadSettings(runtime.home())
        const plan = buildPlan(root, { settings })
        return ok(res, plan)
      }
      if (method === 'POST' && route === 'apply') {
        const body = await readBody(req)
        return ok(res, await applyBody(runtime, body))
      }
      if (method === 'POST' && route === 'ask-ai') {
        const body = await readBody(req)
        return ok(res, await askAi(runtime, body))
      }
      if (method === 'POST' && route === 'pending') {
        const body = await readBody(req)
        const root = resolveRoot(runtime, body.root)
        return ok(res, readPending(runtime, root))
      }
      if (method === 'POST' && route === 'settings') {
        const body = await readBody(req)
        return ok(res, { settings: saveSettings(runtime.home(), body?.patch ?? body) })
      }
      if (method === 'POST' && route === 'rename-session-folder') {
        const body = await readBody(req)
        return ok(res, renameForSession(runtime, body))
      }
      if (method === 'POST' && route === 'sync-folders') {
        return ok(res, syncAllFolders(runtime))
      }
      if (method === 'POST' && route === 'journal') {
        const body = await readBody(req)
        return ok(res, { entries: readJournal(runtime.home(), Number(body?.limit) || 100) })
      }
      return fail(res, 404, 'not-found', `no route for ${method} ${route}`)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'internal'
      return fail(res, code === 'bad-request' ? 400 : 500, code, errorMessage(error))
    }
  }
}

/** Resolve a requested root, refusing anything that is not an existing directory. */
function resolveRoot(runtime, requested) {
  const candidate = typeof requested === 'string' && requested.trim().length > 0
    ? requested
    : runtime.defaultRoot()
  if (!candidate) throw Object.assign(new Error('no workspace path given and no workspace is open'), { code: 'no-root' })
  let info
  try {
    info = statSync(candidate)
  } catch {
    throw Object.assign(new Error(`not a directory: ${candidate}`), { code: 'bad-root' })
  }
  if (!info.isDirectory()) throw Object.assign(new Error(`not a directory: ${candidate}`), { code: 'bad-root' })
  return candidate
}

/**
 * The state the settings page renders: every workspace the Host knows, the
 * session↔folder link table, the settings, and the last journal entries.
 *
 * Session titles are folded per workspace so the page can show both names —
 * "two titles" is the requested behaviour: the workspace's own title follows a
 * workspace rename, the session title follows a session rename, and each is
 * labelled so they are not confused.
 */
async function readState(runtime) {
  const settings = loadSettings(runtime.home())
  const links = loadLinks(runtime.home())
  const workspaces = (() => {
    try {
      const registry = runtime.workspaceRegistry()
      if (!registry || typeof registry.list !== 'function') return []
      return registry.list().map(workspace => ({
        workspaceId: String(workspace.id),
        path: workspace.path,
        title: workspace.title,
        sessionIds: [...(workspace.sessionIds ?? [])].map(String),
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      }))
    } catch {
      return []
    }
  })()

  const titles = await readSessionTitles(runtime, workspaces)

  const rows = workspaces.map(workspace => {
    const sessions = workspace.sessionIds
      .map(id => ({ id, title: titles[id] ?? null }))
      .filter(item => item.title !== null)
    const link = Object.entries(links)
      .filter(([, value]) => value?.workspacePath && normalizePath(value.workspacePath) === normalizePath(workspace.path))
      .map(([sessionId, value]) => ({ sessionId, folder: value.folder, title: value.title ?? null }))
    return {
      ...workspace,
      sessionCount: workspace.sessionIds.length,
      sessions,
      links: link,
      latestSessionTitle: sessions[0]?.title ?? null,
      rootDefault: runtime.defaultRoot() && normalizePath(runtime.defaultRoot()) === normalizePath(workspace.path),
      // Root directory names, so the page can offer a lock switch per folder
      // instead of making the user type a name they cannot see.
      entries: listRootEntries(workspace.path),
    }
  })

  return {
    workspaces: rows,
    settings,
    links,
    statePath: statePaths(runtime.home()).dir,
    aiSessions: runtime.aiSessions ? runtime.aiSessions() : {},
    journal: readJournal(runtime.home(), 20),
    defaultRoot: runtime.defaultRoot() ?? null,
  }
}

/**
 * Root-level entries for one workspace, so the page can offer a lock per folder.
 *
 * Deliberately cheap and tolerant: a workspace whose directory is gone (renamed
 * on disk, or on a disconnected drive) yields an empty list rather than an error,
 * because the rest of the page is still useful for that row.
 */
function listRootEntries(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isFile())
      .map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
      .sort((left, right) => left.name.localeCompare(right.name))
  } catch {
    return []
  }
}

/** Fold the durable title of each requested session; failures stay isolated. */async function readSessionTitles(runtime, workspaces) {
  const ids = [...new Set(workspaces.flatMap(workspace => workspace.sessionIds.map(String)))]
  if (ids.length === 0) return {}
  const query = runtime.sessionQuery()
  if (!query || typeof query.readTitleSnapshots !== 'function') return {}
  try {
    const results = await query.readTitleSnapshots(ids)
    const out = {}
    for (const result of results) {
      if (result && result.status === 'fulfilled' && result.value?.title?.title) {
        out[String(result.sessionId)] = result.value.title.title
      }
    }
    return out
  } catch {
    return {}
  }
}

/** Apply an accepted plan, then record it. */
async function applyBody(runtime, body) {
  const root = resolveRoot(runtime, body.root)
  const settings = loadSettings(runtime.home())
  const groups = Array.isArray(body.groups) ? body.groups : null
  if (!groups) throw Object.assign(new Error('groups is required'), { code: 'bad-request' })
  const plan = { groups, emptyDirs: Array.isArray(body.emptyDirs) ? body.emptyDirs : [] }
  const result = applyPlan(root, plan, {
    settings,
    dryRun: body.dryRun === true,
    actor: typeof body.actor === 'string' ? body.actor : 'page',
  })
  if (body.dryRun !== true) {
    appendJournal(runtime.home(), {
      kind: 'apply',
      root,
      actor: body.actor ?? 'page',
      moved: result.moved.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
      removedDirs: result.removedDirs,
      verify: result.verify,
    })
    clearPending(runtime, root)
  }
  return result
}

/** Ask the dedicated judging session for a plan. */
async function askAi(runtime, body) {
  const root = resolveRoot(runtime, body.root)
  const settings = loadSettings(runtime.home())
  const inventory = buildPlan(root, { settings })
  if (!inventory.ok) return { ok: false, action: 'skipped', reason: inventory.error }

  const workspaceId = workspaceIdForPath(runtime, root)
  const remembered = loadAiSession(runtime.home(), root)
  const outcome = await requestJudgement(
    { sessionController: runtime.sessionController(), workspaceRegistry: runtime.workspaceRegistry() },
    {
      home: runtime.home(),
      workspacePath: root,
      workspaceId,
      inventory,
      rememberedSessionId: remembered?.sessionId,
      saveSession: (sessionId) => saveAiSession(runtime.home(), root, sessionId),
    },
  )
  if (!outcome.ok) return outcome
  clearPending(runtime, root)
  writePending(runtime, root, { status: 'waiting', sessionId: outcome.sessionId, at: new Date().toISOString() })
  return { ...outcome, pending: true }
}

/** The registry id whose canonical path matches, used so the session joins the workspace. */
function workspaceIdForPath(runtime, path) {
  try {
    const registry = runtime.workspaceRegistry()
    if (!registry || typeof registry.list !== 'function') return undefined
    const wanted = normalizePath(path)
    const found = registry.list().find(workspace => normalizePath(workspace.path) === wanted)
    return found ? String(found.id) : undefined
  } catch {
    return undefined
  }
}

/** Pending-judgement files are keyed by the workspace path they describe. */
function pendingPath(runtime, root) {
  const dir = statePaths(runtime.home()).dir
  return join(dir, `pending-${Buffer.from(normalizePath(root)).toString('hex').slice(0, 24)}.json`)
}

function writePending(runtime, root, value) {
  const path = pendingPath(runtime, root)
  mkdirSync(statePaths(runtime.home()).dir, { recursive: true })
  writeFileSync(path, JSON.stringify({ ...value, root }, null, 2), 'utf8')
}

function clearPending(runtime, root) {
  try { rmSync(pendingPath(runtime, root)) } catch { /* nothing to clear */ }
}

/** Read the pending judgement for one workspace, if any. */
function readPending(runtime, root) {
  const path = pendingPath(runtime, root)
  if (!existsSync(path)) return { status: 'none' }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { status: 'none' }
  }
}

/**
 * Accept a plan from the judging session's tool call.
 *
 * This is the channel that makes "let the AI decide" work: the model calls
 * `workspace_cleaner_submit_plan`, and this validates and stores the result the
 * page is waiting for. Validation happens here rather than in the tool so the
 * page and the tool share one gate.
 */
export function acceptJudgedPlan(runtime, input) {
  const root = resolveRoot(runtime, input?.root)
  const rawGroups = Array.isArray(input?.groups) ? input.groups : []
  const known = new Set(readdirSync(root))
  const groups = []
  const rejected = []
  for (const group of rawGroups) {
    const folder = String(group?.folder ?? '').replace(/[\\/]+/g, '/').trim()
    const files = Array.isArray(group?.files) ? group.files.map(String) : []
    if (!folder || files.length === 0) continue
    const kept = []
    for (const name of files) {
      if (!known.has(name)) rejected.push({ name, reason: 'not-in-workspace-root' })
      else kept.push(name)
    }
    if (kept.length > 0) {
      groups.push({ folder, files: kept, reason: typeof group?.reason === 'string' ? group.reason : undefined })
    }
  }
  if (groups.length === 0 && rejected.length === 0) {
    return { ok: false, error: 'no usable groups in the submitted plan', code: 'bad-plan' }
  }
  const value = {
    status: 'ready',
    root,
    groups,
    notes: typeof input?.notes === 'string' ? input.notes : '',
    rejected,
    at: new Date().toISOString(),
  }
  writePending(runtime, root, value)
  appendJournal(runtime.home(), { kind: 'ai-plan', root, groups: groups.length, rejected: rejected.length })
  return { ok: true, ...value }
}

/** Rename one session's linked folder to follow its title. */
function renameForSession(runtime, body) {
  const root = resolveRoot(runtime, body.root)
  const sessionId = String(body.sessionId ?? '')
  if (!sessionId) throw Object.assign(new Error('sessionId is required'), { code: 'bad-request' })
  const links = loadLinks(runtime.home())
  const link = links[sessionId]
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : (link?.title ?? '')
  if (!title) throw Object.assign(new Error('no title available for that session'), { code: 'no-title' })
  const locks = loadSettings(runtime.home()).lockedNames
  const result = renameSessionFolder(
    root,
    { sessionId, title, currentFolder: link?.folder },
    { dryRun: body.dryRun === true, lockedNames: locks },
  )
  if (result.ok && body.dryRun !== true && result.to && result.action !== 'unlinked') {
    setLink(runtime.home(), sessionId, { folder: result.to, workspacePath: root, title })
    appendJournal(runtime.home(), { kind: 'rename-folder', root, sessionId, from: result.from, to: result.to, action: result.action })
  }
  return result
}

/** Re-point every remembered link at the current title and rename where needed. */
function syncAllFolders(runtime) {
  const links = loadLinks(runtime.home())
  const locks = loadSettings(runtime.home()).lockedNames
  const results = []
  for (const [sessionId, link] of Object.entries(links)) {
    if (!link?.workspacePath || !link?.title) continue
    const result = renameSessionFolder(link.workspacePath, {
      sessionId,
      title: link.title,
      currentFolder: link.folder,
    }, { lockedNames: locks })
    if (result.ok && result.to && result.action !== 'unlinked') {
      setLink(runtime.home(), sessionId, { folder: result.to, workspacePath: link.workspacePath, title: link.title })
    }
    results.push({ sessionId, ...result })
  }
  return { results }
}

/** Store a link so a later session rename knows which folder to move. */
export function linkSessionFolder(runtime, input) {
  const root = resolveRoot(runtime, input?.root)
  const sessionId = String(input?.sessionId ?? '')
  const folder = String(input?.folder ?? '')
  if (!sessionId || !folder) throw Object.assign(new Error('sessionId and folder are required'), { code: 'bad-request' })
  setLink(runtime.home(), sessionId, {
    folder,
    workspacePath: root,
    title: typeof input?.title === 'string' ? input.title : undefined,
  })
  return { links: loadLinks(runtime.home()) }
}
