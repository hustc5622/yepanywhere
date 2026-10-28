# MiniMax Code 接入

MiniMax Code（provider 名 `mcode`）通过本机 CLI `mcode acp`（Agent Client Protocol over stdio）接入。CLI 与 MiniMax Code 桌面 App 共用数据目录 `~/.minimax`，所以 App 里创建的会话也会出现在 Yep 中，可以直接接管继续。

## 安装与登录

- CLI 是 npm 包 `@minimax/code`，只发布在 MiniMax 自己的源上：
  `npm install -g @minimax/code --registry=https://npmmirror.xaminim.com/`（Node `22.19+` 或 `24–26`）。
- 登录态与 App 共享（`~/.minimax/auth`）；App 已登录时一般无需再执行 `mcode login`。
- Yep 按顺序查找 `mcode`：`MCODE_PATH` → `~/.minimax-code/bin/mcode`（官方安装器）→ 常见 bin 目录 → `PATH` → `~/.nvm/versions/node/*/bin/mcode`。`mcode` 是 `#!/usr/bin/env node` 脚本，启动时会把它所在的 bin 目录放到 `PATH` 最前面，保证 launchd 启动的服务也能找到匹配的 node。

## 数据来源（只读）

- 会话目录：`~/.minimax/v2/sqlite/runtime-state.sqlite` 的 `local_runtime_sessions`。只列出满足以下条件的会话：`session_kind='conversation'`、无 `parent_session_id`、未归档、非 hidden、已有非空 transcript。子 agent（`task`）、cron、peek 会话不列出。
- App“默认工作区”（`~/.minimax/sessions/<id>/workspace`）里的会话是不属于任何项目的聊天，默认隐藏；设置 `MCODE_INCLUDE_DEFAULT_WORKSPACE=1` 后显示，每个会话会成为一个独立项目。
- Transcript：`~/.minimax/v2/sessions/YYYY/MM/DD/<time>-session_<base64url(id)>/messages.jsonl`。每行是 `{message_id, turn_id, message}`，`message` 是 Pi 格式的 AgentMessage。reader 把它转成线性 Pi session，复用 `convertPiSession` 和 Pi 的工具渲染。
- 用户消息前面拼有 `<system-reminder>`；显示用的正文按 mcode 自己的规则取：`genuineUserQueryText` → `canonicalTextRange` → 剥离生成块。问卷回答显示为 `Q: … A: …` 摘要；没有正文的注入消息（后台任务通知等）不显示。
- 数据目录解析顺序：`MCODE_DATA_DIR`（Yep 专用覆盖）→ `MINIMAX_DATA_DIR` → `MAVIS_DATA_DIR` → `~/.minimax[-<MINIMAX_PROFILE>]`。
- Yep 从不写 MiniMax 的数据库或 transcript。归档 mcode 会话只写 Yep 元数据，不移动文件（文件与 App 共用）。

## 会话与接管

- 新建：`session/new`；接管或继续：`session/resume`（不回放历史），失败时退回 `session/load`。不会在接管失败时偷偷新建会话。
- 权限：Yep 的 `default` / `auto` / `bypassPermissions` 映射到 mcode 的 `permissionMode` 配置项（Ask / Auto / Full access）；`plan` 映射到 `session/set_mode plan`。mcode 自己先应用权限策略，只有它认为需要确认时才发 `session/request_permission`，Yep 不会再自动批准。Ask 模式下工作区内的读写本来就直接放行，越过工作区边界才会询问。
- 模型：来自 ACP `model` 配置项，值的格式是 `m:<provider>:<model>:v:<variant>`。Yep 每个 `provider/model` 显示一项，把 plain 和 `thinking` 两个 variant 折叠成推理强度：`off` 加 `thinkingEffort` 的各档。模型目录不新建会话（ACP 没有 `session/delete`），而是用新 CLI 进程对空闲会话做 resume 再 close（不改动它的历史和时间戳），在 20 秒总预算内跳过无法打开的会话、已删除的工作目录，以及因旧模型退役而不再提供 `model` 选项的会话。目录缓存最多 10 分钟，`config.yaml` 变化后立即失效；旧活跃进程的配置通知不再覆盖目录。新建页选中 MiniMax Code 时会等待后台目录刷新并更新选项。
- 中断：`session/cancel`。Steer：mcode 扩展方法 `mcode/session/steer`，只在 prompt 进行中可用。
- 提问（`ask_user`）：Yep 声明了 `elicitation.form` 能力，mcode 会通过 `elicitation/create` 发送完整问卷（多步骤、多选、Other 自由输入），映射到 Yep 的 AskUserQuestion 面板。回答之后，mcode 在 ACP prompt 返回后再起一个后台 turn 续跑，期间 ACP 不推送正文。provider 会等到 `messages.jsonl` 出现回答时间之后的最终 assistant 消息才结束本轮；transcript 90 秒无变化或队列里有积压时提前结束。
- 队列竞态：问卷回答如果赶在提问的那个 turn 结束之前到达，mcode 会把它放进自己的 Queue，下一次 `session/prompt` 会被 `An earlier queued message has priority` 拒绝。provider 会把积压消息（问卷取 Q/A 摘要）按顺序拼到本次 prompt 前面，从 Queue 删除后重发一次。
- 实时流的正文 ID 与持久化 ID 不对应，展示层按 pi 的方式处理：实时 overlay 只保留工具块，正文以磁盘快照为准。
- App 或终端正在运行的会话会被 ExternalSessionTracker 标记为外部活动。

## 当前不支持

- 编辑或回退历史消息（mcode TUI 支持，但 ACP 未暴露）。
- 会话分支：ACP 有 `session/fork`，本期未接入。
- App 的 SSH app-server（`mcode app-server`）是把桌面端内部 DesktopService 转发出去的私有协议，不是 Codex 那样的 thread/turn 接口，不做对齐。
- 子 agent transcript 关联（`task` 工具结果里有 `sub_session_id`，后续可接）。

## 参考与验证

- 参考源码：`references/minimax/`（见其中 README）。ACP 服务端行为以 `references/minimax/pretty/run-acp-command.js` 和本机 CLI 实测为准，不要凭印象实现。
- 单元测试：`packages/server/test/sessions/mcode-store.test.ts`、`packages/server/test/sdk/providers/mcode.test.ts`。
- 真实联调：`npx tsx scripts/smoke-mcode-provider.ts [cwd]`。这会发起模型请求，并在 MiniMax App 里留下测试会话，运行前需要用户授权。可用环境变量：`SMOKE_RESUME`、`SMOKE_PROMPT`、`SMOKE_DENY=1`、`SMOKE_ANSWER_DELAY_MS`、`SMOKE_MODELS=1`。
