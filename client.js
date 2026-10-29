/**
 * Browser half of dsh-workspace-cleaner: the settings page.
 *
 * One page registered on `settings.section`. It lists every workspace the Host
 * knows, previews a tidying plan, and applies it. The same operations are agent
 * tools, so this file never owns behaviour of its own — it calls the routes,
 * and the routes call the same functions the tools call.
 *
 * The page states what it does not know instead of implying more: an occupied
 * file, a config-referenced directory, or a refused entry is shown with its
 * reason, because a tidier that silently skips things is worse than none.
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace-cleaner',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const API = '/workspace-cleaner/api'
    const NS = 'workspace-cleaner'

    /** Dictionaries. `label` thunks read these through a bound `t`. */
    const ZH = {
      navLabel: '工作区整理',
      title: '工作区整理',
      subtitle: '盘点根目录里的松散文件，按类型归入子文件夹。已有目录与工具目录不动。',
      refresh: '刷新',
      scan: '盘点并预演',
      scanning: '正在盘点…',
      apply: '执行这次移动',
      applying: '正在移动…',
      askAi: '让 AI 判断',
      askingAi: '已交给 AI 判断…',
      aiWaiting: 'AI 正在判断，等待它把清单写回来…',
      aiReady: 'AI 交回了清单',
      aiNone: '还没有 AI 判断结果',
      syncFolders: '同步会话文件夹名',
      renameFolder: '按会话名改名',
      workspaces: '工作区',
      noWorkspaces: '没有读到工作区。检查 Host 是否挂载了 workspaceRegistry。',
      path: '路径',
      workspaceTitle: '工作区名字',
      latestSession: '最近会话',
      links: '会话文件夹',
      sessions: '个会话',
      looseFiles: '松散文件',
      movable: '待移动',
      refused: '已拒绝',
      existingDirs: '已有目录',
      fixedDirs: '固定目录',
      moved: '已移动',
      skipped: '已跳过',
      failed: '失败',
      removedDirs: '已删除的空目录',
      classifyTitle: '分类结果',
      planTitle: '移动计划',
      refusedTitle: '不动的条目及原因',
      scanTitle: '依赖扫描',
      scanSummary: '扫描文件数',
      scanHits: '命中引用',
      scanDirs: '配置声明的目录',
      scanClean: '没有发现指向旧路径的引用。',
      verifyTitle: '执行后复核',
      verifyOk: '复核：残留引用 0。',
      verifyBad: '复核：仍有残留引用，见下。',
      verifySkipped: '预演未改动磁盘，不做复核。',
      dryRun: '仅预演，不落盘',
      settingsTitle: '分组规则',
      settingsHint: '文件名包含关键字就进对应文件夹；没有命中的按扩展名归类。',
      ruleMatch: '文件名包含',
      ruleFolder: '放入文件夹',
      defaultFolder: '兜底文件夹',
      removeEmptyDirs: '删除移动后变空的目录',
      blockReferencedFiles: '不改动被其它文件引用的文件',
      saveSettings: '保存设置',
      saved: '已保存',
      statePath: '状态文件目录',
      journalTitle: '最近操作',
      empty: '这里还没有内容。先点「盘点并预演」。',
      reason: '原因',
      size: '大小',
      close: '关闭',
      error: '出错了',
      failPrefix: '失败',
      noneToMove: '没有可移动的松散文件。',
      file: '文件',
      dir: '目录',
      actions: '操作',
      scanTruncated: '（扫描达到上限，已截断）',
      lockTitle: '锁定目录（永不移动、永不改名）',
      lockHint: '有些文件夹必须保持英文名（工具链不认中文路径），而会话文件夹是中文的。把这类文件夹锁上，整理会跳过它。支持 * 通配符。',
      lockAdd: '加入锁定',
      lockPlaceholder: '文件夹或文件名，如 assets 或 assets-*',
      lockNone: '还没有锁定任何目录。',
      lockHere: '锁定',
      unlockHere: '解锁',
      reasonLocked: '用户锁定',
      reasonTargetLocked: '目标文件夹已锁定',
    }

    const EN = {
      navLabel: 'Workspace Cleaner',
      title: 'Workspace Cleaner',
      subtitle: 'Inventory loose files at the workspace root and group them into subfolders. Existing and tool-owned directories are left alone.',
      refresh: 'Refresh',
      scan: 'Scan and preview',
      scanning: 'Scanning…',
      apply: 'Apply this move',
      applying: 'Moving…',
      askAi: 'Let AI decide',
      askingAi: 'Handed to AI…',
      aiWaiting: 'The AI is judging; waiting for it to write the list back…',
      aiReady: 'The AI returned a list',
      aiNone: 'No AI judgement yet',
      syncFolders: 'Sync session folder names',
      renameFolder: 'Rename from session',
      workspaces: 'Workspaces',
      noWorkspaces: 'No workspaces were read. Check whether the Host mounts workspaceRegistry.',
      path: 'Path',
      workspaceTitle: 'Workspace name',
      latestSession: 'Latest session',
      links: 'Session folders',
      sessions: 'sessions',
      looseFiles: 'Loose files',
      movable: 'To move',
      refused: 'Refused',
      existingDirs: 'Existing dirs',
      fixedDirs: 'Fixed dirs',
      moved: 'Moved',
      skipped: 'Skipped',
      failed: 'Failed',
      removedDirs: 'Empty dirs removed',
      classifyTitle: 'Classification',
      planTitle: 'Move plan',
      refusedTitle: 'Left alone, and why',
      scanTitle: 'Dependency scan',
      scanSummary: 'Files scanned',
      scanHits: 'Reference hits',
      scanDirs: 'Config-declared dirs',
      scanClean: 'No reference to the old paths was found.',
      verifyTitle: 'Verification after applying',
      verifyOk: 'Verified: 0 references left behind.',
      verifyBad: 'Verified: references still remain, listed below.',
      verifySkipped: 'The preview changed nothing on disk, so there is nothing to verify.',
      dryRun: 'Preview only (no writes)',
      settingsTitle: 'Grouping rules',
      settingsHint: 'A file whose name contains a keyword goes to its folder; anything else is grouped by extension.',
      ruleMatch: 'Name contains',
      ruleFolder: 'Into folder',
      defaultFolder: 'Fallback folder',
      removeEmptyDirs: 'Remove directories the move emptied',
      blockReferencedFiles: 'Do not move files other files reference',
      saveSettings: 'Save settings',
      saved: 'Saved',
      statePath: 'State directory',
      journalTitle: 'Recent operations',
      empty: 'Nothing here yet. Press "Scan and preview".',
      reason: 'Reason',
      size: 'Size',
      close: 'Close',
      error: 'Something went wrong',
      failPrefix: 'Failed',
      noneToMove: 'No loose files to move.',
      file: 'file',
      dir: 'dir',
      actions: 'Actions',
      scanTruncated: '(scan hit its budget and was truncated)',
      lockTitle: 'Locked folders (never moved, never renamed)',
      lockHint: 'Some folders must keep an ASCII name — tools reject non-ASCII paths — while session folders are named in Chinese. Lock those and tidying skips them. A * wildcard is supported.',
      lockAdd: 'Add lock',
      lockPlaceholder: 'Folder or file name, e.g. assets or assets-*',
      lockNone: 'Nothing is locked yet.',
      lockHere: 'Lock',
      unlockHere: 'Unlock',
      reasonLocked: 'locked by user',
      reasonTargetLocked: 'target folder is locked',
    }

    // ── styles ─────────────────────────────────────────────────────────────
    // Component-local style element so unmounting removes it. Every color is a
    // theme token: a renamed token degrades appearance, it never breaks the page.
    const CSS = `
.wc-root { display: flex; flex-direction: column; gap: 18px; padding: 4px 2px 32px; color: var(--dsw-alias-label-primary); }
.wc-head { display: flex; flex-direction: column; gap: 4px; }
.wc-title { font-size: 16px; font-weight: 600; }
.wc-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.wc-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.wc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 12px; font-size: 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; }
.wc-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.wc-btn:disabled { opacity: .5; cursor: default; }
.wc-btn-primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: var(--dsw-alias-bg-base); }
.wc-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.wc-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.wc-ws-title { font-size: 13px; font-weight: 600; }
.wc-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.wc-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.wc-tag { font-size: 11px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.wc-tag-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.wc-tag-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.wc-tag-err { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.wc-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.wc-table th { text-align: left; font-weight: 500; color: var(--dsw-alias-label-secondary); padding: 4px 8px 6px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.wc-table td { padding: 4px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.wc-table tr:last-child td { border-bottom: none; }
.wc-section-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.wc-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); line-height: 1.6; white-space: pre-wrap; }
.wc-ok { font-size: 12px; color: var(--dsw-alias-state-success-primary); }
.wc-warn { font-size: 12px; color: var(--dsw-alias-state-warn-primary); line-height: 1.6; }
.wc-field { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.wc-input { height: 26px; padding: 0 8px; font-size: 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); min-width: 0; }
.wc-check { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
.wc-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.wc-tag-lock { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.wc-tag-x { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 12px; line-height: 1; padding: 0 1px; }
.wc-tag-x:hover { opacity: .7; }
.wc-locks { display: flex; flex-wrap: wrap; gap: 4px; }
.wc-lock-on { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.wc-btn-tiny { height: 24px; padding: 0 9px; font-size: 11px; border-radius: 7px; }
.wc-scroll { max-height: 260px; overflow: auto; }
.wc-divider { height: 1px; background: var(--dsw-alias-border-l1); }
`

    function StyleTag() {
      useEffect(() => {
        const id = 'dsh-workspace-cleaner/style'
        if (document.getElementById(id)) return undefined
        const tag = document.createElement('style')
        tag.id = id
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }, [])
      return null
    }

    // ── transport ──────────────────────────────────────────────────────────
    async function call(path, body, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(API + path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json; charset=utf-8' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!payload || payload.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload.result
    }

    const formatBytes = (bytes) => {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / 1024 / 1024).toFixed(1)} MB`
    }

    /**
     * Client-side twin of the Host's lock matcher, so a lock switch shows its
     * state without a round trip. Kept deliberately small: the Host remains the
     * authority for whether a move is allowed, this only paints the button.
     */
    const isLocked = (name, locked) => {
      if (!name || !Array.isArray(locked)) return false
      const lower = String(name).toLowerCase()
      return locked.some((raw) => {
        const rule = String(raw ?? '').trim().toLowerCase()
        if (!rule) return false
        if (rule === lower) return true
        if (!rule.includes('*')) return false
        const pattern = '^' + rule.split('*')
          .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
        return new RegExp(pattern).test(lower)
      })
    }

    // ── small components ───────────────────────────────────────────────────
    function Tag({ tone, children }) {
      const cls = tone === 'ok' ? 'wc-tag wc-tag-ok' : tone === 'warn' ? 'wc-tag wc-tag-warn'
        : tone === 'err' ? 'wc-tag wc-tag-err' : 'wc-tag'
      return h('span', { className: cls }, children)
    }

    function Totals({ plan, t }) {
      const totals = plan?.totals ?? {}
      return h('div', { className: 'wc-tags' }, [
        h(Tag, { key: 'loose' }, `${t('looseFiles')} ${totals.looseFiles ?? 0}`),
        h(Tag, { key: 'move', tone: (totals.movableFiles ?? 0) > 0 ? 'ok' : undefined }, `${t('movable')} ${totals.movableFiles ?? 0}`),
        h(Tag, { key: 'ref', tone: (totals.refused ?? 0) > 0 ? 'warn' : undefined }, `${t('refused')} ${totals.refused ?? 0}`),
        h(Tag, { key: 'exist' }, `${t('existingDirs')} ${totals.existingDirs ?? 0}`),
        h(Tag, { key: 'fixed' }, `${t('fixedDirs')} ${totals.fixedDirs ?? 0}`),
      ])
    }

    function PlanTable({ plan, t }) {
      const groups = plan?.movable ?? []
      if (groups.length === 0) return h('div', { className: 'wc-empty' }, t('noneToMove'))
      return h('table', { className: 'wc-table' }, [
        h('thead', { key: 'h' }, h('tr', null, [
          h('th', { key: 'f' }, t('scanTitle') && `→ ${t('ruleFolder')}`),
          h('th', { key: 'n' }, t('file')),
          h('th', { key: 's' }, t('size')),
          h('th', { key: 'r' }, t('reason')),
        ])),
        h('tbody', { key: 'b' }, groups.flatMap(group => group.files.map(file => h('tr', { key: `${group.folder}/${file.name}` }, [
          h('td', { key: 'f', className: 'wc-mono' }, group.folder),
          h('td', { key: 'n' }, file.name),
          h('td', { key: 's', className: 'wc-mono' }, formatBytes(file.bytes)),
          h('td', { key: 'r', className: 'wc-mono' }, file.reason ?? ''),
        ])))),
      ])
    }

    function RefusedTable({ plan, t }) {
      const refused = plan?.refused ?? []
      if (refused.length === 0) return null
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
        h('div', { key: 't', className: 'wc-section-title' }, t('refusedTitle')),
        h('div', { key: 'l', className: 'wc-tags' }, refused.slice(0, 40).map(item =>
          h(Tag, { key: item.name + (item.reason ?? ''), tone: 'warn' }, `${item.name} · ${item.reason ?? ''}`))),
      ])
    }

    function ScanPanel({ plan, t }) {
      const scan = plan?.scan
      if (!scan) return null
      const clean = (scan.occurrenceCount ?? 0) === 0 && (scan.referencedDirs ?? []).length === 0
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
        h('div', { key: 't', className: 'wc-section-title' }, t('scanTitle')),
        h('div', { key: 'tags', className: 'wc-tags' }, [
          h(Tag, { key: 'n' }, `${t('scanSummary')} ${scan.scannedFiles ?? 0}${scan.truncated ? ' ' + t('scanTruncated') : ''}`),
          h(Tag, { key: 'h', tone: (scan.occurrenceCount ?? 0) > 0 ? 'warn' : 'ok' }, `${t('scanHits')} ${scan.occurrenceCount ?? 0}`),
          h(Tag, { key: 'd', tone: (scan.referencedDirs ?? []).length > 0 ? 'warn' : undefined },
            `${t('scanDirs')} ${(scan.referencedDirs ?? []).join(', ') || '—'}`),
        ]),
        clean ? h('div', { key: 'c', className: 'wc-ok' }, t('scanClean')) : null,
        (scan.occurrences ?? []).length > 0
          ? h('div', { key: 'l', className: 'wc-scroll' }, h('table', { className: 'wc-table' }, [
            h('thead', { key: 'h' }, h('tr', null, [
              h('th', { key: 'f' }, t('file')), h('th', { key: 'n' }, '#'), h('th', { key: 'x' }, t('reason')),
            ])),
            h('tbody', { key: 'b' }, scan.occurrences.map((hit, index) => h('tr', { key: `${hit.file}:${hit.line}:${index}` }, [
              h('td', { key: 'f', className: 'wc-mono' }, hit.file),
              h('td', { key: 'n', className: 'wc-mono' }, String(hit.line)),
              h('td', { key: 'x', className: 'wc-mono' }, hit.text),
            ]))),
          ]))
          : null,
      ])
    }

    function ResultPanel({ result, t }) {
      if (!result) return null
      const verify = result.verify
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
        h('div', { key: 'tags', className: 'wc-tags' }, [
          h(Tag, { key: 'm', tone: (result.moved ?? []).length > 0 ? 'ok' : undefined }, `${t('moved')} ${(result.moved ?? []).length}`),
          h(Tag, { key: 's' }, `${t('skipped')} ${(result.skipped ?? []).length}`),
          h(Tag, { key: 'f', tone: (result.failed ?? []).length > 0 ? 'err' : undefined }, `${t('failed')} ${(result.failed ?? []).length}`),
          h(Tag, { key: 'r' }, `${t('removedDirs')} ${(result.removedDirs ?? []).length}`),
        ]),
        result.dryRun ? h('div', { key: 'd', className: 'wc-warn' }, t('verifySkipped')) : null,
        verify
          ? h('div', { key: 'v', className: verify.remaining > 0 ? 'wc-warn' : 'wc-ok' },
            verify.remaining > 0 ? `${t('verifyBad')} (${verify.remaining})` : t('verifyOk'))
          : null,
        (result.skipped ?? []).length > 0
          ? h('div', { key: 'k', className: 'wc-tags' }, result.skipped.map(item =>
            h(Tag, { key: item.name + item.reason, tone: 'warn' }, `${item.name} · ${item.reason ?? ''}`)))
          : null,
        (result.failed ?? []).length > 0
          ? h('div', { key: 'e', className: 'wc-tags' }, result.failed.map(item =>
            h(Tag, { key: item.name + item.error, tone: 'err' }, `${item.name} · ${item.error ?? ''}`)))
          : null,
      ])
    }

    // ── workspace card ─────────────────────────────────────────────────────
    function WorkspaceCard({ workspace, state, t, onRefresh }) {
      const [busy, setBusy] = useState('')
      const [plan, setPlan] = useState(null)
      const [result, setResult] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [pending, setPending] = useState(null)
      const [dryRun, setDryRun] = useState(true)
      const pollRef = useRef(0)

      const root = workspace.path
      const lockedNames = Array.isArray(state?.settings?.lockedNames) ? state.settings.lockedNames : []

      const scan = useCallback(async () => {
        setBusy('scan'); setError(''); setNotice(''); setResult(null)
        try {
          const value = await call('/scan', { root })
          setPlan(value)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy('')
        }
      }, [root])

      const applyPlan = useCallback(async (groups) => {
        setBusy('apply'); setError(''); setNotice('')
        try {
          const value = await call('/apply', { root, groups, dryRun, actor: 'page' })
          setResult(value)
          if (!dryRun) await scan()
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy('')
        }
      }, [root, dryRun, scan])

      const askAi = useCallback(async () => {
        setBusy('ai'); setError(''); setNotice('')
        try {
          const value = await call('/ask-ai', { root })
          if (!value.ok) {
            setError(value.reason ?? value.action)
            return
          }
          setNotice(t('askingAi'))
          setPending({ status: 'waiting' })
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy('')
        }
      }, [root, t])

      // Poll for the judgement while one is outstanding. A judgement arrives
      // through a tool call from another session, so there is no event to await.
      useEffect(() => {
        if (!pending || pending.status === 'ready') return undefined
        let cancelled = false
        const tick = async () => {
          try {
            const value = await call('/pending', { root })
            if (cancelled) return
            if (value && value.status === 'ready') setPending(value)
            else {
              pollRef.current += 1
              if (pollRef.current > 100) setPending(null)
            }
          } catch {
            // keep polling: a transient failure is not a verdict
          }
        }
        const handle = setInterval(tick, 3000)
        tick()
        return () => { cancelled = true; clearInterval(handle) }
      }, [pending, root])

      const renameFromSession = useCallback(async (link) => {
        setBusy(`rename:${link.sessionId}`); setError('')
        try {
          const value = await call('/rename-session-folder', {
            root, sessionId: link.sessionId, title: link.title ?? undefined,
          })
          setNotice(`${value.action} → ${value.to ?? ''}`)
          await onRefresh()
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy('')
        }
      }, [root, onRefresh])

      /**
       * Toggle one lock. Locking is a settings write, not a filesystem one, so
       * it is immediate and safe — and the scan is re-run so the user sees the
       * entry change category right away instead of guessing whether it took.
       */
      const toggleLock = useCallback(async (name) => {
        const locked = Array.isArray(state?.settings?.lockedNames) ? state.settings.lockedNames : []
        const next = locked.includes(name)
          ? locked.filter(item => item !== name)
          : [...locked, name]
        setBusy(`lock:${name}`); setError('')
        try {
          await call('/settings', { patch: { lockedNames: next } })
          if (plan) await scan()
          await onRefresh()
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy('')
        }
      }, [state, plan, scan, onRefresh])

      const groups = useMemo(() => {
        if (pending?.status === 'ready' && Array.isArray(pending.groups)) return pending.groups
        if (plan?.movable) {
          return plan.movable.map(group => ({
            folder: group.folder,
            files: group.files.map(file => file.name),
            reason: group.files[0]?.reason,
          }))
        }
        return []
      }, [pending, plan])

      return h('div', { className: 'wc-card' }, [
        h('div', { key: 'head', className: 'wc-card-head' }, [
          h('div', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } }, [
            h('div', { key: 't', className: 'wc-ws-title' }, workspace.title || root),
            h('div', { key: 'p', className: 'wc-mono' }, root),
          ]),
          h('div', { key: 'r', className: 'wc-tags' }, [
            h(Tag, { key: 's' }, `${workspace.sessionCount ?? 0} ${t('sessions')}`),
            workspace.latestSessionTitle
              ? h(Tag, { key: 'st' }, `${t('latestSession')}: ${workspace.latestSessionTitle}`)
              : null,
            (workspace.links ?? []).length > 0
              ? h(Tag, { key: 'lk', tone: 'ok' }, `${t('links')} ${workspace.links.length}`)
              : null,
          ]),
        ]),

        h('div', { key: 'locks', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
          h('div', { key: 't', className: 'wc-section-title' }, t('lockTitle')),
          h('div', { key: 'l', className: 'wc-locks' }, (workspace.entries ?? []).filter(entry => entry.directory).map(entry => {
            const locked = isLocked(entry.name, lockedNames)
            return h('button', {
              key: entry.name,
              className: `wc-btn wc-btn-tiny${locked ? ' wc-lock-on' : ''}`,
              disabled: busy !== '',
              title: locked ? t('unlockHere') : t('lockHere'),
              onClick: () => toggleLock(entry.name),
            }, (locked ? '🔒 ' : '') + entry.name)
          })),
        ]),

        h('div', { key: 'actions', className: 'wc-row' }, [
          h('button', { key: 's', className: 'wc-btn', disabled: busy !== '', onClick: scan },
            busy === 'scan' ? t('scanning') : t('scan')),
          h('button', { key: 'a', className: 'wc-btn wc-btn-primary', disabled: busy !== '' || groups.length === 0, onClick: () => applyPlan(groups) },
            busy === 'apply' ? t('applying') : t('apply')),
          h('button', { key: 'ai', className: 'wc-btn', disabled: busy !== '', onClick: askAi },
            busy === 'ai' ? t('askingAi') : t('askAi')),
          h('label', { key: 'd', className: 'wc-check' }, [
            h('input', { key: 'i', type: 'checkbox', checked: dryRun, onChange: event => setDryRun(event.target.checked) }),
            h('span', { key: 'l' }, t('dryRun')),
          ]),
          (workspace.links ?? []).length > 0
            ? h('button', {
              key: 'r', className: 'wc-btn', disabled: busy !== '',
              onClick: async () => {
                setBusy('sync'); setError('')
                try {
                  await call('/sync-folders', {})
                  await onRefresh()
                } catch (cause) {
                  setError(String(cause?.message ?? cause))
                } finally { setBusy('') }
              },
            }, t('syncFolders'))
            : null,
        ]),

        error ? h('div', { key: 'err', className: 'wc-error' }, `${t('error')}: ${error}`) : null,
        notice ? h('div', { key: 'ok', className: 'wc-ok' }, notice) : null,

        pending?.status === 'waiting' ? h('div', { key: 'pw', className: 'wc-warn' }, t('aiWaiting')) : null,
        pending?.status === 'ready'
          ? h('div', { key: 'pr', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
            h('div', { key: 't', className: 'wc-section-title' }, `${t('aiReady')} · ${pending.groups?.length ?? 0}`),
            pending.notes ? h('div', { key: 'n', className: 'wc-sub' }, pending.notes) : null,
            (pending.rejected ?? []).length > 0
              ? h('div', { key: 'x', className: 'wc-tags' }, pending.rejected.map(item =>
                h(Tag, { key: item.name, tone: 'err' }, `${item.name} · ${item.reason}`)))
              : null,
          ])
          : null,

        (workspace.links ?? []).length > 0
          ? h('div', { key: 'links', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
            h('div', { key: 't', className: 'wc-section-title' }, t('links')),
            ...workspace.links.map(link => h('div', { key: link.sessionId, className: 'wc-row' }, [
              h('span', { key: 'f', className: 'wc-mono' }, link.folder),
              h('span', { key: 'a', className: 'wc-mono' }, '←'),
              h('span', { key: 's' }, link.title ?? link.sessionId.slice(0, 8)),
              h('button', {
                key: 'b', className: 'wc-btn', disabled: busy !== '',
                onClick: () => renameFromSession(link),
              }, t('renameFolder')),
            ])),
          ])
          : null,

        plan
          ? h('div', { key: 'plan', style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
            h(Totals, { key: 't', plan, t }),
            h('div', { key: 'd', className: 'wc-divider' }),
            h(ScanPanel, { key: 's', plan, t }),
            h('div', { key: 't2', className: 'wc-section-title' }, t('planTitle')),
            h('div', { key: 'p', className: 'wc-scroll' }, h(PlanTable, { plan, t })),
            h(RefusedTable, { key: 'r', plan, t }),
          ])
          : null,

        result ? h('div', { key: 'res', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
          h('div', { key: 'd', className: 'wc-divider' }),
          h('div', { key: 't', className: 'wc-section-title' }, t('verifyTitle')),
          h(ResultPanel, { key: 'p', result, t }),
        ]) : null,
      ])
    }

    // ── settings card ──────────────────────────────────────────────────────
    function SettingsCard({ settings, t, onSaved }) {
      const [draft, setDraft] = useState(() => ({
        rules: (settings.rules ?? []).map(rule => ({ ...rule })),
        defaultFolder: settings.defaultFolder ?? '_misc',
        removeEmptyDirs: settings.removeEmptyDirs !== false,
        blockReferencedFiles: settings.blockReferencedFiles !== false,
        lockedNames: Array.isArray(settings.lockedNames) ? [...settings.lockedNames] : [],
      }))
      const [lockInput, setLockInput] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')

      const save = async () => {
        setBusy(true); setError(''); setNotice('')
        try {
          await call('/settings', { patch: draft })
          setNotice(t('saved'))
          onSaved?.()
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'wc-card' }, [
        h('div', { key: 'h', className: 'wc-section-title' }, t('lockTitle')),
        h('div', { key: 'lh', className: 'wc-sub' }, t('lockHint')),
        draft.lockedNames.length === 0
          ? h('div', { key: 'ln', className: 'wc-empty' }, t('lockNone'))
          : h('div', { key: 'll', className: 'wc-tags' }, draft.lockedNames.map(name => h('span', {
            key: name,
            className: 'wc-tag wc-tag-lock',
            title: name,
          }, [
            h('span', { key: 'n' }, name),
            h('button', {
              key: 'x',
              className: 'wc-tag-x',
              'aria-label': `${t('unlockHere')} ${name}`,
              onClick: () => setDraft({ ...draft, lockedNames: draft.lockedNames.filter(item => item !== name) }),
            }, '×'),
          ]))),
        h('div', { key: 'ladd', className: 'wc-row' }, [
          h('input', {
            key: 'i',
            className: 'wc-input',
            placeholder: t('lockPlaceholder'),
            value: lockInput,
            onChange: event => setLockInput(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              const value = lockInput.trim()
              if (!value || draft.lockedNames.includes(value)) return
              setDraft({ ...draft, lockedNames: [...draft.lockedNames, value] })
              setLockInput('')
            },
          }),
          h('button', {
            key: 'b', className: 'wc-btn',
            onClick: () => {
              const value = lockInput.trim()
              if (!value || draft.lockedNames.includes(value)) return
              setDraft({ ...draft, lockedNames: [...draft.lockedNames, value] })
              setLockInput('')
            },
          }, t('lockAdd')),
        ]),
        h('div', { key: 'div2', className: 'wc-divider' }),
        h('div', { key: 'h2', className: 'wc-section-title' }, t('settingsTitle')),
        h('div', { key: 's', className: 'wc-sub' }, t('settingsHint')),
        ...draft.rules.map((rule, index) => h('div', { key: `r${index}`, className: 'wc-row' }, [
          h('span', { key: 'l', className: 'wc-sub' }, t('ruleMatch')),
          h('input', {
            key: 'm', className: 'wc-input', value: rule.match,
            onChange: event => {
              const next = [...draft.rules]
              next[index] = { ...next[index], match: event.target.value }
              setDraft({ ...draft, rules: next })
            },
          }),
          h('span', { key: 'a', className: 'wc-sub' }, '→'),
          h('input', {
            key: 'f', className: 'wc-input', value: rule.folder,
            onChange: event => {
              const next = [...draft.rules]
              next[index] = { ...next[index], folder: event.target.value }
              setDraft({ ...draft, rules: next })
            },
          }),
          h('button', {
            key: 'x', className: 'wc-btn',
            onClick: () => setDraft({ ...draft, rules: draft.rules.filter((_, i) => i !== index) }),
          }, '×'),
        ])),
        h('div', { key: 'add', className: 'wc-row' }, [
          h('button', {
            className: 'wc-btn',
            onClick: () => setDraft({ ...draft, rules: [...draft.rules, { match: '', folder: '' }] }),
          }, '+'),
        ]),
        h('div', { key: 'd', className: 'wc-field' }, [
          h('span', { key: 'l', className: 'wc-sub' }, t('defaultFolder')),
          h('input', {
            key: 'i', className: 'wc-input', value: draft.defaultFolder,
            onChange: event => setDraft({ ...draft, defaultFolder: event.target.value }),
          }),
        ]),
        h('label', { key: 'e', className: 'wc-check' }, [
          h('input', {
            key: 'i', type: 'checkbox', checked: draft.removeEmptyDirs,
            onChange: event => setDraft({ ...draft, removeEmptyDirs: event.target.checked }),
          }),
          h('span', { key: 'l' }, t('removeEmptyDirs')),
        ]),
        h('label', { key: 'b', className: 'wc-check' }, [
          h('input', {
            key: 'i', type: 'checkbox', checked: draft.blockReferencedFiles,
            onChange: event => setDraft({ ...draft, blockReferencedFiles: event.target.checked }),
          }),
          h('span', { key: 'l' }, t('blockReferencedFiles')),
        ]),
        error ? h('div', { key: 'err', className: 'wc-error' }, error) : null,
        notice ? h('div', { key: 'ok', className: 'wc-ok' }, notice) : null,
        h('div', { key: 'save', className: 'wc-row' }, [
          h('button', { key: 's', className: 'wc-btn wc-btn-primary', disabled: busy, onClick: save }, t('saveSettings')),
        ]),
      ])
    }

    // ── the page ───────────────────────────────────────────────────────────
    function WorkspaceCleanerPage(props) {
      const dict = props.locale?.langCode === 'zh' ? ZH : (props.locale?.langCode ? EN : ZH)
      const t = useCallback((key) => dict[key] ?? key, [dict])
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        setBusy(true); setError('')
        try {
          setState(await call('/state'))
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => { load() }, [load])

      return h('div', { className: 'wc-root' }, [
        h(StyleTag, { key: 'style' }),
        h('div', { key: 'head', className: 'wc-head' }, [
          h('div', { key: 't', className: 'wc-title' }, t('title')),
          h('div', { key: 's', className: 'wc-sub' }, t('subtitle')),
        ]),
        h('div', { key: 'row', className: 'wc-row' }, [
          h('button', { key: 'r', className: 'wc-btn', disabled: busy, onClick: load }, t('refresh')),
          state?.defaultRoot ? h('span', { key: 'd', className: 'wc-mono' }, state.defaultRoot) : null,
        ]),
        error ? h('div', { key: 'e', className: 'wc-error' }, `${t('error')}: ${error}`) : null,
        !state && busy ? h('div', { key: 'l', className: 'wc-empty' }, t('scanning')) : null,
        state && (state.workspaces ?? []).length === 0
          ? h('div', { key: 'n', className: 'wc-empty' }, t('noWorkspaces'))
          : null,
        ...(state?.workspaces ?? []).map(workspace => h(WorkspaceCard, {
          key: workspace.workspaceId,
          workspace,
          state,
          t,
          onRefresh: load,
        })),
        state ? h('div', { key: 'div', className: 'wc-divider' }) : null,
        state ? h(SettingsCard, { key: 's', settings: state.settings ?? {}, t, onSaved: load }) : null,
        state ? h('div', { key: 'sp', className: 'wc-sub' }, `${t('statePath')}: ${state.statePath}`) : null,
        (state?.journal ?? []).length > 0
          ? h('div', { key: 'j', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
            h('div', { key: 't', className: 'wc-section-title' }, t('journalTitle')),
            ...state.journal.slice(-8).reverse().map((entry, index) => h('div', { key: `j${index}`, className: 'wc-mono' },
              `${entry.at ?? ''} · ${entry.kind ?? ''} · ${entry.root ?? ''}${entry.moved !== undefined ? ` · ${entry.moved}` : ''}`)),
          ])
          : null,
      ])
    }

    const NS_DICTS = { zh: ZH, en: EN }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, NS_DICTS), 'workspace-cleaner: dictionaries')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'workspace-cleaner',
          order: 520,
          // A thunk is re-read on every projection, so the nav label follows a
          // language switch without re-registering the slot.
          label: () => ctx.locale.bind(NS)('navLabel'),
          locale: NS,
        }, WorkspaceCleanerPage))
      },
    }
  },
})
