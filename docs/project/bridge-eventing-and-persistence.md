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
