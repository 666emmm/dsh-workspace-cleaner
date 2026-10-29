/**
 * Client-half test: load `client.js` the way the browser loader does, then
 * render the registered page with a stub React.
 *
 * `node --check` only proves the file parses. The failures that actually break
 * this page are render-time ones — a hook called conditionally, an undefined
 * helper, a props shape the owner does not pass — and those only surface by
 * running the component. React itself is stubbed to the six hooks this page
 * uses, so the test stays honest about what it covers: it proves the component
 * runs and produces a tree, not that the browser paints it.
 *
 * Usage: node test/client.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`)
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`) }
}

// ── a React small enough to reason about ──────────────────────────────────
let hookIndex = 0
let hookStore = []
const React = {
  createElement(type, props, ...children) {
    // Function components run immediately, the way React resolves them during a
    // render pass. Recording only the reference would leave every child's text
    // out of the tree, which is exactly what a render test needs to see.
    if (typeof type === 'function') return type({ ...(props ?? {}), children })
    return { type, props: props ?? {}, children: children.flat(Infinity) }
  },
  useState(initial) {
    const index = hookIndex++
    if (!(index in hookStore)) hookStore[index] = typeof initial === 'function' ? initial() : initial
    return [hookStore[index], (next) => { hookStore[index] = typeof next === 'function' ? next(hookStore[index]) : next }]
  },
  useEffect() { hookIndex += 1 },
  useCallback(fn) { hookIndex += 1; return fn },
  useMemo(fn) { hookIndex += 1; return fn() },
  useRef(initial) { hookIndex += 1; return { current: initial } },
}

// ── the loader contract ───────────────────────────────────────────────────
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(module) { loaded = module },
  },
}
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', remove() {} }),
  head: { appendChild() {} },
}
globalThis.fetch = async () => ({ json: async () => ({ ok: true, result: null }), status: 200 })

const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
// The client is a script for the browser loader, not an ES module: evaluate it
// with the globals above visible.
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'fetch', 'React', source)(globalThis.window, globalThis.document, globalThis.fetch, null)

console.log('module registration')
check('the loader received exactly one module', loaded !== null && typeof loaded === 'object')
check('the id matches the bundle', loaded?.id === 'dsh-workspace-cleaner', loaded?.id)
check('a factory is present', typeof loaded?.factory === 'function')

const factory = loaded.factory
const requiredNames = []
const plugin = factory((name) => {
  requiredNames.push(name)
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})

console.log('\nplugin shape')
check('it asks only for react', requiredNames.length === 1 && requiredNames[0] === 'react', requiredNames)
check('it declares the slots it uses', Array.isArray(plugin.inject) && plugin.inject.includes('slots'), plugin.inject)
check('it declares locale', Array.isArray(plugin.inject) && plugin.inject.includes('locale'), plugin.inject)

// ── apply with a stub context ─────────────────────────────────────────────
const registrations = []
const dictionaries = []
const ctx = {
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  locale: {
    register(ns, dicts) { dictionaries.push({ ns, dicts }); return () => {} },
    bind(ns) { return (key) => key },
  },
  slots: {
    inject(key, callback) { registrations.push({ key }); return callback() },
    register(spec, component) { registrations.push({ spec, component }); return () => {} },
  },
}

console.log('\napply')
let applyError = null
try { plugin.apply(ctx) } catch (error) { applyError = error }
check('apply does not throw', applyError === null, applyError?.message)
check('it registers dictionaries for zh and en', dictionaries.length === 1
  && Boolean(dictionaries[0].dicts.zh) && Boolean(dictionaries[0].dicts.en), dictionaries.map(d => d.ns))
check('it registers into settings.section', registrations.some(r => r.spec?.name === 'settings.section'))
const page = registrations.find(r => typeof r.component === 'function')
check('the registration carries a component', Boolean(page))

const spec = page.spec
check('the section id is stable', spec.id === 'workspace-cleaner', spec.id)
check('it places itself after the shipped sections', typeof spec.order === 'number' && spec.order >= 500, spec.order)
check('the label is a thunk so it follows the locale', typeof spec.label === 'function', typeof spec.label)

// ── render with realistic props ───────────────────────────────────────────
console.log('\nrender')
hookIndex = 0
hookStore = []
let tree = null
let renderError = null
try {
  tree = page.component({
    locale: { langCode: 'zh' },
    close: () => {},
    useWorkspaces: (selector) => selector?.({ items: [] }),
    useSessions: (selector) => selector?.({ ids: [], byId: {} }),
  })
} catch (error) {
  renderError = error
}
check('the page renders without throwing', renderError === null, renderError?.message)
check('it returns an element', tree !== null && typeof tree === 'object')
const asText = JSON.stringify(tree)
check('the title reaches the tree', asText.includes('工作区整理'))
check('it renders a refresh control', asText.includes('刷新'))
// The settings and lock cards are downstream of `/state`; they must not appear
// before the first successful read, or the page would claim knowledge it has
// not got yet.
check('the lock card waits for state', !asText.includes('锁定目录'))

console.log('\nrender with state')
// Seed the state hook (index 1: `t` is the first hook) with the shape the Host
// actually answers, then render again — this is what the browser does after the
// first `/state` response lands.
const sampleState = {
  workspaces: [{
    workspaceId: 'ws-1',
    path: 'D:\\demo',
    title: '演示工作区',
    sessionIds: ['s1'],
    sessions: [{ id: 's1', title: '整理笔记' }],
    sessionCount: 1,
    latestSessionTitle: '整理笔记',
    links: [{ sessionId: 's1', folder: '整理笔记', title: '整理笔记' }],
    entries: [
      { name: 'assets', directory: true },
      { name: '图片素材', directory: true },
      { name: 'a.png', directory: false },
    ],
  }],
  settings: {
    rules: [{ match: 'shot', folder: 'screenshots' }],
    defaultFolder: '_misc',
    removeEmptyDirs: true,
    blockReferencedFiles: true,
    lockedNames: ['assets'],
  },
  statePath: 'C:\\state',
  journal: [],
  defaultRoot: 'D:\\demo',
}
hookIndex = 0
hookStore = [undefined, sampleState]
let stateTree = null
let stateError = null
try {
  stateTree = page.component({ locale: { langCode: 'zh' }, close: () => {} })
} catch (error) {
  stateError = error
}
check('the page renders with state', stateError === null, stateError?.message)
const withState = JSON.stringify(stateTree)
check('the workspace title appears', withState.includes('演示工作区'))
check('the lock card appears once state is known', withState.includes('锁定目录'))
check('the existing lock is shown', withState.includes('assets'))
check('the settings card appears', withState.includes('分组规则'))
check('the session link row appears', withState.includes('整理笔记'))

console.log('\nenglish locale')
hookIndex = 0
hookStore = []
let enTree = null
let enError = null
try {
  enTree = page.component({ locale: { langCode: 'en' }, close: () => {} })
} catch (error) {
  enError = error
}
check('the page renders in English', enError === null, enError?.message)
check('the English title appears', JSON.stringify(enTree).includes('Workspace Cleaner'))

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
