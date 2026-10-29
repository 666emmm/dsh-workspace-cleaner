/**
 * Route-level test: drive the handler the way the browser does.
 *
 * The engine test covers file behaviour; this one covers the contract the page
 * actually calls — status codes, the envelope, and the `/state` shape the
 * settings page renders. A route that answers 500 on a healthy workspace is a
 * broken page, and the smoke test would not see it.
 *
 * Usage: node test/routes.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHandler } from '../lib/routes.js'

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`)
  else { failures += 1; console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`) }
}

const root = mkdtempSync(join(tmpdir(), 'wc-routes-'))
mkdirSync(join(root, 'keep-dir'))
mkdirSync(join(root, 'node_modules'))
writeFileSync(join(root, 'a.png'), 'png')
writeFileSync(join(root, 'b.csv'), 'x,y')
writeFileSync(join(root, 'package.json'), '{}')
const home = mkdtempSync(join(tmpdir(), 'wc-home-'))

/** Minimal response double: captures status and JSON body. */
function response() {
  const out = { status: 0, headers: {}, body: '' }
  return {
    set statusCode(value) { out.status = value },
    get statusCode() { return out.status },
    setHeader(key, value) { out.headers[key.toLowerCase()] = value },
    end(text) { out.body = text },
    get result() {
      return { status: out.status, headers: out.headers, json: JSON.parse(out.body || '{}') }
    },
  }
}

/** Minimal request double carrying a JSON body, async-iterable like a real one. */
function request(method, url, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  const stream = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (text) yield Buffer.from(text, 'utf8')
    },
  }
  return stream
}

const runtime = {
  home: () => home,
  defaultRoot: () => root,
  settings: () => ({
    rules: [{ match: 'shot', folder: 'screenshots' }],
    defaultFolder: '_misc',
    removeEmptyDirs: true,
    blockReferencedFiles: true,
    protectedNames: [],
  }),
  workspaceRegistry: () => ({
    list: () => [{
      id: 'ws-1', path: root, title: 'Test Workspace',
      sessionIds: ['s-1'], createdAt: '2026-01-01', updatedAt: '2026-01-01',
    }],
  }),
  sessionController: () => undefined,
  sessionQuery: () => undefined,
  aiSessions: () => ({}),
  record: () => {},
  raw: () => runtime,
}
const handle = createHandler(runtime)

const call = async (method, path, body) => {
  const res = response()
  await handle(request(method, `/workspace-cleaner/api${path}`, body), res)
  return res.result
}

console.log('envelope')
const outside = await call('GET', '/../../etc/passwd')
check('an unrelated path is not served', outside.status === 404 || outside.json.ok !== true, outside)

const state = await call('GET', '/state')
check('/state answers 200', state.status === 200, state.status)
check('/state is ok', state.json.ok === true, state.json)
check('/state lists the workspace', (state.json.result?.workspaces ?? []).length === 1, state.json.result?.workspaces)
check('the workspace carries its title', state.json.result.workspaces[0].title === 'Test Workspace')
check('/state carries settings', typeof state.json.result.settings === 'object')
check('/state carries a state path', typeof state.json.result.statePath === 'string', state.json.result.statePath)

console.log('\nscan')
const scan = await call('POST', '/scan', { root })
check('/scan answers 200', scan.status === 200, scan.status)
check('/scan is ok', scan.json.ok === true, scan.json.error)
check('/scan found loose files', (scan.json.result?.totals?.looseFiles ?? 0) >= 2, scan.json.result?.totals)
check('/scan left node_modules alone', (scan.json.result?.totals?.fixedDirs ?? 0) >= 1)

console.log('\nscan refuses a non-directory')
const bad = await call('POST', '/scan', { root: join(root, 'a.png') })
check('/scan rejects a file as root', bad.json.ok === false && bad.json.code === 'bad-root', bad.json)

console.log('\napply (preview)')
const groups = [{ folder: 'images', files: ['a.png'] }]
const preview = await call('POST', '/apply', { root, groups, dryRun: true })
check('/apply preview is ok', preview.json.ok === true, preview.json.error)
check('preview moved nothing', existsSync(join(root, 'a.png')))

console.log('\napply (real)')
const applied = await call('POST', '/apply', { root, groups, dryRun: false, actor: 'page' })
check('/apply is ok', applied.json.ok === true, applied.json.error)
check('the file moved', existsSync(join(root, 'images', 'a.png')))
check('the response carries a verification', applied.json.result?.verify !== null)
check('the verification found the scanned files', (applied.json.result?.verify?.checked ?? 0) > 0, applied.json.result?.verify)

console.log('\nsettings')
const saved = await call('POST', '/settings', { patch: { defaultFolder: 'other' } })
check('/settings is ok', saved.json.ok === true, saved.json.error)
check('/settings persisted', saved.json.result?.settings?.defaultFolder === 'other', saved.json.result?.settings?.defaultFolder)
const reread = await call('GET', '/state')
check('the new setting survives a reload', reread.json.result?.settings?.defaultFolder === 'other')

console.log('\nask-ai degrades without a session controller')
const ai = await call('POST', '/ask-ai', { root })
check('/ask-ai is ok', ai.json.ok === true, ai.json.error)
check('it reports the missing service instead of throwing', ai.json.result?.action === 'skipped', ai.json.result)

console.log('\npending')
const pending = await call('POST', '/pending', { root })
check('/pending answers none', pending.json.result?.status === 'none', pending.json.result)

console.log('\nunknown route')
const unknown = await call('POST', '/nope')
check('an unknown route is a 404', unknown.status === 404, unknown.status)

rmSync(root, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
