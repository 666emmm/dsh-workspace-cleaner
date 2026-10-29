/**
 * The AI-judgement half: hand the inventory to one dedicated session and let
 * that session write the plan back through the plugin's own tool.
 *
 * Why a session and not a request to the model inside the route handler: the
 * plugin has no LLM access of its own, and creating one would duplicate the
 * routing, credentials, and preset logic the Host already owns. A session is
 * the supported way to run a model turn, and its result comes back through a
 * tool call — a typed, validated channel — instead of through prompt text.
 *
 * `sessionController.prompt` only reports `{ accepted: true }`. Nothing here
 * pretends otherwise: the judgement arrives asynchronously, when the agent
 * calls `workspace_cleaner_submit_plan`, and the UI polls for it.
 */

import { basename } from 'node:path'

/** How long a judgement may take before the UI says so instead of spinning. */
export const AI_TIMEOUT_MS = 5 * 60 * 1000

/** Marker the tool result carries so a session can tell it succeeded. */
export const PLAN_ACCEPTED = 'PLAN_ACCEPTED'

/**
 * The instruction handed to the judging session.
 *
 * Written for a model that has never seen this plugin: it states the goal, the
 * hard constraints the user cares about (do not touch directories the user
 * made, do not touch directories a tool owns), the exact tool to call, and the
 * reason each constraint exists. It also forbids the recursive failure mode:
 * clicking the button that would create another judging session.
 * @param {{ root: string, inventory: object }} input the plan produced by the deterministic pass.
 * @returns {string} the prompt body.
 */
export function judgementPrompt(input) {
  const rootName = basename(input.root)
  return [
    '你在帮用户整理一个工作区文件夹。下面是插件用**确定性规则**做出来的第一版盘点结果。',
    '',
    '**你的任务**：判断哪些条目应该移动、移到哪里，并把结论通过工具写回来 —— 不要只把结论写在回复正文里，那样插件读不到。',
    '',
    '## 必须遵守的约束',
    '',
    '1. **`existing-dir` 里的目录是用户自己建的**：未经明确许可不要移动，尤其不要改名。',
    '2. **`fixed-dir` 里的目录是工具固定目录**（被某个程序的配置或约定指向）：一律不动，搬了功能就废。',
    '3. 只移动根目录下的**松散文件**。不要新建深层嵌套目录，一层就够。',
    '4. **不删除任何用户文件**。删除不在你的权限里。拿不准就移动，不删。',
    '5. 目录名和文件名用**会话/内容能读懂的中文或英文短语**，不要用哈希、id、日期戳。',
    '6. 如果某个文件被别的文件以字符串形式引用（`scan.occurrences` 里提到它），移动它会静默破坏引用 —— 要么别动，要么在理由里写清代价。',
    '',
    '## 怎么交回结论',
    '',
    `调用工具 \`workspace_cleaner_submit_plan\`，参数：`,
    `- \`root\`：\`${input.root}\``,
    '- `groups`：数组，每项 `{ "folder": "目标子文件夹", "files": ["文件名", ...], "reason": "为什么这些文件属于这里" }`',
    '- `notes`：可选，给人看的一句话总结',
    '',
    '只列出你**确实要移动**的文件。不需要移动的文件不要出现在 `groups` 里 —— 插件会把没列出的当作"保留"。',
    '',
    '## 不要做的事',
    '',
    '- 不要去点设置页里的「让 AI 判断」按钮，也不要再调用会创建会话的接口 —— 那会无限套娃，把你自己再拉起一遍。',
    '- 不要为了"整理得更好看"而移动用户自建目录。',
    '',
    '## 盘点结果',
    '',
    '```json',
    JSON.stringify(summarizeInventory(input.inventory, rootName), null, 2),
    '```',
  ].join('\n')
}

/**
 * Trim the plan down to what a model needs to decide. The full plan carries
 * per-file metadata (bytes, occupancy probes) that would only waste context.
 */
function summarizeInventory(plan, rootName) {
  return {
    workspace: rootName,
    totals: plan?.totals ?? {},
    looseFiles: (plan?.classification ?? [])
      .filter(item => item.kind === 'file')
      .map(item => ({ name: item.name, movable: item.movable, reason: item.reason ?? null })),
    existingDirs: (plan?.classification ?? [])
      .filter(item => item.category === 'existing-dir')
      .map(item => item.name),
    fixedDirs: (plan?.classification ?? [])
      .filter(item => item.category === 'fixed-dir')
      .map(item => ({ name: item.name, reason: item.reason ?? null })),
    deterministicSuggestion: (plan?.movable ?? []).map(group => ({
      folder: group.folder,
      files: group.files.map(file => file.name),
    })),
    refused: plan?.refused ?? [],
    referencedDirs: plan?.scan?.referencedDirs ?? [],
    referenceHits: (plan?.scan?.occurrences ?? []).map(hit => ({
      file: hit.file, line: hit.line, text: hit.text,
    })),
  }
}

/**
 * Ask one judging session for a plan, creating it the first time.
 *
 * The session joins the workspace by `workspaceId` rather than `cwd`: with a bare
 * `cwd` the Host attaches no workspace and the conversation lands ungrouped in
 * the sidebar, which is confusing for a session the user never asked for. The
 * two fields are mutually exclusive on the create call, so only one is passed.
 *
 * @param {{ sessionController: any, workspaceRegistry?: any }} services live services.
 * @param {{ home: string, workspacePath: string, workspaceId?: string, inventory: object, rememberedSessionId?: string, saveSession: (id: string | null) => void }} input
 * @returns {Promise<{ ok: boolean, action: string, sessionId?: string, reason?: string }>}
 */
export async function requestJudgement(services, input) {
  const controller = services.sessionController
  if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
    return { ok: false, action: 'skipped', reason: 'sessionController is not mounted in this profile' }
  }
  const prompt = judgementPrompt({ root: input.workspacePath, inventory: input.inventory })
  if (prompt.trim().length === 0) {
    return { ok: false, action: 'skipped', reason: 'nothing to judge' }
  }

  let sessionId = input.rememberedSessionId
  let action = 'reused'

  if (!sessionId) {
    const request = input.workspaceId
      ? { workspaceId: input.workspaceId }
      : { cwd: input.workspacePath }
    try {
      const created = await controller.create(request)
      sessionId = created?.sessionId
      if (!sessionId) return { ok: false, action: 'failed', reason: 'create returned no sessionId' }
      action = 'created'
      input.saveSession(sessionId)
    } catch (error) {
      return { ok: false, action: 'failed', reason: messageOf(error) }
    }
  }

  try {
    await controller.prompt({
      requestId: `wc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
      clientTimeZone: 'Asia/Shanghai',
    })
    return { ok: true, action, sessionId }
  } catch (error) {
    // A remembered session that no longer exists must not poison every later
    // click: forget it and report, so the next attempt creates a fresh one.
    const reason = messageOf(error)
    if (/not[\s_-]?found|disposed|archived|unknown session|invalid session/i.test(reason)) {
      input.saveSession(null)
      return { ok: false, action: 'stale-session', reason }
    }
    return { ok: false, action: 'failed', reason }
  }
}

/** A message worth showing a user, from any thrown value. */
function messageOf(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}
