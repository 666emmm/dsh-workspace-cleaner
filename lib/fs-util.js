/**
 * Filesystem-level helpers: safe names, kind classification, occupancy probes.
 *
 * Everything here is deliberately dependency-free and synchronous-friendly so
 * the scan/plan/apply pipeline can run inside one route handler without
 * importing a filesystem abstraction that a plugin cannot reach.
 */

import { openSync, closeSync, existsSync, statSync, readdirSync } from 'node:fs'
import { extname, join, basename, sep } from 'node:path'

/** Extension groups used by the default grouping rules. */
export const KIND_BY_EXTENSION = {
  '.png': 'images', '.jpg': 'images', '.jpeg': 'images', '.webp': 'images',
  '.gif': 'images', '.bmp': 'images', '.svg': 'images', '.ico': 'images', '.avif': 'images',
  '.mp4': 'media', '.mov': 'media', '.webm': 'media', '.mkv': 'media', '.avi': 'media',
  '.mp3': 'media', '.wav': 'media', '.m4a': 'media', '.flac': 'media', '.ogg': 'media',
  '.md': 'docs', '.txt': 'docs', '.pdf': 'docs', '.docx': 'docs', '.doc': 'docs',
  '.rtf': 'docs', '.pptx': 'docs', '.odt': 'docs',
  '.xlsx': 'data', '.xls': 'data', '.csv': 'data', '.tsv': 'data', '.parquet': 'data',
  '.json': 'data', '.jsonl': 'data', '.yaml': 'data', '.yml': 'data', '.toml': 'data',
  '.xml': 'data', '.sqlite': 'data', '.db': 'data',
  '.zip': 'archives', '.7z': 'archives', '.rar': 'archives', '.gz': 'archives',
  '.tar': 'archives', '.tgz': 'archives',
  '.ps1': 'scripts', '.bat': 'scripts', '.cmd': 'scripts', '.sh': 'scripts',
  '.py': 'scripts', '.mjs': 'scripts', '.cjs': 'scripts', '.js': 'scripts',
  '.ts': 'scripts', '.rb': 'scripts', '.pl': 'scripts',
  '.log': 'logs', '.err': 'logs', '.out': 'logs', '.trace': 'logs',
}

/** Directory names that belong to a tool, not to the user: never moved, never renamed. */
export const PROTECTED_DIRECTORY_NAMES = [
  '.git', '.hg', '.svn', '.github', '.gitlab', '.vscode', '.idea',
  '.dsh-knowledge', '.dsh-knowledge-backup', '.dsh', '.agents', '.claude',
  'node_modules', '.pnpm-store', '.venv', 'venv', '__pycache__', '.next',
  '.cache', '.turbo', 'dist', 'build', 'out', 'target',
]

/** File names that are structural: moving them breaks a toolchain or a convention. */
export const PROTECTED_FILE_NAMES = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'yarn.lock', 'tsconfig.json', 'cordis.yml', 'cordis.patch.yml', 'README.md',
  '.gitignore', '.gitattributes', '.npmrc', '.editorconfig', '.env',
]

/**
 * Whether a raw name can be used as a directory or file name on Windows and
 * POSIX alike. Chinese, spaces, and dashes are explicitly fine.
 * @param {string} name candidate name.
 * @returns {boolean} true when no reserved character or device name appears.
 */
export function isSafeName(name) {
  if (typeof name !== 'string') return false
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > 80) return false
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(trimmed)) return false
  if (/[. ]$/.test(trimmed)) return false
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(trimmed)) return false
  return true
}

/**
 * Turn a session title into a folder name. Lossy on purpose: the result must be
 * a legal path segment, and a title that adapts to a path is more useful than a
 * folder that cannot be created.
 * @param {string} title raw title.
 * @param {string} fallback used when nothing survives.
 * @returns {string} a legal single path segment.
 */
export function folderNameFromTitle(title, fallback) {
  let name = String(title ?? '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
  name = name.replace(/\s+/g, ' ').trim()
  name = name.replace(/[. ]+$/, '')
  if (name.length > 60) name = name.slice(0, 60).trim()
  if (!name || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) return fallback
  return name
}

/**
 * Probe whether a file can be opened exclusively. An editor, a browser, or a
 * host process holding the file makes this throw, which is the whole point:
 * moving a file someone is writing to is how content gets lost.
 * @param {string} path absolute file path.
 * @returns {{ free: boolean, reason?: string }} occupancy answer.
 */
export function probeFile(path) {
  try {
    const fd = openSync(path, 'r+')
    closeSync(fd)
    return { free: true }
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : ''
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
      return { free: false, reason: 'occupied' }
    }
    if (code === 'ENOENT') return { free: false, reason: 'missing' }
    return { free: false, reason: 'unreadable' }
  }
}

/**
 * Whether one name is locked by the user.
 *
 * A lock is the escape hatch for the case no rule can know about: a folder that
 * must keep its English name (a toolchain that rejects non-ASCII paths) while
 * the session folders around it are named in Chinese. A locked entry is never
 * moved, never renamed, and never used as a grouping target.
 *
 * Entries support an exact name (case-insensitive) or a `*` wildcard, so
 * `assets-*` covers a family without listing each member.
 * @param {string} name entry name to test.
 * @param {readonly string[] | undefined} locked user-declared locks.
 * @returns {boolean} true when a lock matches.
 */
export function isLockedName(name, locked) {
  if (typeof name !== 'string' || !Array.isArray(locked)) return false
  const lower = name.toLowerCase()
  for (const raw of locked) {
    const rule = String(raw ?? '').trim().toLowerCase()
    if (!rule) continue
    if (rule === lower) return true
    if (!rule.includes('*')) continue
    // Wildcards are the only metacharacter honored: building the pattern from
    // raw user text is how a lock silently stops matching (`a.b` matching `axb`).
    const pattern = '^' + rule.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
    if (new RegExp(pattern).test(lower)) return true
  }
  return false
}

/**
 * @param {string} root workspace root.
 * @param {import('node:fs').Dirent} entry directory entry.
 * @param {ReadonlySet<string>} referencedDirNames config-referenced directory names.
 * @param {{ protectNames?: readonly string[], lockedNames?: readonly string[] }} [options] extra protections.
 * @returns {{ name: string, kind: 'file' | 'directory', category: 'loose-file' | 'existing-dir' | 'fixed-dir', movable: boolean, reason?: string }} classification.
 */
export function classifyEntry(root, entry, referencedDirNames, options = {}) {
  const name = entry.name
  const protectNames = options.protectNames ?? []
  // A user lock outranks every other rule: it is the one instruction the plugin
  // cannot infer, so nothing may quietly override it.
  if (isLockedName(name, options.lockedNames)) {
    const directory = entry.isDirectory()
    return {
      name,
      kind: directory ? 'directory' : 'file',
      category: directory ? 'fixed-dir' : 'loose-file',
      movable: false,
      reason: 'locked-by-user',
    }
  }
  if (entry.isDirectory()) {
    if (PROTECTED_DIRECTORY_NAMES.includes(name)) {
      return { name, kind: 'directory', category: 'fixed-dir', movable: false, reason: 'tool-directory' }
    }
    if (referencedDirNames.has(name.toLowerCase())) {
      return { name, kind: 'directory', category: 'fixed-dir', movable: false, reason: 'referenced-by-config' }
    }
    return { name, kind: 'directory', category: 'existing-dir', movable: false, reason: 'user-directory' }
  }
  if (!entry.isFile()) {
    return { name, kind: 'file', category: 'loose-file', movable: false, reason: 'not-a-regular-file' }
  }
  if (PROTECTED_FILE_NAMES.includes(name) || protectNames.includes(name)) {
    return { name, kind: 'file', category: 'loose-file', movable: false, reason: 'structural-file' }
  }
  return { name, kind: 'file', category: 'loose-file', movable: true }
}

/**
 * Pick the folder a loose file belongs in, using the configured rules first and
 * the extension table second.
 * @param {string} name file name.
 * @param {{ rules?: ReadonlyArray<{ match: string, folder: string }>, defaultFolder?: string }} settings grouping rules.
 * @returns {string} target folder name relative to the workspace root.
 */
export function folderForFile(name, settings = {}) {
  const rules = Array.isArray(settings.rules) ? settings.rules : []
  const lower = name.toLowerCase()
  for (const rule of rules) {
    const match = String(rule?.match ?? '').toLowerCase()
    if (!match) continue
    if (match.startsWith('.') ? lower.endsWith(match) : lower.includes(match)) {
      return String(rule.folder || settings.defaultFolder || '_misc').replace(/[\\/]+/g, '/')
    }
  }
  const kind = KIND_BY_EXTENSION[extname(lower)] ?? null
  if (kind) return kind
  return String(settings.defaultFolder || '_misc').replace(/[\\/]+/g, '/')
}

/**
 * Resolve a non-colliding destination path inside a folder: an identical file
 * already there is treated as done (idempotent re-run), a different one gets a
 * numeric suffix rather than being overwritten.
 * @param {string} dir destination directory.
 * @param {string} name desired file name.
 * @param {string} sourcePath original absolute path.
 * @returns {{ path: string, action: 'move' | 'already-there', reason?: string }} destination decision.
 */
export function resolveDestination(dir, name, sourcePath) {
  const direct = join(dir, name)
  if (existsSync(direct)) {
    try {
      const a = statSync(direct)
      const b = statSync(sourcePath)
      if (a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2000) {
        return { path: direct, action: 'already-there' }
      }
    } catch {
      return { path: direct, action: 'move', reason: 'stat-failed' }
    }
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    for (let index = 1; index < 1000; index += 1) {
      const candidate = join(dir, `${stem} (${index})${ext}`)
      if (!existsSync(candidate)) return { path: candidate, action: 'move', reason: 'renamed-on-conflict' }
    }
    return { path: direct, action: 'move', reason: 'conflict-budget-exhausted' }
  }
  return { path: direct, action: 'move' }
}

/** Absolute child of a root, guarding against a name that escapes it. */
export function childOf(root, name) {
  if (typeof name !== 'string' || name.length === 0) throw new Error('empty name')
  if (name.includes('/') || name.includes('\\')) throw new Error(`name is not one segment: ${name}`)
  const path = join(root, name)
  if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error(`escapes the workspace: ${name}`)
  return path
}

/** Names of entries currently at a root, cheap and order-stable. */
export function listNames(root) {
  try {
    return readdirSync(root, { withFileTypes: true }).map(entry => ({
      name: entry.name,
      directory: entry.isDirectory(),
      file: entry.isFile(),
    }))
  } catch {
    return []
  }
}

/** Display-only short label for a path. */
export function shortLabel(path) {
  return typeof path === 'string' && path.length > 0 ? basename(path) : path
}
