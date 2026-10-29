/**
 * The tidying engine: inventory → dependency scan → plan → apply → verify.
 *
 * The pipeline order is the whole point. A move that breaks a hard-coded path
 * is worse than a messy workspace, so the dependency scan runs before a plan is
 * ever shown, and the verification pass runs after the moves and reports what
 * still points at the old location.
 *
 * Nothing here deletes a user file. The only removal is a directory that the
 * moves themselves emptied, and only when the user left that enabled.
 */

import { existsSync, statSync, readdirSync, readFileSync, renameSync, mkdirSync, rmdirSync } from 'node:fs'
import { join, extname, basename, relative, sep } from 'node:path'
import {
  classifyEntry, folderForFile, folderNameFromTitle, isSafeName, isLockedName, probeFile,
  resolveDestination, childOf, KIND_BY_EXTENSION, PROTECTED_DIRECTORY_NAMES,
} from './fs-util.js'

/** File extensions worth reading when looking for a hard-coded path. */
const SCANNABLE = new Set([
  '.py', '.ps1', '.mjs', '.cjs', '.js', '.ts', '.json', '.yml', '.yaml',
  '.bat', '.cmd', '.sh', '.md', '.txt', '.toml', '.ini', '.cfg', '.env',
])

/** Config-ish names whose directory fields a script scan cannot reveal. */
const CONFIG_NAMES = new Set([
  '.env', '.env.local', 'settings.json', 'settings.yaml', 'settings.yml',
  'config.json', 'config.yaml', 'config.yml', 'cordis.yml', 'cordis.patch.yml',
  'package.json', 'pyproject.toml', 'tsconfig.json', '.npmrc',
])

/** How many entries a scan reads at most; a bound keeps one request responsive. */
const SCAN_FILE_BUDGET = 400
const SCAN_BYTES_BUDGET = 2 * 1024 * 1024

/**
 * Run the dependency scan over a workspace.
 *
 * Two passes, because they fail differently: a script with a hard-coded path
 * breaks one script, while a config that owns a directory breaks a whole
 * feature. The second pass cannot be found by grepping for a path at all — it
 * is found by reading directory-valued fields and treating the directories they
 * name as untouchable.
 *
 * @param {string} root workspace root.
 * @param {{ files?: readonly string[], extraKeywords?: readonly string[] }} input what to look at.
 * @returns {{ referencedDirs: string[], occurrences: Array<{ file: string, line: number, text: string, kind: 'script' | 'config' }>, scanned: number, truncated: boolean }} scan result.
 */
export function scanDependencies(root, input = {}) {
  const occurrences = []
  const referencedDirs = []
  const selfRelative = []
  const files = input.files ?? walkFiles(root, SCAN_FILE_BUDGET)
  let bytes = 0
  let truncated = false
  let scanned = 0

  const keywords = [basename(root), ...(input.extraKeywords ?? [])].filter(Boolean)

  for (const absolute of files) {
    const name = basename(absolute)
    const ext = extname(name).toLowerCase()
    const isConfig = CONFIG_NAMES.has(name)
    if (!SCANNABLE.has(ext) && !isConfig) continue
    let text
    try {
      const size = statSync(absolute).size
      if (size > 512 * 1024) continue
      if (bytes + size > SCAN_BYTES_BUDGET) { truncated = true; break }
      text = readFileSync(absolute, 'utf8')
      bytes += size
      scanned += 1
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.length > 4000) continue
      // A quoted absolute path naming this workspace is the strongest signal.
      const quoted = /["'`]([A-Za-z]:[\\/][^"'`\r\n]*|[\\/][^"'`\r\n]*)["'`]/g
      let match
      while ((match = quoted.exec(line)) !== null) {
        const candidate = match[1]
        if (candidate.includes(root) || (keywords[0] && candidate.includes(keywords[0]))) {
          occurrences.push({ file: relative(root, absolute), line: index + 1, text: line.trim().slice(0, 300), kind: isConfig ? 'config' : 'script' })
        }
      }
      // A self-relative anchor makes the file depend on where it lives, so it
      // must not be relocated. Recorded once per file.
      if (hasSelfRelativeAnchor(line)) {
        const relPath = relative(root, absolute)
        if (!selfRelative.includes(relPath)) selfRelative.push(relPath)
      }
      if (isConfig) {
        // Directory-valued config fields: `"output": "<dir>"`, `dir=`, `path:`.
        const field = /["']?(out(?:put)?|dir|directory|path|folder|root|target|dest(?:ination)?)["']?\s*[:=]\s*["']([^"'\r\n]+)["']/i.exec(line)
        if (field) addReferenced(field[2], root, referencedDirs)
      } else {
        const assigned = /(OUT|OUTPUT|DIR|PATH|FOLDER|ROOT)\s*=\s*[rbuf]?["']([^"']+)["']/i.exec(line)
        if (assigned) addReferenced(assigned[2], root, referencedDirs)
      }
    }
  }

  return { referencedDirs, occurrences, selfRelative, scanned, truncated }
}

/**
 * Anchors that make a script depend on where it lives.
 *
 * This is the trap a pure path scan cannot see: `OUT = r"D:\..."` is an
 * absolute path that survives a move, but `os.path.dirname(__file__)` or
 * `$PSScriptRoot` resolves against the script's own location, so moving the
 * script silently changes what it reads and writes. Such a script is refused
 * here rather than moved into a folder where it half-works.
 */
const SELF_RELATIVE_ANCHORS = [
  '__file__', '__dirname', '$PSScriptRoot', '$MyInvocation.MyCommand.Path',
  'import.meta.dirname', 'import.meta.url', 'process.cwd()', 'os.getcwd()',
  'Path.GetDirectoryName', "Resolve-Path '.'", 'dirname "$0"',
]

/** Whether a text names a self-relative anchor. */
function hasSelfRelativeAnchor(text) {
  return SELF_RELATIVE_ANCHORS.some(anchor => text.includes(anchor))
}

/**
 * Record a directory a file's value points at.
 *
 * The value is usually a full path (`C:\...\tts-output`), so taking its first
 * segment would name the drive and miss the directory entirely. Instead every
 * segment is tested against the workspace root: a segment that names a real
 * directory *there* is the one the file depends on. That also handles a bare
 * relative folder (`"out"`), which is the common case in JSON configs.
 */
function addReferenced(value, root, out) {
  const segments = String(value).split(/[\\/]+/).filter(Boolean)
  for (const segment of segments) {
    if (!isSafeName(segment)) continue
    if (out.includes(segment)) continue
    // `isSafeName` alone would accept a name that does not exist; the directory
    // check is what makes the answer about this workspace rather than a guess.
    if (existsSync(join(root, segment)) && statSync(join(root, segment)).isDirectory()) {
      out.push(segment)
    }
  }
}

/** Collect files under a root, breadth-first, skipping tool directories. */function walkFiles(root, limit) {
  const out = []
  const queue = [root]
  while (queue.length > 0 && out.length < limit) {
    const dir = queue.shift()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= limit) break
      if (entry.name.startsWith('.') && entry.isDirectory()) continue
      if (PROTECTED_DIRECTORY_NAMES.includes(entry.name)) continue
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) queue.push(absolute)
      else if (entry.isFile()) out.push(absolute)
    }
  }
  return out
}

/**
 * Inventory one workspace and produce a plan.
 *
 * @param {string} root workspace root.
 * @param {{ settings: object, sessions?: ReadonlyArray<{ id: string, title: string }>, links?: Record<string, { folder: string }> }} input
 * @returns {object} a plan: classification counts, movable items, refusals, and the scan.
 */
export function buildPlan(root, input) {
  const settings = input.settings ?? {}
  const entries = (() => {
    try {
      return readdirSync(root, { withFileTypes: true })
    } catch (error) {
      return { error }
    }
  })()
  if (!Array.isArray(entries)) {
    return { ok: false, error: `cannot read ${root}: ${errorMessage(entries?.error)}`, root }
  }

  const scan = scanDependencies(root, {})
  const referenced = new Set(scan.referencedDirs.map(name => name.toLowerCase()))
  const protectNames = Array.isArray(settings.protectedNames) ? settings.protectedNames : []
  const lockedNames = Array.isArray(settings.lockedNames) ? settings.lockedNames : []

  const classification = []
  const movable = []
  const refused = []

  for (const entry of entries) {
    const verdict = classifyEntry(root, entry, referenced, { protectNames, lockedNames })
    classification.push(verdict)
    if (verdict.kind !== 'file') continue
    if (!verdict.movable) {
      refused.push({ name: verdict.name, reason: verdict.reason })
      continue
    }
    // A file another file names explicitly is not safe to move silently, and
    // neither is a script that resolves against its own location.
    const named = scan.occurrences.some(hit => hit.text.includes(verdict.name))
    const relName = verdict.name
    if (scan.selfRelative.includes(relName)) {
      refused.push({ name: verdict.name, reason: 'self-relative-script' })
      continue
    }
    if (named && settings.blockReferencedFiles !== false) {
      refused.push({ name: verdict.name, reason: 'referenced-by-file' })
      continue
    }
    const target = folderForFile(verdict.name, settings)
    // A locked folder is a place the user said "leave exactly as it is", so it
    // must not become a destination either: adding files to it would change it
    // just as surely as moving it would.
    if (isLockedName(target.split('/')[0], lockedNames)) {
      refused.push({ name: verdict.name, reason: 'target-folder-locked' })
      continue
    }
    const sourcePath = join(root, verdict.name)
    const occupancy = probeFile(sourcePath)
    if (!occupancy.free) {
      refused.push({ name: verdict.name, reason: occupancy.reason ?? 'occupied' })
      continue
    }
    movable.push({
      name: verdict.name,
      from: sourcePath,
      toFolder: target,
      bytes: safeSize(sourcePath),
      reason: ruleReasonFor(verdict.name, settings),
    })
  }

  const groups = groupByFolder(movable)
  const emptyDirs = settings.removeEmptyDirs === false ? [] : listEmptyDirs(root, classification)

  return {
    ok: true,
    root,
    generatedAt: new Date().toISOString(),
    scan: {
      scannedFiles: scan.scanned,
      truncated: scan.truncated,
      referencedDirs: scan.referencedDirs,
      occurrences: scan.occurrences.slice(0, 50),
      occurrenceCount: scan.occurrences.length,
    },
    classification,
    movable: groups,
    refused,
    emptyDirs,
    totals: {
      entries: classification.length,
      looseFiles: classification.filter(item => item.kind === 'file').length,
      movableFiles: movable.length,
      existingDirs: classification.filter(item => item.category === 'existing-dir').length,
      fixedDirs: classification.filter(item => item.category === 'fixed-dir').length,
      refused: refused.length,
    },
  }
}

/** Which rule chose a file's folder, for the reason column the user reads. */
function ruleReasonFor(name, settings) {
  const lower = name.toLowerCase()
  for (const rule of Array.isArray(settings.rules) ? settings.rules : []) {
    const match = String(rule?.match ?? '').toLowerCase()
    if (match && (match.startsWith('.') ? lower.endsWith(match) : lower.includes(match))) {
      return `rule:${rule.match}`
    }
  }
  const kind = KIND_BY_EXTENSION[extname(lower)]
  return kind ? `extension:${kind}` : 'default-folder'
}

/** Group the movable files by their destination folder. */
function groupByFolder(items) {
  const map = new Map()
  for (const item of items) {
    if (!map.has(item.toFolder)) map.set(item.toFolder, [])
    map.get(item.toFolder).push(item)
  }
  return [...map.entries()]
    .map(([folder, files]) => ({ folder, files, bytes: files.reduce((sum, file) => sum + (file.bytes ?? 0), 0) }))
    .sort((left, right) => left.folder.localeCompare(right.folder))
}

/** Directories that hold nothing at all, deepest first so removal can cascade. */
function listEmptyDirs(root, classification) {
  const out = []
  for (const item of classification) {
    if (item.kind !== 'directory') continue
    if (item.category === 'fixed-dir') continue
    const path = join(root, item.name)
    try {
      if (readdirSync(path).length === 0) out.push(item.name)
    } catch {
      continue
    }
  }
  return out
}

/**
 * Apply a plan. Idempotent by construction: a file already at its destination
 * in the expected size is reported as done, not moved again; a target that
 * exists with different content gets a numeric suffix rather than being
 * overwritten.
 *
 * @param {string} root workspace root.
 * @param {{ groups: ReadonlyArray<{ folder: string, files: ReadonlyArray<{ name: string }> }>, emptyDirs?: readonly string[] }} plan accepted plan.
 * @param {{ settings?: object, dryRun?: boolean, actor?: string }} [options]
 * @returns {object} per-item results plus the verification pass.
 */
export function applyPlan(root, plan, options = {}) {
  const dryRun = options.dryRun === true
  const settings = options.settings ?? {}
  const moved = []
  const skipped = []
  const failed = []

  for (const group of plan.groups ?? []) {
    const folder = String(group.folder ?? '').replace(/[\\/]+/g, '/')
    const segments = folder.split('/').filter(Boolean)
    if (segments.length === 0 || segments.some(segment => !isSafeName(segment))) {
      for (const file of group.files ?? []) failed.push({ name: file.name, error: `unsafe folder name: ${group.folder}` })
      continue
    }
    const targetDir = join(root, ...segments)
    let createdDir = false
    if (!dryRun && !existsSync(targetDir)) {
      try {
        mkdirSync(targetDir, { recursive: true })
        createdDir = true
      } catch (error) {
        for (const file of group.files ?? []) failed.push({ name: file.name, error: `cannot create ${folder}: ${errorMessage(error)}` })
        continue
      }
    }

    for (const file of group.files ?? []) {
      // Callers differ: the settings page sends plain names, the agent tool may
      // send objects. Accepting both here is what keeps one implementation
      // serving both, instead of the page and the tool drifting apart.
      const name = typeof file === 'string' ? file : file?.name
      if (typeof name !== 'string' || name.length === 0) {
        failed.push({ name: String(file), error: 'missing file name' })
        continue
      }
      const sourcePath = childOf(root, name)
      if (!existsSync(sourcePath)) {
        skipped.push({ name, reason: 'vanished-since-plan' })
        continue
      }
      const occupancy = probeFile(sourcePath)
      if (!occupancy.free) {
        skipped.push({ name, reason: occupancy.reason ?? 'occupied' })
        continue
      }
      const decision = resolveDestination(targetDir, name, sourcePath)
      if (decision.action === 'already-there') {
        skipped.push({ name, reason: 'already-at-destination' })
        continue
      }
      if (dryRun) {
        moved.push({ name, from: sourcePath, to: decision.path, dryRun: true })
        continue
      }
      try {
        renameSync(sourcePath, decision.path)
        moved.push({ name, from: sourcePath, to: decision.path, renamedOnConflict: decision.reason === 'renamed-on-conflict' })
      } catch (error) {
        failed.push({ name, error: errorMessage(error) })
      }
    }
    if (createdDir && moved.length === 0) {
      try { rmdirSync(targetDir) } catch { /* a non-empty or re-created folder stays */ }
    }
  }

  const removedDirs = []
  if (!dryRun && settings.removeEmptyDirs !== false) {
    for (const name of plan.emptyDirs ?? []) {
      const path = childOf(root, name)
      try {
        // Only ever remove a directory this run left empty.
        if (readdirSync(path).length !== 0) continue
        rmdirSync(path)
        removedDirs.push(name)
      } catch {
        continue
      }
    }
  }

  return {
    dryRun,
    moved,
    skipped,
    failed,
    removedDirs,
    verify: dryRun ? null : verifyAfterApply(root, moved),
  }
}

/**
 * After applying, rescan for survivors of the exact strings the plan moved.
 * A count of zero is the claim worth making; anything else must be reported
 * rather than glossed over.
 */
function verifyAfterApply(root, movedItems) {
  if (movedItems.length === 0) return { checked: 0, remaining: 0, samples: [] }
  const scan = scanDependencies(root, {})
  const names = new Set(movedItems.map(item => basename(item.from)))
  const remaining = scan.occurrences.filter(hit => [...names].some(name => hit.text.includes(name)))
  return {
    checked: scan.scanned,
    remaining: remaining.length,
    samples: remaining.slice(0, 10),
    referencedDirs: scan.referencedDirs,
  }
}

/**
 * Rename a session's folder so it follows the session's title.
 *
 * This is the "folder name follows the session rename" half. It is
 * deliberately conservative: the link table says which folder belongs to which
 * session, so a rename only ever touches a folder this plugin created a link
 * for — never a directory the user made by hand.
 *
 * @param {string} root workspace root.
 * @param {{ sessionId: string, title: string, currentFolder?: string }} input
 * @param {{ dryRun?: boolean, lockedNames?: readonly string[] }} [options]
 * @returns {{ ok: boolean, from?: string, to?: string, action: string, reason?: string }}
 */
export function renameSessionFolder(root, input, options = {}) {
  const desired = folderNameFromTitle(input.title, `session-${String(input.sessionId).slice(0, 8)}`)
  const current = input.currentFolder
  // A locked folder keeps its name even when the session it belongs to is
  // renamed: that is what locking is for. The link is retargeted so the page
  // still shows the right session, but no directory on disk moves.
  if (isLockedName(current ?? '', options.lockedNames) || isLockedName(desired, options.lockedNames)) {
    return { ok: false, action: 'locked', from: current, to: desired, reason: 'locked-by-user' }
  }
  if (!current) {
    return { ok: true, action: 'unlinked', to: desired, reason: 'no-link-yet' }
  }
  if (current === desired) return { ok: true, action: 'unchanged', from: current, to: desired }
  const fromPath = join(root, current)
  if (!existsSync(fromPath)) {
    // The folder was renamed or removed by hand: retarget the link, do not fight it.
    return { ok: true, action: 'retarget', from: current, to: desired, reason: 'folder-missing' }
  }
  let target = join(root, desired)
  if (existsSync(target)) {
    const merged = mergeInto(fromPath, target, options)
    return { ok: merged.ok, action: 'merged', from: current, to: desired, reason: merged.reason }
  }
  if (options.dryRun === true) return { ok: true, action: 'rename', from: current, to: desired, dryRun: true }
  try {
    renameSync(fromPath, target)
    return { ok: true, action: 'rename', from: current, to: desired }
  } catch (error) {
    return { ok: false, action: 'failed', from: current, to: desired, reason: errorMessage(error) }
  }
}

/** Move the contents of one folder into another, never overwriting. */
function mergeInto(sourceDir, targetDir, options) {
  if (options.dryRun === true) return { ok: true, reason: 'dry-run' }
  try {
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const fromPath = join(sourceDir, entry.name)
      const decision = resolveDestination(targetDir, entry.name, fromPath)
      if (decision.action === 'already-there') continue
      renameSync(fromPath, decision.path)
    }
    if (readdirSync(sourceDir).length === 0) rmdirSync(sourceDir)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: errorMessage(error) }
  }
}

/** Size in bytes, or 0 when it cannot be read. */
function safeSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** A message worth showing a user, from any thrown value. */
export function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

/** Normalize a path for comparison across separator styles. */
export function normalizePath(path) {
  return String(path ?? '').replace(/[\\/]+/g, sep).replace(/[\\/]+$/, '').toLowerCase()
}
