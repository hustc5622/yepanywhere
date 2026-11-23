# Pi coding-agent 接入说明

## 参考基线

- 上游仓库：`https://github.com/earendil-works/pi.git`
- 本地参考源码：`references/pi/`
- 当前固定提交：`b1efcf7d7c5d7394fbb12ede0174e04d39ee7004`
- 对应包：`@earendil-works/pi-coding-agent` `0.84.2`

Pi 协议或 session 行为变更时，以仓库内参考源码为准：RPC 看
`packages/coding-agent/src/modes/rpc/`，session、模型和扩展生命周期看
`packages/coding-agent/src/core/`，持久化格式看
`packages/coding-agent/docs/session-format.md`。

本机运行支持需要安装对应 CLI：

```bash
npm install -g @earendil-works/pi-coding-agent
```

## 接入方案

Yep 启动受管 Pi 进程时使用：

```text
pi --mode rpc --provider <generated-provider> --model <model> \
  --session-dir <project-session-dir> \
  --extension <yep-bundled-extension>
```

（`YEP_PI_NATIVE_CONFIG=false` 时额外带 `--no-extensions`，见下文“配置来源”。）

Pi RPC 是严格的一行一个 JSON 对象的 stdin/stdout 协议。Yep 使用原生
`prompt`、`steer`、`abort`、`set_model`、`set_thinking_level`、`compact`、
`get_session_stats`、`fork` 和 `get_state` 命令，并消费 message/tool/
`agent_settled` 事件。不能用会吞掉或重写换行的交互式终端协议替代它。

主要实现映射：

| 能力 | Pi 原生能力 | Yep 实现 |
| --- | --- | --- |
| 进程通信 | `--mode rpc` JSONL | `packages/server/src/sdk/providers/pi.ts` |
| 工具审批 | extension `tool_call` + RPC UI confirm | `packages/server/resources/pi-yep-extension.mjs` 转给统一审批流 |
| 模型选择 | extension `registerProvider` + RPC `set_model` | 动态生成 OpenAI-compatible / Anthropic provider |
| 思考等级 | `set_thinking_level` | 复用 Codex 风格 off/auto/low/medium/high 控件 |
| 历史会话 | 原生 append-only JSONL tree | `pi-files.ts`、`pi-reader.ts`、`pi-schema/` |
| 编辑历史消息 | RPC `fork(entryId)` | 保留源 session，在新原生 session 上继续 |
| 分支切换 | `parentSession` + copied prefix | 把原提示和编辑后的提示显示为跨 session sibling 分支 |
| 搜索与列表刷新 | session 文件 watcher | provider catalog、session/content index 以 `pi::` scope 失效 |

## 模型范围

Pi 通过 provider-neutral `fetchLlmGatewayModels()` 读取 gateway
`/v1/models` 结果，并复用每个模型声明的 endpoint 范围：

- `chat/completions` 走动态 `openai-completions` provider；
- `anthropic/messages` 走动态 `anthropic-messages` provider；
- UI 允许在模型实际支持的协议之间选择；
- 选择的 context/output limits 会写入 Pi 动态模型定义。

这不是读取或修改用户的 `~/.pi/agent/models.json`。Yep 把当次会话的模型
目录注入受管子进程，因而不会修改用户的模型目录。

动态注册的模型没有 `thinkingLevelMap`，所以 Pi 原生只会无损接受
`off/minimal/low/medium/high`，并把 `xhigh/max` clamp 到可用等级。Yep 的共享
控件没有 `minimal` 档，因此只展示 low/medium/high；auto 使用 Pi 的中档默认值。

`openai-completions` 模型同时固定一组可移植 `compat` 覆盖
（`supportsDeveloperRole: false`、`supportsStore: false`、
`maxTokensField: "max_tokens"`）。Pi 对未知 baseUrl 的默认检测面向
api.openai.com，会把 system prompt 升级成 `developer` role；通用
OpenAI-compatible gateway（LiteLLM/one-api 风格）会对该 role 返回 400
`invalid_request_error`，已在共享 gateway 上实测确认。

## 审批和凭据边界

Pi 本身明确不内置权限系统，所以 Yep 必须通过扩展在每个 `tool_call` 前
请求确认。扩展把请求交给 Yep 的统一 `onToolApproval`，因此 default、
acceptEdits、plan 和 bypassPermissions 仍由 Yep 的 permission mode 决定。

gateway 配置和 key 只在启动时通过临时环境变量交给扩展。扩展捕获后立即
从 `process.env` 删除，避免 Pi 的 bash 工具继承；Pi 在 native fork 后会
重建 AgentSession 并重新加载扩展，所以捕获值只保留在该子进程的
`globalThis` symbol 中。原生 session JSONL 仍按下文写入 Pi 的正常 session tree。

## 配置来源

Yep 是拉起 Pi 的中间层：受管进程与终端 `pi` 使用同一份 `~/.pi/agent`
配置（扩展包如 `pi-mcp-adapter`、`mcp.json` 中的 MCP、skills、`auth.json`、
`models.json`、trust 等），Yep 只额外 `--extension` 挂载自己的扩展。

唯一的例外是 `settings.json`：Pi 的 RPC `set_model` / `set_thinking_level`
会写回全局 settings，而 Yep 的 `yep-*` provider 只存在于 Yep 扩展中，写进
用户文件会让终端 `pi` 的默认模型失效。因此受管子进程的
`PI_CODING_AGENT_DIR` 指向 `<YEP_ANYWHERE_DATA_DIR>/pi-agent/` 覆盖层
（`pi-native-agent-dir.ts`）：

- 用户 agent dir（`PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`）的每个顶层条目
  都以符号链接接入覆盖层；
- `settings.json` 每次启动复制一份普通文件，Pi 改写只落在覆盖层；
- 覆盖层原有的真实文件（旧隔离模式数据）首次冲突时移到
  `.yep-isolated-backup/`；Pi 以原子 rename 覆盖链接产生的缓存文件下次启动
  时丢弃并重新链接；
- 每次启动 Pi 进程都会重新同步，所以终止会话进程后继续发消息即可加载最新
  配置，不需要新开会话。

用户扩展中需要交互的 RPC UI 请求（`select` / `input` / `editor`）当前由 Yep
自动取消，`confirm` 只放行 Yep 自己的审批前缀；`notify` / `setStatus` 等
fire-and-forget 请求被忽略。

`YEP_PI_NATIVE_CONFIG=false` 恢复旧隔离模式：去掉覆盖层中的链接、还原备份，
并以 `--no-extensions` 启动，用户 `~/.pi/agent` 下的全局 settings/extensions/
skills 不会注入 Yep 受管进程。

## Session 语义

Pi 默认把会话写到：

```text
~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl
```

文件头提供 `id`、`cwd`、`timestamp` 和可选 `parentSession`。后续 entry 通过
`id`/`parentId` 形成树；展示时必须从最新叶节点回溯，只投影 active branch，
不能把被放弃分支的消息混入 transcript。模型、thinking、compaction、usage、
工具调用/结果和 fork lineage 都从原生记录派生。

编辑历史消息时先执行 native `fork`，再重新设置当前表单里的模型和 thinking。
顺序不能反过来，因为 fork 会替换 Pi 的 AgentSession 并恢复源分支状态。
Yep 计算 `--session-dir` 时复用 Pi 源码的 cwd 编码算法；恢复或编辑既有会话时
则使用源 JSONL 所在目录，确保 fork 仍落在同一个原生项目目录。仅当用户设置
Pi 原生 `PI_CODING_AGENT_SESSION_DIR` 时，才按上游语义使用一个扁平目录。

### 新建会话与会话 ID

Supervisor 先用随机临时 ID 创建 `Process`，Pi 的真实 ID 要等 provider 完成
启动才会在 `system/init` 中给出：spawn `pi --mode rpc`（会加载原生扩展，
常见 3–5 秒、偶尔 10 秒以上）→ `set_model` → `set_thinking_level` →
`get_state`（拿到 `sessionId`）→ `get_commands` → `init`。

新建 Pi 会话的启动与 create-only 路径都严格等待这个 ID（最长 30 秒），
拿到后才 `registerProcess`，所以 `session-created`、状态事件和 HTTP 响应里
只会出现真实 ID；超时或 init 前报错会让请求失败。带消息恢复既有会话时 ID
已知，不等待；不带消息恢复（如压缩、切换配置）同样严格等待 init；编辑 fork
按 native fork 的超时等待新 ID。

不要再依赖“先用临时 ID 注册、之后发 `session-id-changed` 修正”：这会把同一
会话拆成两个客户端视图。对仍可能走非严格等待的 provider，客户端修正链路是：
侧栏处理 activity 通道的 `session-id-changed`（临时卡片改名或并入真实卡片）；
会话页的 display 订阅在请求 ID 已被替换时补发 `session-id-changed`；
`/metadata` 按 `sessionIdAliases` / 进程当前 ID 返回真实 `session.id`；
访问记录与已读标记在写入时解析别名，并在 ID 变更时迁移。

### agent 自己发起的轮次与轮次状态

扩展可以在 Yep 没有发 prompt 时启动新的一轮：`pi.sendMessage(..., { triggerTurn: true })`，例如 pi-subagents 异步子任务完成后的唤醒、goal 续跑。Pi RPC 照常输出 `agent_start` … `agent_settled`。Provider 在两次提问之间也读取 RPC 事件：

- 空闲时收到 `agent_start`，发出 `system/turn_started`（`origin: "agent"`），`Process` 切到运行中，直到 `agent_settled` 的 `result` 才回到空闲；`agent_settled.aborted` 映射为 `turnStatus: "interrupted"`。空闲时的 `compaction_start` 同样包成一轮。
- 此前这些事件留在 RPC 队列里没人读：会话显示空闲、transcript 停在一半就被判成中断；下一次提问还会先读到残留的 `agent_settled`，把新的一轮提前结束。
- 提问一律带 `streamingBehavior: "followUp"`：如果扩展恰好在发送前启动了一轮，提问并入那一轮（Pi 空闲时忽略这个参数），不会被 Pi 以「Agent is already processing」拒绝。
- 扩展命令（如 `/goal`）回应 `disposition: "handled"` 时没有自己的一轮，Yep 直接发 `result` 收尾；命令触发的一轮按 agent 自己发起的轮次处理。此前这种提问会一直等不到 `agent_settled`。

会话的「上一轮状态」（`lastTurnStatus`）从原生记录派生：`stop`/`length` 为完成，`error` 为失败，`aborted`（以及记成错误的 abort）为**已中断**；记录停在一轮中间（结尾是提问、工具结果或 `toolUse`）为 **`incomplete`（未完成）**。同样的形状在 agent 仍在写入时也会出现，所以 `incomplete` 只在没有进程持有、也没有外部 agent 运行这个会话时展示（`presentLastTurnStatus`）。agy、MiniMax Code、dsh 复用同一套派生。

## 当前边界

- Yep 创建的 Pi 会话具备 RPC 控制和远程审批；外部终端 Pi 会话可被发现并
  标记活跃，但 Yep 不接管其原生交互或审批。
- Pi RPC 不转发 extension-only `model_select` 事件；Yep 的中途模型切换以
  `set_model` 成功响应和自身进程状态为准。
- gateway 目录目前不统一声明 reasoning/image 能力。为提供 Codex 风格思考
  和附件交互，动态模型声明这两项能力；最终仍受上游具体模型/API 兼容性约束。
- bundle 构建必须把 `pi-yep-extension.mjs` 复制到发布产物的 `resources/`。

## 验证

实现包含两组不发起真实模型请求的协议测试：

- fake strict-LF RPC 进程：覆盖 fork 顺序、模型/limits、thinking、流式消息、
  工具审批、Anthropic base URL、扩展重载和环境变量清理；
- 原生 JSONL fixture：覆盖项目扫描、active branch、父 session、usage、
  compaction 和工具结果 normalization。

常规门禁使用 `pnpm lint`、`pnpm typecheck` 和 `pnpm test`；不需要重启已运行
服务，也不需要浏览器自动化。

## 运行中工具输出与日志文件

Pi 原生 RPC 会转发 `tool_execution_update`；provider 将其与 Yep 扩展通知去重，
合并成工具块的 `partialOutput`。滚动预览采用最新快照，不能用字符串长度判断新旧。

对于 Bash 的显式 `>`、`>>`、`2>`、`&>` 重定向，Yep 扩展在 **Pi 执行机器**上每
500 ms 读取日志尾部，并在预览中用 `--- 文件路径 ---` 标明来源。每个工具最多跟随
3 个文件，每次每文件最多读取 6000 字节、保留末尾 10 行；扩展日志通知最多 8000
字符。普通终端输出独立保留，避免日志刷新覆盖标准输出。

路径识别不执行 shell 文本。支持字面量绝对路径、当前工作目录相对路径，以及
开头明确的 `cd 路径;` / `cd 路径 &&`；无法确定目录的相对路径、变量路径、命令替换、
heredoc 和设备文件不跟随。脚本内部未出现在命令行中的日志路径也不会自动发现。
已有文件必须在工具开始后发生变化才会展示，避免把旧测试结果当成当前进度。
文件创建、追加、截断、替换和删除都可处理；仅读取普通文件，工具结束、agent 结束、
会话切换或退出时停止跟随。该机制不强制刷新 pytest/Python 自身的输出缓冲。
