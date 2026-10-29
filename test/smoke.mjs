/**
 * Smoke test for the tidying engine, run against a throwaway directory.
 *
 * It exists because the interesting failures here are silent ones: a file that
 * moved into the wrong folder, a directory the user made that got moved, or a
 * verification pass that claims zero references when there are some.
 *
 * Usage: node test/smoke.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildPlan, applyPlan, scanDependencies, renameSessionFolder } from '../lib/cleaner.js'
import { folderNameFromTitle, isSafeName } from '../lib/fs-util.js'

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

/** Fixture: a workspace with every category the classifier must distinguish. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wc-smoke-'))
  mkdirSync(join(root, 'deveco-review'))
  mkdirSync(join(root, 'node_modules'))
  mkdirSync(join(root, '.dsh-knowledge'))
  mkdirSync(join(root, 'tts-output', 'out'), { recursive: true })
  writeFileSync(join(root, 'canvas-demo.png'), 'png-bytes')
  writeFileSync(join(root, 'report.md'), '# report')
  writeFileSync(join(root, 'data.csv'), 'a,b\n1,2\n')
  writeFileSync(join(root, 'build.py'), 'import os\nOUT = os.path.join(os.path.dirname(__file__), "tts-output")\n')
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ output: 'tts-output', voice: 'x' }, null, 2))
  writeFileSync(join(root, 'package.json'), '{"name":"x"}')
  writeFileSync(join(root, 'tts-output', 'out', 'keep.txt'), 'inner')
  return root
}

console.log('name helpers')
check('rejects a path separator', isSafeName('a/b') === false)
check('accepts Chinese with spaces', isSafeName('价格 对比') === true)
check('rejects a trailing dot', isSafeName('name.') === false)
check('strips illegal chars from a title', folderNameFromTitle('a/b:c', 'x') === 'a b c')
check('falls back for an empty title', folderNameFromTitle('   ', 'fb') === 'fb')

const root = fixture()
console.log(`\nfixture: ${root}`)

console.log('\nscan')
const scan = scanDependencies(root)
check('finds the config-declared directory', scan.referencedDirs.includes('tts-output'), scan.referencedDirs)
check('skips node_modules in the walk', scan.occurrences.every(hit => !hit.file.startsWith('node_modules')))

console.log('\nplan')
const plan = buildPlan(root, {
  settings: {
    rules: [{ match: 'report', folder: 'reports' }],
    defaultFolder: '_misc',
    removeEmptyDirs: true,
    blockReferencedFiles: true,
  },
})
check('plan is ok', plan.ok === true, plan.error)
const byName = Object.fromEntries(plan.classification.map(item => [item.name, item]))

check('user directory is untouchable', byName['deveco-review']?.movable === false
  && byName['deveco-review']?.category === 'existing-dir', byName['deveco-review'])
check('node_modules is a fixed dir', byName['node_modules']?.category === 'fixed-dir')
check('.dsh-knowledge is a fixed dir', byName['.dsh-knowledge']?.category === 'fixed-dir')
check('config-declared dir is a fixed dir', byName['tts-output']?.category === 'fixed-dir', byName['tts-output'])
check('package.json is not movable', byName['package.json']?.movable === false, byName['package.json'])
check('canvas-demo.png is movable', byName['canvas-demo.png']?.movable === true, byName['canvas-demo.png'])
check('report.md hit the rule', plan.movable.some(group => group.folder === 'reports'
  && group.files.some(file => file.name === 'report.md')), plan.movable)
check('data.csv was grouped by extension', plan.movable.some(group => group.folder === 'data'))
check('build.py is refused: it resolves against its own path', plan.refused.some(item => item.name === 'build.py' && item.reason === 'self-relative-script'), plan.refused)

console.log('\napply (dry run)')
const dry = applyPlan(root, { groups: plan.movable.map(g => ({ folder: g.folder, files: g.files.map(f => f.name) })) }, {
  settings: plan.settings ?? { removeEmptyDirs: true },
  dryRun: true,
})
check('dry run moved nothing on disk', existsSync(join(root, 'canvas-demo.png')))
check('dry run reported moves', dry.moved.length > 0, dry.moved.length)
check('dry run skipped verification', dry.verify === null)

console.log('\napply (real)')
const real = applyPlan(root, { groups: plan.movable.map(g => ({ folder: g.folder, files: g.files.map(f => f.name) })) }, {
  settings: { removeEmptyDirs: true },
  dryRun: false,
})
check('canvas-demo.png landed in images/', existsSync(join(root, 'images', 'canvas-demo.png')))
check('report.md landed in reports/', existsSync(join(root, 'reports', 'report.md')))
check('data.csv landed in data/', existsSync(join(root, 'data', 'data.csv')))
check('user directory was not moved', existsSync(join(root, 'deveco-review')))
check('fixed directory was not moved', existsSync(join(root, 'tts-output', 'out', 'keep.txt')))
check('no failures', real.failed.length === 0, real.failed)
check('verification reported something', real.verify !== null)

console.log('\nidempotency')
const again = applyPlan(root, { groups: plan.movable.map(g => ({ folder: g.folder, files: g.files.map(f => f.name) })) }, {
  settings: { removeEmptyDirs: true },
  dryRun: false,
})
check('second run moves nothing', again.moved.length === 0, again.moved)
check('second run skips vanished files', again.skipped.every(item => item.reason === 'vanished-since-plan' || item.reason === 'already-at-destination'))

console.log('\nsession folder rename')
writeFileSync(join(root, 'notes.md'), 'x')
mkdirSync(join(root, '旧会话名'))
writeFileSync(join(root, '旧会话名', 'a.txt'), 'a')
const renamed = renameSessionFolder(root, { sessionId: 'abc12345', title: '新会话名', currentFolder: '旧会话名' })
check('rename succeeded', renamed.ok === true && renamed.action === 'rename', renamed)
check('new folder exists', existsSync(join(root, '新会话名', 'a.txt')))
check('old folder is gone', !existsSync(join(root, '旧会话名')))

const noLink = renameSessionFolder(root, { sessionId: 'abc12345', title: '随便', currentFolder: undefined })
check('an unlinked session is only retargeted', noLink.action === 'unlinked', noLink)

console.log('\nlocks')
{
  const lockRoot = mkdtempSync(join(tmpdir(), 'wc-lock-'))
  mkdirSync(join(lockRoot, 'assets'))
  mkdirSync(join(lockRoot, 'assets-extra'))
  mkdirSync(join(lockRoot, '图片素材'))
  mkdirSync(join(lockRoot, 'docs-ascii'))
  writeFileSync(join(lockRoot, 'a.png'), 'x')
  writeFileSync(join(lockRoot, 'locked.txt'), 'y')

  const lockedPlan = buildPlan(lockRoot, {
    settings: { rules: [], defaultFolder: '_misc', lockedNames: ['assets*', 'locked.txt'] },
  })
  const lockByName = Object.fromEntries(lockedPlan.classification.map(item => [item.name, item]))
  check('exact lock is honoured', lockByName['assets']?.reason === 'locked-by-user', lockByName['assets'])
  check('wildcard lock is honoured', lockByName['assets-extra']?.reason === 'locked-by-user', lockByName['assets-extra'])
  check('an unlocked folder is not locked', lockByName['图片素材']?.reason === 'user-directory', lockByName['图片素材'])
  check('a locked file is refused', lockedPlan.refused.some(item => item.name === 'locked.txt' && item.reason === 'locked-by-user'), lockedPlan.refused)

  // A lock on the destination is a lock on the change, not just on the source.
  const targetLocked = buildPlan(lockRoot, {
    settings: { rules: [{ match: '.png', folder: 'assets' }], lockedNames: ['assets'] },
  })
  check('a locked destination refuses the move', targetLocked.refused.some(item => item.reason === 'target-folder-locked'), targetLocked.refused)

  // Locking must also stop a session folder from being renamed.
  const lockedRename = renameSessionFolder(lockRoot, {
    sessionId: 'abc', title: '中文会话名', currentFolder: 'docs-ascii',
  }, { lockedNames: ['docs-ascii'] })
  check('a locked folder is not renamed', lockedRename.action === 'locked' && existsSync(join(lockRoot, 'docs-ascii')), lockedRename)

  const freeRename = renameSessionFolder(lockRoot, {
    sessionId: 'abc', title: '中文会话名', currentFolder: '图片素材',
  }, { lockedNames: ['docs-ascii'] })
  check('an unlocked folder still renames', freeRename.action === 'rename', freeRename)

  rmSync(lockRoot, { recursive: true, force: true })
}

console.log('\ncleanup')
rmSync(root, { recursive: true, force: true })
check('fixture removed', !existsSync(root))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
