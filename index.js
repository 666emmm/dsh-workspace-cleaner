/**
 * Host half of dsh-workspace-cleaner.
 *
 * Three responsibilities, all in service of one page:
 * 1. The HTTP surface under `/workspace-cleaner/api` — inventory, dependency
 *    scan, plan, apply, and the workspace list the settings page renders.
 * 2. The three agent tools, which call the same functions the page calls.
 * 3. The session↔folder links, so a folder named after a session follows that
 *    session when it is renamed.
 *
 * Service access follows the compatibility rule this Harness enforces: only the
 * services the plugin cannot work without belong in `inject`. The optional ones
 * — the session controller, the workspace registry, the query service, the
 * persistence feed — come through `ctx.inject`, so the plugin stays active
 * (with reduced features) in a profile that composes fewer of them, instead of
 * failing to activate.
 */

import { join } from 'node:path'
import { PREFIX, createHandler, linkSessionFolder } from './lib/routes.js'
import { TOOLS, bindToolRuntime } from './lib/tools.js'
import { renameSessionFolder } from './lib/cleaner.js'
import { loadSettings, loadLinks, loadAiSession, appendJournal } from './lib/store.js'

/** Cordis plugin name; matches the bundle row id. */
export const name = 'dsh-workspace-cleaner'

/** Only the services this plugin cannot run without. */
export const inject = ['webServer', 'tools']

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx host context.
 */
export function apply(ctx) {
  /** Optional services, filled in as they appear and cleared when they leave. */
  const services = {
    sessionController: undefined,
    workspaceRegistry: undefined,
    sessionQuery: undefined,
    workingDirectory: undefined,
  }

  for (const serviceName of Object.keys(services)) {
    // `ctx.inject` keeps the plugin active when the service is absent; a hard
    // `inject` entry would prevent activation entirely, which is the wrong
    // trade for a feature the page can degrade without.
    ctx.inject([serviceName], (scoped) => {
      try {
        services[serviceName] = scoped.get(serviceName)
      } catch {
        services[serviceName] = undefined
      }
      scoped.effect(() => () => { services[serviceName] = undefined })
    })
  }

  const homeDir = () =>
    process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')

  const defaultRoot = () => {
    try {
      const working = services.workingDirectory
      const candidate = working && typeof working.defaultDirectory === 'string' ? working.defaultDirectory : null
      // `defaultDirectory` is the process launch directory, which for a plugin
      // started from a global install is the dsh package folder — not anything
      // the user recognises. Prefer a registered workspace when the two disagree,
      // so the page opens on the folder the person is actually working in.
      const registry = services.workspaceRegistry
      if (registry && typeof registry.list === 'function') {
        const list = registry.list()
        if (candidate) {
          const match = list.find(workspace =>
            String(workspace.path).replace(/[\\/]+/g, '/').toLowerCase()
            === candidate.replace(/[\\/]+/g, '/').toLowerCase())
          if (match) return candidate
        }
        if (list.length > 0) return list[0].path
      }
      if (candidate) return candidate
    } catch {
      // fall through
    }
    return process.cwd()
  }

  /** The runtime the routes and tools read. One object, no hidden globals. */
  const runtime = {
    home: homeDir,
    defaultRoot,
    settings: () => loadSettings(homeDir()),
    workspaceRegistry: () => services.workspaceRegistry,
    sessionController: () => services.sessionController,
    sessionQuery: () => services.sessionQuery,
    aiSessions: () => {
      const ai = loadAiSession(homeDir(), defaultRoot())
      return ai ? { [defaultRoot()]: ai } : {}
    },
    record: (entry) => appendJournal(homeDir(), entry),
    raw: () => runtime,
  }

  bindToolRuntime(() => runtime)

  // ── tools ───────────────────────────────────────────────────────────────
  // `ctx.tools` is a hard dependency, so it is in `inject`: reaching for it
  // without declaring it is exactly the error this Harness reports.
  ctx.effect(() => {
    const disposers = TOOLS.map(tool => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* already gone */ }
      }
    }
  }, 'workspace-cleaner: tools')

  // ── HTTP ────────────────────────────────────────────────────────────────
  ctx.effect(() => {
    const handler = createHandler(runtime)
    return ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler })
  }, 'workspace-cleaner: routes')

  // ── session rename follow-through ───────────────────────────────────────
  /**
   * When the user renames a session, its folder follows.
   *
   * The rename lands durably as a `session/title` event with a `user` source.
   * Listening on that event rather than polling means the folder moves in the
   * same breath as the rename, and a purely automatic title (a `provider` or
   * `fallback` source) never moves a folder the user did not name.
   */
  ctx.inject(['sessionPersistence'], (scoped) => {
    scoped.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'session/title') return
        const source = event.data?.source
        if (!source || source.kind !== 'user') return
        const sessionId = String(session?.id ?? '')
        const title = String(event.data?.title ?? '').trim()
        if (!sessionId || !title) return
        const link = loadLinks(homeDir())[sessionId]
        if (!link?.folder || !link?.workspacePath) return
        const result = renameSessionFolder(link.workspacePath, {
          sessionId, title, currentFolder: link.folder,
        }, { lockedNames: loadSettings(homeDir()).lockedNames })
        if (!result.ok || !result.to || result.action === 'unlinked') return
        linkSessionFolder(runtime, { root: link.workspacePath, sessionId, folder: result.to, title })
        appendJournal(homeDir(), {
          kind: 'rename-folder', root: link.workspacePath, sessionId,
          from: result.from, to: result.to, action: result.action, by: 'session-rename',
        })
      } catch {
        // A folder that cannot follow its session must never fail the rename.
      }
    })
  })

  ctx.logger?.info?.(`workspace cleaner ready at ${PREFIX}`)
}
