/**
 * Tool-level test: call the registered tools the way the agent runtime does.
 *
 * The engine test covers the maths; this covers the wiring the registry relies
 * on — `execute` receives parsed args and an exec carrying the session, and
 * returns a plain JSON value the declared output schema can render. It also
 * exercises the lock list end to end, because a lock that is honoured in the
 * engine but not passed in by the tool is a lock that does nothing.
 *
 * Usage: node test/tools.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TOOLS, bindToolRuntime } from '../lib/tools.js'

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`)
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`) }
}

const root = mkdtempSync(join(tmpdir(), 'wc-tools-'))
const home = mkdtempSync(join(tmpdir(), 'wc-tools-home-'))
mkdirSync(join(root, 'keep'))
mkdirSync(join(root, '图片素材'))
writeFileSync(join(root, 'a.png'), 'x')
writeFileSync(join(root, 'b.csv'), 'y')
writeFileSync(join(root, 'keep', 'inside.txt'), 'z')

const recorded = []
// Mirrors the runtime `index.js` builds: `home` and `raw` are part of the
// contract the tools read, so a stub without them would test a fiction.
const stubRuntime = {
  home: () => home,
  defaultRoot: () => root,
  settings: () => ({
    rules: [], defaultFolder: '_misc', removeEmptyDirs: true,
    blockReferencedFiles: true, lockedNames: ['keep'],
  }),
  record: (entry) => recorded.push(entry),
  workspaceRegistry: () => undefined,
  sessionController: () => undefined,
  sessionQuery: () => undefined,
  aiSessions: () => ({}),
}
stubRuntime.raw = () => stubRuntime
bindToolRuntime(() => stubRuntime)

// The registry hands `execute` the parsed args and an execution identity whose
// agent carries the session; the tools resolve the workspace from it.
const exec = { agent: { session: { header: { cwd: root }, id: 'session-test' } } }
const tool = (name) => TOOLS.find(item => item.name === name)

console.log('registration shape')
for (const item of TOOLS) {
  check(`${item.name}: has a description`, typeof item.description === 'string' && item.description.length > 40)
  check(`${item.name}: declares an output schema`, Boolean(item.output?.schema))
  check(`${item.name}: declares a renderer`, typeof item.output?.render === 'function')
  check(`${item.name}: parameters are an object schema`, item.parameters?.type === 'object')
  check(`${item.name}: concurrency is declared`, typeof item.isConcurrencySafe === 'function')
}

console.log('\nworkspace_cleaner_plan')
const plan = await tool('workspace_cleaner_plan').execute({}, exec)
check('it answers with an object', plan && typeof plan === 'object')
check('it found both loose files', plan.totals.looseFiles === 2, plan.totals)
check('the locked folder is reported as locked', plan.classification.find(item => item.name === 'keep')?.reason === 'locked-by-user')
check('the Chinese folder is a user directory', plan.classification.find(item => item.name === '图片素材')?.category === 'existing-dir')
check('nothing was moved by planning', existsSync(join(root, 'a.png')))

const explicit = await tool('workspace_cleaner_plan').execute({ workspace: root }, exec)
check('an explicit workspace is honoured', explicit.root === root || explicit.ok === true)

console.log('\nworkspace_cleaner_apply (dry run)')
const groups = plan.movable.map(group => ({ folder: group.folder, files: group.files.map(file => file.name) }))
const dry = await tool('workspace_cleaner_apply').execute({ groups, dryRun: true }, exec)
check('dry run reports the moves', dry.moved.length === 2, dry.moved.length)
check('dry run defaults were not written', existsSync(join(root, 'a.png')))
check('dry run records nothing in the journal', recorded.length === 0, recorded)

console.log('\nworkspace_cleaner_apply (real)')
// `dryRun` defaults to true on purpose — a tool that moves files when a
// parameter is omitted is a footgun. Real writes must be asked for explicitly.
const real = await tool('workspace_cleaner_apply').execute({ groups, dryRun: false }, exec)
check('no failures', real.failed.length === 0, real.failed)
const after = readdirSync(root, { withFileTypes: true })
const files = after.filter(entry => entry.isFile()).map(entry => entry.name)
const dirs = after.filter(entry => entry.isDirectory()).map(entry => entry.name)
check('no loose files remain', files.length === 0, files)
check('images/ was created', dirs.includes('images'), dirs)
check('data/ was created', dirs.includes('data'), dirs)
check('a.png is in images/', existsSync(join(root, 'images', 'a.png')))
check('b.csv is in data/', existsSync(join(root, 'data', 'b.csv')))
check('the locked folder is untouched', existsSync(join(root, 'keep', 'inside.txt')))
check('the user directory is untouched', dirs.includes('图片素材'))
check('the run is recorded', recorded.length === 1 && recorded[0].actor === 'agent', recorded)

console.log('\nworkspace_cleaner_apply (guards)')
let threw = null
try { await tool('workspace_cleaner_apply').execute({ groups: [] }, exec) } catch (error) { threw = error }
check('an empty plan is refused', threw !== null, threw?.message)

let pathEscape = null
try {
  await tool('workspace_cleaner_apply').execute({ groups: [{ folder: 'x', files: ['../escape.txt'] }] }, exec)
} catch (error) { pathEscape = error }
check('a path-escaping name is refused', pathEscape !== null, pathEscape?.message)

console.log('\nworkspace_cleaner_submit_plan')
const submitted = await tool('workspace_cleaner_submit_plan').execute({
  root,
  groups: [{ folder: 'docs', files: ['ghost.txt'] }],
  notes: 'test',
}, exec)
check('unknown files are rejected rather than accepted', submitted.rejected?.length === 1, submitted)

rmSync(root, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
