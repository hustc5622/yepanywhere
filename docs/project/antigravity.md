# Antigravity CLI 接入

Antigravity CLI（命令 `agy`，provider 名 `agy`）是 Google 面向个人账号（Free、Google AI Pro/Ultra）的官方终端 agent。2026-06-18 起，Gemini CLI 只服务 Gemini Code Assist 企业用户，个人账号迁到 `agy`。Yep 通过本机 `agy acp`（Agent Client Protocol over stdio）接入。旧的 `gemini` / `gemini-acp` provider 继续保留，用来读取旧的 Gemini CLI 数据。

`agy` 是闭源单二进制，协议事实以本机实测为准。参考资料、探测脚本和 JSON-RPC trace 都在 `references/antigravity/`（README 记录了全部协议细节），不要凭印象实现。

## 安装、更新与登录

- 安装：`curl -fsSL https://antigravity.google/cli/install.sh | bash`，二进制装到 `~/.local/bin/agy`。安装器还会往 `~/.zshrc` 和 `~/.zprofile` 追加 `PATH`。
- 更新：`agy` 自带后台自更新（锁文件在 `~/.gemini/antigravity-cli/updater/`），也可以手动执行 `agy update`。用 `AGY_CLI_DISABLE_AUTO_UPDATE=true` 关闭自更新。Yep 的「CLI 更新」入口暂不接管它。
- Yep 按以下顺序查找 `agy`：`AGY_PATH` → `~/.local/bin/agy` → `/opt/homebrew/bin/agy` → `/usr/local/bin/agy` → `PATH`。launchd 启动的服务不继承 shell `PATH`，所以默认安装位置要排在前面。
- 登录：凭证存在系统 keychain（macOS Keychain），Yep 不读取。可以在 Yep 里登录（见下节），也可以在 Yep 主机上交互运行一次 `agy`，完成 Google 登录和首次的 ToS 确认。SSH 或无浏览器环境用 `agy acp --login`：它在终端打印授权链接，再从 stdin 读取授权码。
- 也可以用 API key：在 `~/.gemini/antigravity-cli/settings.json` 里设置 `"modelProvider": "gemini"`，并导出 `GEMINI_API_KEY`。企业账号可以用 ADC（`AGY_ADC_AUTH=true`）。
- 认证状态：`agy models` 需要登录才能用，Yep 用它同时判断登录态并获取模型目录。结果缓存 5 分钟，未登录时缓存 20 秒。列表接口先返回缓存，后台再刷新。未登录时会话启动报 `agy.auth_required`。

## Yep 内登录

入口：新建会话选中 Antigravity 时的「Antigravity 账号」卡片，以及 设置 → Provider 里 Antigravity 条目下的同一张卡片。

1. 点击「用 Google 账号登录」（已登录时为「重新登录」）。服务端在 Yep 主机上启动 `agy acp --login`，从 stdout 解析出 Google OAuth 链接返回给客户端（30 秒内没拿到链接就判为失败）。
2. 用户在当前设备打开链接并授权。落地页（`antigravity.google/oauth-callback`）会显示授权码；把授权码或落地页完整网址粘回卡片，点「提交」。
3. 服务端把这一行写进子进程 stdin。子进程退出码为 0 后，用 `agy models` 复核登录态，结果为 `completed`；退出码非 0 时，原样显示 agy 的错误（如 `couldn't log in: … Malformed auth code.`）。授权码错误不会影响已有的登录。
4. 「退出登录」通过 ACP `logout` 实现（agy `initialize` 声明了 `agentCapabilities.auth.logout`），先二次确认；它会让 Yep 主机上所有 agy（包括终端里的）一起退出。

约束：同一时间只允许一个登录流程，开始新的登录会取消旧的；15 分钟内没提交授权码就超时；提交后 60 秒内没完成也判为失败。授权码只接受单行，最长 4096 字符，只写入 agy 的 stdin，不记日志，也不回传给客户端；流程结束后不再返回 OAuth 链接。登录在 Web/API 进程里执行，凭证写入主机 keychain，外置 runtime 之后启动的 agy 直接读取。

接口（受 `ENABLED_PROVIDERS` 控制，未启用时返回 404）：`GET /api/providers/agy/account[?fresh=1]`、`POST /api/providers/agy/login`、`GET /api/providers/agy/login`、`POST /api/providers/agy/login/code {code}`、`DELETE /api/providers/agy/login`、`POST /api/providers/agy/logout`。实现：`packages/server/src/sdk/providers/agy-login.ts`、`packages/client/src/components/AgyAccountCard.tsx`。

## 会话与接管

- 新建用 `session/new`；接管或继续用 `session/resume`（不回放历史），失败时退回 `session/load`。接管失败时不会偷偷新建会话。
- resume/load 之后，agy 会把模型、thinking level 和执行模式重置为账号默认值。Yep 每次启动进程后都会重新下发当前选择。
- 模型：`agy models` 输出 slug，档位编码在 slug 里（`gemini-4-neon-high`）。Yep 按家族显示（`gemini-4-neon`），档位作为推理强度（`low`/`medium`/`high`/`xhigh`），通过 ACP `session/set_config_option` 的 `model` 和 `thought_level` 下发。只有一个档位的模型保留完整 slug（如 `gpt-oss-120b-medium`）。家族不支持所选档位时，保留 agy 默认档位，不让本轮失败。
- 执行模式：Yep `default` / `acceptEdits` / `auto` / `plan` 分别映射到 agy 的 `default` / `accept-edits` / `auto` / `plan`（`session/set_mode`）。`bypassPermissions` 使用最宽松的原生模式（有 `auto` 用 `auto`，否则用 `accept-edits`），agy 仍然询问的请求由 Yep 自动批准。`auto` 需要终端沙箱，企业账号不可用；不可用时回退为 `default`。agy 自己的 `permissions` 规则始终先生效。
- 审批：agy 先应用自己的模式和规则，需要确认时才发 `session/request_permission`，选项只有 `allow`（allow_once）和 `deny`（reject_once）。Yep 不会二次自动批准（bypass 除外）。拒绝后 agy 直接结束本轮。
- 提问：Yep 声明了 `elicitation.form`，`ask_question` 通过 `elicitation/create` 发来表单（`q1` 的 `oneOf` 选项加 `q1_other` 自由输入），映射到 Yep 的 AskUserQuestion 面板。
- 插入消息（steer）：轮次进行中再发一次 `session/prompt`，agy 会把它并入当前轮。前一个 prompt 请求立即以 `end_turn` 返回，本轮的结果归属到最新的请求，provider 以最新请求结束为本轮结束。
- 中断：`session/cancel`，进行中的工具调用标为 failed，prompt 返回 `stopReason: "cancelled"`。
- slash 命令来自 ACP `available_commands_update`（`/goal`、`/compact`、`/plan`、`/schedule` 等），作为普通 prompt 文本发送即可。`/model`、`/usage` 这类由 CLI 自己回答的命令不走 ACP。
- 工具名：ACP SDK 解析消息时会丢掉 agy 私有的 `tool_call.name`，provider 通过 `ACPClient.setRawMessageObserver` 从原始帧里记录它；没记录到时按参数形状推断（`CommandLine` 对应 `run_command`，依此类推）。映射到 Yep renderer 的规则在 `packages/server/src/sessions/agy-tools.ts`。

## 数据来源（只读）

- 会话目录：`~/.gemini/antigravity-cli/conversation_summaries.db` 的 `conversation_summaries` 表。只列出 `parent_conversation_id = ''`（排除子 agent 运行）且 `step_count > 0`（排除只建了会话、从未提问的）的记录。工作目录取自 `workspace_uris`：同一目录的真实路径和传入路径都出现时，取传入路径（即符号链接那种写法）。
- Transcript：`brain/<id>/.system_generated/logs/transcript_full.jsonl`，每行一个 step。不用 `transcript.jsonl`，因为它的参数是二次编码的字符串，长内容还可能被截断。step 的映射如下：
  - `USER_INPUT`：取 `<USER_REQUEST>` 里的正文，再加上 `media` 里的图片，转成 user 消息。
  - `PLANNER_RESPONSE`：转成 assistant 消息，包括 thinking、正文和 tool call。
  - `GENERIC`：转成 tool 结果，去掉 `Created At:`/`Completed At:` 这些记账行；`status: ERROR` 时取 `error`。
  - `CHECKPOINT`：对应 `/compact`，转成 Pi compaction。
  - `SYSTEM_MESSAGE` 不显示。
- tool call id：transcript 里没有 id。reader 从 `conversations/<id>.db` 的 `steps.step_payload`（protobuf）里扫描 `call_<digits>`，让历史记录和实时流用同一个 id（实时工具块因此可以和落盘记录去重）。扫不到时退回 `agy-call-<step>-<n>`。
- 文件变化：监听 `brain/` 目录下的 `transcript_full.jsonl`。终端里的 `agy` 正在运行的会话，会被 ExternalSessionTracker 标记为外部活动。
- 展示：和 Pi、MiniMax Code 一样，实时通道只转发工具块，正文以磁盘快照为准，按 step 整段出现。
- 折叠：agy 一个 prompt 由多个 planner step 串起来，中途可能有多段面向用户的正文。reader 把以下两种 step 的正文标为 `final_answer`（`annotateAgyReplyPhases`），让它们留在「已完成」折叠外，并把工作过程切成前后几段：一是只有正文、没有工具调用的 step（agy 交还控制，比如等后台任务时的进度说明，或最终答复）；二是正文和 `ask_question` 在同一个 step（向用户提问前给出的报告）。正文配普通工具调用的（「我先看看 X」）仍然折叠。历史里的 thinking 也会显示在折叠区里。
- `AGY_DATA_DIR` 是 Yep 专用的覆盖项（测试和诊断用），默认值是 `~/.gemini/antigravity-cli`。Yep 从不写 agy 的数据库或 transcript；归档 agy 会话只写 Yep 自己的元数据。

## 当前不支持

- 编辑、回退和分支：agy TUI 里有 `/rewind`、`/fork`，但 ACP 没有暴露。
- 逐字流式显示正文：ACP 会推送正文增量，但为了和磁盘记录对齐，展示层按 step 整段显示。ACP 也不推送 thinking，thinking 只在历史里出现。
- 多账号：未实现（`--app-data-dir` 能否隔离 keychain 还没验证）。界面也不显示账号邮箱：agy 不对外提供邮箱，只在日志里出现。
- MCP 注入：ACP 的 `session/new` 支持 `mcpServers`，HTTP 类 MCP 需要 `--process-per-session`，目前尚未接入。
- 配额与额度（`agy -p /usage`、`/credits`）。
- 子 agent transcript 关联（`invoke_subagent`，会话目录里有 `parent_conversation_id`）。

## 参考与验证

- 单元测试：`packages/server/test/sdk/providers/agy.test.ts`、`agy-login.test.ts`（用模拟 agy 脚本覆盖登录流程）、`packages/server/test/sessions/agy-store.test.ts`、`packages/server/test/routes/providers.test.ts`、`packages/client/src/components/__tests__/AgyAccountCard.test.tsx`。
- 真实联调：`npx tsx scripts/smoke-agy-provider.ts [cwd]`。依次覆盖新建、续接和工具审批，再做问卷测试，最后用 reader 读回历史。脚本会发起模型请求（默认 Gemini 3.8 Flash low），并在 agy 历史里留下测试会话，运行前需要用户授权。可用环境变量：`SMOKE_RESUME`、`SMOKE_PROMPT`、`SMOKE_DENY=1`、`SMOKE_MODEL`、`SMOKE_EFFORT`、`SMOKE_MODE`、`SMOKE_MODELS=1`、`SMOKE_QUESTION=0`。
- 升级 `agy` 后，重新运行 `references/antigravity/probe/step*.mjs`（需要登录，会发起少量请求），对比新旧 trace，再核对 `agy*.ts`。
