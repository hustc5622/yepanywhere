# Bridge 事件推送与会话持久化（4510 / 4520）

本文档记录 2026-07 对 Codex bridge（4510）与 OpenCode bridge（4520）的一轮重构，覆盖状态机、持久化与事件时延三块。实现入口：

- `packages/server/src/bridge-common/BridgeEventNotifier.ts`
- `packages/server/src/bridge-common/BridgeHttpClient.ts`
- `packages/server/src/codex-bridge/CodexBridgeService.ts`
- `packages/server/src/opencode-bridge/OpenCodeBridgeService.ts`

## Poll-on-push 事件通道

历史问题：external 模式下主服务只能靠 1s 间隔轮询 `/sessions` + `/session-views` 合成生命周期事件，`waiting-input` 等状态到前端最多有一个完整轮询周期的延迟。

现状：

- 两个 bridge sidecar 都暴露 `GET /events`（SSE）。任何 session 状态变化（activity、pending input、title、删除等）都会以 50ms 去抖广播一条 `event: changed` 信号帧。
- `BridgeHttpClient` 启动时除定时轮询外还订阅 `/events`，收到 `changed` 立即触发一次 `pollSessions()`（并发轮询会被合并排队）。
- 信号帧不携带业务数据；既有的"轮询 + diff → EventBus"管线仍是唯一事实来源，因此不存在事件双写/乱序问题。
- SSE 不可用（老版本 sidecar / 网络问题）时自动退化为纯定时轮询，5s 重连。

## Codex bridge 会话持久化

历史问题：4510 的 session 记录纯内存，重启后所有外部会话消失，直到 TUI 重连。

现状：session 元数据（threadId、projectPath、title、messageCount、turn 状态、completedTurnIds、是否已发过 session-created）以 500ms 去抖原子写入 `<dataDir>/codex-bridge/sessions.json`，bridge 启动时恢复为 idle/无连接状态。live 连接状态不持久化，由 TUI 重连后的通知流重建。

## Canonical 事件 journal 轮转

provider（`<dataDir>/codex-events/events.jsonl`）与 bridge（`<dataDir>/codex-bridge/codex-events.jsonl`）的 canonical event journal 都是 `JsonlCodexEventStore` 管理的 append-only JSONL。2026-08-13 起支持按大小轮转：活跃文件达到 `YEP_CODEX_EVENT_STORE_ROTATE_BYTES`（默认 256 MiB）时，下一次 append 先把它重命名为 `{base}.{yyyyMMddHHmmssSSS}.jsonl` 段文件，并只保留最近 `YEP_CODEX_EVENT_STORE_KEEP_SEGMENTS` 个段（默认 3，超出的最旧段直接删除）。冷加载按时间序聚合所有保留段 + 活跃文件，进程内索引跨段保持 sequence 连续；只读实例通过 identity/大小变化检测自动全量重载。轮转会打 `codex_event_store_rotated` 日志。在此之前 journal 无界增长（实测约 190 MB/天），曾因单文件超过 V8 字符串上限（512 MiB）导致 Codex 新建会话全线 500。

## Codex bridge 状态机要点

- `turn/completed` 解析 `turn.status`（completed/interrupted/failed）与 `turn.error`，记录到 `lastTurnStatus` / `lastErrorMessage` 并透传到 session view。
- 顶层 `error` 通知：`willRetry=false` 时终止 turn（resolve pending → idle + failed）；`willRetry=true` 保持 in-turn。
- pending input 解决后的活动回退基于 `turnActive` 跟踪，不再无条件回退 `in-turn`。
- 会话在 thread 元数据（cwd）到达前不对外暴露（`projectPathKnown` 门禁），避免被错误归档到 bridge 进程的 cwd 对应项目。

## OpenCode bridge 状态机要点

- `session.status` 支持完整 `idle|busy|retry` union；retry 携带 attempt/next/action 透传到 `retryStatus`，UI 可显示"重试中"而非静默 spinner。
- `session.error` → idle + `lastErrorMessage`；`session.deleted` → 移除会话与 pending inputs。
- 用户消息落库（`message.updated` role=user）与 session 元数据更新不再视为活跃 turn；仅 assistant 侧/流式 part 事件才置 `in-turn`。
- provider 侧以 `session.status(type=idle)` 为回合终止信号（`session.idle` 上游已废弃，保留兼容）。

## Codex rewind（单刷）权威计数

客户端编辑历史 prompt 时附带 `rollbackTarget: { timestamp, text }`；服务端在 resume 路由用 `computeCodexRollbackNumTurns`（`packages/server/src/sessions/codex-rollback.ts`）基于持久化 turn 树计算 `thread/rollback` 圈数，客户端渲染项计数仅作 fallback。日志事件：`codex_rollback_numturns_resolved` / `codex_rollback_numturns_resolution_failed`。

## 外部 OpenCode 实例（默认 `opencode` TUI）的审批接入

背景：新版 opencode（≥1.2.x）的默认 TUI **不监听任何端口**（server 跑在进程内 Bun Worker，TUI 走进程内 RPC），4520 bridge 的 `/global/event` SSE 只能看见 bridge 托管的 4521 server（即 `of` / `opencode attach` 的会话）。直接跑 `opencode` 的会话与审批对 bridge 完全不可见；上游也没有 server 注册表可发现（`permission.ask` 阻塞插件钩子已在 v1.2.27 被上游删除）。

方案：**全局转发插件 + bridge 外部实例 API**。

- 插件源：`packages/server/resources/opencode-plugin/yep-bridge.ts`；安装：`scripts/install-opencode-yep-plugin.sh`（复制到 `~/.config/opencode/plugin/yep-bridge.ts`，opencode 对所有实例自动加载）。安装脚本是幂等的；`scripts/redeploy-server.sh` 每次成功构建 bundle 后会同步该版本，首次安装 OpenCode bridge LaunchAgent 时也会同步，避免运行时继续加载旧的手工副本。
- 插件行为：实例启动时 `POST /external/instances` 注册（instanceId + directory）；`event` 钩子把 permission/question/session.\* 事件 `POST /external/events` 转给 4520；同时对 `GET /external/instances/:id/decisions?waitMs=25000` 长轮询，取到决策后用**进程内 SDK client** 应用（permission → `postSessionIdPermissionsPermissionId`；question → 底层 hey-api client 直调 `/question/:id/reply|reject`）。TUI 弹窗与 Yep 前端谁先答都行，`permission.replied` 事件双向对账。
- bridge 侧（`OpenCodeBridgeService`）：`SessionRecord.instanceId` 标记外部实例会话（cwd 用插件上报的真实 directory）；`respondToInput` 对带 instanceId 的 pending 走决策队列而非 HTTP 回复；外部会话不参与托管 server 的 status 对账，改用**长轮询心跳**判活（静默 90s 置 idle，10min 遗忘）。
- 防重复上报：Yep 托管的 opencode 进程（bridge 4521 + provider per-session serve）注入一次性启动标记 `YEP_MANAGED_OPENCODE=1`，并用 `YEP_MANAGED_OPENCODE_SERVER_PORT` 绑定当前 `serve --port`。插件只对命令与端口都匹配的 server 保持沉默，初始化后立即从 `process.env` 删除这两个标记，避免 agent 启动的服务、工具和嵌套 `opencode run` 继承 managed 身份。兼容旧 launcher 时，没有 port 标记也只允许 `serve` 命令静默；`YEP_OPENCODE_PLUGIN_DISABLE=1` 仍是可继承的硬开关；`YEP_OPENCODE_BRIDGE_URL` 覆盖 bridge 地址。
