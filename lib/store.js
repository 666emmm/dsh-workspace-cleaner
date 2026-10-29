/**
 * Durable, plugin-owned state: the session↔folder links and the cleaner settings.
 *
 * Deliberately a plain JSON file under the DSH home, not the settings namespace:
 * `settings.register` no longer exists on this Harness generation (the settings
 * service now owns form documents), so a plugin that wants to remember a value
 * across restarts writes its own file.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** Where the plugin keeps its state, next to the other DSH data. */
export function stateDir(home) {
  return join(home ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'workspace-cleaner')
}

/**
 * Read one JSON file, returning `fallback` for anything unreadable.
 * A corrupt state file must degrade to defaults, never block the plugin.
 */
function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    const text = readFileSync(path, 'utf8')
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

/** Write JSON atomically: a torn write would lose every link at once. */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, path)
}

/** Default settings; every field is user-editable through the settings page. */
export const DEFAULT_SETTINGS = {
  /** Grouping rules evaluated before the extension table. */
  rules: [
    { match: 'screenshot', folder: 'screenshots' },
    { match: '截图', folder: 'screenshots' },
    { match: '报告', folder: 'reports' },
  ],
  defaultFolder: '_misc',
  /** Remove directories that became empty after moving their contents. */
  removeEmptyDirs: true,
  /** Refuse to move a file another file in the workspace still names. */
  blockReferencedFiles: true,
  /** Ask before moving anything: the page always previews first. */
  dryRunDefault: true,
  /** Folders that must never be touched, in addition to the built-in list. */
  protectedNames: [],
  /**
   * Folders or files the user locked: never moved, never renamed, never used as
   * a grouping target. This is the answer for names that must stay ASCII in a
   * workspace whose session folders are Chinese — no heuristic can infer it.
   * Exact names or `*` wildcards.
   */
  lockedNames: [],
}

/** State file paths for one installation. */
export function statePaths(home) {
  const dir = stateDir(home)
  return {
    dir,
    links: join(dir, 'links.json'),
    settings: join(dir, 'settings.json'),
    journal: join(dir, 'journal.jsonl'),
    ai: join(dir, 'ai-session.json'),
    pending: join(dir, 'pending-plan.json'),
  }
}

/** Read the persisted settings merged over the defaults. */
export function loadSettings(home) {
  const paths = statePaths(home)
  const stored = readJson(paths.settings, {})
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    rules: Array.isArray(stored.rules) ? stored.rules : DEFAULT_SETTINGS.rules,
    protectedNames: Array.isArray(stored.protectedNames) ? stored.protectedNames : [],
    lockedNames: Array.isArray(stored.lockedNames)
      ? stored.lockedNames.filter(name => typeof name === 'string' && name.trim().length > 0)
      : [],
  }
}

/** Persist a settings patch; unknown keys are dropped so the file stays readable. */
export function saveSettings(home, patch) {
  const paths = statePaths(home)
  const current = loadSettings(home)
  const next = { ...current }
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key]
  }
  writeJson(paths.settings, next)
  return next
}

/**
 * Read the session→folder link table.
 * Shape: `{ [sessionId]: { folder, workspacePath, title, updatedAt } }`.
 */
export function loadLinks(home) {
  const paths = statePaths(home)
  const stored = readJson(paths.links, {})
  const links = stored.links && typeof stored.links === 'object' ? stored.links : {}
  return links
}

/** Replace one link, or drop it when `folder` is empty. */
export function setLink(home, sessionId, value) {
  const paths = statePaths(home)
  const links = loadLinks(home)
  if (!value || !value.folder) delete links[sessionId]
  else links[sessionId] = { ...value, updatedAt: new Date().toISOString() }
  writeJson(paths.links, { version: 1, links })
  return links
}

/**
 * The remembered AI-judgement session per workspace path.
 *
 * One session per workspace, reused rather than recreated: a fresh session per
 * click would leave a trail of half-finished conversations in the sidebar, and
 * the reuse path is what `sessionController.prompt` already supports (it
 * resumes a cold session on its own).
 */
export function loadAiSession(home, workspacePath) {
  const stored = readJson(statePaths(home).ai, {})
  const map = stored.sessions && typeof stored.sessions === 'object' ? stored.sessions : {}
  return map[workspacePath]
}

/** Remember (or forget, with `null`) the AI session for one workspace path. */
export function saveAiSession(home, workspacePath, sessionId) {
  const paths = statePaths(home)
  const stored = readJson(paths.ai, {})
  const map = stored.sessions && typeof stored.sessions === 'object' ? stored.sessions : {}
  if (!sessionId) delete map[workspacePath]
  else map[workspacePath] = { sessionId, at: new Date().toISOString() }
  writeJson(paths.ai, { version: 1, sessions: map })
  return map[workspacePath] ?? null
}

/** Append one journal line describing a move, so a run can be explained later. */
export function appendJournal(home, record) {
  const paths = statePaths(home)
  try {
    mkdirSync(paths.dir, { recursive: true })
    const line = JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n'
    const previous = existsSync(paths.journal) ? readFileSync(paths.journal, 'utf8') : ''
    writeFileSync(paths.journal, previous + line, 'utf8')
  } catch {
    // A journal that cannot be written must not fail the move it describes.
  }
}

/** Return the most recent journal lines, newest last. */
export function readJournal(home, limit = 100) {
  const paths = statePaths(home)
  try {
    if (!existsSync(paths.journal)) return []
    const lines = readFileSync(paths.journal, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit).map(line => {
      try { return JSON.parse(line) } catch { return { raw: line } }
    })
  } catch {
    return []
  }
}
