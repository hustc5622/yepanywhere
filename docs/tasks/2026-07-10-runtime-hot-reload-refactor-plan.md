# Yep Runtime 热重载重构开发计划

## 背景

当前 `pnpm dev:8022` 的热重载路径能保护外置 `4510` Codex bridge，但不能保护仍由 `8022` web/API 进程直接持有的 agent runtime。后端源码变更会触发 `scripts/dev.js` 杀掉 server 子进程；server 收到 `SIGTERM` 后进入 `gracefulShutdown`，主动 abort `Supervisor` 中的 active sessions。结果是：

- 浏览器 WebSocket 断开，前端容易刷新或重新拉取。
- `codex` provider 的 `codex app-server --listen stdio://` 被关闭。
- `opencode` provider 的 per-session `opencode serve` 被杀掉。
- 正在进行的 turn、审批、等待用户输入、deferred queue 等内存状态丢失。

目标是重构 yep 的 runtime 体系，使普通后端/UI 代码热重载不再中断正在运行的 Codex CLI / OpenCode CLI 会话。

## M3_Inspector 参考结论

`~/Desktop/work/M3_Inspector` 的关键设计不是“后端 worker 永不重启”，而是“后端 worker 重启不拥有 LLM 进程生命周期”。

参考点：

- `README.md` 说明：后端默认 `BM_RELOAD=1`，会监听源码变更并热重载；OpenCode evaluation job 独立进程组运行，stdout/stderr 落到 `BM_JOB_LOG_DIR`；reload 后新 worker 从数据库和 ndjson 日志接管或收尾。
- `api/main.py` 使用 uvicorn reload，同时 startup 调用 `_adopt_or_finalize_orphans()`。
- `api/workers/agent_runner.py` 中 `_spawn_detached()` 使用 `start_new_session=True`，把 stdout/stderr 写入稳定日志文件。
- `register_shutdown()` 只清空 `_RUNNING` 内存句柄，不 kill OpenCode job。
- `_adopt_or_finalize_orphans()` 通过 DB 中的 `pid/log_path/log_offset/status/input_payload` 判断进程是否仍活着，并从上次 offset 继续 tail ndjson。

可复用原则：

1. 长生命周期 LLM 进程不能由会热重载的 web/API worker 直接拥有。
2. runtime 事件必须能落盘或可重放，不能只存在内存里。
3. 新的 web/API worker 只需要重建观察者、订阅者和 API facade。
4. shutdown 需要区分“完整退出”和“web/API shell 热替换”。

## Yep 现状梳理

### 当前 reload 链路

- `scripts/dev.js` 监听 `packages/server/src` 和 `packages/shared/src`。
- 源码变化后调用 `requestServerRestart("source change")`。
- `requestServerRestart()` 对 server 子进程发送 `SIGTERM`。
- `packages/server/src/index.ts` 的 `gracefulShutdown()` 收到 `SIGTERM` 后：
  - 遍历 `supervisor.getAllProcesses()`。
  - 对所有 active session 调用 `p.abort()`。
  - shutdown device bridge、Codex bridge、OpenCode bridge client、terminal、archive scheduler。

### 当前 runtime 绑定点

- `createApp()` 内部直接创建 `Supervisor`。
- session start/resume/message/input routes 直接调用 `Supervisor`。
- `/api/status/workers` 读取当前进程内 `Supervisor` 内存状态。
- `/api/ws` session subscription 直接订阅当前进程内 `Process`。
- `Process` 内保存：
  - active iterator / `MessageQueue`
  - pending tool approvals
  - deferred queue
  - hold 状态
  - permission mode version
  - 15-30 秒 SSE replay bucket
  - streaming text accumulator

### Provider 生命周期问题

OpenCode provider：

- `packages/server/src/sdk/providers/opencode.ts` 当前是 per-session `opencode serve`。
- provider `finally` 中会 kill `serverProcess`。
- 只要 `Process`/iterator 所在 Node 进程退出，OpenCode session turn 就会断。

Codex provider：

- `packages/server/src/sdk/providers/codex.ts` 当前每个 session 通过 `CodexAppServerClient` spawn `codex app-server --listen stdio://`。
- abort 或 finally 会 `activeClient.close()` / `appServer.close()`，进而 terminate child process。
- `codex app-server` 也跟随当前 8022 server runtime 生命周期。

OpenCode bridge：

- `OpenCodeBridgeService` 已有 standalone sidecar 形态，但当前 bridge 主要反向调用 8022 API 去启动 `provider: "opencode"` 的 Yep session。
- 因此 bridge 外壳可以独立，但真正执行 turn 的 `Supervisor/Process/provider` 仍可能在 8022 内部。

Codex bridge：

- `4510` external bridge 已经能避免 `codex --remote ws://127.0.0.1:4510` TUI session 被 8022 替换中断。
- 但 yep 内部 `codex` provider turn 仍由 8022 `Supervisor` 持有。

## 设计目标

1. 普通后端 route/UI/session reader 改动可以热替换 `8022`，不 abort active Codex/OpenCode/Claude turns。
2. 前端最多经历 WebSocket reconnect，不强制整页刷新。
3. pending approval、waiting-input、hold、deferred queue、mode change 等交互状态在 8022 重启后仍可见、可操作。
4. `/api/status/workers` 和 reload banner 反映真实 runtime 状态，而不是当前 web/API shell 内存状态。
5. runtime 代码本身变更时不自动中断 active work；只显示 runtime dirty，需要用户明确确认。
6. 保留生产部署的完整 restart/shutdown 语义，避免引入孤儿进程泄漏。

## 非目标

- 第一阶段不重写所有 provider 协议。
- 第一阶段不要求 runtime 自身代码热替换不中断 active turn。
- 第一阶段不要求跨机器迁移 runtime。
- 第一阶段不要求替换现有 Codex bridge / OpenCode bridge 公开协议。
- 第一阶段不改变 provider JSONL/session 文件格式。

## 目标架构

### 三层 runtime 边界

```text
Browser / Mobile
      |
      | HTTP / WebSocket
      v
8022 web-api shell
  - Hono routes
  - auth / settings / metadata
  - session readers / scanners
  - Vite proxy / static assets
  - activity forwarding
      |
      | RuntimeController protocol
      v
agent-runtime sidecar
  - Supervisor
  - Process
  - WorkerQueue
  - MessageQueue
  - pending input / approvals
  - provider CLI child processes
  - runtime event journal
      |
      +-- codex app-server children
      +-- opencode serve / global opencode server
      +-- claude / gemini provider processes
      +-- optional bridge clients
```

### 8022 web-api shell

职责：

- 对外保持现有 REST/WebSocket API。
- 处理 auth、settings、metadata、project scan、session list、session detail。
- 通过 `RuntimeController` 代理所有 live process 操作。
- 订阅 runtime events，并转发到 current process 的 `EventBus`，让现有 client activity bus 尽量少改。
- 可以频繁重启；重启时只关闭自己的 HTTP/WS listener，不 abort runtime。

### agent-runtime sidecar

职责：

- 拥有 `Supervisor` 和 provider child process 生命周期。
- 提供 localhost-only HTTP 或 Unix socket control API。
- 提供 event stream 给 8022 shell。
- 写 runtime event journal，支持 shell reconnect 后 replay。
- 统一暴露 worker activity / process info / pending input / queue state。
- 支持独立 start/status/shutdown/reload。

### RuntimeController 接口

先在 server 内部定义 provider-agnostic facade，便于兼容 embedded 和 external 两种模式。

建议接口：

```ts
interface RuntimeController {
  start(): Promise<void>;
  shutdown(options?: { abortActive?: boolean }): Promise<void>;
  getStatus(): Promise<RuntimeStatus>;
  getWorkerActivity(): Promise<WorkerActivity>;
  listProcesses(): Promise<ProcessInfo[]>;
  getProcess(processId: string): Promise<ProcessInfo | null>;
  getProcessForSession(sessionId: string): Promise<ProcessInfo | null>;

  startSession(input: StartRuntimeSessionRequest): Promise<RuntimeStartResponse>;
  createSession(input: CreateRuntimeSessionRequest): Promise<RuntimeStartResponse>;
  resumeSession(input: ResumeRuntimeSessionRequest): Promise<RuntimeStartResponse>;
  queueMessage(input: QueueRuntimeMessageRequest): Promise<QueueRuntimeMessageResponse>;
  respondToInput(input: RuntimeInputResponseRequest): Promise<{ accepted: boolean }>;
  cancelProcess(input: CancelRuntimeProcessRequest): Promise<{ cancelled: boolean }>;
  interruptProcess(input: InterruptRuntimeProcessRequest): Promise<{ success: boolean; supported: boolean }>;
  holdProcess(input: HoldRuntimeProcessRequest): Promise<{ ok: boolean }>;
  setPermissionMode(input: RuntimePermissionModeRequest): Promise<{ ok: boolean }>;

  subscribe(options: RuntimeSubscribeOptions): AsyncIterable<RuntimeEvent>;
  replay(options: RuntimeReplayOptions): Promise<RuntimeEvent[]>;
}
```

实现：

- `EmbeddedRuntimeController`：第一步包住现有 `Supervisor`，保持当前行为。
- `HttpRuntimeController`：8022 shell 连接 standalone `agent-runtime`。

## 状态持久化与 replay

M3 的 `log_offset` 适合 batch job；yep 需要额外覆盖交互式状态。

建议新增 runtime journal：

```text
~/.yep-anywhere/runtime/
  runtime.json
  processes/
    <processId>.json
  events/
    <processId>.jsonl
  locks/
```

`processes/<processId>.json` 保存：

- processId
- provider
- sessionId / tempSessionId
- projectId / projectPath
- pid
- cwd
- model / thinking / effort / permissionMode / modeVersion
- state
- startedAt / updatedAt / idleSince / holdSince
- queueDepth
- pendingInput summary
- active runtime owner id

`events/<processId>.jsonl` 保存 append-only runtime events：

- `seq`
- `timestamp`
- `processId`
- `sessionId`
- `type`
- payload

事件类型：

- `message`
- `state-change`
- `session-id-changed`
- `mode-change`
- `pending-input-created`
- `pending-input-resolved`
- `deferred-queue-changed`
- `worker-activity-changed`
- `process-terminated`
- `error`

8022 shell reconnect 后：

1. 调用 runtime `getStatus()`。
2. 订阅 global event stream。
3. 对 active sessions 按 last seen seq 调用 `replay()`。
4. 用 replay events 重建 SSE catch-up，而不是依赖旧 shell 内存。

## 开发阶段

### Phase 0：测试护栏与现状固化

目标：在大改前让当前问题可被自动化捕捉。

任务：

- 新增 fake long-running provider 或扩展现有 mock provider。
- 测试 active turn 时触发 shell restart 的期望行为，先以 `test.todo` 或 skipped spec 固化目标。
- 增加 unit tests 覆盖：
  - `Supervisor.getWorkerActivity()`
  - pending input lifecycle
  - `Process` event emission
  - worker queue state changes
- 给 `scripts/dev.js` 的 restart 分类逻辑加单测或脚本级 smoke test。

验收：

- 当前行为的中断路径有明确 failing/skipped case。
- 后续每个 phase 都能用同一套 case 验证不会回退。

### Phase 1：RuntimeController 抽象

目标：不改变运行方式，先把 `Supervisor` 调用从 routes 中抽象出去。

任务：

- 新增 `packages/server/src/runtime/types.ts`。
- 新增 `packages/server/src/runtime/EmbeddedRuntimeController.ts`。
- 将 `createApp()` deps 中的 `supervisor` 改为可注入 `runtimeController`。
- 保留 `supervisor` 作为 debug/compat 入口，但 route 主路径走 `runtimeController`。
- 迁移范围：
  - session start/resume/create/message/input
  - process info
  - worker status
  - queue status
  - WS session subscription 中 live process 事件源

验收：

- 默认 embedded 模式行为不变。
- 现有 server tests 通过。
- `/api/status/workers` 返回字段兼容。

### Phase 2：agent-runtime standalone 骨架

目标：把 `Supervisor` 放进独立进程，但先不追求全部 feature parity。

任务：

- 新增 `packages/server/src/runtime/standalone.ts`。
- 新增 `runAgentRuntimeOnly()` entrypoint。
- 新增 control server：
  - `GET /status`
  - `GET /workers`
  - `GET /processes`
  - `POST /sessions`
  - `POST /sessions/:id/resume`
  - `POST /sessions/:id/messages`
  - `POST /sessions/:id/input`
  - `POST /processes/:id/cancel`
  - `GET /events`
- 新增 `HttpRuntimeController`。
- control server 限制 localhost，复用 desktop token 或生成 runtime token 文件。
- `scripts/dev.js` 支持启动/复用 runtime sidecar。

验收：

- `YEP_RUNTIME_MODE=embedded` 完全兼容。
- `YEP_RUNTIME_MODE=external` 下可以 start/resume/queue 一个 mock provider session。
- 8022 shell 重启后 runtime process 仍在。

### Phase 3：8022 shell 接入 external runtime

目标：dev 8022 默认把 live session 操作代理到 external runtime。

任务：

- `scripts/dev:8022` 启动流程改为：
  1. preflight 8022 / runtime / bridge pids。
  2. 若 runtime 不存在，启动 runtime。
  3. 若 runtime 存在，复用。
  4. 启动 8022 shell 和 Vite。
- `index.ts` shutdown 区分：
  - `web-shell-reload`：只关闭 8022 listener、file watchers、frontend proxy、当前 WS。
  - `full-shutdown`：才调用 runtime shutdown/abort。
- `maintenance /reload` 和 `/api/server/restart` 增加 reload intent。
- reload banner 后端按钮改为 shell reload，不再默认 full server restart。

验收：

- 修改 route 文件后，8022 重启，runtime active turn 不 abort。
- 页面 activity bus reconnect 后继续收到同一个 process 的事件。
- `/api/status/workers` 在 shell 重启前后保持 activeWorkers 不变。

### Phase 4：runtime event journal 与 replay

目标：解决 shell 重启期间的 stream gap。

任务：

- 在 runtime 内封装 `RuntimeEventStore`。
- 所有 `Process.subscribe()` 事件写 journal。
- event stream 增加 `lastSeq` replay。
- 8022 `ActivityForwarder` 维护 runtime subscription。
- WS session subscription 支持从 runtime replay 当前 session recent events。
- 用 event journal 替代或补强 `Process` 15-30 秒 bucket。

验收：

- shell 重启期间产生的 assistant text/tool events 在 reconnect 后不丢。
- pending approval 在 shell 重启后仍能显示并响应。
- deferred queue 在 shell 重启后仍显示。

### Phase 5：OpenCode provider 生命周期改造

目标：OpenCode active turn 不再受 shell reload 影响。

优先路径：

- provider 继续由 runtime sidecar 持有，先保证 shell reload 不 kill。
- 然后评估是否把 per-session `opencode serve` 收敛到 global OpenCode server / bridge 模式，减少进程数和启动成本。

任务：

- 在 external runtime 下验证现有 `OpenCodeProvider` 不被 8022 reload 影响。
- 给 `OpenCodeBridgeService` 和 `OpenCodeProvider` 梳理职责：
  - OpenCode bridge 面向外部 OpenCode CLI / global opencode events。
  - OpenCode provider 面向 Yep-created sessions。
- 如果切 global OpenCode server：
  - 抽出 `OpenCodeRuntimeClient`。
  - runtime 持有 managed global `opencode serve`。
  - 每个 session 不再 spawn 独立 server。
  - session status / permission / question 通过 global event/pending endpoints 同步。

验收：

- OpenCode turn 中修改 yep backend route，8022 shell reload 后 turn 继续。
- waiting permission 时 shell reload 后仍可 approve/deny。
- OpenCode session JSON/DB 能被现有 reader 正常显示。

### Phase 6：Codex provider 生命周期改造

目标：Codex provider active turn 不再受 shell reload 影响。

任务：

- 在 external runtime 下验证现有 `CodexProvider` 的 app-server child 由 runtime 持有。
- runtime event journal 记录 Codex normalized messages、approval requests、turn state。
- shell reload 后继续通过 runtime respond approval / steer / queue。
- 保留 `4510` external bridge，不和 provider runtime 混淆。

验收：

- Codex provider active turn 中 shell reload 不关闭 app-server child。
- approval request 在 shell reload 后仍能响应。
- `thread/rollback`、resume、branch marker 行为不回退。

### Phase 7：热重载分类与开发体验

目标：文件变更按影响范围处理，不再“一刀切重启所有东西”。

文件分类：

- Shell-only：
  - routes
  - frontend proxy
  - auth/settings/metadata
  - session readers/scanners
  - client/server rendering helpers
- Runtime-impacting：
  - `supervisor/`
  - `sdk/providers/`
  - `runtime/`
  - `MessageQueue`
  - provider protocol converters
- Shared-impacting：
  - `packages/shared/src`
  - protocol types
  - message schemas

策略：

- Shell-only：自动重启 8022 shell。
- Runtime-impacting：标记 runtime dirty；如果没有 active work，可提示一键 runtime reload；如果有 active work，只显示等待/强制选项。
- Shared-impacting：同时标记 shell dirty 和 runtime dirty；若 protocol version 不兼容，禁止 shell 连接旧 runtime 并提示操作。

验收：

- 修改 route 文件自动 shell reload，不中断 active runtime。
- 修改 provider 文件不自动 kill active runtime。
- banner 文案清楚区分 `Reload Web/API` 和 `Reload Agent Runtime`。

### Phase 8：生产部署与管理命令

目标：dev 和 production 的 shutdown/restart 语义清晰。

任务：

- 新增命令：
  - `pnpm runtime:dev`
  - `pnpm runtime:status`
  - `pnpm runtime:stop`
  - `pnpm runtime:reload`
- `scripts/dev-8022.js --check` 输出：
  - 8022 listener PID
  - runtime PID/status/sessionCount/activeWorkers
  - Codex bridge PID/status
  - OpenCode bridge PID/status
  - Vite PID
- `scripts/deploy.sh` 区分：
  - restart web/API shell
  - restart agent-runtime
  - restart Codex bridge
  - restart OpenCode bridge
- full shutdown 才会 abort active sessions，并要求明确确认。

验收：

- operator 能只重启 8022 shell。
- operator 能看到 runtime active work 并避免误杀。
- production restart 路径保留可控 full cleanup。

## 兼容策略

### Feature flag

新增环境变量：

- `YEP_RUNTIME_MODE=embedded|external`
- `YEP_RUNTIME_CONTROL_URL=http://127.0.0.1:<port>`
- `YEP_RUNTIME_PORT=<port>`
- `YEP_RUNTIME_TOKEN_FILE=<path>`
- `YEP_RUNTIME_EVENT_JOURNAL=1`

默认迁移顺序：

1. `embedded` 默认，完成抽象。
2. `dev:8022` 默认 `external`。
3. 本地生产 8022 可选择 `external`。
4. 稳定后再考虑全局默认 `external`。

### API 兼容

对客户端保持现有接口：

- `/api/projects/:projectId/sessions`
- `/api/projects/:projectId/sessions/:sessionId/resume`
- `/api/sessions/:sessionId/messages`
- `/api/sessions/:sessionId/input`
- `/api/status/workers`
- `/api/ws`

内部 route 实现改为 runtime proxy，但 response shape 保持兼容。

### SessionRuntime 语义

现有 `SessionRuntime` 字段保持：

- `ownership`
- `activity`
- `isBusy`
- `hasResidentWorker`
- `canArchive`
- `archiveBlockCode`
- `archiveBlockReason`

调整解释：

- `ownership.owner === "self"` 表示当前 Yep runtime owns this session，不再等同于当前 8022 process owns it。
- 可新增 `runtimeOwnerId` 或 `runtimeProcessId` 作为调试字段，但不影响旧客户端。

## 测试计划

### Unit tests

- `RuntimeController` embedded/external contract tests。
- `RuntimeEventStore` append/replay/rotation tests。
- `ActivityForwarder` reconnect/replay tests。
- `Process` event journal adapter tests。
- reload file classification tests。

### Integration tests

- fake provider active turn:
  1. start external runtime
  2. start 8022 shell
  3. start long turn
  4. restart shell
  5. assert turn still running
  6. assert queued message / approval works

- pending approval:
  1. fake provider emits approval request
  2. restart shell
  3. client fetches pending input
  4. approve
  5. provider continues

- event replay:
  1. disconnect shell subscriber
  2. runtime emits messages
  3. reconnect with lastSeq
  4. assert no lost/no duplicate events

### Real provider smoke tests

需要用户明确授权后运行：

- Codex provider active turn + shell reload。
- OpenCode provider active turn + shell reload。
- Codex bridge `4510` existing session unaffected。
- OpenCode bridge existing session unaffected。

### Manual verification

不默认使用 browser automation。需要 UI 验证时先询问用户。

手动检查：

- `pnpm dev:8022:replace`
- 打开 `/yep`
- 启动 Codex/OpenCode session
- 修改 shell-only backend file
- 观察：
  - agent PID 不变
  - session ownership/activity 不丢
  - pending input 可响应
  - 页面不强制全刷新

## 风险与缓解

### 风险：runtime 协议与现有 route 耦合太深

缓解：

- 先做 `EmbeddedRuntimeController`，不改行为。
- 每迁移一个 route 就保留 contract tests。

### 风险：事件 replay 造成重复消息

缓解：

- runtime event 增加 monotonic `seq`。
- client/server merge 继续以 message uuid / tool id 去重。
- replay API 支持 `afterSeq`。

### 风险：shell 和 runtime shared types 版本不一致

缓解：

- runtime `/status` 返回 `protocolVersion`、`buildId`、`sharedSchemaVersion`。
- shell 启动时检查兼容性。
- 不兼容时显示 runtime reload required，不代理 live operations。

### 风险：runtime sidecar 泄漏或孤儿进程

缓解：

- runtime 写 PID file 和 heartbeat。
- dev preflight 检查 stale PID。
- full shutdown 才清理 runtime child processes。
- runtime 自身 shutdown 区分 graceful drain 和 force abort。

### 风险：pending approval 在 shell 重启期间超时

缓解：

- pending input 属于 runtime，不属于 shell。
- approval request 写入 process state。
- shell reconnect 后从 runtime 拉取 pending state。

### 风险：生产部署复杂度上升

缓解：

- 保留 embedded mode。
- deploy scripts 分阶段引入 external runtime。
- 文档明确 restart target。

## 文件级改造清单

新增：

- `packages/server/src/runtime/types.ts`
- `packages/server/src/runtime/EmbeddedRuntimeController.ts`
- `packages/server/src/runtime/HttpRuntimeController.ts`
- `packages/server/src/runtime/RuntimeEventStore.ts`
- `packages/server/src/runtime/standalone.ts`
- `packages/server/src/runtime/server.ts`
- `packages/server/src/runtime/client.ts`
- `packages/server/test/runtime/*.test.ts`

修改：

- `packages/server/src/app.ts`
- `packages/server/src/index.ts`
- `packages/server/src/routes/sessions.ts`
- `packages/server/src/routes/processes.ts`
- `packages/server/src/routes/ws.ts`
- `packages/server/src/routes/ws-handlers.ts`
- `packages/server/src/supervisor/Supervisor.ts`
- `packages/server/src/supervisor/Process.ts`
- `packages/server/src/watcher/EventBus.ts`
- `packages/server/src/routes/dev.ts`
- `packages/server/src/routes/server-admin.ts`
- `packages/server/src/maintenance/server.ts`
- `scripts/dev.js`
- `scripts/dev-8022.js`
- `scripts/deploy.sh`
- `DEVELOPMENT.md`

可能修改：

- `packages/server/src/sdk/providers/opencode.ts`
- `packages/server/src/sdk/providers/codex.ts`
- `packages/server/src/opencode-bridge/*`
- `packages/server/src/codex-bridge/*`
- `packages/client/src/hooks/useReloadNotifications.ts`
- `packages/client/src/components/ReloadBanner.tsx`
- `packages/client/src/lib/activityBus.ts`

## 里程碑

### Milestone A：抽象完成但行为不变

包含 Phase 0-1。

完成标准：

- embedded mode 通过现有测试。
- route 调用不再直接依赖 `Supervisor` 主路径。

### Milestone B：external runtime 可用

包含 Phase 2-3。

完成标准：

- dev:8022 可以启动/复用 runtime sidecar。
- shell reload 不中断 fake provider active turn。

### Milestone C：交互状态可 replay

包含 Phase 4。

完成标准：

- shell reload 后 message streaming、pending input、deferred queue 不丢。

### Milestone D：Codex/OpenCode 实 provider 验证

包含 Phase 5-6。

完成标准：

- Codex/OpenCode active turn 在 shell reload 后继续。
- real provider smoke tests 通过。

### Milestone E：开发体验收口

包含 Phase 7-8。

完成标准：

- reload banner 区分 shell/runtime。
- dev/deploy/status 命令语义清晰。
- 文档更新完成。

## 推荐实施顺序

第一轮 PR：

1. Phase 0 测试护栏。
2. Phase 1 RuntimeController 抽象。
3. 保持 embedded mode 默认。

第二轮 PR：

1. Phase 2 standalone runtime。
2. `HttpRuntimeController`。
3. mock provider integration。

第三轮 PR：

1. Phase 3 dev:8022 接 external runtime。
2. shell reload intent。
3. worker status 走 runtime。

第四轮 PR：

1. Phase 4 event journal/replay。
2. WS subscription reconnect。

第五轮 PR：

1. Codex/OpenCode real provider smoke。
2. OpenCode global runtime 评估或迁移。
3. 文档和 deploy 脚本收口。

## 开放问题

1. runtime control transport 用 HTTP localhost 还是 Unix socket？
   - HTTP 更易调试，复用 fetch。
   - Unix socket 权限边界更好，但跨平台处理更复杂。

2. runtime 是否应默认独立于 8022 production？
   - 建议先只在 `dev:8022` 默认 external。
   - production 保持 embedded 或可配置 external。

3. OpenCode provider 是否立即迁移到 global `opencode serve`？
   - 建议先通过 external runtime 解决 reload 中断。
   - 再单独做 global server 优化。

4. runtime code dirty 时是否允许自动 drain reload？
   - 初期不自动。
   - 后续可支持“无 active work 时自动 reload runtime”。

5. event journal 保存多久？
   - 初期按 active process 生命周期保存。
   - process terminal 后保留最近 N 小时或 N MB，避免磁盘无限增长。
