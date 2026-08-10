# Yep Anywhere 飞书 × Codex 渠道桥接开发方案

> 文档状态：历史设计基线；核心方案已在 2026.8.1 落地，当前行为以代码、测试和 `CHANGELOG.md` 为准
> 调研与代码核查截止：2026-08-07
> 目标项目：Yep Anywhere 2026.8.x 发行线
> 目标场景：从既有第三方桥接宿主迁移的飞书机器人；生产身份、时间和消息样例均已脱敏

本文保留设计阶段的问题分析、验收条件和 PR 拆分，便于追溯架构决策；其中“待实现”措辞和未勾选清单不代表当前完成状态。

## 0. 结论摘要

设计调研时，目标机器人的飞书入站消息、会话路由、Codex 启动、流式卡片和审批交互主要由既有桥接宿主承担；Lark MCP 只是 Codex 主动调用飞书 API 的工具层，不是完整的消息桥。

建议在 Yep Anywhere 内建设一等公民的 `FeishuChannelService`，复用 Yep 已有的 Codex app-server、Supervisor、`RuntimeController`、审批队列、会话持久化和实时订阅能力。第一阶段把服务放在 Yep Server 进程内；只有在渠道协议稳定、确实需要故障隔离或跨主机部署时，再抽成独立 sidecar。

推荐链路如下：

```text
飞书开放平台 WebSocket
        │
        ▼
FeishuChannelService
  ├─ 账号连接与权限检查
  ├─ 消息去重、访问控制、按 scope 串行化
  ├─ 文本/富文本/附件/话题卡片标准化
  ├─ 飞书 scope ↔ Yep session 持久化映射
  ├─ CardKit 流式回复与审批回调
  └─ 诊断、重连、限流和降级
        │
        ▼
SessionCommandService（设计阶段待从 routes 抽取，现已落地）
        │
        ▼
RuntimeController → Supervisor → Codex Provider
        │                           │
        │                           └─ codex app-server --listen stdio://
        ▼
session/event/pending-input 统一状态
```

Codex 需要主动创建飞书文档、读取云盘或调用其他飞书 OpenAPI 时，仍通过独立的 Lark MCP/CLI 工具层完成。渠道桥使用的 App Secret 不应自动暴露给 Codex 子进程。

## 1. 背景与问题定义

### 1.1 当前生产链路

对目标部署环境进行只读核查后，确认当时运行中的机器人进程来自既有桥接宿主安装包，脱敏后的核心进程形态为：

```text
/Applications/LegacyBridge.app/.../bridge/dist/index.mjs
```

既有桥接宿主当时承担：

1. 通过飞书长连接接收 `im.message.receive_v1` 等事件。
2. 将飞书消息解析为 Codex 可理解的输入。
3. 维护飞书 chat/topic 与本地 Codex session 的映射。
4. 启动和保活本地 Codex 进程。
5. 将 Codex 流式输出投射成飞书卡片。
6. 把工具审批和用户问题转换为飞书交互。
7. 给 Codex 注入飞书工具能力。

Yep Anywhere 当时同机运行，但不是目标机器人入站链路的中间层。因此，Yep 页面中的 Codex 会话管理能力与飞书机器人形成两套平行的运行和状态体系。

### 1.2 已确认的“话题无法读取”原因

截图中“某人发布了话题、下方包含多条话题回复”的卡片，在飞书事件层并不等同于普通 `text` 或 `post`，实际以 `message_type=merge_forward` 到达机器人。

目标消息到达时，既有桥接宿主的脱敏日志行为是：

```text
收到 message_type=merge_forward
→ 当前消息分发器直接忽略该类型
```

使用该机器人的既有应用身份进行只读 OpenAPI 验证，可以成功取得：

- 1 条父消息；
- 29 条关联记录；
- 其中包含 21 条文本和 8 条交互卡片消息。

因此，设计阶段的阻塞点不是飞书权限，也不是 Codex 能力，而是既有桥接宿主的消息适配层没有实现 `merge_forward` 展开。目标功能原则上不需要为已验证应用新增权限，但新实现仍应提供启动时权限诊断，避免其他环境的权限配置不同。

### 1.3 两种“话题”必须分开建模

飞书产品界面中都可能叫“话题”，但开发时是两个不同概念：

| 产品表现 | 事件/API 特征 | 开发语义 |
| --- | --- | --- |
| 分享到会话中的“发布了话题”卡片 | `message_type=merge_forward`，调用 message get API 返回父消息及子消息 | 一条消息携带的一组引用材料，需要递归展开后交给 Codex |
| 话题群或群内 thread | 事件含 `thread_id`，部分回复只带 `root_id` | 会话 scope；同一话题应绑定同一个 Yep/Codex session，并在原话题内回复 |

新实现必须同时支持两者，但不能把 `merge_forward.message_id` 误当成 session scope，也不能把所有普通群回复错误拆成独立 session。

### 1.4 为什么不继续修改既有桥接宿主安装包

目标环境中只发现了安装后的 bundle 和 source map，没有发现可维护、可测试、可正常发布的桥接宿主源码仓库。直接修改安装包会带来以下问题：

- 更新应用后修改容易丢失；
- 缺少稳定的单元测试和发布链；
- 飞书会话状态与 Yep 会话状态继续分裂；
- 机器人能力依赖一个不可控的宿主版本；
- 审批、附件和消息解析修复需要重复建设。

既有桥接宿主可以在迁移期间保留为回滚路径，但不应继续作为长期开发底座。

## 2. 目标、非目标与设计原则

### 2.1 目标

1. 让飞书成为 Yep Anywhere 的正式渠道，飞书和 Web UI 监督同一批 Yep session。
2. 完整读取截图所示的飞书话题卡片，包括根消息、回复、嵌套转发和附件。
3. 支持私聊、普通群、话题群及 thread 内的连续 Codex 对话。
4. 支持 Codex 流式输出、工具审批、用户问题、停止任务和错误恢复。
5. 复用 Yep 现有运行层，不再复制一套 Codex 进程管理器。
6. 具备多机器人账号的数据隔离能力，以覆盖当前不止一个机器人配置的部署形态。
7. 默认以最小权限、工作区限制、发送者白名单和人工审批保护开发机。
8. 可以在不改动 Codex Provider 的情况下，将来扩展到 Yep 支持的其他 provider。

### 2.2 非目标

第一阶段不包含：

- 重做一套通用 IM 框架或同时支持所有聊天平台；
- 用飞书替代 Yep Web UI 的全部会话管理功能；
- 将飞书 App Secret 下发给 Codex；
- 自动为机器人申请高敏感飞书权限；
- 在同一飞书应用凭据上同时运行既有桥接宿主和 Yep 两个长连接消费者；
- 自动停止或替换既有桥接服务；正式切换必须是单独、明确授权的运维动作；
- 第一版实现飞书文档评论、日历、任务和云文档全功能 Agent；这些属于工具层或后续渠道扩展。

### 2.3 设计原则

- **Yep session 是事实来源**：飞书只保存路由和展示状态，不另建独立 Codex 历史。
- **渠道层不解析 Codex 私有 stdout**：消费 Yep 的标准 session/runtime 事件。
- **同一 scope 串行、不同 scope 并行**：避免一个话题内并发写同一 session。
- **入站至少一次，执行尽量一次**：飞书会重投事件，必须做持久化幂等。
- **卡片是视图，不是状态源**：审批状态以 Yep pending input 为准。
- **凭据和业务配置分离**：Secret 不进入普通 settings JSON、API 返回或日志。
- **功能按能力降级**：卡片失败可退回 post/text；通讯录权限缺失仍可使用 ID；附件失败不应吞掉文本。
- **引用材料按不可信数据处理**：转发话题中的内容不能覆盖系统规则、工作区限制和审批策略。

## 3. Yep Anywhere 当前可复用能力

### 3.1 Codex 运行层已经具备

当前实现已经直接使用 Codex app-server，而不是依赖 `codex exec` 文本解析：

- [`packages/server/src/sdk/providers/codex.ts`](../../packages/server/src/sdk/providers/codex.ts) 通过 `codex app-server --listen stdio://` 运行 Codex；
- 支持 `thread/start`、`thread/resume`、`turn/start`；
- 处理 command/file approval 和 `tool/requestUserInput`；
- 处理模型、reasoning effort、sandbox、MCP profile、token usage、rollback 和流式 item 事件；
- [`packages/server/src/sdk/providers/codex-protocol/`](../../packages/server/src/sdk/providers/codex-protocol/) 保存由 `codex app-server generate-ts` 生成的协议子集；
- `pnpm codex:protocol:update` / `pnpm codex:protocol:check` 已经用于协议升级和漂移检查。

官方 Codex 文档把 App Server 定位为富客户端集成入口，支持会话历史、审批和流式 Agent 事件；默认 stdio 是稳定的本地传输，而 WebSocket 传输仍标记为 experimental/unsupported。Yep 当前使用 stdio 的方向应保持不变。[Codex App Server](https://github.com/openai/codex/tree/main/codex-rs/app-server)

### 3.2 `RuntimeController` 已覆盖机器人需要的控制动作

[`packages/server/src/runtime/types.ts`](../../packages/server/src/runtime/types.ts) 已提供：

- `startSession` / `createSession`；
- `resumeSession` / `queueMessage`；
- `abortProcess` / `interruptProcess`；
- `getPendingInputRequest` / `respondToInput`；
- `setPermissionMode` / `setHold`；
- `subscribeSession` / `subscribeActivity` / `replay`；
- 进程、队列、模型、命令和上下文状态查询。

其 embedded 与 external 两种实现由：

- [`EmbeddedRuntimeController.ts`](../../packages/server/src/runtime/EmbeddedRuntimeController.ts)
- [`HttpRuntimeController.ts`](../../packages/server/src/runtime/HttpRuntimeController.ts)

提供。飞书渠道只依赖接口，就能兼容未来把 Agent runtime 独立成进程的部署方式。

### 3.3 Supervisor 与订阅层已经处理并发和审批

- [`packages/server/src/supervisor/Supervisor.ts`](../../packages/server/src/supervisor/Supervisor.ts) 负责 worker、队列、session 启停；
- [`packages/server/src/supervisor/Process.ts`](../../packages/server/src/supervisor/Process.ts) 维护 pending approval 队列、permission mode、消息历史和状态机；
- [`packages/server/src/subscriptions.ts`](../../packages/server/src/subscriptions.ts) 统一输出 `connected`、`message`、`status`、`mode-change`、`error`、`complete` 等事件，并支持重连 replay；
- [`packages/server/src/watcher/EventBus.ts`](../../packages/server/src/watcher/EventBus.ts) 提供 session/process/activity 的全局事件。

飞书渠道不应再实现自己的 Codex process pool 或 permission broker。它只需要做 scope 串行化、调用运行层、把 `InputRequest` 渲染到飞书，并把按钮决策交回 `respondToInput`。

### 3.4 设计时需要补出的应用层（现已落地）

设计调研时，虽然 `RuntimeController` 足够完整，但 session 的上层业务逻辑有较多内容直接写在 [`packages/server/src/routes/sessions.ts`](../../packages/server/src/routes/sessions.ts) 中，例如：

- project/session 定位；
- provider/model/MCP profile/reasoning 默认值解析；
- metadata 和 `createdBy` 持久化；
- session ID 变化处理；
- resume 与 active-process queue 的选择；
- permission mode 持久化；
- 上传后的 `UploadedFile` 组装；
- 不同 pending input owner 的选择。

如果 `FeishuChannelService` 直接调用 `RuntimeController`，这些规则会被复制一遍。因此设计方案要求抽出一个薄的应用层，例如：

```ts
interface SessionCommandService {
  start(input: StartChannelSessionInput): Promise<SessionCommandResult>;
  send(input: SendChannelMessageInput): Promise<SessionCommandResult>;
  interrupt(sessionId: string): Promise<InterruptResult>;
  getPendingInput(sessionId: string): Promise<InputRequest | null>;
  respondToInput(input: ChannelInputResponse): Promise<{ accepted: boolean }>;
  subscribe(
    sessionId: string,
    listener: SessionEventListener,
    options?: SessionSubscribeOptions,
  ): Promise<SessionSubscription | null>;
}
```

该应用层现已落地于 [`packages/server/src/services/SessionCommandService.ts`](../../packages/server/src/services/SessionCommandService.ts)，由 Hono routes 和飞书服务共同调用；`RuntimeController` 继续作为更低层的进程控制抽象。上面的接口保留为设计阶段的边界示意，不代表当前实现的逐字段签名。

### 3.5 `codex-bridge` 目录不是本功能的直接入口

[`packages/server/src/codex-bridge/`](../../packages/server/src/codex-bridge/) 主要服务外部 `codex --remote` TUI 和 4510 bridge 场景。飞书机器人由 Yep 创建和管理 session 时，应走正常的 session/runtime/provider 链路，不应把消息再代理到 4510，也不应给 `CodexBridgeService` 增加飞书逻辑。

## 4. 架构选择

### 4.1 方案比较

| 方案 | 优点 | 代价/风险 | 结论 |
| --- | --- | --- | --- |
| A. Yep Server 内置 `FeishuChannelService` | 最大化复用 `RuntimeController`、EventBus、metadata 和配置；无内部 HTTP 认证问题；Web UI 与飞书天然共享状态 | 飞书 SDK 与主服务同进程；需要做好异常隔离和可单独启停 | **MVP 推荐** |
| B. Yep monorepo 独立 sidecar | 故障隔离清晰，可独立重启和部署 | 需要新的 scoped Channel Control API、事件续传、上传接口和凭据；公开 UI API 依赖 cookie/desktop token，不适合作为长期机器接口 | 协议稳定后可选 |
| C. 飞书直接连接 Codex App Server | 链路短 | 重复实现 Yep 已有的 session、审批、持久化、模型配置、附件、队列和展示归一化 | 不采用 |
| D. 修改既有桥接宿主 bundle | 短期改动少 | 不可维护、更新易覆盖、状态继续分裂 | 仅临时回滚，不继续开发 |

### 4.2 为什么 MVP 选进程内服务

当前代码已经在 `packages/server/src/index.ts` 中集中管理长生命周期服务，并为 graceful shutdown 保留引用。`FeishuChannelService` 可以沿用相同模式：

1. ServerSettings、metadata、runtime 初始化完成后创建服务；
2. 服务按账号启动 `WSClient`；
3. 飞书不可用时只把渠道标记为 degraded，不影响 Yep Web/API；
4. graceful shutdown 时只关闭自己的 WSClient 和订阅；
5. 设置页面允许单独启用、禁用或重连某个飞书账号，不要求重启 Yep。

这比让 sidecar 使用 `YEP_DESKTOP_AUTH_TOKEN` 或 runtime 全权限 token 更安全，也避免从进程外复制 Web UI 的上传和订阅协议。

### 4.3 未来抽 sidecar 的前提

只有满足下列需求之一时再抽离：

- 飞书连接稳定性明显影响主服务；
- 需要在另一台主机运行渠道入口；
- 需要多个 Yep 实例共享一个渠道网关；
- 需要独立发布飞书 adapter。

届时应定义专用的 `Channel Control API`，使用最小权限 token，至少包含：session start/send/interrupt、pending input、事件续传和流式附件导入。不要复用 cookie、desktop token，也不要把 runtime 控制 token 暴露给网络侧渠道进程。

## 5. 推荐模块边界

建议先实现 Feishu 专用边界，不为尚不存在的第二个渠道设计过度抽象。目录可以是：

```text
packages/server/src/channels/
├── types.ts                         # 少量 provider-neutral 渠道类型
└── feishu/
    ├── FeishuChannelService.ts      # 多账号生命周期与总编排
    ├── FeishuAccountConnection.ts   # 一个 appId 对应一个 WS/REST client
    ├── event-dispatcher.ts          # im.message/card.action 入口
    ├── config.ts                    # 安全配置解析与默认值
    ├── secret-store.ts              # App Secret，不进入普通 settings API
    ├── status.ts                    # 连接、权限、延迟、最后错误
    ├── policy.ts                    # 用户/群/mention/admin/模式权限
    ├── scope.ts                     # chat/thread → scope key
    ├── inbox-store.ts               # 持久化去重、恢复和投递状态
    ├── binding-store.ts             # scope ↔ project/session
    ├── scheduler.ts                 # per-scope 串行化与短窗口合并
    ├── prompt.ts                    # 可信元数据与不可信材料分隔
    ├── media.ts                     # 飞书资源下载与 Yep UploadedFile 导入
    ├── normalizer/
    │   ├── index.ts
    │   ├── text.ts
    │   ├── post.ts
    │   ├── interactive.ts
    │   ├── merge-forward.ts
    │   └── resources.ts
    ├── reply/
    │   ├── controller.ts            # 每个运行回合的回复状态机
    │   ├── cardkit.ts
    │   ├── markdown.ts
    │   └── fallback.ts
    ├── approval/
    │   ├── operation-store.ts       # 短期 operationId → requestId
    │   ├── cards.ts
    │   └── callbacks.ts
    └── commands/
        ├── router.ts
        └── handlers.ts

packages/server/src/services/
└── SessionCommandService.ts         # routes 与渠道共用的应用层

packages/server/src/routes/
└── feishu-channel.ts                # 设置、状态、测试、显式重连 API

packages/shared/src/
└── feishu-channel.ts                # 可由客户端使用的脱敏配置/状态类型

packages/client/src/pages/settings/
└── FeishuChannelSettings.tsx

packages/server/test/channels/feishu/
└── ...
```

如果实现过程中发现 `SessionCommandService` 抽取面过大，可以先只覆盖飞书需要的 start/send/interrupt/input/subscribe 五条路径，但必须让现有 Hono route 也调用同一实现，避免形成第二套规则。

## 6. 核心数据流

### 6.1 入站消息

```text
im.message.receive_v1
  → 验证 account/tenant/bot identity
  → durable inbox 去重
  → 解析 sender/chat/message/thread/root/parent
  → 访问控制与 @bot 策略
  → 标准化消息内容
      ├─ 普通 text/post
      ├─ merge_forward 递归展开
      ├─ 引用消息补取
      └─ 图片/文件/音视频资源下载
  → 计算 scope key
  → 同 scope 进入串行队列
  → 查找或创建 binding
  → SessionCommandService.start/send
  → 建立 session subscription
  → 立即发送处理中状态
```

### 6.2 Codex 输出

```text
RuntimeController.subscribeSession
  → connected/status/message/error/complete
  → provider-neutral SessionProjection
  → ReplyController 状态机
  → 500~1000ms 合并增量
  → CardKit 更新
  → 完成时关闭 streaming mode
  → 卡片失败则降级为 post/text
```

飞书 renderer 不应消费客户端预渲染 HTML。它应从标准 `SDKMessage`/session event 提取：

- assistant 文本增量；
- tool start/progress/result；
- plan 和状态；
- error/interrupt/completion；
- token/context usage（可选展示）。

### 6.3 审批和用户问题

```text
status(waiting-input) / InputRequest
  → 创建一次性 operationId
  → operation-store 保存 account/chat/session/request 映射
  → 发送审批或选择卡片
  → card.action.trigger
  → 3 秒内校验并立即 ACK
  → 校验操作者、scope、过期时间和 pending request
  → SessionCommandService.respondToInput
  → 更新原卡片为已批准/拒绝/过期
  → Codex 继续运行
```

卡片 payload 只放不可逆的 `operationId` 和动作，不放 App Secret、完整命令、文件内容或可被伪造后跨 session 使用的 `requestId`。

## 7. 统一入站模型

建议渠道内部先归一化为结构化对象，再构建 Codex user message：

```ts
interface FeishuInboundMessage {
  accountId: string;
  eventId?: string;
  messageId: string;
  chat: {
    chatId: string;
    chatType: "p2p" | "group";
    threadId?: string;
    rootId?: string;
    parentId?: string;
  };
  sender: {
    openId: string;
    displayName?: string;
    tenantKey?: string;
    isBot: boolean;
  };
  content: {
    sourceType: string;
    text: string;
    quoted?: FeishuQuotedMessage[];
    forwardedTopic?: FeishuForwardedTopic;
    attachments: UploadedFile[];
    warnings: string[];
  };
  mentions: FeishuMention[];
  createdAt: string;
}
```

Codex 输入建议由两部分组成：

```text
<channel_context source="feishu">
  account、chat type、thread 和发送者等最小必要元数据
</channel_context>

<user_content>
  用户直接发送的内容
  <quoted_material trust="untrusted">...</quoted_material>
  <forwarded_topic trust="untrusted">...</forwarded_topic>
</user_content>
```

注意：XML 标签只用于清晰分隔，不代表安全边界。真正的安全边界仍由系统/开发者指令、文件 sandbox、workspace root、allowlist 和审批策略提供。

## 8. 消息类型支持矩阵

### 8.1 P0：替换既有桥接宿主的必要能力

| 飞书类型 | P0 行为 |
| --- | --- |
| `text` | 解析文本和 mentions，移除只用于触发机器人的 @bot 标记，保留对其他人的提及 |
| `post` | 按段落、链接、代码、mentions 和图片顺序提取；图片成为附件 |
| `image` | 下载资源，识别真实 MIME，作为 Yep image/attachment 传入 |
| `file` | 下载并保存原始文件名、MIME、大小；传入 `UploadedFile` |
| `audio` | 下载为附件并标记语音；P0 不保证转写 |
| `video` / `media` | 下载或在超限时给出明确占位与错误，不静默丢弃 |
| `interactive` | 至少提取卡片中的 plain_text、lark_md/markdown、字段值和链接 |
| `merge_forward` | 展开父消息、所有子消息和嵌套容器，保留顺序、发送者、时间和附件 |
| reply/quote | 根据 `parent_id` 补取被引用消息，避免只把当前一句“分析一下”交给 Codex |
| 未知类型 | 输出 `[未支持的飞书消息类型: xxx]` 警告并记录计数，不崩溃、不伪造内容 |

### 8.2 P1

- 语音消息自动转写，优先飞书 STT，可配置其他转写器作为 fallback；
- sticker、location、share_chat、share_user 等类型的友好表示；
- 卡片表单值和更完整的 CardKit 2.0 DSL 提取；
- 大型附件异步下载进度；
- 话题内容生成独立 Markdown 材料文件并可在 Yep UI 中查看；
- 文本/卡片回复模式可按账号或会话配置；
- 回复中的工具调用、plan、token usage 可选展示。

### 8.3 P2

- 飞书云文档评论中 @机器人触发 Codex；
- reaction 作为“继续、停止、确认”等轻量控制；
- 主动通知、定时任务和跨会话广播；
- 其他 IM 渠道共享抽象；
- 独立 Feishu sidecar。

## 9. `merge_forward` / 话题卡片的精确实现要求

这是本项目的首个强制验收点。

### 9.1 拉取与建树

收到 `message_type=merge_forward` 后：

1. 调用飞书 message get API，使用当前消息 `message_id`；
2. 请求原始卡片内容参数，例如 `card_msg_content_type=raw_card_content` 或当前 SDK 对应的完整 card 参数；
3. API 返回父消息和一个扁平 `items[]`；
4. 跳过重复的根容器记录；
5. 按 `upper_message_id` 构建 `parentId -> children[]`；
6. 每组 children 按 `create_time` 升序；
7. 遇到嵌套 `merge_forward`，在同一棵树上递归，不为每一层重复请求 API；
8. 逐条调用统一 content converter，不能只处理 text；
9. 批量解析发送者显示名；缺少通讯录权限时回退到稳定别名或 ID；
10. 返回结构化 topic 和适合模型阅读的 Markdown，而不是只返回一段不可追踪的拼接文本。

### 9.2 输出格式建议

```markdown
# 飞书转发话题

- 原始消息 ID：om_xxx
- 消息数：29
- 时间范围：2026-01-01 10:00:00 至 10:20:00 +08:00

## 话题正文

**用户甲｜10:00**

@用户乙，请分析这组脱敏任务结果并总结待办……

## 回复

**用户甲｜10:01**

已补充请求记录与结果记录之间的映射说明。

**用户乙｜10:02**

示例子任务［已完成］

...
```

模型侧不需要看到原始 `open_id`，除非显示名无法解析或用户明确要求。原始 ID 仍可保存在结构化对象中用于诊断，但不得写入普通回复。

### 9.3 附件与超长内容

建议提供可配置保护阈值，初始值在实现和压测后确定：

- 最大消息数；
- 最大嵌套深度；
- 最大标准化字符数；
- 单附件和单次消息总下载大小；
- API 分页/请求次数；
- 解析和下载总超时。

阈值触发时必须：

1. 明确告诉 Codex 和用户哪些内容被截断；
2. 保留原始总数和已读取数量；
3. 优先把完整标准化内容写为 session 附件，再给 Codex 文件路径；
4. 不允许仅截取开头却声称已经读完全部话题。

### 9.4 目标截图的验收标准

针对本次已观察到的样例：

- 不再出现 `ignoring message type=merge_forward`；
- 一次拉取能识别父消息及 29 条关联记录；
- 至少识别其中 21 条文本和 8 条交互消息；
- 根问题和 23 条可见话题回复在模型输入中保持正确顺序；
- 卡片中的可见正文不能退化成 `[interactive card]`；
- 若某条卡片确实没有可提取文本，应带消息 ID 和类型的占位，不应消失；
- Codex 能基于完整材料提炼任务背景、参与者结论、未解决问题和行动项。

## 10. Scope 与 session 绑定

### 10.1 Scope 规则

建议默认规则：

```ts
function computeScope(message: FeishuInboundMessage): FeishuScopeKey {
  if (message.chat.chatType === "p2p") {
    return `${accountId}:p2p:${chatId}`;
  }
  if (isTopicOrThreadModeChat && effectiveThreadId) {
    return `${accountId}:thread:${chatId}:${effectiveThreadId}`;
  }
  return `${accountId}:group:${chatId}`;
}
```

- 私聊：每个 chat 一个 session；
- 普通群：默认全群共享一个 session；
- 话题群：每个 `thread_id` 一个 session；
- 某些 reply 事件只有 `root_id` 时，应通过 chat metadata/message lookup/cache 推导 effective thread，不能直接退回错误 scope；
- 账号 ID 必须参与 key，避免多个机器人账号的 chat ID 冲突；
- `merge_forward.message_id` 只是材料 ID，不参与 session scope。

可以为高级用户增加 `groupSessionMode=chat|thread`，但默认行为必须稳定、可解释，并在 `/status` 中显示。

### 10.2 Binding 生命周期

```ts
interface FeishuSessionBinding {
  version: 1;
  scopeKey: string;
  accountId: string;
  chatId: string;
  threadId?: string;
  projectId: string;
  projectPath: string;
  sessionId: string;
  provider: "codex";
  permissionMode?: PermissionMode;
  model?: string;
  reasoningEffort?: string;
  codexMcpMode?: CodexMcpMode;
  createdAt: string;
  updatedAt: string;
  lastInboundMessageId?: string;
}
```

规则：

- 第一条消息使用账号默认 project 或管理员已绑定的 project；
- 若 session 有 active process，调用 `queueMessage`；
- 若 session 已落盘但没有 active process，调用 `resumeSession`；
- 若绑定不存在，创建新 session；
- `session-id-changed` 事件必须原子更新 binding，不能永久保存临时 ID；
- `/new` 创建新 session 并更新 binding，但不删除旧 Codex 历史；
- `/reset` 只解除当前 scope 绑定；
- `/resume` 或 `/bind` 只能绑定允许 workspace 内、当前用户有权访问的 session；
- 项目切换必须先中断或等待当前 turn 完成，再更新 binding。

设计阶段 [`SessionCreatedBy`](../../packages/shared/src/app-types.ts) 只有 `"yep" | "external"`；当前实现已扩展为 `"yep" | "external" | "channel"`，并增加脱敏的 `originChannel: "feishu"`。chat ID、thread ID 和用户 ID 仍只保存在受保护的 binding store 中，因此 Yep UI 可以标识“来自飞书”，又不需要把聊天身份混入通用 session metadata。

### 10.3 同一 scope 的消息调度

- 以 scope 为单位使用 Promise chain/FIFO；
- 允许 200~500ms 的可配置 debounce，把用户连续发送的文字和附件合成一轮；
- 当前 turn 运行时到达的新消息，不得并发启动第二个相同 session；
- 具体采用 steer、普通 queue 还是 deferred，由 Yep 的 `SessionCommandService` 和 provider 能力决定，飞书层不自行模拟；
- 不同 scope 的并发上限交给 Supervisor/WorkerQueue；
- `/stop` 优先于普通队列消息，并清晰显示是否成功中断。

## 11. 持久化与幂等

建议放在当前 profile 的 `dataDir`：

```text
<dataDir>/channels/feishu/
├── accounts.json          # 非敏感账号配置，versioned
├── secrets.json           # 0600；或只存 secretRef
├── bindings.json          # scope ↔ session
├── inbox.jsonl            # 入站事件状态日志
├── operations.json        # 尚未完成的审批/问题操作
└── media-cache/           # 未导入 session 前的临时资源
```

### 11.1 Durable inbox

飞书会因超时、断线或平台重试重复投递。仅使用内存 `Set` 不足以防止服务重启后重复执行 Codex。

每个入站事件建议记录：

```ts
interface FeishuInboxRecord {
  key: string; // accountId + eventId，缺失时使用 messageId + event type
  accountId: string;
  messageId?: string;
  scopeKey?: string;
  status: "received" | "dispatching" | "dispatched" | "completed" | "failed";
  sessionId?: string;
  tempId?: string;
  attempts: number;
  receivedAt: string;
  updatedAt: string;
  lastErrorCode?: string;
}
```

要求：

- 原始用户正文不写入 dedup 日志；
- 在开始 Codex dispatch 前持久化状态；
- 使用由飞书 `message_id` 派生的稳定 `tempId`；
- 服务启动时恢复 `received/dispatching` 状态并进行对账；
- 已完成记录按 TTL 和数量上限压缩；
- card action 也要用 event/action ID 去重；
- 对“请求已交给 Runtime，但进程在落盘前崩溃”的窗口建立专项故障测试。

完全 exactly-once 不现实，但实现不能因为一次飞书重投就启动两次明显相同的开发任务。

### 11.2 原子保存

bindings、accounts 和 operations 使用“临时文件 + fsync/close + rename”的原子写入方式，并带 schema version。不要在进程退出时才集中保存。

## 12. 附件处理

[`packages/server/src/uploads/manager.ts`](../../packages/server/src/uploads/manager.ts) 已提供文件名清洗、大小限制、流式写入和 `UploadedFile` 结构，但当前主要由 WebSocket upload transport 驱动。飞书渠道不应伪装成浏览器 WebSocket 客户端。

建议给 `UploadManager` 增加可测试的直接导入 API：

```ts
interface IngestUploadInput {
  projectId: string;
  sessionId: string;
  originalName: string;
  mimeType: string;
  expectedSize?: number;
  stream: AsyncIterable<Uint8Array>;
}

ingest(input: IngestUploadInput): Promise<UploadedFile>;
```

浏览器 upload route 和飞书 media downloader 共同复用它。

第一条消息带附件时可使用现有两阶段流程：

1. `createSession` 获取 session ID；
2. 下载飞书资源并导入该 session 的 uploads 目录；
3. 以 `attachments` 调用 `queueMessage`；
4. 如果下载失败，仍发送文本和明确的附件错误提示。

附件要求：

- 以实际 magic bytes 修正不可靠的 MIME；
- 原始文件名经过 Yep 的安全清洗；
- 禁止 `../`、绝对路径注入和 symlink escape；
- 下载使用流和 backpressure，不把大文件一次性读入内存；
- 每文件、每消息、每账号并发都有限制；
- 临时失败文件可清理；已导入 session 的附件保留策略应与 Yep 统一；
- 当前 Yep 尚未完整实现“删除 session 时删除 uploads”，此处需登记为共同的数据保留风险，而不是由飞书层私自删除。

## 13. 飞书回复与卡片状态机

### 13.1 回复模式

建议支持三种模式：

1. `card`：默认；流式更新 CardKit 2.0；
2. `markdown`：使用飞书 post/markdown 增量或分段回复；
3. `text`：只在完成后发送，作为最保守的 fallback。

P0 至少实现 `card + text fallback`。

### 13.2 ReplyController 状态

```text
created
  → acknowledged
  → streaming
  → waiting_input ──┐
  → completed       │
  → interrupted     │
  → failed          │
  → degraded_text   │
                    └─ 审批完成后回到 streaming
```

要求：

- 收到消息后尽快给出“已接收/处理中”反馈；
- 卡片更新使用单调递增 sequence，所有更新按 Promise chain 串行；
- 文本 delta 合并后再更新，建议 500~1000ms 节流，避免触发平台限流；
- 完成后关闭 streaming mode，再写最终状态；
- 超出单卡内容限制时分段或创建续卡，不能静默截断最终回答；
- CardKit API 失败时记录错误码并降级，不创建大量重复卡片；
- 若回复来自话题群，使用 `reply_in_thread=true` 回到同一 thread；
- 普通群的 quoted reply 与 topic reply 不混用。

### 13.3 工具展示

P0 可以只展示：

- 当前状态；
- Codex 最终回答；
- “正在执行工具”及经过清洗的工具名；
- pending approval；
- 错误和中断。

不要默认把完整 shell 输出、环境变量、文件内容或超长 patch 放入群聊。P1 再增加可折叠摘要和 Yep session 深链。

## 14. 审批、问题与卡片回调

### 14.1 决策映射

| 飞书按钮 | Yep 操作 |
| --- | --- |
| 允许一次 | `respondToInput(..., response="approve")` |
| 本 session 始终允许 | `response="approve_always"`；provider 不支持时退化为一次 |
| 允许并切换 Accept Edits | 先批准，再由共享应用层切换 `acceptEdits` |
| 拒绝 | `response="deny"`，可带用户反馈 |
| 用户问题选项 | 组装 `UserQuestionAnswers` 并批准提交 |

`bypassPermissions` 不应在飞书渠道默认开放。即使管理员启用，也应限制为受信私聊、显式二次确认和受限 workspace。

### 14.2 回调安全

每次 operation 必须绑定：

- `accountId`；
- `chatId/threadId`；
- `sessionId`；
- `requestId`；
- 允许操作的 user/open_id；
- 创建时间与过期时间；
- 当前状态和一次性 nonce。

回调处理：

1. 先校验事件确实来自对应飞书账号；
2. 校验操作者在 allowlist 中，且有权审批该 scope；
3. 根据 operation store 查真实 request，不信任卡片传回的 session/request 字段；
4. 再向 Yep 查询该 pending request 是否仍有效；
5. 先在飞书要求的时间内 ACK，再异步执行较慢的更新；
6. 重复点击返回“已处理”，不得重复审批；
7. 过期按钮更新为灰色并提示从 Yep UI 处理。

## 15. 飞书内命令

### 15.1 P0 命令

| 命令 | 行为 |
| --- | --- |
| `/help` | 展示可用命令和当前安全限制 |
| `/status` | 展示 account、scope、project、session、provider、model、mode、活动状态 |
| `/new` | 为当前 scope 创建新的 Yep session；旧 session 保留 |
| `/reset` | 解除当前 binding；下一条消息创建新 session |
| `/stop` | 中断当前 scope 的 active turn |
| `/project list` | 只列出账号允许的 project |
| `/project use <name>` | 切换 project，并创建新 session |
| `/mode <default\|plan\|acceptEdits>` | 在账号策略允许范围内修改 permission mode |
| `/doctor` | 检查连接、事件、权限、卡片和 Yep runtime 状态，不输出 Secret |

### 15.2 P1 命令

- `/resume`：列出当前 workspace 最近 session 并绑定；
- `/model`：查看或切换当前 provider 的可用模型；
- `/effort`：切换 reasoning effort；
- `/mcp clear|standard|full`：选择 Codex MCP profile；
- `/pending`：重新展示当前等待输入的审批/问题；
- `/link`：返回 Yep session 深链；
- `/reply-mode`：切换 card/markdown/text。

管理员命令和普通用户命令必须分开。任意路径的 `/cd` 不建议作为 P0 功能；项目应从预先配置的 allowlist 中选择。

## 16. 多账号与配置模型

设计调研覆盖了多个机器人配置，因此即使首个迁移对象只有一个机器人，后端数据模型也必须以 `accountId` 为一级命名空间。

```ts
interface FeishuAccountConfig {
  id: string;
  name: string;
  enabled: boolean;
  domain: "feishu" | "lark";
  appId: string;
  secretRef: string;
  defaultProjectPath: string;
  allowedWorkspaceRoots: string[];
  allowedUsers: string[];
  adminUsers: string[];
  allowedChats: string[];
  requireMentionInGroup: boolean;
  groupSessionMode: "chat" | "thread-when-available";
  defaultProvider: "codex";
  defaultPermissionMode: PermissionMode;
  replyMode: "card" | "markdown" | "text";
}
```

### 16.1 Secret 管理

不要把 `appSecret` 直接加到 `ServerSettings`：当前 `getSettings()` 会复制并通过 API 返回完整 settings，一旦这样实现，Secret 会进入浏览器响应和可能的客户端日志。

推荐顺序：

1. 环境变量或外部 secret reference；
2. Yep 独立 `FeishuSecretStore`，文件权限 0600，API 永远只返回 `configured: true/false` 和末尾掩码；
3. 后续可增加 macOS Keychain/系统凭据库实现。

Secret 不得出现在：

- Git；
- 普通 server settings 响应；
- 结构化日志；
- 错误卡片；
- Codex prompt；
- Codex 子进程环境，除非某个明确独立配置的 MCP 工具确实需要，且该工具使用自己的 credential reference。

### 16.2 设置页面

建议新增 `Settings → Feishu`：

- 账号列表、启用状态、连接状态；
- App ID 和 Secret 配置/轮换；
- Feishu/Lark domain；
- 默认 project、允许 workspace roots；
- admin/user/chat allowlist；
- 群聊是否必须 @bot；
- 默认模型、reasoning、permission mode、MCP profile、回复模式；
- “测试 REST 权限”“连接长连接”“显式重连”按钮；
- 最近连接时间、最近事件时间、最后错误和缺失权限；
- 危险配置警告，例如开放所有群或允许 bypassPermissions。

根据项目约定，新增 UI 文案需要同步：

- [`packages/client/src/i18n/en.json`](../../packages/client/src/i18n/en.json)
- [`packages/client/src/i18n/zh-CN.json`](../../packages/client/src/i18n/zh-CN.json)

## 17. 飞书应用权限和事件

应按“启用的能力 → 所需权限”动态诊断，而不是一次申请所有权限。

### 17.1 基础能力

需要在飞书开放平台启用长连接事件：

- `im.message.receive_v1`
- `card.action.trigger`

基础权限通常包括：

- 接收消息：`im:message` 或平台当前对应的 p2p/group-at granular scope；
- 机器人发消息：`im:message:send_as_bot`；
- 读取消息/展开转发：`im:message:readonly` 或对应消息读取权限；
- 图片和文件：`im:resource`；
- chat/topic 元数据：`im:chat`；
- CardKit 创建和更新：`cardkit:card:write`，读取状态时再加 read；
- 显示名解析：`contact:user.base:readonly` 或相应基础通讯录权限，可选。

具体 scope 名称应以实现时使用的飞书 API 返回和官方 SDK 为准。当前目标应用已验证能读取样例 `merge_forward`，不应为了这个样例无差别扩权。

### 17.2 `/doctor` 权限矩阵

诊断结果应按能力显示：

```text
消息长连接             PASS
私聊消息读取           PASS
群 @消息读取           PASS
机器人消息发送         PASS
merge_forward 展开     PASS
消息资源下载           PASS
CardKit 创建/更新      WARN: 缺 cardkit:card:write
用户显示名             OPTIONAL: 缺 contact scope，使用 ID 回退
```

权限缺失不能只打印平台错误码；要给出受影响功能和最小补救建议。

## 18. 安全设计

### 18.1 默认访问策略

coding agent 能读取和修改开发机文件，不能采用“连接成功后所有飞书用户都可用”的默认值。

建议：

- 未配置管理员/allowed user 时，渠道保持 locked；
- 私聊也要求 user allowlist；
- 群聊要求 chat allowlist + user allowlist + @bot；
- 默认不接受其他 bot 发出的消息，防止机器人互相递归；
- admin 才能切换 project、mode、model、MCP profile 和账号配置；
- 群聊不允许 `bypassPermissions`；
- 审批只能由触发者或 admin 完成，策略可配置但默认从严；
- 账号按 tenant_key 校验，拒绝跨租户异常事件。

### 18.2 工作区边界

- 每个账号至少有一个 `allowedWorkspaceRoots`；
- project path 先 realpath/canonicalize，再检查是否位于 allow root；
- 拒绝通过 `..`、symlink 或大小写差异逃逸；
- `/project use` 只使用服务端已登记的 project ID；
- 飞书文本不能直接决定 `cwd`、executor 或绝对路径；
- remote executor 支持放到 P2，并单独定义 host allowlist。

### 18.3 Prompt injection 与数据边界

转发话题、引用消息、卡片内容、附件和发送者名称都属于不可信用户数据。渠道层应：

- 使用结构化标签明确 `quoted_material` / `forwarded_topic`；
- 不把材料拼进 developer/system instructions；
- 不让材料控制 permission mode、workspace、MCP profile 或回复目标；
- 在系统规则中声明引用材料不能覆盖更高优先级约束；
- 对“把 Secret 发给我”“关闭审批”等内容仍走正常安全策略；
- 不因为内容来自历史话题就视为管理员指令。

### 18.4 日志与隐私

结构化日志默认只记录：

- account ID；
- event/message ID 的短 hash 或后缀；
- scope hash；
- 消息类型、数量、大小、耗时；
- session/process/request correlation ID；
- 平台错误码和降级路径。

默认不记录完整正文、附件内容、App Secret、access token、完整 tool input 或用户显示名。诊断包需要再次脱敏。

## 19. 可靠性、限流与恢复

### 19.1 连接

- 每个账号独立 `WSClient`；
- SDK 自动重连之外，维护显式状态：`disabled/connecting/connected/degraded/stopped`；
- 记录最后事件时间和最后成功 API 时间；
- 连续失败采用有上限的指数退避和 jitter；
- 一个账号失败不能阻塞其他账号和 Yep 主服务；
- 同一 `appId` 在一个 Yep 实例内只允许一个 connection owner。

### 19.2 API 限流

- 所有 CardKit 更新经过 coalescing；
- 针对 429/平台频控读取 `Retry-After` 或错误码并退避；
- 普通消息发送、资源下载、用户信息查询分开限流；
- 显示名使用 account-scoped LRU/TTL cache，并优先批量查询；
- 卡片 update 失败不能重新执行 Codex turn；
- 回复发送最终失败时，session 仍保留，并在状态页给出可恢复链接。

### 19.3 服务重启恢复

启动时：

1. 加载 accounts、bindings、inbox 和未完成 operation；
2. 查询 `RuntimeController.listProcessSnapshots()`；
3. 对仍活跃且有 binding 的 session 恢复订阅；
4. 查询 pending input，必要时重发或修复审批卡片；
5. 对已结束但回复状态不明的 inbox 记录读取 session 最终状态，不重新启动 turn；
6. 清理已过期 operation 和临时 media；
7. 连接飞书长连接。

## 20. 可观测性与管理 API

建议增加：

```text
GET  /api/channels/feishu/status
GET  /api/channels/feishu/accounts
PUT  /api/channels/feishu/accounts/:accountId
PUT  /api/channels/feishu/accounts/:accountId/secret
POST /api/channels/feishu/accounts/:accountId/test
POST /api/channels/feishu/accounts/:accountId/connect
POST /api/channels/feishu/accounts/:accountId/disconnect
POST /api/channels/feishu/accounts/:accountId/reconnect
GET  /api/channels/feishu/accounts/:accountId/permissions
GET  /api/channels/feishu/bindings
DELETE /api/channels/feishu/bindings/:scopeKey
```

所有写操作走 Yep 既有 auth + `X-Yep-Anywhere` 防护。Secret update 接口只写不读。

建议日志事件：

```text
feishu_account_connect_started
feishu_account_connected
feishu_account_disconnected
feishu_event_received
feishu_event_duplicate_dropped
feishu_message_policy_denied
feishu_message_normalized
feishu_merge_forward_expanded
feishu_media_download_completed
feishu_session_binding_created
feishu_session_binding_remapped
feishu_session_dispatch_started
feishu_session_subscription_restored
feishu_card_created
feishu_card_update_degraded
feishu_input_card_created
feishu_input_response_accepted
feishu_input_response_rejected
```

每个事件带 duration、count、bytes、status/error code，但不带正文和 Secret。

状态指标至少包括：

- 每账号连接状态；
- 收到/去重/拒绝/失败消息数；
- `merge_forward` 成功率、子消息数和解析耗时；
- 下载成功率及字节数；
- 首次反馈延迟、首 token 延迟、完成延迟；
- card update 次数、频控和降级次数；
- pending approval 数和过期数；
- scope queue 深度。

## 21. 飞书工具层与渠道层的边界

### 21.1 渠道层

负责：

- 接收用户消息；
- 提取话题/附件；
- 路由 Yep session；
- 返回回复；
- 处理审批和命令。

### 21.2 Lark MCP/CLI 工具层

负责 Codex 主动执行：

- 读取/创建飞书文档；
- 查询云盘、表格、日历、任务；
- 主动发送消息等飞书 API 操作。

可选底座：

- [larksuite/lark-openapi-mcp](https://github.com/larksuite/lark-openapi-mcp)
- [larksuite/cli](https://github.com/larksuite/cli)

MCP 不是入站机器人桥，不能替代 `FeishuChannelService`。同样，渠道 App Secret 不应自动成为 MCP 的 user credential；应用身份和用户身份必须清楚区分。

如果 Codex 工具主动向当前 chat 发送交互卡片，其 callback value 必须使用命名空间，避免被渠道审批回调误识别，例如：

```json
{ "namespace": "codex-tool", "operationId": "..." }
```

渠道自有审批则使用：

```json
{ "namespace": "yep-feishu", "operationId": "...", "action": "approve" }
```

## 22. 开源项目复用建议

本次进行的是源码级只读核查，建议“借鉴渠道实现、保留 Yep 运行层”。

| 项目 | 建议复用 | 不建议照搬 |
| --- | --- | --- |
| [VicLuoV5/lark-codex-bridge](https://github.com/VicLuoV5/lark-codex-bridge) | `scope.ts` 的 chat/topic 路由思想、`pending-queue.ts`、附件/引用消息处理、CardKit 管理、Secret 与运维经验 | `codex exec` adapter 和独立 session store；Yep 已有更完整的 app-server/runtime |
| [larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark) | 官方团队维护的飞书 channel 语义、`merge-forward` 单次拉取建树、interactive card 提取、thread/root 处理、CardKit 状态机、权限诊断 | OpenClaw plugin/agent 接口和大而全的飞书工具层 |
| [d-wwei/Agents-To-IM](https://github.com/d-wwei/Agents-To-IM) | 权限卡片 UX、资源/MIME 处理、语音转写、降级和多平台测试思路 | 它自己的 runtime、store 和 provider adapter |
| [francize/agents-to-im](https://github.com/francize/agents-to-im) | 群组到 session 的产品交互、状态恢复和管理体验 | group-per-runtime 的强约束，除非与 Yep 产品模型一致 |
| [larksuite/node-sdk](https://github.com/larksuite/node-sdk) | 官方 WSClient、EventDispatcher、REST client 和消息 normalize 能力 | 不在 SDK 类型不足处无边界使用 `any`；应包在本项目 adapter 内 |

核查版本快照：

- `lark-codex-bridge`：`e8b0dc0`，2026-06-01；
- `openclaw-lark`：`dde0be3`，2026-07-16；
- `d-wwei/Agents-To-IM`：`a997b8e`，2026-04-15。

这些项目当前均使用 MIT License。若直接复制非平凡代码，应保留原版权声明和 MIT 文本，并在 Yep 的 third-party notices/源码头中注明来源和具体 commit。仅参考思路后独立实现，也应在本设计文档和 PR 中记录参考来源，便于后续审计。

## 23. 测试方案

### 23.1 单元测试

至少覆盖：

- text/post/interactive 内容提取；
- mention all、@bot 和其他用户 mention；
- `merge_forward` 扁平 items 建树；
- 嵌套 `merge_forward`；
- child text/post/image/file/audio/interactive/unknown；
- sender name 批量查询、缓存和无权限回退；
- `thread_id`、仅 `root_id`、普通 group reply 的 scope 计算；
- allowlist、admin、群 @策略；
- inbox dedup 和 crash recovery；
- binding 原子保存、session-id remap；
- per-scope 串行、跨 scope 并行；
- card coalescing、sequence、频控和 fallback；
- approval callback 一次性、过期、越权和重复点击；
- Secret masking；
- workspace realpath/symlink escape；
- 附件大小、MIME、文件名和下载失败。

### 23.2 Contract fixtures

在以下目录保存脱敏事件/API fixture：

```text
packages/server/test/fixtures/feishu/
├── text-event.json
├── post-with-images-event.json
├── topic-group-reply-event.json
├── merge-forward-event.json
├── merge-forward-get-29-items.json
├── merge-forward-nested.json
├── interactive-card-v2.json
├── approval-callback.json
└── permission-errors.json
```

fixture 不得包含真实 App ID、Secret、token、open_id、chat_id、姓名、业务 trace 或未脱敏正文。为本次 29 条样例建立结构等价 fixture 和 golden Markdown 输出。

### 23.3 集成测试

使用 fake Lark client + fake/embedded `RuntimeController`：

1. 收到第一条消息创建 session；
2. 后续消息 resume/queue 同一 session；
3. topic A/B 不串 session；
4. Codex delta 更新同一张卡；
5. pending approval → card callback → runtime 解除等待；
6. 服务重启后恢复 binding 和 active subscription；
7. 飞书 API 429、超时和卡片更新失败不会重复执行 Codex；
8. `session-id-changed` 后继续正确路由。

### 23.4 真机验收矩阵

使用新的测试飞书应用，不与既有桥接宿主共享凭据：

| 场景 | 预期 |
| --- | --- |
| 私聊普通文本 | 创建 session，流式回复，Yep UI 可同时看到 |
| 私聊连续追问 | 复用相同 session |
| 普通群未 @bot | 默认静默 |
| 普通群 @bot | 在群内回复，共享群 scope |
| 话题群两个 topic | 两个独立 session，回复回到各自 thread |
| 截图同类话题卡片 | 展开全部可读消息后由 Codex 提炼 |
| 嵌套转发 + 图片/文件 | 文本顺序正确，附件可由 Codex 读取 |
| 工具审批 | 合法用户按钮通过，越权用户被拒绝 |
| 用户问题多选 | 答案结构正确返回 Codex |
| 运行中 `/stop` | 中断当前 turn，session 可继续 |
| 网络断开重连 | 不丢 binding，不重复执行已处理消息 |
| Yep Server 重启 | 恢复连接、active session 和 pending input |
| CardKit 被限流 | 降级为文本，不重复创建 turn |

不需要使用浏览器自动化完成这些验证；设置 UI 的浏览器测试应在另行明确要求时执行。

## 24. 开发阶段与 PR 拆分

> 以下清单保留设计阶段的实施顺序，不表示当前完成状态。2026.8.1 已发布能力以 `CHANGELOG.md` 和现有测试为准。

### Phase 0：冻结接口与样例

- [ ] 脱敏保存本次 `merge_forward` 事件和 message get 响应 fixture；
- [ ] 确认目标飞书应用的实际 scopes 和事件订阅；
- [ ] 确认 multi-account、workspace 和默认 permission policy；
- [ ] 将本文档评审通过。

### PR 1：应用层抽取

- [ ] 新增 `SessionCommandService`；
- [ ] 让现有 Hono session routes 调用该 service；
- [ ] 保持 API 行为不变；
- [ ] 覆盖 start/resume/queue/input/interrupt/session-id remap 测试。

### PR 2：Feishu 基础设施

- [ ] 添加官方 Node SDK；
- [ ] account config、secret store、status 和 lifecycle；
- [ ] WSClient/EventDispatcher；
- [ ] allowlist、bot identity、自消息过滤；
- [ ] 设置 API 和 `/doctor` 最小版本；
- [ ] graceful shutdown。

### PR 3：入站标准化与话题读取

- [ ] text/post/interactive converters；
- [ ] reply/quote 补取；
- [ ] `merge_forward` 单次拉取、建树、递归和 sender resolution；
- [ ] media downloader + UploadManager ingest API；
- [ ] 29-item fixture golden test；
- [ ] 长内容和附件限制。

### PR 4：Session routing 与持久化

- [ ] scope resolver；
- [ ] binding store；
- [ ] durable inbox；
- [ ] per-scope scheduler；
- [ ] create/resume/queue；
- [ ] restart recovery；
- [ ] `/new`、`/reset`、`/status`、`/stop`、`/project`。

### PR 5：流式回复

- [ ] ReplyController；
- [ ] CardKit create/update/settings；
- [ ] delta coalescing、sequence 和 fallback；
- [ ] thread reply；
- [ ] error/interrupted/completed 状态；
- [ ] 长回答分段。

### PR 6：审批和用户问题

- [ ] pending input projection；
- [ ] operation store；
- [ ] card callbacks；
- [ ] approve/approve_always/deny；
- [ ] question/choice；
- [ ] 权限、过期、重复点击和恢复测试。

### PR 7：管理 UI、硬化和迁移

- [ ] Feishu Settings 页面和中英文文案；
- [ ] permissions/status/test/reconnect；
- [ ] metrics、脱敏日志和诊断导出；
- [ ] 测试应用完整验收；
- [ ] 既有桥接宿主切换/回滚 runbook；
- [ ] `CHANGELOG.md` 的 `[Unreleased]`。

每个 PR 先运行聚焦测试，完成实现后至少执行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm codex:protocol:check
```

只有新增或修改 Web UI 流程确实需要 E2E 时再运行 `pnpm test:e2e`；浏览器自动化需按项目规则另行确认。

## 25. 迁移与回滚方案

### 25.1 迁移前

1. 创建独立测试飞书应用和机器人；
2. 使用与生产相同的消息类型、群类型和权限矩阵验收；
3. 不在生产 App ID 上同时启动 Yep 和既有桥接宿主长连接；
4. 导出既有桥接宿主当前非敏感配置：bot 名称、workspace、allowlist、回复策略；
5. 不复制日志中的 token/Secret；凭据通过 Secret 设置流程重新写入；
6. 确认 Yep binding 文件和 dataDir 备份策略；
7. 准备明确的回滚开关。

### 25.2 切换窗口

切换必须由运维人员明确授权后执行：

```text
确认当前没有关键 Codex turn
→ 停止/禁用既有桥接宿主中目标 bot 的长连接
→ 确认该 App ID 不再有旧 consumer
→ 在 Yep 中启用对应 Feishu account
→ 私聊 /status
→ 测试 text、附件、merge_forward、thread、approval
→ 观察错误和重复投递
```

不能让两个进程长期使用同一飞书应用的长连接凭据。开放平台可能把事件随机投递给其中一个连接，造成“偶尔不回复”的不可诊断状态。

### 25.3 回滚

```text
在 Yep 中禁用目标 Feishu account
→ 确认 WSClient 已断开
→ 重新启用既有桥接宿主的目标 bot
→ 验证 /status 或普通消息
```

Yep session 和 binding 不删除；回滚后它们只进入 idle，方便再次迁移。回滚不应删除任何 Codex 历史或附件。

## 26. 风险与待确认事项

| 项目 | 风险 | 建议 |
| --- | --- | --- |
| session 业务逻辑仍在 routes | 渠道直接调用 RuntimeController 会复制规则 | 先抽 `SessionCommandService` |
| App Secret 保存 | 放入普通 settings 会下发客户端 | 独立 write-only Secret Store |
| 飞书事件重复 | 可能重复执行开发任务 | durable inbox + stable tempId + 恢复对账 |
| CardKit 频控/内容限制 | 流式卡片失败或截断 | coalescing、分段、text fallback |
| 超长话题 | prompt 过长、下载耗时 | 阈值、完整材料文件、明确截断信息 |
| 话题与 thread 混淆 | 串 session 或回复错位置 | 独立建模并建立 fixture |
| pending approval 恢复 | 重启后按钮失效或重复审批 | operation 持久化 + runtime 重新查询 |
| 上传保留策略 | session 删除后文件可能残留 | 与 Yep uploads 生命周期统一设计 |
| 账号多开 | 同一 App ID 事件随机分发 | 进程内锁 + 迁移 runbook |
| 群聊 prompt injection | 他人诱导读取/修改代码 | 默认 deny、@策略、workspace、sandbox、审批 |
| 开源代码复制 | 丢失许可证或引入宿主耦合 | 记录 commit、保留 MIT notice、只移植纯 adapter |

开发前仍需产品确认的选择：

1. 普通群默认是整个 chat 共享 session，还是每个 root thread 独立；本文推荐前者；
2. 哪些飞书用户可审批他人触发的任务；本文推荐触发者或 admin；
3. 第一个版本是否必须支持多个机器人同时启用；后端建议支持，UI 可先限制；
4. 默认 project 如何配置，以及是否允许用户在飞书切换；
5. `approve_always` 在 Codex 当前版本上的具体持久化语义；不支持时 UI 必须标明退化；
6. 话题内容超过模型上下文时，是自动生成材料文件，还是先向用户确认；本文推荐自动生成并显式提示；
7. 是否在第一版显示工具详情；本文推荐只显示安全摘要。

## 27. 第一笔实现建议

第一笔代码不要先做设置 UI 或卡片动画，而应完成一个可验证的纵向切片：

```text
测试飞书 App
→ WS 收到 text/merge_forward
→ 解析成 FeishuInboundMessage
→ scope 绑定到一个固定测试 project
→ 通过共享 SessionCommandService 启动 Codex
→ 消费 session 文本事件
→ 以一条最终 text/post 回复
```

该切片的完成条件：

- 测试应用不依赖既有桥接宿主；
- Yep UI 能看到同一个 session；
- `merge_forward` 29-item fixture 通过；
- 不支持的消息不会被静默吞掉；
- 重投同一 message 不会重复启动 turn；
- Secret 不出现在日志/API；
- 关闭飞书渠道不会停止 Yep 或任何无关 session。

随后再叠加流式 CardKit、审批、管理 UI 和正式迁移。这样可以最早验证核心价值：Yep 是否真正成为飞书与 Codex 的统一运行底座。

## 28. 参考来源

### Yep Anywhere 本地实现

- [`packages/server/src/sdk/providers/codex.ts`](../../packages/server/src/sdk/providers/codex.ts)
- [`packages/server/src/runtime/types.ts`](../../packages/server/src/runtime/types.ts)
- [`packages/server/src/routes/sessions.ts`](../../packages/server/src/routes/sessions.ts)
- [`packages/server/src/subscriptions.ts`](../../packages/server/src/subscriptions.ts)
- [`packages/server/src/supervisor/Process.ts`](../../packages/server/src/supervisor/Process.ts)
- [`packages/server/src/uploads/manager.ts`](../../packages/server/src/uploads/manager.ts)
- [`packages/server/src/services/ServerSettingsService.ts`](../../packages/server/src/services/ServerSettingsService.ts)
- [`docs/project/bridge-eventing-and-persistence.md`](bridge-eventing-and-persistence.md)
- [`docs/project/webhook-automation-spec.md`](webhook-automation-spec.md)

### Codex 官方

- [OpenAI Codex](https://github.com/openai/codex)
- [Codex App Server](https://github.com/openai/codex/tree/main/codex-rs/app-server)
- [Codex TypeScript SDK](https://github.com/openai/codex/tree/main/sdk/typescript)

### 飞书官方与开源实现

- [飞书/Lark Node SDK](https://github.com/larksuite/node-sdk)
- [飞书官方 OpenClaw 插件](https://github.com/larksuite/openclaw-lark)
- [飞书 OpenAPI MCP](https://github.com/larksuite/lark-openapi-mcp)
- [飞书 CLI](https://github.com/larksuite/cli)
- [lark-codex-bridge](https://github.com/VicLuoV5/lark-codex-bridge)
- [Agents-To-IM](https://github.com/d-wwei/Agents-To-IM)
- [agents-to-im](https://github.com/francize/agents-to-im)
