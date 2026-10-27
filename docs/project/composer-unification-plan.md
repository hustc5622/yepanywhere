# 对话输入框统一：现状审查与开发计划

日期：2026-10-23。前置文档：[composer-lifecycle.md](composer-lifecycle.md)（已收敛编辑器、附件、键盘、草稿规则）、[2026-10-09-side-conversations-plan.md](2026-10-09-side-conversations-plan.md)（旁路设计）。本文只读源码得出，未运行浏览器自动化，未重启服务。

目标：新建会话、续聊（含历史编辑）、旁聊使用同一个全局输入框组件；provider 差异只以「能力 + 命令目录」传入，页面只做提交适配。

## 1. 已确认的产品决定

1. Codex `/` 菜单只保留经 app-server（或 Yep 对应实现）真正起作用的命令。
2. 输入框复制时带上全部附件：图片和普通文件。
3. 旁聊输入框与主输入框统一；能力边界按各 provider 的旁路实现决定。

## 2. 现状要点

### 2.1 组件分布

| 入口 | 组件 | 共享程度 |
| --- | --- | --- |
| 新建会话 | `NewSessionForm`（2391 行，输入区与工具栏内联于约 1810–2050 行） | 共用 `AttachmentComposer`、`useComposerDocument`、`composerKeyboard` |
| 续聊 / 排队 / 打断 / 历史编辑 | `MessageInput` + `MessageInputToolbar` | 同上，另有补全、语音快捷键、折叠 |
| 旁聊 | `SideConversationPanel` 原生 `<textarea>` | 无共享：IME/Enter 自判，无附件、无命令、移动端 Enter 也会发送 |

`composer-lifecycle.md` 中的「快速新建 FAB」源码已不存在，需同步修正该文档。

### 2.2 新建与续聊的差异

| 能力 | 续聊 | 新建 |
| --- | --- | --- |
| 输入中 `/`、`$` 补全 | 有 | 无，仅工具栏按钮 |
| 命令描述 / 来源 | 有 | 无 |
| `/model`、`/side`、`/compact` 等客户端拦截 | 有（`SessionPage.handleSend`） | 无，原文发送 |
| Codex `$skill` → `codexInputs` | 有（进程存活时） | 无；API 已支持该字段 |
| Ctrl+Space 语音、转写去首尾空格 | 有 | 无 |
| 推理强度图标、附件按钮、预览弹窗、外置附件列表 | 一份 | 另一份重复实现 |

### 2.3 命令目录

`lib/agentCommands.ts#getAgentCommandConfigs` 是唯一的分组函数，但输入数据由两个页面各自拼：

- 续聊在 `SessionPage.tsx` 约 710–845 行拼 skills、details、`side`/`btw` 过滤；新建拿不到。
- 续聊只在 `status.owner === "self"`（或 Pi 空闲）时显示命令。Claude 空闲会话 REST 已返回 `slashCommands` 仍被隐藏；Codex 空闲会话全部隐藏，尽管 `/compact` 可经 `resumeAndExecuteCodexControl` 执行。
- Codex skills 只在进程存活时调 `skills/list`。
- Pi 有服务端按 cwd 的命令缓存 `pi-command-cache.ts`，新建未使用。
- MiniMax Code ACP 实际会发 `available_commands_update`（`references/minimax/pretty/run-acp-command.js:17794`），Yep 在 `mcode.ts:275` 丢弃。

### 2.4 Codex 命令的真实可用性

Codex 的 `/` 命令全部由 TUI 在本地解析（`references/codex/codex-rs/tui/src/slash_command.rs`）。经 app-server `turn/start` 发出的 `/xxx` 只是普通文本，会被模型当成提示。因此当前 `CODEX_SLASH_COMMANDS` 的 47 项中，真正生效的只有 Yep 拦截的几项：

| 命令 | 实际路径 | 处理 |
| --- | --- | --- |
| `compact` | `thread/compact/start`（空闲时 resume 后执行） | 保留 |
| `model` | Yep `ModelSwitchModal`，下一 turn 覆盖 | 保留 |
| `side`、`btw` | Yep 旁路 → `thread/fork(ephemeral)` | 保留（仅 capability 可用时） |
| `review` | `review/start` 控制已存在，未接到命令 | 接线后保留 |
| `goal` | `thread/goal/*` 与 `GoalModal` 已存在，未接到命令 | 接线后保留 |
| 其余（`vim`、`theme`、`keymap`、`statusline`、`quit`、`ps`、`stop` 等） | 无 app-server 等价，或为实验接口（backgroundTerminals 关闭） | 删除 |

`fork`、`rename`、`archive`、`new`、`status`、`permissions`、`init` 可以映射到 Yep 已有功能或 `thread/*` RPC，但不属于"经 app-server 发出即生效"。本轮不保留，后续按需单独加入。`$` skills 仍通过 `skills/list` 获取。

命令目录要为每条命令标注处理方式：`yep`（Yep 自己处理）、`native-rpc`（映射到 provider RPC）或 `provider-text`（原文交给 provider 解析，例如 Claude、Pi 的扩展命令）。菜单只显示其中可执行的命令。

### 2.5 复制

| 位置 | 现状 |
| --- | --- |
| 已发送用户消息 | `writeClipboardUserInput` 写入 `text/plain` 和带 Yep 标记的 HTML，**只含图片**；普通文件附件丢失 |
| 输入框粘贴 | `readClipboardUserInput` 能把 Yep 标记还原成图片附件；不识别普通文件 |
| 输入框复制 / 剪切 | `AttachmentComposer.copySelection` 只写 `text/plain`，`@[name]` token 粘贴后变成孤立 token |
| 一键复制 | 输入框没有 |

另外，已发送消息复制图片时，`loadClipboardImage` 直接用浏览器 `fetch(sourceUrl)`，而历史编辑恢复使用 `connection.fetchBlob`。远程或中继连接下前者可能取不到数据，需在实现时核实。

浏览器限制：Web Clipboard API 只能可靠写入 `text/plain`、`text/html`、`image/png`，**不能**把任意文件作为系统文件放进剪贴板。因此"带上普通文件"只能在 Yep 之间生效，粘贴到外部应用时只有文字和图片。

### 2.6 旁聊的实际形态（与"完整续聊 session"有差距）

| 项 | 当前实现 |
| --- | --- |
| Provider | 仅 Codex（`thread/fork`/`thread/start`，`ephemeral`、`sandbox: read-only`、`approvalPolicy: never`）与 Pi（Yep 扩展内独立 SDK session） |
| 工具 | Codex 仅 `request_user_input`（被拒）/`view_image`，禁用 shell、MCP、agents、插件；Pi 仅 read/grep/find/ls |
| 输入 | `SideConversationRequest.send` 只有 `text`（≤ 32,000 字符），无附件、无命令 |
| 消息模型 | `SideConversationMessage` 只有 user/assistant 文本与完成后的 HTML，无工具调用渲染、无审批 |
| 生命周期 | 每个父会话一个，进程内最多 4 个；10 分钟单轮、30 分钟空闲回收；不持久化，runtime 重启即失效 |

这是 2026-10-09 方案刻意设计的"只读快照问答"，不是完整 session。可扩展性：

| Provider | 原生基础 | 输入框可开放的能力 |
| --- | --- | --- |
| Codex | `thread/fork` + `turn/start`，input 支持图片 | 图片附件（需服务端扩展 `send`）；`$skill` 需评估在只读沙箱下的意义 |
| Pi | SDK session `prompt` 支持 images | 图片附件；Pi 命令需逐个确认在子 session 中可执行 |
| Claude | SDK `query({ resume, forkSession: true })` 与 `forkSession()`；`persistSession` 可控 | 尚未实现旁路，需新 adapter |
| MiniMax Code | ACP `sessionCapabilities.fork`（`run-acp-command.js:18064`） | 尚未实现旁路，需新 adapter |
| Gemini ACP / Cursor | 未核实 | 暂不支持 |

**已决定（2026-10-23）**：旁路保持"只读快照问答"，只统一输入框，并按 capability 开放图片附件。"可写的完整分支 session"等同于 Yep 已有的 fork/branch 以侧栏形式展示，涉及审批、工具渲染、持久化，另立方案，不在本计划内。

## 3. 目标结构

```
shared
  command-catalog：CommandEntry { prefix, name, description?, source?, handling: yep | native-rpc | provider-text }
  parseComposerIntent(text, catalog) → compact | model | side | review | goal | skills[] | plain
client/lib
  composerCapabilities：{ attachments, imageOnly?, commands, voice, thinking, permissionMode, queue, interrupt, collapse, contextUsage }
  clipboard v2：文本 + 有序附件（图片 dataURL；文件按大小内联或引用）
client/hooks
  useCommandCatalog(provider, scope)   scope = new-session(projectId/cwd) | session(sessionId) | side(sessionId)
  useCommandCompletion(text, cursor, catalog)   从 MessageInput 抽出
  useComposerDocument（已有）+ copyAll / copySelection（富剪贴板）
client/components
  <Composer>          编辑器、补全菜单、内联/外置附件、预览、复制
  <ComposerToolbar>   按 capabilities 渲染：附件、语音、命令、推理强度、权限、上下文、旁路入口、发送/排队/打断/停止；左右两侧留扩展插槽
  适配层              NewSessionComposer / SessionComposer / SideComposer：附件存储与上传策略、提交、额外插槽
```

页面不再自行判断 provider 是否有命令，也不自行拼命令详情；`commandPrefix/commands/showCommandButton/commandLabel` 这组旧属性在迁移完成后删除，只保留 `commandButtons` 的等价物。

## 4. 实施步骤

每步可单独合并；涉及正式产物时更新 `CHANGELOG.md [Unreleased]`，界面文案同步 `en` / `zh-CN`。

### 第 1 步：命令目录与补全统一（2026-10-23 已完成）

实现：`lib/agentCommands.ts#buildAgentCommandCatalog`（按 `scope: new-session | session`、`ownsProcess`、`canResume`、`hasSideConversation` 生成菜单）、`hooks/useAgentCommandCatalog.ts`（本地化）、`hooks/useCommandCompletion.ts` + `components/CommandCompletionMenu.tsx`（从 `MessageInput` 抽出，新建会话复用，菜单在新建页向下展开）。Codex 新增 `/review`、`/goal` 解析（`lib/codexInputCommands.ts`），`GoalModal` 支持 `initialObjective`。与下列原计划的差异：命令目录仍放在 client `lib`，未移入 shared（服务端暂不消费）；新建会话对 `/model`、`/side` 采用"不出现在菜单"，手动键入仍按普通文本发送；`parseComposerIntent` 未单独抽出，留到第 4 步与提交适配一起做。

1. 新增 shared `command-catalog`，迁移 `agentCommands.ts`；Codex 静态表收敛为 §2.4 的保留集合，每条带 `handling` 与说明。
2. 新增 `useCommandCatalog`：
   - Claude：进程 init 数据 → REST `slashCommands` → 静态兜底；空闲会话也显示。
   - Codex：保留集合在空闲时显示（执行时按需 resume）；skills 见第 2 步。
   - Pi：实时 → `pi-command-cache` → `compact`。
   - 其他 provider：空。
3. 从 `MessageInput` 抽出 `useCommandCompletion`，`NewSessionForm` 接入输入中补全和命令详情。
4. 抽出 `parseComposerIntent`，`SessionPage.handleSend/handleQueue` 与新建提交共用；新建会话对 `/model`（打开模型选择）、`/side` 等在无会话时给出明确提示，不再原文发送。
5. 接线 `/review`（`review/start`）、`/goal`（`GoalModal`）。

### 第 2 步：skills 与新建会话（2026-10-23 已完成 Codex / Pi / MiniMax Code / Cursor；Claude 暂不处理）

#### 各 provider 的 skills 机制（源码核对）

| Provider | 发现规则（优先级从高到低） | 调用方式 | 实时来源 |
| --- | --- | --- | --- |
| Codex | 项目 `.codex/skills`、cwd 到 git 根的 `.agents/skills`、`$CODEX_HOME/skills`、`~/.agents/skills`、`$CODEX_HOME/skills/.system`、插件 skills；`skills.config` 控制启用（`codex-rs/ext/skills/src/host_roots.rs`） | `$名称`，提交为 `{type:"skill",name,path}` 结构化输入 | app-server `skills/list`，**不需要 thread** |
| Pi | `~/.pi/agent/skills`、项目 `.pi/skills`、`.agents/skills`（项目与用户）、npm 包 skills | `/skill:名称`，Pi `prompt()` 展开 | RPC `get_commands`（已有按 cwd 缓存 `pi-commands.json`） |
| MiniMax Code | 工作区（向上查找）`.minimax`/`.claude`/`.agents` 的 `skills`、`~/.claude`/`~/.codex`/`~/.agents` 的 `skills`、`~/.minimax/agents/<agent>/skills`、`~/.minimax/skills`、`~/.minimax/.builtin-skills`（`local-runtime-v2/.../skill/registry/roots.ts`） | `/名称`，未被 ACP 内置命令处理的交给 runtime | ACP `available_commands_update`：内置 `help/new/model/status/doctor/context/skills/mcp/usage/compact` + skills（描述带 `[Skill]`） |
| Cursor | `.cursor/skills`、`.cursor/skills-cursor`、`.cursor/plugins`、`.claude/skills`、`.codex/skills`、`.agents/skills` 等（用户与项目，`skill-path-utils.ts`） | `/名称`，`resolveLeadingSlashCommand` | ACP `available_commands_update`：`copy-request-id` + `loadCommands({includeSkills:true})` |

本机实测（本仓库目录）：Codex `skills/list` 返回 19 个（含 `documents:documents` 等插件 skills，扫描拿不到），扫描得到 Codex 11、Pi 3、MiniMax Code 24、Cursor 26 个。

#### 实现

- 服务端 `packages/server/src/agent-commands/`：`service.ts`（统一入口：运行中进程 → 目录缓存 → 目录扫描）、`codex-skills.ts`（短时 `codex app-server` 调 `skills/list`，按 cwd 缓存 60 秒，失败不缓存）、`skill-scanner.ts`（按上表规则扫描 `SKILL.md`，只作兜底）、`acp-commands.ts`（规范化 ACP 命令，过滤 mcode `/new`、Cursor `/copy-request-id`，跟踪最新列表）、`command-cache.ts`（mcode/Cursor 的 `agent-commands.json`）。
- 接口 `GET /api/projects/:projectId/agent-commands?provider=&sessionId=` 返回 shared `AgentCommandListing`（`origin: live | cache | scan | none`，`commands` 为 `/` 命令，`skills` 为 Codex `$` skills）。会话加载接口的 `slashCommands` 兜底也扩展到 mcode/Cursor 缓存。
- mcode、Cursor provider 拦截 `available_commands_update`（不进入转录队列），提供 `supportedCommands()`，`supportsSlashCommands` 改为 `true`。
- 客户端 `hooks/useAgentCommandListing.ts`；`SessionPage` 改用该接口取 Codex skills（不再只在进程运行时调用 `skills/list`），新建会话同样接入并提交 `codexInputs`；`useCommandCompletion` 新增 `onActivate`，进入 `/`、`$` token 时节流刷新。

#### 已知限制

- 扫描不含插件 / npm 包 skills 与启用配置，只在 provider 从未为该目录报告过列表时使用。
- Cursor 预热（`cursor-prepare`）的 ACP 客户端在会话接管前收到的命令列表会丢失，此时回落到目录缓存。
- Codex 使用默认 `CODEX_HOME` 探测；按账号隔离的 `CODEX_HOME` 若有不同 skills，以会话运行后的实时结果为准。
- 每次进入新建页选择 Codex 会短时启动一次 `codex app-server`（约 1.5 秒，60 秒内复用）。

原计划内容：

1. 服务端提供不依赖 thread 进程的 skills 查询：Codex 用 app-server `skills/list`（按 cwd，带缓存）；Pi 与 Claude 从命令目录中 `source: skill` 的条目派生。
2. 新建会话解析 `$skill`，填入 `codexInputs`。
3. MiniMax Code 消费 `available_commands_update`，进入命令目录（需先用真实 `mcode acp` 确认命令执行语义；联调要授权）。

### 第 3 步：富剪贴板 v2 与一键复制（2026-10-23 已完成）

实现：
- `lib/clipboard.ts`：写入 v2（`data-yep-anywhere-user-input="2"`），按顺序为每个附件生成一个元素——图片 `<img src=data:>`（其他富文本应用可见）、普通文件 `<span data-yep-anywhere-attachment-data>`、超限的受管上传 `<span data-yep-anywhere-attachment-ref>`、读不到的 `<span data-yep-anywhere-attachment-missing>`；读取兼容 v1。`ClipboardAttachmentSource.read()` 优先，`sourceUrl` 兜底；结果为 `{ requestedAttachmentCount, copiedAttachmentCount, failedNames }`。引用只接受 `isManagedUploadDownloadUrl`。
- `useComposerDocument`：新增 `getClipboardSource`、`copyAll()`、`handleCopyAttachments()`；粘贴 v2 时先读取引用（默认 `connection.fetchBlob`），再按失败数移除多余 token，部分失败用 toast 提示（无 ToastProvider 时静默，新增 `useOptionalToastContext`）。`attachFiles` 允许只有文字的还原。
- `AttachmentComposer`：复制/剪切选区包含附件卡片时，先同步写纯文本，再调用 `onCopyAttachments(text, ids)` 用富剪贴板覆盖。
- `ComposerCopyButton`：续聊工具栏与新建会话工具栏的「复制输入内容（含附件）」。
- 已发送消息：`UserPromptBlock` 为全部附件生成来源，读取复用 `restorePromptAttachments.readPromptAttachment`（经当前连接），不再只复制图片、也不再直接用浏览器 `fetch`。

验证范围：jsdom 组件与单元测试覆盖三种入口的复制、粘贴、引用读取和孤立 token 清理。真实浏览器中 Chrome 对 `text/html` 剪贴板的净化是否保留大体积 `data-*` 属性、Safari/WebView 的用户激活限制，仍需获准后做浏览器验证。

原计划内容：

1. 剪贴板标记升级为 v2，兼容读取 v1：按顺序携带全部附件，并保留它们在正文中的 token 位置；图片内联为 dataURL；普通文件在单个和总量上限内（建议单个 5 MB、总计 20 MB）内联，超出则只带受管上传引用（同一服务器内粘贴时用 `connection.fetchBlob` 重新获取）。
2. 抽出与 `restorePromptAttachments` 共用的附件读取函数，复制统一走 `connection.fetchBlob`，修正远程连接下的取数路径。
3. `AttachmentComposer` 的复制 / 剪切写入 v2：把选区内的 token 解析为对应附件。
4. 输入框增加「复制全部」按钮；已发送消息的复制同样带上普通文件。
5. 粘贴 v2 时，图片和文件都恢复为附件；部分失败时提示失败项，不留下孤立 token。
6. 粘贴到外部应用时只有文字和图片，界面提示中注明这一限制。

### 第 4 步：`<Composer>` / `<ComposerToolbar>` 抽取（2026-10-23 已完成）

实现（文件均在 `packages/client/src/`）：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 控制器 | `hooks/useComposer.ts` | 语音（临时转写、`takeText()` 收尾）、`/`/`$` 补全、`useComposerDocument`、键盘策略（IME → Ctrl+Space → 补全 → Enter/Ctrl+Enter）、附件预览状态；容器只给草稿、附件存储与 `onSubmit`/`onQueue` |
| 编辑区 | `components/ComposerEditor.tsx` | 补全菜单（`menuPlacement`）、`AttachmentComposer`、正文外附件卡片（`attachmentDetail`）、隐藏文件选择框、预览弹窗 |
| 工具栏 | `components/ComposerToolbar.tsx` | 固定顺序：`leading` → 附件 → 复制 → 思考 → 语音 → 命令 → `trailing`，右侧 `actions`；`variant: session \| new-session` 决定按钮类名与图标尺寸（16 / 18） |
| 共用按钮 | `components/ThinkingToggleButton.tsx`、`components/ComposerCopyButton.tsx` | 两处原先各自一份的思考按钮 SVG 合并 |
| 适配层 | `components/MessageInput.tsx`（续聊）、`components/NewSessionForm.tsx` 输入区（新建） | 续聊：草稿持久化、上传附件、发送/插话/排队、折叠；新建：本地待上传文件、启动会话按钮与 spinner |

`MessageInputToolbar` 保留原有 props（`SessionStreamPanes` 在审批面板折叠时单独使用它），内部改为 `ComposerToolbar` + 会话提交按钮组。`MessageInput.tsx` 从 729 行降到 347 行；`NewSessionForm.tsx` 从 2391 行降到 2210 行，输入区不再自带编辑、语音、补全、附件卡片和预览逻辑。

行为上的统一（用户可见）：新建会话支持 Ctrl+Space 语音、转写去首尾空格；新建会话的正文外附件卡片移到输入框下方；紧凑模式的思考按钮位置与续聊一致。`parseComposerIntent`（发送前命令拦截）仍在 `SessionPage`，新建会话尚无需要拦截的命令，暂不抽出。

原计划内容：

1. 以 `MessageInput` 为基础抽出 `<Composer>`、`<ComposerToolbar>`；`MessageInput` 变为 `SessionComposer` 适配层。
2. `NewSessionForm` 的输入区与工具栏替换为共享组件，provider/模型配置区保留在表单；统一图标尺寸、语音行为和推理强度按钮。
3. 补充入口一致性测试：同一组操作（补全、粘贴、复制、附件、IME、Enter）在三个适配层上行为一致。

### 第 5 步：旁聊接入（2026-10-23 已完成）

实现：
- 协议（shared `side-conversations.ts`）：`send` 增加可选 `attachments: [{ path, name, mimeType }]`（≤ 8）；`SideConversationResponse.capabilities.images` 下发能力；用户消息带 `attachments` 名称。
- 服务端：`side-conversations/attachments.ts#resolveSideImages` 只接受 `UPLOADS_DIR` 内（realpath 校验）的图片、单张 ≤ 20 MB；`SideConversationSession` 在接纳问题前校验（失败时状态保持 idle、不记录消息，请求 ID 可重试），纯文字问题保持原有同步时序；`SideTransport.send(text, requestId, images)`。Codex 适配层把图片读成 data URL 作为 `{type:"image"}` 输入（兼容桥接 app-server 不在本机）；Pi 通过私有命令传路径，扩展 `readSideImages` 读取为 `ImageContent` 交给子会话 `prompt({ images })`。Codex 本地、Codex 桥接、Pi 三处 `supportsImages: true`。
- 客户端：新 `hooks/useComposerUploads.ts`（选中即上传、保持顺序、撤销恢复），`useComposer`/`useComposerDocument` 新增 `acceptFile`/`onRejectFiles`（插入 token 前过滤）；`SideConversationPanel` 改用 `useComposer` + `ComposerEditor` + `ComposerToolbar`（附图、复制、语音，右侧保留结束/新建/停止/发送），草稿仍按父 session + side id 隔离；`useSideConversation.send(text, context, attachments)` 与能力状态。
- 主输入框 `/side` 仍只发文字（提示改为引导到旁聊面板附图）。

后续可选：`SessionPage.handleAttach` 与 `useComposerUploads` 逻辑重复，可让续聊也改用该 hook；Claude / MiniMax Code 旁路 adapter 另立方案。

原计划内容：

1. `SideConversationPanel` 改用 `<Composer>`，capabilities 为：无排队/打断、无权限切换、命令仅限 Yep 自处理的 `/new` 类操作，附件按服务端 capability 决定。
2. 服务端为 `SideConversationRequest.send` 增加可选附件（图片优先），Codex 映射为 `localImage`/`image` input，Pi 映射为 images；capability 通过 `SideConversationResponse` 下发。
3. 草稿按父 session + side id 隔离，复用 `useDraftPersistence`。
4. Claude / MiniMax Code 旁路 adapter 作为独立后续方案，不在本计划内。

### 第 6 步：收尾（2026-10-23 已完成）

- 待上传文件持久化：`lib/draftFileStore.ts`（IndexedDB `yep-draft-files`：`drafts` 保存每个草稿的有序 id 与时间，`files` 每个文件一条，按 `draftKey` 索引；增量保存只读取新增文件；单个 25 MB、合计 100 MB 上限，超限只留内存并提示；7 天过期，打开数据库时清理；IndexedDB 不可用时为空操作）。`NewSessionForm` 以 `安装 ID:new-session:项目 ID` 为 key 恢复（恢复期间禁止发送）、300 ms 去抖保存、启动成功后删除。
- 拖入文件：`AttachmentComposer.onDropFiles`（`caretPositionFromPoint`/`caretRangeFromPoint` 定位落点，落在附件卡片上时保留原光标；只接受包含 `Files` 的拖放，`data-drag-over` 高亮）→ `useComposerDocument.handleDropFiles`，经 `acceptFile` 过滤（旁聊仅图片）。
- 去重：`useComposerUploads` 支持外部状态（`state`）、`pendingUploads()`、`cancelPending()`、`setOrder()`、`restoreFile()`；`SessionPage` 删除自带的上传、移除、恢复与顺序跟踪代码，改用该 hook（附件仍由 `useDraftAttachments` 持久化）。
- `composer-lifecycle.md` 已移除不存在的 FAB 入口并指向本文。

尚未处理（未纳入本计划）：续聊附件的"部分上传失败"产品规则（`composer-lifecycle.md` 后续顺序第 3 条）仍为"发送成功的部分"；提交快照/事务 id（第 2 条）未做。

原计划内容：

- 更新 `composer-lifecycle.md`（移除 FAB、指向本文）。
- 可选：新建会话待上传文件存入 IndexedDB；支持拖入文件。

## 5. 风险与验证

- Codex 命令删减会改变用户习惯：菜单显示 `handling` 说明，未保留的命令仍可手动输入（作为普通文本发送）。
- 空闲时 `/compact` 会 resume 进程，需保留现有提示和失败恢复草稿逻辑。
- 富剪贴板体积：dataURL 会让剪贴板 HTML 很大，需设上限并处理 Safari/WebView 的用户激活限制（沿用当前"先写入、再异步填充"的 `ClipboardItem` 做法）。
- 旁路附件会占用快照上下文和存储，需要沿用旁路的大小限制并按 capability 关闭。
- 验证：`pnpm lint`、`pnpm typecheck`、`pnpm test`（重点 `MessageInput`、`NewSessionForm`、`composerFlows`、`clipboard`、`agentCommands`、旁路 server 测试）。真实剪贴板、移动软键盘和浏览器原生撤销需在获准后做浏览器或设备验证。
