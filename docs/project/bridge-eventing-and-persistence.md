# Codex Bridge 事件推送与会话持久化（4510）

本文档记录 Codex bridge（4510）的状态机、持久化与事件时延实现。OpenCode provider 与 4520/4521 bridge 已于 2026-08-18 退役；历史设计见对应日期计划。

- `packages/server/src/bridge-common/BridgeEventNotifier.ts`
- `packages/server/src/bridge-common/BridgeHttpClient.ts`
- `packages/server/src/codex-bridge/CodexBridgeService.ts`

## Poll-on-push 事件通道

历史问题：external 模式下主服务只能靠 1s 间隔轮询 `/sessions` + `/session-views` 合成生命周期事件，`waiting-input` 等状态到前端最多有一个完整轮询周期的延迟。

现状：

- Codex bridge sidecar 暴露 `GET /events`（SSE）。任何 session 状态变化（activity、pending input、title、删除等）都会以 50ms 去抖广播一条 `event: changed` 信号帧。
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

## Codex bridge 执行接管

- Yep 恢复 Codex Session 前先查询 4510 的 `/sessions/:id/active`。若 Session 仍有外部 TUI 连接，provider 复用该连接的 `clear|light|full` MCP profile，并通过 4510 `/status` 返回的 WebSocket 地址连接对应的常驻 app-server，不再启动独立的 `codex app-server --listen stdio://`；`cf` 的独立代理/MCP 环境因此不会被默认 profile 覆盖。
- `thread/resume` 返回仍在进行的 turn 时，首条 Web 输入使用带 `expectedTurnId` 的 `turn/steer`；如果 turn 在检查与提交之间已经结束，则重新读取 thread 后安全退回 `turn/start`。
- 4510 所有权探测、认证或 WebSocket 连接失败时按 `CODEX_BRIDGE_UNAVAILABLE` 明确失败。此路径 fail closed，不会为了“重试”而创建一个可能同时写入同一 thread 的 app-server。

## Codex rewind（单刷）权威计数

客户端编辑历史 prompt 时附带 `rollbackTarget: { timestamp, text }`；服务端在 resume 路由用 `computeCodexRollbackNumTurns`（`packages/server/src/sessions/codex-rollback.ts`）基于持久化 turn 树计算 `thread/rollback` 圈数，客户端渲染项计数仅作 fallback。日志事件：`codex_rollback_numturns_resolved` / `codex_rollback_numturns_resolution_failed`。
