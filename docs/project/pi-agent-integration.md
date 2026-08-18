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
  --session-dir <project-session-dir> --no-extensions \
  --extension <yep-bundled-extension>
```

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
`globalThis` symbol 中。Yep 启动参数使用 `--no-extensions` 禁止自动加载
用户扩展，显式加载的 Yep 扩展仍生效；不会在 `~/.pi` 下安装扩展或改写
models/settings。原生 session JSONL 仍按下文写入 Pi 的正常 session tree。

此外，Pi 的 RPC `set_model` / `set_thinking_level` 会把选择写回全局
`settings.json`。Yep 因此把受管子进程的 `PI_CODING_AGENT_DIR` 固定到
`<YEP_ANYWHERE_DATA_DIR>/pi-agent/`（profile 也自然隔离），避免临时的
`yep-*` provider 成为用户终端 Pi 的默认模型。session 仍显式写在 Pi 的原生
session tree 中，项目内的 context 文件仍按 Pi 的正常规则发现；用户
`~/.pi/agent` 下的全局 settings/extensions/skills 不会注入 Yep 受管进程。

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
