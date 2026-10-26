# 模块、入口与影响边界

[返回总览](README.md)。源码链接以仓库为基准，符号用于重新定位。模块职责由接线确认，不由目录名推测。

## 三种关系分开看

| 关系 | 当前实例 | 变更含义 |
| --- | --- | --- |
| 源码导入 | client/server 导入 `@yep-anywhere/shared`；`app.ts` 导入并实例化 service；provider registry 导入各 adapter | shared schema、协议或类型变化会跨 client/server/runtime；单纯 import 不能证明部署启动了某模块 |
| 运行时调用/消息 | 页面 HTTP → Hono → command；shell external HTTP/SSE → runtime；provider JSON-RPC/ACP/RPC；EventBus → WS/push | 检查协议、异常返回、重连和所有调用方，而非仅改一个 import |
| 共享数据 | CLI 与 Yep reader 共享原生会话；shell/runtime/bridge 的事件记录被显示层读取；多设备共享服务端已读状态 | 检查 writer、失效、排序与 ID；共享文件不等于共享同一个进程内 cache |

导入证据：[packages/client/package.json](../../packages/client/package.json)、[packages/server/package.json](../../packages/server/package.json) `dependencies`，以及 [packages/server/src/app.ts](../../packages/server/src/app.ts) `createApp`。runtime 契约见 [packages/server/src/runtime/types.ts](../../packages/server/src/runtime/types.ts) `RuntimeController`（当前 `RUNTIME_CONTROLLER_PROTOCOL_VERSION = 6`）。

## 核心模块责任表

| 模块与真实入口 | 调用方 / 依赖 | 数据写入与复用边界 |
| --- | --- | --- |
| [index.ts](../../packages/server/src/index.ts) `startServer`；[app.ts](../../packages/server/src/app.ts) `createApp` | CLI/Node 入口；依赖 config、服务初始化和路由工厂 | 负责装配、启动/关闭服务；新增服务先找注入点。`app.ts` 底部导出的简化 `app` 只有 health，不能代替生产 `createApp` |
| [services/SessionCommandService.ts](../../packages/server/src/services/SessionCommandService.ts) `start/create/resume/queue/send/interrupt` | sessions API、Feishu；依赖 runtime、scanner、reader、metadata、interaction | 参数、provider、凭据继承及 admission 规则的复用入口；写 session metadata/来源/recents，委托 runtime 执行 |
| [runtime/types.ts](../../packages/server/src/runtime/types.ts) `RuntimeController`；[EmbeddedRuntimeController.ts](../../packages/server/src/runtime/EmbeddedRuntimeController.ts)；[HttpRuntimeController.ts](../../packages/server/src/runtime/HttpRuntimeController.ts) | command、display、process API、interaction；embedded 委托 Supervisor，external 请求独立控制面 | 会话命令/查询/事件统一边界。web shell 代码应通过 controller 查询 ownership，external 下本地 Supervisor 没有实际 worker |
| [supervisor/Supervisor.ts](../../packages/server/src/supervisor/Supervisor.ts) `startSession/resumeSession/registerProcess/processQueue` | Embedded controller；依赖 provider、`Process`、`WorkerQueue` | 进程/会话映射、worker admission、排队、回收、ownership 事件；队列主要是内存，不是可靠任务数据库 |
| [supervisor/Process.ts](../../packages/server/src/supervisor/Process.ts) `Process/setState` | Supervisor；依赖 `AgentSession` iterator、消息队列 | 当前 turn、pending input、hold、消息 buffer、异步事件；provider 才执行原生操作。UI ownership 与 process activity 不同 |
| [sdk/providers/types.ts](../../packages/server/src/sdk/providers/types.ts) `AgentProvider/AgentSession/StartSessionOptions`；[index.ts](../../packages/server/src/sdk/providers/index.ts) `getProvider` | Supervisor；依赖原生 CLI/SDK/app-server | provider 接入入口；原生写入、approval mapping、工具和消息 normalize 需逐 provider 核对。Codex 的通知缓冲使用 [utils/async-queue.ts](../../packages/server/src/utils/async-queue.ts) `AsyncQueue` |
| [projects/scanner.ts](../../packages/server/src/projects/scanner.ts) `ProjectScanner`；[routes/provider-catalog.ts](../../packages/server/src/routes/provider-catalog.ts) `buildProviderProjectCatalog` | projects/global sessions/inbox/search/recents 等 | 聚合真实目录与 provider 项目，维护扫描缓存；新 provider 不能只加入 runtime registry |
| [sessions/provider-resolution.ts](../../packages/server/src/sessions/provider-resolution.ts) `resolveSessionSources/findSessionSummaryAcrossProviders`；[types.ts](../../packages/server/src/sessions/types.ts) `ISessionReader` | command、列表、display、历史 API | 按来源选 reader，返回原生历史/summary；应复用解析入口，避免页面/路由自行猜 provider 文件位置 |
| [codex-history/CodexSessionCatalog.ts](../../packages/server/src/codex-history/CodexSessionCatalog.ts) `CodexSessionCatalog`；[CodexAppServerHistoryReader.ts](../../packages/server/src/codex-history/CodexAppServerHistoryReader.ts) `getSemanticTurnsPage` | app 装配，provider catalog、sessions、display | Codex catalog 与分页历史；仍有 rollout reader fallback，来源可用性及 revision 要保留 |
| [display/SessionDisplayService.ts](../../packages/server/src/display/SessionDisplayService.ts) `configureSource/subscribe/snapshot/detail/output`；[SessionDisplayReducer.ts](../../packages/server/src/display/SessionDisplayReducer.ts) `SessionDisplayReducer` | HTTP display API、WS display subscription；依赖 runtime、历史 source | 每个 session/branch 的内存 projection、snapshot/patch、工具详情缓存；不是原生持久化 writer |
| [routes/session-display.ts](../../packages/server/src/routes/session-display.ts) `registerSessionDisplayRoutes/createSessionDisplaySource` | `createSessionsRoutes` 注册；reader、Codex history、augments、file stores | 接历史与 file evidence；部分文件查询会导入派生 operation 记录，因此“读 API”不一定完全不写缓存 |
| [interactions/SessionInteractionService.ts](../../packages/server/src/interactions/SessionInteractionService.ts) `getPendingInput/respondToInput`；[InteractionBroker.ts](../../packages/server/src/interactions/InteractionBroker.ts) `register/resolve` | Web/API、channel command；依赖 runtime / Codex bridge | 选择请求持有者、答案校验、CAS、持久化操作状态；新增回答入口应复用这一层 |
| [watcher/EventBus.ts](../../packages/server/src/watcher/EventBus.ts) `EventBus`；[FileWatcher.ts](../../packages/server/src/watcher/FileWatcher.ts)、[FocusedSessionWatchManager.ts](../../packages/server/src/watcher/FocusedSessionWatchManager.ts) | runtime、file watcher、bridge 发布；列表、WS、通知订阅 | EventBus 是进程内总线；持久回放另由 journal 负责。focused watcher 提供目标会话变化 |
| [metadata/SessionMetadataService.ts](../../packages/server/src/metadata/SessionMetadataService.ts) `updateMetadata/remapSessionId` | command、标题服务、路由、app callbacks | Yep 自有标题/置顶/归档/凭据/分叉关系；不要误当 provider transcript writer |
| [indexes/SessionIndexService.ts](../../packages/server/src/indexes/SessionIndexService.ts)；[SessionContentIndexService.ts](../../packages/server/src/indexes/SessionContentIndexService.ts) | 列表与全文检索；依赖文件变化、reader | 分离 summary 索引与全文索引；各自 JSON、锁、缓存失效，不可用全文索引替代实时状态 |
| [notifications/NotificationService.ts](../../packages/server/src/notifications/NotificationService.ts) `markSeen/hasUnread`；[push/PushNotifier.ts](../../packages/server/src/push/PushNotifier.ts) `handleProcessStateChange` | mark-seen、inbox、recents、EventBus | 前者持久化已读/needsReview；后者通知决策和内存去重，投递委托 PushService/NativePushService |
| [channels/feishu/channel-runtime.ts](../../packages/server/src/channels/feishu/channel-runtime.ts) `prepare/doStart` | `startServer`；service、inbox、binding、inbound/reply/interaction manager | channel 持久化先准备，handler 安装后启动网络消费；复用 command，不独立拥有主 lifecycle 或中央 broker |
| [session-files/lifecycle.ts](../../packages/server/src/session-files/lifecycle.ts) `SessionFileLifecycle`；[operation-store.ts](../../packages/server/src/session-files/operation-store.ts) `SessionFileOperationStore` | provider/bridge 捕获，history import，display 读取 | 前后快照与结构化工具操作分开存；内容按 hash 存储，带 coverage/执行身份 |

表内省略前缀的 server 链接均属于 `packages/server/src/`。UI 专属复用入口见 [ui-map.md](ui-map.md)。

## API 与路由注册地图

以下是**注册组及代表入口**，不是逐字段 OpenAPI。主服务路径前可加 `BASE_PATH`，由 `createApp` 的 `root.basePath(basePath)` 实现。多数 API 共同经过 host/CORS/custom header/auth 中间件；具体例外和条件见下一节。

| 注册前缀 / 代表路径 | 工厂、责任及条件 |
| --- | --- |
| `/health`、`/api/version` | `health`、`createVersionRoutes`；健康与构建/能力信息 |
| `/api/auth` | `createAuthRoutes`，有 AuthService 时注册 |
| `/api/projects` | `createProjectsRoutes` + `createFilesRoutes` + `createGitStatusRoutes`；目录、项目、文件、Git |
| `/api/projects/:projectId/sessions`、`.../create`、`.../:sessionId/resume` | `createSessionsRoutes`：start、create-only、resume 命令 |
| `/api/projects/:projectId/sessions/:sessionId/{metadata,display,display/view,agents,clone}` | `createSessionsRoutes` 与 `registerSessionDisplayRoutes`：详情/显示/子 agent/克隆；display 下还有工具详情、output、问题与文件相关路由 |
| `/api/sessions`、`/api/sessions/:sessionId/locate` | `createGlobalSessionsRoutes` 与 `createSessionsRoutes`；全局列表与裸 ID 定位 |
| `/api/sessions/:sessionId/{messages,input,pending-input,process,side-conversation,codex-control,mark-seen,metadata}` | 会话级控制和状态；同属 `createSessionsRoutes`，method 不同语义不同 |
| `/api/sessions` 下 Codex transcript / image | `createCodexTranscriptRoutes`、`createCodexImageRoutes`；与列表共前缀，不是同一 handler |
| `/api/processes`、`/api/status/workers`、`/api/queue` | `createProcessesRoutes` / `createSessionsRoutes`；runtime 与 worker admission |
| `/api/inbox`、`/api/recents`、`/api/search`、`/api/archive/sessions` | 聚合/最近访问/全文/归档；recents、search 依赖对应 service |
| `/api/reports`、`/api/local-file`、`/api/local-image` | 独立报告与预览。local-image 接受 allowlist，并在注入 scanner 时接受已发现的本地项目路径；可提供图片和视频 |
| `/api/providers`、`/api/harness-updates`、`/api/codex-accounts`、`/api/llm-gateway-keys` | provider/CLI 更新、Codex 账号与网关选择；账号路由要求 dataDir |
| `/api/codex-bridge` | 外部会话适配；Codex 要注入 bridge service |
| `/api/settings`、`/api/auth/feishu`、`/api/channels/feishu` | settings/channel service 存在时注册；配置不等于通道已连通 |
| `/api/push`、`/api/connections`、`/api/browser-profiles`、`/api/activity` | 推送注册、连接档案、activity；按依赖条件注册 |
| `/api/sharing` | 分享，要求 service；注册存在仍可能缺 Worker 配置。`/api/devices` 与设备桥接已删除 |
| `/api/dsh/launch`、`/apps/dsh/` | [routes/dsh.ts](../../packages/server/src/routes/dsh.ts) `createDshRoutes`，由 [index.ts](../../packages/server/src/index.ts) `startServer` 安装，不在 `createApp` 的路由表里。只代理本机 `DshWebService` 管理的 loopback 进程 |
| `/api/server-info`、`/api/server`、`/api/deploy`、`/api/network-binding` | 管理与部署入口，包含会改变服务状态的操作；本轮未调用 |
| `/api/onboarding`、`/api/client-logs`、`/api/dev`、`/api/debug` | onboarding/logging 依赖 dataDir；dev/debug 有开发环境或手动 reload 条件 |
| `/api/ws`、`/api/projects/:projectId/sessions/:sessionId/upload/ws`、静态前端 | `index.ts` `startServer` 额外安装；当前 DirectConnection.upload 调独立上传 WS，multiplex WS handler 也实现 upload 帧；不能只看注释就认定上传是 HTTP |

全部组的注册证据：[packages/server/src/app.ts](../../packages/server/src/app.ts) `createApp`。会话子路径见 [routes/sessions.ts](../../packages/server/src/routes/sessions.ts) `createSessionsRoutes`，display 子路径见 [routes/session-display.ts](../../packages/server/src/routes/session-display.ts) `registerSessionDisplayRoutes`；额外 WS/上传入口见 [index.ts](../../packages/server/src/index.ts) `startServer`。

## 权限与运行边界

- 主 API：[middleware/security.ts](../../packages/server/src/middleware/security.ts) `hostCheckMiddleware/corsMiddleware/requireCustomHeader` 校验 host/origin，变更请求要求 `X-Yep-Anywhere: true`。这不是业务用户的逐项目 ACL。
- 认证：[middleware/auth.ts](../../packages/server/src/middleware/auth.ts) `createAuthMiddleware` 根据 AuthService、`authDisabled`、desktop token、cookie 执行；auth 未启用时存在放行路径。`/api/auth/*` 有例外。反向代理前缀下的例外匹配没有动态验收。
- WS：[routes/ws.ts](../../packages/server/src/routes/ws.ts) `createWsRoutes` 校验 origin；主 API 中间件作用于 upgrade。`handleRequest` 用服务端 Symbol `WS_INTERNAL_AUTHENTICATED` 标识内部转发，不靠客户端可伪造的字符串头来替代认证。没有应用层端到端加密的当前实现证据。
- external runtime：[runtime/control-server.ts](../../packages/server/src/runtime/control-server.ts) `createRuntimeControlApp/tokensMatch` 校验 Bearer token；[HttpRuntimeController.ts](../../packages/server/src/runtime/HttpRuntimeController.ts) `start` 检查协议。控制面的 `/events`、`/activity-events` 是内部 SSE，不应据此把浏览器订阅描述成 SSE。
- 文件 API：[routes/local-file.ts](../../packages/server/src/routes/local-file.ts) `createLocalFileRoutes` 读取支持类型的绝对路径、`realpath/stat`；[uploads/manager.ts](../../packages/server/src/uploads/manager.ts) `UploadManager` 则检查上传目录 containment。这些能力处于不同路径信任边界，修改时应分别检查。

## 后台任务与外部集成

| 任务 / 集成 | 源码入口与触发 | 已确认的边界 |
| --- | --- | --- |
| 文件变化与外部会话 | [index.ts](../../packages/server/src/index.ts) `createWatcherIfExists`、[supervisor/ExternalSessionTracker.ts](../../packages/server/src/supervisor/ExternalSessionTracker.ts) `ExternalSessionTracker`、`FocusedSessionWatchManager` | 全局和当前会话 watcher 共存；外部活动是观测/归属推断，不能自动赋予可写控制权 |
| Worker 回收/排队 | [Supervisor.ts](../../packages/server/src/supervisor/Supervisor.ts) `terminateStaleProcesses/reclaimExpiredIdleProcesses/processQueue` | 容量、idle、hold 与进程存活共同影响 admission |
| runtime journal 维护 | [EmbeddedRuntimeController.ts](../../packages/server/src/runtime/EmbeddedRuntimeController.ts) `startJournalMaintenance` | 定时 prune；journaling 可关闭，不能假定无限保留 |
| display 同步 | [SessionDisplayService.ts](../../packages/server/src/display/SessionDisplayService.ts) `poll/expire/flush` | 默认约 1 秒刷新条件检查、25ms patch 合并、无监听后约 30 秒释放；都是源码默认，非现场测量 |
| Codex bridge | [bridge-common/BridgeHttpClient.ts](../../packages/server/src/bridge-common/BridgeHttpClient.ts) `BridgeHttpClient`；[codex-bridge/CodexBridgeService.ts](../../packages/server/src/codex-bridge/CodexBridgeService.ts) `CodexBridgeService` | 外部 app-server 控制、会话观测与 bridge 事件；bridge 状态不等于 Yep resident process |
| 手动标题生成 / 自动归档 | [app.ts](../../packages/server/src/app.ts) `createApp` 中 SessionTitleService、archive scheduler 接线 | 标题只由 POST 手动触发，未调用旧式自动生成 `start()` hook；archive service 存在时安装 daily scheduler |
| 飞书 / MCP | [channels/feishu/channel-runtime.ts](../../packages/server/src/channels/feishu/channel-runtime.ts) `doStart` | 先持久化、再装入站/卡片处理器；复用 UploadManager/command；外部 SDK、账号、用户授权是独立依赖 |
| 推送 / webhook | [push/PushNotifier.ts](../../packages/server/src/push/PushNotifier.ts)、[webhooks/LifecycleWebhookService.ts](../../packages/server/src/webhooks/LifecycleWebhookService.ts) 构造订阅 | EventBus 事件驱动，外部投递失败不等于 agent 本身失败 |
| PTY | [terminal/TerminalService.ts](../../packages/server/src/terminal/TerminalService.ts) `TerminalService` | 终端用 node-pty；未启动或连接。设备桥接服务和 Go sidecar 已不在树中 |
| dsh Web | [dsh/web-service.ts](../../packages/server/src/dsh/web-service.ts) `DshWebService`；[index.ts](../../packages/server/src/index.ts) 在 `startServer` 中构造并交给 `createDshRoutes` | 按需启动本机 `dsh web`。更新期间用 `withUpdateLock` 与 harness 更新互斥。不拥有 Yep 会话 |

部署关系仅盘点：根 `package.json` 的 `deploy/hot-apply` 指向脚本；[.github/workflows/release.yml](../../.github/workflows/release.yml) 仅 `ya-v*` 产品 tag，[pages.yml](../../.github/workflows/pages.yml) 为 `site-v*` / 手动网站部署。实际发布状态、bundle 和运行 commit 均待确认。
