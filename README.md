# 工作区整理 · dsh-workspace-cleaner

一键整理工作区文件夹。设置页里能看到当前有哪些工作区，点一下就把根目录的松散文件按类型归进子文件夹；
会话文件夹会跟着会话改名一起更新。**已有目录和工具固定目录不动。**

![设置页](docs/settings.png)

## 它到底做什么

一张表说完三件事的处理方式：

| 条目 | 判断依据 | 处理 |
|---|---|---|
| 松散文件 | 根目录的普通文件 | 可移动，按规则/扩展名分组 |
| 已有目录 | 用户自己建的 | **不动，也不改名** |
| 固定目录 | 被工具/配置指向的 | **不动**（搬了功能就废） |

固定目录有两类来源，都会出现在"不动的条目"里并写明原因：

- **内置名单**：`node_modules`、`.git`、`.venv`、`dist` 等二十来个
- **配置声明**：扫描 `settings.json` / `config.yaml` / `.env` 等文件里的目录字段，
  凡是值为本工作区里真实存在的目录名，就整体保护

## 动手之前先做两件事

**① 依赖扫描（脚本 + 配置）**

移动会静默破坏两类东西，所以两者都在"预演"里列出来：

- **写死路径的脚本**：`OUT = r"D:\...\out"` 这类
- **自相对脚本**：`__file__`、`__dirname`、`$PSScriptRoot`、`import.meta.dirname`、
  `process.cwd()` —— 它们靠自身位置解析路径，搬走就悄悄换了个地方读写，所以**直接拒绝移动**

**② 占用探测**

被编辑器/浏览器/宿主进程打开的文件用独占打开试探，被占用就跳过并说明，**不去杀进程**
（整理工具本身就跑在宿主里）。

## 锁定目录（这次的限制器）

会话名常常是中文，但有些工具链只认 ASCII 路径。锁定就是给这种情况的出口：

- 每个工作区卡片里，根目录的每个文件夹都是一个小按钮，点一下**锁定/解锁**
- 锁定后：**不移动、不改名、也不会被当作归类的目标文件夹**
- 支持 `*` 通配符，`assets*` 能覆盖一族
- 设置卡片里也能手动输入/删除锁

锁定的判定优先级最高 —— 它是插件唯一无法自行推断的信息，任何规则都不能覆盖它。

## 会话文件夹跟着会话改名

1. 插件记住「哪个会话 ↔ 哪个文件夹」（`links.json`）
2. 用户在侧边栏重命名会话 → 落一条 `session/title` 事件（`source.kind === 'user'`）
3. 插件监听这条事件，把文件夹改成同名
4. **只动自己登记过的文件夹**，从不碰用户手建的目录；锁定的文件夹除外

自动生成的标题（`provider` / `fallback` 来源）不会触发改名 —— 只有用户亲手命名的才算。

## 让 AI 判断（可选）

规则分组是确定性的，但没有"这个文件属于哪个项目"的信息。点「让 AI 判断」时：

1. 插件把盘点结果 JSON 交给一个**专用会话**（每个工作区复用同一个，不刷屏）
2. 那个会话用 `workspace_cleaner_submit_plan` 工具把清单写回来
3. 页面轮询拿到清单，仍然走同一个 apply 引擎

为什么用工具而不是读回复正文：`sessionController.prompt` 只回 `{accepted:true}`，
投递进 inbox 就结束了，读不到 AI 的结论。工具调用是结构化、可校验的回传通道。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `workspace_cleaner_plan` | 只读：盘点 + 依赖扫描 + 拒绝原因 |
| `workspace_cleaner_apply` | 执行移动；`dryRun` 默认 true |
| `workspace_cleaner_submit_plan` | 交回 AI 判断结果 |
| `workspace_cleaner_link_folder` | 登记「文件夹属于某个会话」 |

页面和工具调的是同一批函数，所以两边的行为不会漂移。

## HTTP 接口

前缀 `/workspace-cleaner/api`，信封统一 `{ok:true,result}` / `{ok:false,error,code}`：

`GET /state` · `POST /scan` · `POST /apply` · `POST /ask-ai` · `POST /pending`
`POST /settings` · `POST /rename-session-folder` · `POST /sync-folders` · `POST /journal`

## 幂等与诚实边界

- 目的一样、大小和修改时间一致 → 视为已完成，不重复搬
- 目标已存在但内容不同 → 加数字后缀，**绝不覆盖**
- 预演不落盘，也不做复核（没改动就没什么可验的）
- 执行后**重新扫描**，把残留引用数和样本列出来 —— 不说"应该没问题"
- **不删除任何用户文件**；唯一会删的是本次移动后变空的目录，且可在设置里关掉

## 状态文件

全部在 `%DSH_HOME%\workspace-cleaner\`（默认 `C:\Users\<你>\.dsh\workspace-cleaner\`）：

`settings.json` · `links.json` · `ai-session.json` · `journal.jsonl` · `pending-<hash>.json`

用独立 JSON 而不是设置命名空间，因为这个 Harness 世代的 `settings.register` 已经不存在了。

## 测试

```bash
node test/smoke.mjs    # 引擎：分类、扫描、预演/执行、幂等、改名、锁定
node test/routes.mjs   # 路由：信封、状态码、/state 形状、降级
node test/tools.mjs    # 工具：注册形状、dryRun 默认、锁定生效、越界拒绝
node test/client.mjs   # 面板：加载器契约、apply、渲染（中/英）
```

四套都用临时目录，跑完即清。

## 已知限制

- **只在 Windows 上验证过**。路径处理用的是 `node:path`，但占用探测和非法字符集是按 Windows 定的
- 依赖扫描读文件有预算上限（400 个文件 / 2 MiB），超了会标"已截断"而不是假装扫全了
- 归因靠扩展名和文件名规则，**不理解内容**；要理解内容就用「让 AI 判断」
- AI 判断需要 `sessionController`；没有时按钮会如实报缺失，不会静默失败
