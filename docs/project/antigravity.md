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

入口：新建会话选中 Antigravity 时的「Antigravity 用量与账号」折叠卡片，以及 设置 → Provider 里 Antigravity 条目下的同一张卡片（默认展开）。

1. 点击「用 Google 账号登录」（已登录时为「重新登录」）。服务端在 Yep 主机上启动 `agy acp --login`，从 stdout 解析出 Google OAuth 链接返回给客户端（30 秒内没拿到链接就判为失败）。
2. 用户在当前设备打开链接并授权。落地页（`antigravity.google/oauth-callback`）会显示授权码；把授权码或落地页完整网址粘回卡片，点「提交」。
3. 服务端把这一行写进子进程 stdin。子进程退出码为 0 后，用 `agy models` 复核登录态，结果为 `completed`；退出码非 0 时，原样显示 agy 的错误（如 `couldn't log in: … Malformed auth code.`）。授权码错误不会影响已有的登录。
4. 「退出登录」通过 ACP `logout` 实现（agy `initialize` 声明了 `agentCapabilities.auth.logout`），先二次确认；它会让 Yep 主机上所有 agy（包括终端里的）一起退出。

约束：同一时间只允许一个登录流程，开始新的登录会取消旧的；15 分钟内没提交授权码就超时；提交后 60 秒内没完成也判为失败。授权码只接受单行，最长 4096 字符，只写入 agy 的 stdin，不记日志，也不回传给客户端；流程结束后不再返回 OAuth 链接。登录在 Web/API 进程里执行，凭证写入主机 keychain，外置 runtime 之后启动的 agy 直接读取。

接口（受 `ENABLED_PROVIDERS` 控制，未启用时返回 404）：`GET /api/providers/agy/account[?fresh=1]`、`POST /api/providers/agy/login`、`GET /api/providers/agy/login`、`POST /api/providers/agy/login/code {code}`、`DELETE /api/providers/agy/login`、`POST /api/providers/agy/logout`。实现：`packages/server/src/sdk/providers/agy-login.ts`、`packages/client/src/components/AgyAccountCard.tsx`。

## 额度与 AI Credits

和 Codex 用量卡片对齐，额度显示在同一张「Antigravity 用量与账号」卡片里：按额度组（`Gemini Models`、`Claude and GPT models`、`Gemini 4 Argon` 等）显示 5 小时和每周窗口的已用百分比（agy 返回剩余比例，Yep 换算成已用）、重置时间和组内模型，另外显示 AI Credits 余额和升级链接。

- 数据来源：Yep 主机上执行 `agy -p /usage --output-format json` 和 `agy -p /credits --output-format json`（工作目录为临时目录）。这两个是 agy 在 print 模式下直接回答的只读 slash 命令，返回 `num_turns: 0`、空 `conversation_id`，不发起对话、不消耗额度，也不留下会话记录。
- 参数必须保持原样：会话启动用的 `--disable-slash-commands` 会让 `/usage` 变成一次真实的付费对话。解析时如果 `num_turns` 不为 0，或 `command.name` 不是 `usage`/`quota`（`/credits` 要求是 `credits`），直接判为错误，不展示结果。
- 状态：`ok`、`not-installed`、`signed-out`（输出含 `Please sign in` 等）、`unavailable`（agy 返回 `status: ERROR`，例如企业账号没有分模型额度）、`error`（启动失败、60 秒超时、无法解析）。`/credits` 失败不影响额度展示。
- 读取时机：卡片展开且已登录时才读取；只缓存成功结果（5 分钟），并发请求共用一次读取；「刷新」带 `fresh=1` 强制重读。一次读取约 6 秒。
- 接口：`GET /api/providers/agy/usage[?fresh=1]`（受 `ENABLED_PROVIDERS` 控制）。实现：`packages/server/src/sdk/providers/agy-usage.ts`，类型在 `packages/shared/src/agy.ts`。

## 代理（只有模型流量走远端）

agy 的模型、登录和额度流量都在 Google 域名下（推理是 `daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent`）。有的主机只能通过代理访问 Google，有的需要固定出口地区。另外，launchd 启动的 Yep 进程不会继承 shell 里的 `HTTPS_PROXY`。遇到这些情况，在 `.env.deploy.local` 里写：

```bash
YEP_AGY_PROXY=http://127.0.0.1:8486          # 或带认证的远端 http://user:pass@host:port
NO_PROXY=localhost,127.0.0.1,::1,*.local,api.deepseek.com
```

`scripts/install-launchagents.sh` 会把这两个变量写进 server 和 runtime 的 LaunchAgent。登录、`/usage` 和模型目录在 8022 server 进程里执行，所以只要 server plist 里的值和 `.env.deploy.local` 不一致，`scripts/deploy.sh` 就会在重启 server 前同步它，比较时不会打印代理地址。runtime plist 在 runtime 重启（`--restart-runtime`）时刷新。agy 是闭源程序，没有类似 Codex `openai_base_url` 的地址覆盖，而且它启动的 shell 命令和 MCP 会继承全部代理变量。因此 Yep 不把 `YEP_AGY_PROXY` 直接交给 agy，而是在进程内起一个只监听 `127.0.0.1` 的分流 CONNECT 代理（`packages/server/src/sdk/providers/agy-network.ts`，每个进程一个，首次启动 agy 时创建）：

| 目标 | 路径 |
| --- | --- |
| `googleapis.com`、`google.com`、`gstatic.com`、`googleusercontent.com` 及其子域 | 分流代理 → `YEP_AGY_PROXY` |
| 其他域名（MCP、工具访问的站点、内网地址） | 分流代理 → 本机直连 |

`agySpawnEnv` 只把分流代理地址设为 agy 子进程（会话、登录、`/usage`、`/credits`）的 `HTTPS_PROXY`/`https_proxy`，同时清空 `HTTP_PROXY`/`ALL_PROXY`（大小写两种写法）。因此：

- agy 启动的工具即使继承了 `HTTPS_PROXY`，访问非 Google 域名时也走本机网络，不会被带到远端出口。工具访问 Google 域名时会和 agy 一样走远端。
- 远端代理连不上或拒绝时，分流代理返回 502，不会改成直连，避免模型请求在你不知情时换了出口。
- 分流代理记住最近一次上游失败（5 分钟内有效，任一次成功即清除，日志事件 `agy_upstream_proxy_failed`）。出口断开时 agy 刷不了 token，会报 `Authentication required` / `Please sign in`；这期间 Yep 不把 agy 标成未登录，会话错误改报代理不可用（`agy.proxy_unavailable`），而不是让用户重新登录。
- 分流代理只处理 CONNECT（HTTPS），没有认证。它只监听回环地址，远端代理的凭据只保存在 Yep 进程里，不会出现在 agy 的环境变量中。
- 其他 provider（Claude、Codex、Pi 等）继续用 runtime 自己的网络环境。
- 没设 `YEP_AGY_PROXY` 时不改写任何变量，agy 继承宿主已有的代理设置。
- `NO_PROXY` 没设时用内置默认值（本机回环与 `*.local` 直连）。

本机与 home 的实际部署（2026-11）：home 的 NinjaDesktop（mihomo）在「覆写增强 → 覆写配置」里加了一个 `listeners` 条目 `agy-us`（`127.0.0.1:8486`，`proxy` 固定为美国节点）。home 的 tinyproxy（`18485`，经 frp 暴露在 `47.95.254.240:18485`）用按域名的 `upstream` 把上表的 Google 域名转到 8486，其余仍转到 Clash 的规则端口 8485（Codex 走这里，出口是新加坡）。home 的 Yep 用 `YEP_AGY_PROXY=http://127.0.0.1:8486`。本机 Yep 原先用与 Codex 相同的那个带认证的 `47.95.254.240:18485` 地址；2026-11-23 home 出口掉线后改为不设 `YEP_AGY_PROXY`，agy 直接使用本机网络（本机出口实测为美国洛杉矶节点），`.env.deploy.local` 里保留注释掉的那一行，需要时取消注释重新部署即可。从 `.env.deploy.local` 删掉（或注释掉）`YEP_AGY_PROXY` 后，`scripts/deploy.sh` 会把它从 server 和 runtime 的 LaunchAgent plist 里一并删除。在 Yep 内的终端或 agent 里执行部署时，shell 会继承运行中 Yep 的 `YEP_AGY_PROXY`/`NO_PROXY`；`scripts/lib/deploy-env.sh` 把与已部署 plist 相同的继承值视为非显式设置并忽略，以 env 文件为准（否则旧值会被重新写回 plist）。

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

## agent 自己发起的轮次

agy 的后台命令和计时器结束时，agy 会在没有 prompt 的情况下自己继续工作（协议细节见 `references/antigravity/README.md`「agent 自己发起的轮次」）。Yep 的处理：

- 两次提问之间也读取 ACP 更新。出现对话类更新（正文、思考、工具调用）就发出 `system/turn_started`（`origin: "agent"`），`Process` 据此从空闲切到运行中，界面和普通提问一样显示「运行中」，可以插入消息、中断。状态元数据（`usage_update`、`session_info_update` 等）不算；上一轮结束后 2 秒内到达的残余正文也不算（agy 可能先返回 prompt 再补最后几段）。
- 这一轮没有 prompt 可以等，结束以 transcript 为准：ACP 静默 1.5 秒，且 `transcript_full.jsonl` 最新的 step 比这一轮开始时新、并且是交还控制的 step（不带 tool call 的 `PLANNER_RESPONSE` 或 `ERROR_MESSAGE`），就发出 `result`。只读文件尾部（`readAgyTranscriptTail`）。兜底：静默 10 秒且最新 step 已交还控制，或静默 30 分钟。
- 唤醒期间发的消息作为 `session/prompt` 并入这一轮，由它接管这一轮的结束；中断时没有 prompt 可返回 `cancelled`，Yep 直接以 `interrupted` 收尾。
- 还有后台调用未结束时（开始超过 6 小时的不算），`hasPendingBackgroundWork()` 为真，Supervisor 不回收、不抢占这个空闲进程，否则会连带杀掉后台任务和它将要发起的那一轮。
- 实现：`packages/server/src/sdk/providers/agy.ts`（`hasAgentWork`、`streamTurn`）、`packages/server/src/sessions/agy-store.ts`（`readAgyTranscriptTail`）。真实联调：`npx tsx scripts/smoke-agy-agent-turn.ts`（`SMOKE_STEER=1` 插入消息，`SMOKE_CANCEL=1` 中断；会发起模型请求）。

## 编辑提问与分支

和 Pi、Codex 一样，编辑历史提问会保留原会话，在新会话里继续（source-preserving edit fork）：

- ACP 没有暴露 `/fork`、`/rewind`，但每个 `agy acp` 进程都内嵌 TUI 用的语言服务器。它在回环地址上提供 Connect HTTP+JSON，要求 `x-antigravity-csrf-token`；令牌可以用环境变量 `ANTIGRAVITY_SERVER_CSRF_TOKEN` 指定，HTTP 端口只打印在 ACP 日志里（`Language server listening on random port at <port> for HTTP`）。
- 编辑第 N 步的提问时，Yep 另起一个短命的 `agy acp --log-file <临时文件>`，带上随机令牌，先发 `initialize` 和只读的 `session/list` 让语言服务器启动，从日志读出端口，并等 `session/list` 成功（它同时是登录检查，失败就不分叉，避免留下没人接入的复制会话），再调用 `exa.language_server_pb.LanguageServerService/ForkConversation {sourceCascadeId, forkAtStepIndex: N-1, targetForkWorkspace: "FORK_TARGET_CURRENT_WORKSPACE"}`，拿到 `newCascadeId` 后结束这个进程。之后会话进程照常 `session/resume` 新会话并发送改写后的提问。实现：`packages/server/src/sdk/providers/agy-fork.ts`。
- `forkAtStepIndex` 包含该步：新会话复制 `0..N-1` 步，保留原来的 step 序号、时间戳和工作区，末尾再加一条 fork 通知（`SYSTEM_MESSAGE`）。agy 拒绝在用户提问那一步分叉（`that step is a user message`），所以连续两条提问之间没有回复时无法编辑后一条。
- 编辑第一条提问（N = 0）没有可保留的历史，直接 `session/new`。
- 只分叉对话，不回退工作区文件（和终端 `/fork`、其他 provider 的编辑一致）。fork 不调用模型，实测约 1～6 秒（主要是语言服务器启动）。
- agy 不记录分叉来源（`conversation_parents` 没有记录，`parent_conversation_id` 为空，新会话照常出现在会话目录里）。Yep 把 `forkParentSessionId` 和被替换提问的 id（`forkTargetMessageId`）写进自己的会话元数据，reader 据此用 copied-prefix 方式（同 Pi）构建分支：复制的历史要求 step 序号、角色、正文和时间戳都相同；被编辑提问与原提问显示为同级分支，会话列表把整个分支族合并成一项。
- 消息 id 为 `agy-<会话 id>-step-<n>`。fork 保留 step 序号，不带会话 id 的话同一分支族里会出现重复 id。旧版本的 `agy-step-<n>` 仍能解析。

## 旁路对话（`/side`、`/btw`）

和 Codex、Pi 一样，可以在主任务运行中或空闲时开一个独立的只读旁路，问完用「带回主任务」把结论带回输入框。agy 没有 ACP 层面的 ephemeral 会话，所以实现方式与编辑分支类似，用独立进程加内嵌语言服务器：

- 旁路另起一个 `agy acp --log-file <临时目录>/acp.log`（随机 `ANTIGRAVITY_SERVER_CSRF_TOKEN`），**不动主会话进程**，因此主任务那一轮继续运行。
- 有主上下文时：先 `session/list` 启动内嵌语言服务器并兼做登录检查，再用 `GetCascadeTrajectorySteps` 读该进程看到的 step 列表，挑一个 agy 接受的 fork 点（`planAgySideFork`）：agy 只允许在「一轮结束时、下一条用户消息之前」分叉，所以对话已交还控制就在最后一步分叉；主任务还在跑就退到上一轮的结尾，最多试 3 个候选点（读列表和分叉之间主任务又走了一步时，报错原文是 `a fork must be taken at the end of a turn`，直接用下一个候选）。分叉后立即登记这个新会话，再在原进程里 `session/resume` 它。
- 没有主上下文时直接 `session/new`。两种情况都给 agy 传 `_meta.antigravity.systemPrompt.append`，内容是旁路边界（`SIDE_BOUNDARY`）、只读工具策略，以及主任务正在处理的请求原文（第一轮还没结束时，fork 点不存在，旁路改用新会话，但会把这条请求作为参考附上，最多 6000 字符）。
- 模型和思考等级继承主会话当前的 `model` / `thought_level`；agy 在 resume 后会把模式重置回默认，所以每次都重新 `session/set_mode default`。resume 失败时退回 `session/load`。
- 只读靠 agy 的审批通道强制，思路与 agy 自带 `/btw` 一致（它同样允许读文件、自动拒绝需要审批的调用）：`read_file` 等只读工具不经审批，`run_command` 只在整条命令是纯只读命令时批准（`isAgySideReadOnlyCommand`：只允许 `rg`/`grep`/`find`（不带 `-exec`、`-delete`）/`ls`/`cat`/`head`/`tail`/`wc`/`sed -n` 行区间/`git status|log|show|diff|blame` 等，管道和 `&&`、`;` 可以，重定向只允许丢弃到 `/dev/null`，拒绝展开、子 shell 和后台执行），其余一律拒绝并在回答末尾说明拒绝了什么。子 agent、`send_message`、`schedule`、`manage_task`、workflow、swarm 这类不经审批就会执行、且会碰到旁路之外的调用，一出现就取消这一轮。
  - 如果 agy 的 `toolPermission` 是 `always-proceed` 或 `proceed-in-sandbox`，或者 `settings.json` 的 `permissions.allow` 里有任何非只读动作（例如 `command(git)`），旁路根本不会被创建：那意味着 agy 会自动执行写操作，审批通道管不到。项目级 `.gemini` 规则不在这个预检能看到的范围内，所以还有第二道网：写类工具（`write_file`/`edit_file`/`run_command`/`call_mcp_tool` 等）如果在没有经过 Yep 批准的情况下直接完成，旁路立即关闭并提示是哪条调用穿过了规则。
- agy 会把旁路会话落盘到 `~/.gemini/antigravity-cli`。为了不让它出现在 Yep 的会话列表、索引和外部活动里，Yep 在自己的数据目录写 `agy-side-sessions.json`（`register` / `markDeleted` / 孤儿 `pid` 回收，原子写入，按 mtime 缓存）：`listAgySessionRecords`、`findAgySessionRecord` 统一过滤掉这些 id，因此会话列表、会话详情、搜索、索引、外部活动追踪和文件监听都看不到它们。删除后仍保留 10 分钟，因为 agy 的 `conversation_summaries` 行是异步消失的。
- 关闭旁路时：`session/cancel` → `session/close` → 用同一个语言服务器调 `DeleteCascadeTrajectory {cascadeId}` 删除临时会话 → 结束进程并删掉临时目录。删除失败时记录 `agy_side_conversation_deleted` 之外的告警，条目留在注册表里当孤儿，下次创建旁路时用新进程的语言服务器回收。Yep 从不直接删 agy 的文件。
- 主会话进程结束时（`abort`、自然退出、runtime 重启）旁路一起结束；旁路自身也有 30 分钟空闲、10 分钟单轮上限。
- 已知限制：不能真正恢复「运行中那一轮的前半段」——主任务还在推进时，旁路拿到的是上一轮结束时的快照加当前请求原文；用户 `/btw` 原生实现同样不继承未完成的轮次。agy 自己发起的唤醒轮次期间的旁路同理。
- 实现：`packages/server/src/side-conversations/agy.ts`（fork 选点、只读判定、设置预检、事件映射）、`agy-registry.ts`（临时会话注册表）、`packages/server/src/sdk/providers/agy-acp-tools.ts`（与主 provider 共用的工具名、结果文本、模型切换）、`acp/client.ts`（`_meta`、`session/close`、进程退出回调）。测试：`packages/server/test/side-conversations/agy.test.ts`（模拟 agy 覆盖分叉选点与回退、只读审批、拒绝提示、空上下文、注册表隐藏与清理、设置冲突）。

## 数据来源（只读）

- 会话目录：`~/.gemini/antigravity-cli/conversation_summaries.db` 的 `conversation_summaries` 表。只列出 `parent_conversation_id = ''`（排除子 agent 运行）且 `step_count > 0`（排除只建了会话、从未提问的）的记录。工作目录取自 `workspace_uris`：同一目录的真实路径和传入路径都出现时，取传入路径（即符号链接那种写法）。
- Transcript：`brain/<id>/.system_generated/logs/transcript_full.jsonl`，每行一个 step。不用 `transcript.jsonl`，因为它的参数是二次编码的字符串，长内容还可能被截断。step 的映射如下：
  - `USER_INPUT`：取 `<USER_REQUEST>` 里的正文，再加上 `media` 里的图片，转成 user 消息。
  - `PLANNER_RESPONSE`：转成 assistant 消息，包括 thinking、正文和 tool call。
  - `GENERIC`：转成 tool 结果，去掉 `Created At:`/`Completed At:` 这些记账行；`status: ERROR` 时取 `error`。记账行是 agy 唯一的逐调用起止时间：一个 `PLANNER_RESPONSE` 的全部调用共用该步的 `created_at`，`GENERIC` 的 `created_at` 是调用发出时间而非结束时间。因此结果条目的时间取 `Completed At`，并带上 `durationMs = Completed At - Created At`（实时结果同样从 `rawOutput.output` 读取）；运行中的调用在展示层优先用实时 `tool_call` 到达时间作起点（`SessionDisplayReducer.adoptLiveToolStarts`）。
  - `CHECKPOINT`：对应 `/compact`，转成 Pi compaction。
  - `SYSTEM_MESSAGE` 不显示。
- tool call id：transcript 里没有 id。reader 从 `conversations/<id>.db` 的 `steps.step_payload`（protobuf）里扫描 `call_<digits>`，让历史记录和实时流用同一个 id（实时工具块因此可以和落盘记录去重）。扫不到时退回 `agy-call-<step>-<n>`。
- 文件变化：监听 `brain/` 目录下的 `transcript_full.jsonl`。终端里的 `agy` 正在运行的会话，会被 ExternalSessionTracker 标记为外部活动。
- 展示：和 Pi、MiniMax Code 一样，实时通道只转发工具块，正文以磁盘快照为准，按 step 整段出现。
- 折叠：agy 一个 prompt 由多个 planner step 串起来，中途可能有多段面向用户的正文。reader 把以下两种 step 的正文标为 `final_answer`（`annotateAgyReplyPhases`），让它们留在「已完成」折叠外，并把工作过程切成前后几段：一是只有正文、没有工具调用的 step（agy 交还控制，比如等后台任务时的进度说明，或最终答复）；二是正文和 `ask_question` 在同一个 step（向用户提问前给出的报告）。正文配普通工具调用的（「我先看看 X」）仍然折叠。历史里的 thinking 也会显示在折叠区里。
- 上下文用量：取最后一个带 token 的 `PLANNER_RESPONSE` 的 `input_tokens + cache_read_tokens + output_tokens`。窗口不用 ACP `usage_update.size`（恒为 `1048576`，是模型原始窗口），而用 agy 实际压缩的上限：agy 二进制里 `model_profiles` 的 `CASCADE_USE_EXPERIMENT_CHECKPOINTER.max_token_limit`，下一次请求会超过它时写 `CHECKPOINT`。实测 Gemini 4 Argon（`MODEL_PLACEHOLDER_M417`，512000）约 51 万压缩、Gemini 3.8 Flash（无专属 profile，默认 256000）约 25.4 万压缩。对应表在 `packages/shared/src/app-types.ts` 的 `getAgyContextWindow`（Gemini 4 / Orchestrator 512K，Flash、Claude 256K，GPT-OSS 80K，其他 256K）；reader 以 provider `agy` 解析窗口（不走 Pi 网关表的 Gemini 1M），模型目录也带上这个值。升级 agy 后可用 `strings ~/.local/bin/agy | grep max_token_limit` 和 `~/.gemini/antigravity-cli/log/` 里的 `Switching model ... (enum: …)` 复核。
- `AGY_DATA_DIR` 是 Yep 专用的覆盖项（测试和诊断用），默认值是 `~/.gemini/antigravity-cli`。Yep 从不写 agy 的数据库或 transcript；归档 agy 会话只写 Yep 自己的元数据。

## 当前不支持

- 原地回退（`/rewind`，语言服务器的 `RevertToCascadeStep`）：会改写原会话，Yep 的编辑统一走保留原会话的分叉，不接入。
- 逐字流式显示正文：ACP 会推送正文增量，但为了和磁盘记录对齐，展示层按 step 整段显示。ACP 也不推送 thinking，thinking 只在历史里出现。
- 多账号：未实现（`--app-data-dir` 能否隔离 keychain 还没验证）。界面也不显示账号邮箱：agy 不对外提供邮箱，只在日志里出现。
- MCP 注入：ACP 的 `session/new` 支持 `mcpServers`，HTTP 类 MCP 需要 `--process-per-session`，目前尚未接入。
- 子 agent transcript 关联（`invoke_subagent`，会话目录里有 `parent_conversation_id`）。

## 参考与验证

- 单元测试：`packages/server/test/sdk/providers/agy.test.ts`、`agy-agent-turn.test.ts`（用模拟 agy 覆盖后台任务唤醒、并入、中断和残余正文）、`agy-fork.test.ts`（用模拟 agy 覆盖语言服务器端口、CSRF 令牌和 fork 失败）、`packages/server/test/sessions/agy-branch.test.ts`（分支视图）、`agy-login.test.ts`（用模拟 agy 脚本覆盖登录流程）、`agy-usage.test.ts`（真实 `/usage`、`/credits` 输出作 fixture）、`agy.test.ts` 的 `agy spawn env`（`YEP_AGY_PROXY` 只作用于 agy）、`agy-network.test.ts`（分流代理：Google 域名走认证上游、其余直连、上游失败不回退）、`packages/server/test/sessions/agy-store.test.ts`、`packages/server/test/routes/providers.test.ts`、`packages/client/src/components/__tests__/AgyAccountCard.test.tsx`。
- 真实联调：`npx tsx scripts/smoke-agy-provider.ts [cwd]`。依次覆盖新建、续接和工具审批，再做问卷测试，最后用 reader 读回历史。脚本会发起模型请求（默认 Gemini 3.8 Flash low），并在 agy 历史里留下测试会话，运行前需要用户授权。可用环境变量：`SMOKE_RESUME`、`SMOKE_PROMPT`、`SMOKE_DENY=1`、`SMOKE_MODEL`、`SMOKE_EFFORT`、`SMOKE_MODE`、`SMOKE_MODELS=1`、`SMOKE_QUESTION=0`。
- 旁路对话真实联调：`npx tsx --conditions source scripts/smoke-agy-side-conversation.ts [cwd]`。先跑一轮主任务，再开一次带主上下文的旁路（要求读一个文件，检查只读工具能正常用）、一次不带上下文的旁路（要求写文件，检查被拒绝且旁路没被关掉），最后确认临时会话对注册表和会话目录都不可见。会发起模型请求并留下一个主会话，`SMOKE_SKIP_EMPTY=1`、`SMOKE_SKIP_EDIT=1` 可裁剪。
  - 零模型验证（不发起对话，只建会话、分叉、删除）：起一个主会话后立刻 `create` / `close` 带上下文和不带上下文的旁路，确认 `brain/<id>` 和 `conversations/<id>.db` 被 `DeleteCascadeTrajectory` 清掉、注册表里留下带 `deletedAt` 的条目。
- 升级 `agy` 后，重新运行 `references/antigravity/probe/step*.mjs`（需要登录，会发起少量请求），对比新旧 trace，再核对 `agy*.ts`。
