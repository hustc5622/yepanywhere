# 功能与协作关系

[返回总览](README.md)。本页从用户目标组织能力；实现责任见 [modules.md](modules.md)，具体持久化见 [data-and-state.md](data-and-state.md)。表中的“支持”均指源码有路径，未证明部署已配置或第三方可用。

## 核心使用循环

| 用户目标 | 输入 → 可见输出 | 协作模块、数据及前后关系 |
| --- | --- | --- |
| 找到项目及已有 agent 会话 | 项目路径、筛选 → 项目列表、全局会话、定位跳转 | `ProjectScanner` 聚合 provider scanner；`buildProviderProjectCatalog` 建请求内目录；reader / index 加上 metadata 和 runtime 状态。同一路径可有多种 provider，项目的主 provider 不等于其全部会话来源。后续进入 F1/F2 |
| 创建或继续工作 | prompt、provider、model、权限、附件 → session/process ID 或排队结果 | `NewSessionForm` → `SessionCommandService` → `RuntimeController` → `Supervisor` → provider。`start` 与无消息的 `create` 分开；附件可先建 session，再上传、发送。F1 |
| 阅读历史并监督实时进度 | project/session/branch、游标 → 问题目录、工具组、文本、状态、按需详情 | `useSession` + `SessionDisplayService` 合并历史与运行事件；新显示投影与 legacy 路径并存。折叠工具合集可带 `durationMs`/`timedCount`，没有可靠起止时不推算。依赖 provider store、runtime journal、内存缓存。F2 |
| 批准工具或回答 agent | request ID、批准/拒绝/答案 → 继续执行或明确失败 | `SessionInteractionService` 在 runtime / Codex bridge 中选请求持有者；`InteractionBroker` 协调并发回答；通知只是提醒入口。F3 |
| 编辑历史探索另一条路线 | 原 prompt 身份、修改文本 → 新会话或 provider 特定恢复结果 | `resolveSessionEditSubmission` 区分 Codex/Pi fork 与 Claude resume；不是统一“截断文件”。Codex 使用原生 fork，另记 family 元数据。F4 |
| 及时发现要处理的会话 | 聚合状态、访问记录 → needsAttention / active / recent / unread | `createInboxRoutes` 结合 catalog、runtime、bridge、metadata、`NotificationService`；可见会话页面标记已读，activity 事件刷新其他客户端。F5 |

以上对应的源码入口：

- 项目聚合：[packages/server/src/projects/scanner.ts](../../packages/server/src/projects/scanner.ts) `ProjectScanner`；[packages/server/src/routes/provider-catalog.ts](../../packages/server/src/routes/provider-catalog.ts) `buildProviderProjectCatalog`；[packages/server/src/sessions/provider-resolution.ts](../../packages/server/src/sessions/provider-resolution.ts) `resolveSessionSources`。
- 命令与创建：[packages/client/src/components/NewSessionForm.tsx](../../packages/client/src/components/NewSessionForm.tsx) `NewSessionForm`；[packages/server/src/services/SessionCommandService.ts](../../packages/server/src/services/SessionCommandService.ts) `start/create/resume/queue/send`。
- 显示：[packages/client/src/hooks/useSessionMessages.ts](../../packages/client/src/hooks/useSessionMessages.ts) `useSessionMessages`；[packages/server/src/display/SessionDisplayService.ts](../../packages/server/src/display/SessionDisplayService.ts) `initialize/subscribe/snapshot`。
- 审批：[packages/server/src/interactions/SessionInteractionService.ts](../../packages/server/src/interactions/SessionInteractionService.ts) `respondToInput`；[packages/server/src/interactions/InteractionBroker.ts](../../packages/server/src/interactions/InteractionBroker.ts) `resolve`。
- 分叉：[packages/client/src/lib/sessionBranching.ts](../../packages/client/src/lib/sessionBranching.ts) `resolveSessionEditSubmission`；[packages/server/src/sdk/providers/codex.ts](../../packages/server/src/sdk/providers/codex.ts) `loadCodexForkBoundary`。
- 收件箱：[packages/server/src/routes/inbox.ts](../../packages/server/src/routes/inbox.ts) `createInboxRoutes`；[packages/server/src/notifications/NotificationService.ts](../../packages/server/src/notifications/NotificationService.ts) `markSeen/hasUnread`。

## 配套能力

| 用户目标 | 公开入口与具体证据 | 输出 / 写入责任与关联 |
| --- | --- | --- |
| 搜索历史 | [routes/search.ts](../../packages/server/src/routes/search.ts) `createSearchRoutes` → [indexes/SessionContentIndexService.ts](../../packages/server/src/indexes/SessionContentIndexService.ts) `SessionContentIndexService` | 全文匹配与会话定位；内容索引是派生数据，不能取代原始历史 |
| 改标题、置顶、归档 | [routes/sessions.ts](../../packages/server/src/routes/sessions.ts) `createSessionsRoutes` 的 `PUT /sessions/:sessionId/metadata` → [archive/SessionArchiveService.ts](../../packages/server/src/archive/SessionArchiveService.ts) `archiveSession/restoreSession` | metadata 与 archive manifest 分开；归档可能移动会话文件，忙碌/外部活跃会话返回 409；不能把 archived 理解成只改 UI 字段 |
| 克隆整个会话 | [routes/sessions.ts](../../packages/server/src/routes/sessions.ts) `POST /projects/:projectId/sessions/:sessionId/clone` | 调用 `cloneCodexSession` / `cloneClaudeSession`，写新会话文件及标题；与“编辑某条历史 prompt”的原生 fork 是两套入口 |
| 看工具造成的文件变化 | [routes/session-display.ts](../../packages/server/src/routes/session-display.ts) `registerSessionDisplayRoutes` → [session-files/lifecycle.ts](../../packages/server/src/session-files/lifecycle.ts) `SessionFileLifecycle`、[operation-store.ts](../../packages/server/src/session-files/operation-store.ts) `SessionFileOperationStore` | 工具操作记录与执行边界快照共同提供证据；快照不证明每次变化由某个进程独占造成 |
| 发送文件、预览文件 | [uploads/manager.ts](../../packages/server/src/uploads/manager.ts) `UploadManager`；[routes/files.ts](../../packages/server/src/routes/files.ts) `createFilesRoutes`；[routes/local-file.ts](../../packages/server/src/routes/local-file.ts) `createLocalFileRoutes`；[routes/local-image.ts](../../packages/server/src/routes/local-image.ts) `createLocalImageRoutes` | 上传归 Yep uploads；项目文件预览读取工作区。local-file 接受绝对文本路径。local-image 在 allowlist 或已发现的本地项目路径下提供图片和视频，扩展名见 `MEDIA_EXTENSIONS`。这些路径边界彼此不同 |
| 浏览报告并评论、上传 | [routes/reports.ts](../../packages/server/src/routes/reports.ts) `createReportsRoutes`；[client ReportsPage](../../packages/client/src/pages/ReportsPage.tsx) `ReportsPage` | 报告目录、图片及评论由该路由管理；不是 agent 原生会话存储 |
| 不打断主任务地侧聊 | [routes/sessions.ts](../../packages/server/src/routes/sessions.ts) `POST /sessions/:sessionId/side-conversation`；[side-conversations/session.ts](../../packages/server/src/side-conversations/session.ts) `SideConversationSession` | provider 特定 side channel，Codex/Pi 有适配；主 command 入口拒绝保留 side 指令。未推定所有 provider 支持 |
| 管理模型、账号和上下文 | [routes/providers.ts](../../packages/server/src/routes/providers.ts) `createProvidersRoutes`；[codex-accounts.ts](../../packages/server/src/routes/codex-accounts.ts) `createCodexAccountsRoutes`；[llm-gateway-keys.ts](../../packages/server/src/routes/llm-gateway-keys.ts) `createLlmGatewayKeysRoutes` | 发现能力/模型与账号配置；session metadata 固定 Codex account 或 Pi gateway key，resume 继承，不等于全局当前选择 |
| 从飞书发消息、审批 | [channels/feishu/channel-runtime.ts](../../packages/server/src/channels/feishu/channel-runtime.ts) `FeishuChannelRuntime.doStart` | inbox、binding、reply、interaction manager 复用 command service；账号启用和用户授权另有检查。外部权限与真实投递未确认 |
| 收到通知或触发生命周期回调 | [push/PushNotifier.ts](../../packages/server/src/push/PushNotifier.ts) `handleProcessStateChange`；[webhooks/LifecycleWebhookService.ts](../../packages/server/src/webhooks/LifecycleWebhookService.ts) `LifecycleWebhookService` | EventBus 驱动 Web Push / native push / HTTP webhook；需配置和订阅，存在去重与连接设备过滤 |
| 导出分享快照 | [services/SharingService.ts](../../packages/server/src/services/SharingService.ts) `SharingService`；[sharing-worker/src/index.ts](../../sharing-worker/src/index.ts) `fetch` | 独立 HTML 快照上传到配置的 Worker/R2，属于主动外部写入，不是私有会话流的自动副本 |
| 使用远程终端 | [terminal/TerminalService.ts](../../packages/server/src/terminal/TerminalService.ts) `TerminalService` | PTY 使用 WS 控制帧；未启动或连接。设备串流、Go sidecar 和 `/api/devices` 已删除。设置里的「设备」仍是浏览器档案与推送，不是远程控制 |
| 在页面内打开 dsh | [pages/DshPage.tsx](../../packages/client/src/pages/DshPage.tsx) `DshPage`；[routes/dsh.ts](../../packages/server/src/routes/dsh.ts) `createDshRoutes`；[dsh/web-service.ts](../../packages/server/src/dsh/web-service.ts) `DshWebService` | `POST /api/dsh/launch` 按需启动或复用本机 `dsh web`，`/apps/dsh/` 代理 HTTP 与 WebSocket。dsh 不进入 provider 注册表或统一会话列表。安装与凭据见 [dsh-web.md](../project/dsh-web.md) |

表内缩写路径均链接到 `packages/server/src/` 下对应源码；调用注册证据统一见 [app.ts](../../packages/server/src/app.ts) `createApp` 及 [index.ts](../../packages/server/src/index.ts) `startServer`。

## Provider 能力不能只看枚举

| provider | 当前注册/解析事实 | 阅读和复用入口 |
| --- | --- | --- |
| Codex | active registry 成员；`createApp` / standalone runtime 默认选择 Codex；app-server 与 remote bridge 分支 | `sdk/providers/codex.ts`、`codex-bridge/`、`codex-history/`、`sessions/codex-reader.ts` |
| Codex OSS | 独立 active provider，不能自动套用 Codex app-server 的编辑与审批契约 | `sdk/providers/codex-oss.ts`；客户端 `CodexOssProvider` |
| Gemini | registry 同时包含 legacy Gemini 与 ACP；`getProvider("gemini")` 和 `getProvider("gemini-acp")` 都返回 ACP 实例 | `sdk/providers/index.ts` `getProvider`；`gemini-acp.ts`、`sessions/gemini-reader.ts` |
| Pi | active；RPC 执行路径和原生 session tree；网关配置可按 session 保存 | `sdk/providers/pi.ts`、`sessions/pi-reader.ts`；参考 `references/pi/.../rpc-types.ts`，本轮只抽查命令定义 |
| Kimi | retired（2026-10 移除）；旧数据中的 `kimi` 按 retired provider 处理，接口返回 410 | `sdk/providers/policy.ts` `RETIRED_PROVIDER_NAMES` |
| ZCode | retired（2026-10 移除）；旧数据中的 `zcode` 按 retired provider 处理，接口返回 410 | `sdk/providers/policy.ts` `RETIRED_PROVIDER_NAMES` |
| Cursor | **实际 active registry 成员**，有 ACP adapter 与 SQLite/blob 历史读取；旧总览未列全 | `sdk/providers/cursor.ts`、`sessions/cursor-store.ts`、`sessions/cursor-reader.ts` |
| Claude | 不在 active discovery；`getProvider("claude")` 仍能解析，供既有会话兼容 | `sdk/providers/index.ts` `getAllProviders/getProvider`；`claude.ts`、`sessions/reader.ts` |
| Claude Ollama / OpenCode | policy 仍把 `claude-ollama` 算 live，但 server `getProvider` 无对应分支；OpenCode 被明确列为 retired | 差异是现状，不代表可新建或可安全删除；见 findings |

注册事实来源：[packages/server/src/sdk/providers/index.ts](../../packages/server/src/sdk/providers/index.ts) `getAllProviders/getProvider`、[policy.ts](../../packages/server/src/sdk/providers/policy.ts) `isLiveProviderName/isRetiredProviderName/isProviderEnabled`、[packages/client/src/providers/registry.ts](../../packages/client/src/providers/registry.ts) `activeProviders/getProvider`。枚举允许、目录存在、CLI 安装、账号可用、runtime 可用、UI 开放是不同条件。
