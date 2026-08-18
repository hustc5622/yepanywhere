# Feishu × Codex × Yep 体验对齐架构与验证基线

状态：协议、canonical event、interaction、runtime、session、attachment/artifact、Feishu channel 和客户端投影已有离线实现与自动化验证；真实 tenant contract、canary、consumer 切换、服务部署和浏览器/device 验证未在本文对应的代码集成过程中执行，仍需独立授权。

本文是可公开的需求、架构和验收基线，不包含真实账号、consumer、build、代理、运行日志、私人路径或现场消息。任何环境特定值都应只存在于受控变更记录中。

## 1. 核心结论

Codex app-server 的 `Thread -> Turn -> Item` 原生协议必须先进入可版本化、可重放的 canonical event spine，再分别投影到 Yep、Feishu 和 legacy SDK message。`SDKMessage` 可以继续作为兼容输出，但不能成为 Codex 信息的唯一事实来源。

目标数据流：

```text
Feishu event
  -> durable inbox
  -> bounded message/attachment normalization
  -> SessionCommandService
  -> Codex native connection
  -> canonical event store + reducer
       ├── InteractionBroker
       ├── Yep typed renderer
       ├── Feishu CardKit/plain projection
       └── legacy SDKMessage projection
```

“体验对齐”指对齐上游正式提供给客户端的 user-visible item、notification、reasoning summary、commentary、工具活动和交互请求；不表示发送隐藏 chain-of-thought、credential、环境变量、私人路径或未经策略允许的 tool input。

## 2. 协议基线

当前 checked-in baseline 对应 Codex CLI `0.147.0`：

| Profile | Schema hash | 用途 |
| --- | --- | --- |
| stable | `sha256:3539e05467a752e6d8575b293b149e4fe6d6ffd3550d649baf8e43187907c681` | 默认 event contract |
| experimental | `sha256:e46a86223fe756a8d93a7acb1a0a8a6371381b6d0d11c41dbda5a978637865a3` | provider 明确 gate 的实验能力 |

coverage registry 固定覆盖：11 个 server requests、72 个 server notifications、18 个 thread items 和 7 个 user inputs。generator、manifest、schema 和 generated TypeScript 属于同一机械基线；不得手工修改 generated output。

```bash
corepack pnpm codex:protocol:check
corepack pnpm codex:protocol:test
```

baseline 表示 wire schema 可见性，不表示每个实验 capability 都已对外开放。runtime 只能声明实际实现并有安全 fallback 的 capability；未知方法进入有界、fingerprint-only diagnostics，不能静默吞掉，也不能把 raw method/payload 暴露到版本 API。

## 3. 完整性定义

| 层级 | 要求 |
| --- | --- |
| 身份完整性 | 保留 thread/turn/item/request/client-message 关联；Feishu 侧保留 account/scope/message relation 的私有 canonical identity |
| 结构完整性 | 保留富文本顺序、引用/话题/转发关系、附件 ownership、MIME、大小、hash 和截断原因 |
| 内容可用性 | image/audio 使用目标 runtime 支持的原生输入；其他文件提供受控原件、提取 manifest 和索引 |
| 回放完整性 | live、refresh 和 restart replay 得到同一 canonical state，不重复外部副作用 |
| 决策完整性 | approval/question 保留 provider 原生 decision、scope、request identity 和一次性 resolution |
| 展示完整性 | Yep/Feishu 视觉密度可不同，但状态、错误、等待原因和终态不能矛盾 |

## 4. Canonical event spine

事件 envelope 至少包含：schema version、provider、session/thread/turn/item/request identity、method、direction、phase、provider/local timestamps、session-local sequence、safe payload、protocol identity 和 replay provenance。

核心约束：

1. store-before-forward/project/respond；journal 写入失败时 fail closed；
2. sequence 是 session-local 单调值，不能用时间戳代替；
3. live reduce 和全量 replay 深度相等；
4. delta 可先于 snapshot 到达，completed snapshot 是终态权威；
5. completed 后迟到 delta 只记录 anomaly，不回退状态；
6. unknown event 保留安全分类和指标，不进入裸 `default: return []`；
7. replay 不再次执行 CardKit、provider response 或其他外部 effect；
8. redaction 在持久化和投影前执行，raw provider payload 不进入普通 WebSocket/API。

Turn 状态机：

```text
accepted -> queued -> in_progress
                        ├── waiting_user -> in_progress
                        ├── completed
                        ├── interrupted
                        └── failed

accepted/queued -> failed
```

这保证在 user echo 或 `turn/started` 之前发生的 non-retryable error/process exit 仍有明确 owner，并能结束外部任务卡。terminal 默认不可逆；restart/retry 必须使用新 generation。

## 5. Error 与 diagnostics

Canonical error 使用稳定类别，而不是外发 raw stack：

| 类别 | 示例 | 默认动作 |
| --- | --- | --- |
| `protocol` | schema/capability 不兼容 | fail closed，提示升级 |
| `overloaded` | app-server `-32001` | 有界退避和 jitter |
| `thread_not_found` | 不可恢复的空/旧 thread | 只在严格 provenance 条件下 replacement |
| `auth` / `rate_limit` | 登录或额度阻塞 | 引导到受控 Yep 页面 |
| `permission` | sandbox/policy denied | 等待明确用户决策 |
| `attachment` | 下载、校验、提取或超限 | 显示固定阶段码 |
| `tool` | command/MCP/dynamic tool failure | 显示安全摘要 |
| `process_exit` | provider 非预期退出 | 终结 turn 和 open interaction |
| `cancelled` | 用户 interrupt | 终结当前 generation |
| `internal` | 未分类实现错误 | correlation fingerprint + Yep 详情 |

`GET /api/version` 暴露固定 protocol identity、进程期 unknown 计数和单向 fingerprint bucket。它不返回 raw method、runtime spoofed value、payload 或私人路径。fork/dev release channel 继续不访问 upstream update server。

## 6. Interaction authority

`InteractionBroker` 是 command/file/permission/MCP approval、question 和其他宿主请求的唯一 durable CAS authority。

```text
open -> answering -> resolved
  ├── expired
  ├── cancelled
  └── failed / uncertain
```

要求：

- UI 提交 `operationId + version + actor + decisionId`；
- 只有 open/current version/authorized actor 可以 claim；
- provider callback 最多调用一次；
- provider 已接受但本地确认前崩溃时标记 uncertain，禁止自动重放；
- `serverRequest/resolved`、turn interrupt、process exit 和 timeout 关闭所有表面上的旧操作；
- question 支持单选、多选、自由文本、secret 和多题校验；没有 resolution 时不能自动发送空 answers；
- command/file/permission/MCP 响应保留原生 decision 与 scope，UI 只显示 server 明确允许的选项；
- secret answer、feedback、private payload 和 provider callback 不进入 durable projection。

Feishu operation store 只负责 card projection/idempotency；不能形成第二套 decision authority。

## 7. Session、Skills 与分支

`SessionCommandService` 统一 start/create/resume/queue/send/interrupt/native controls，HTTP route 只做认证、输入解析和结果映射。它保留 provider resolution、Codex thread-level MCP config、permission live-state/metadata fallback、model、executor 和 immediate-admission 语义。

Skills 使用结构化 `UserInput::Skill`；公开 history 只显示 bounded name/description，`SKILL.md` path 只在 provider 信任边界内使用。伪造、控制字符和测试允许根之外的路径 fail closed。

历史编辑必须 source-preserving：

1. 从 canonical transcript 选择 user input；
2. 恢复 text/image/audio/skill/mention 结构；
3. 使用 app-server `thread/fork` 建立新 thread；
4. 持久化 parent/child/fork boundary provenance；
5. 原 thread/rollout 不 rollback、不截断、不覆盖；
6. app-server 不支持精确 boundary 时显式 blocked/fallback，不伪装等价；
7. client 只导航到 server 返回且 lineage 可验证的新 session。

## 8. Feishu 入站模型

私有 canonical message 保存 account/scope、event/message relation、sender fingerprint、时间、message type、ordered body、attachment manifest 和 normalization warning。公开 session metadata 只保存 channel origin 和非敏感 rollout key，不保存 tenant/chat/user 映射。

Normalizer 具备有界预算：普通/引用/话题/`merge_forward` 都有 item、depth、字符和 resource 上限；循环、超限、未知类型和缺失权限产生 typed warning/failure。当前默认不静默读取普通群的完整历史；context 范围必须由消息关系或显式产品策略决定。

Transport 只有显式启动 enabled account 才创建 SDK client/long connection。无配置 profile 完全 inert。event 处理顺序为 policy → durable inbox → normalize/media → per-scope scheduler → `SessionCommandService`；binding receipt 先于 dispatched/completed marker，未知恢复窗口 fail closed。

## 9. Attachment 与 generated artifact

所有外部 bytes 先进入权限为 `0700/0600` 的 managed upload，再执行：

```text
authorize -> bounded download -> size/hash -> MIME/container validation
  -> archive/path/symlink checks -> immutable storage -> extraction/native input
  -> task-scoped retention
```

支持 PDF、DOCX、XLSX、PPTX、ZIP 和视频的有界提取；ZIP 校验 central/local header、CRC、重叠区间、路径、symlink 和压缩炸弹限制。失败必须指出阶段，不能统一成“文件处理失败”。

Generated artifact 只接受 live、exact、completed canonical `fileChange`/`imageGeneration`，并绑定 event/thread/turn/task/workspace grant。materialization 使用 no-follow 和 inode/device/size/hash 二次校验，拒绝路径逃逸、link、敏感文件、archive、类型/大小/数量超限和读取竞态。download route 重新核验 registry、journal、expiry 和 digest；普通 upload 不能冒充 generated artifact。

公开 event、history 和 card 只含 opaque managed reference、安全 diff/metadata 或图片占位，不含源绝对路径、data URI 或 secret-shaped content。

## 10. Feishu 输出与可靠性

投影支持 `compact`、`rich` 和 `plain` 三种密度；它们共享 canonical state 和 redaction policy。

Root task projection 包含：单调状态、项目/模型安全摘要、context/attachment warning、plan、有限过程、interaction、change/artifact 摘要和 final answer。高频 delta 合并；status/error/interaction/final 立即 flush；相同 render hash 不重复更新。

Outbound intent 和 outbox 实施 sequence/idempotency、bounded payload、retry 和 terminal 优先级。CardKit 失败降级 plain，不创建第二个 turn。topic mode 无法确认时 fail closed，不把回复误发到主群。generated media 上传前重新验证 size、MIME 和 digest；durable state 只保存 opaque remote key。

Card action 必须验证 account/scope/message/operation/actor/generation。旧 turn、旧 binding、重复、越权或过期 action 只返回 resolved/expired，不触发 provider。

## 11. Yep 客户端投影

Shared render model 使用 typed/native item，覆盖：assistant/commentary、reasoning summary、plan、tool、command、file diff、MCP、web、image、interaction、collaboration/subagent、artifact、warning/error 和 unknown fallback。

要求：

- persisted/live 使用同一 reducer/selector；
- unknown kind 在生产显示安全 fallback，在开发/coverage guard 中可见；
- plan 在主时间线可见，不只存在于 inspector；
- reasoning summary 与 raw reasoning 分层，raw 默认不展示；
- subagent navigation 只对 manifest 可验证的 descendant 开启；
- fork banner 只接受 server 提供的 opaque locator；
- transcript export 经过 session authentication、`no-store` 和 redaction；
- Feishu secret 保持 blank/write-only；保存新 secret 时按 disabled-config → secret → enable 顺序；
- 所有用户文案同步 `en` 和 `zh-CN`，不新增其他 locale。

## 12. 实现状态矩阵

| 能力域 | 当前代码状态 | 仍需外部证据 |
| --- | --- | --- |
| 0.147.0 schema/manifest/coverage | 已实现，确定性 check/test | 新 Codex 版本升级时重生成和审计 |
| canonical event/store/replay/diagnostics | 已实现，shadow/primary 有显式 rollout | 生产 retention/capacity 策略 |
| InteractionBroker | 已实现，CAS/at-most-once/fail-closed | 真实多客户端时序观察 |
| runtime lifecycle | 已实现 admission、restart、interrupt、terminal replay | 已授权的进程恢复演练 |
| session command/fork/lineage/export | 已实现 | 多版本 app-server fork capability contract |
| attachment/artifact | 已实现有界 parser/materializer/download | parser 依赖持续 CVE/性能审计 |
| Feishu core | 已实现 config/secret/binding/inbox/policy/transport | 目标 tenant scope/事件 contract |
| Feishu output/commands/callbacks | 已实现 CardKit/outbox/reply/runtime | 平台 QPS、卡片大小和 upload 限制 |
| client typed experience | 已实现 renderer/Skills/subagent/fork/export/settings | browser/viewport 手工或自动验证需授权 |
| edit/recall/reaction | recall/reaction transport 有受限处理 | 目标平台 mutation payload/产品语义 |
| 普通群历史范围 | 默认最小上下文 | 产品决策和平台 API contract |
| realtime audio、MCP HTML UI、raw reasoning | 默认关闭/不外发 | 独立 threat model 与产品决策 |
| 真实 consumer 迁移 | 未执行 | 单消费者 canary、观察与回滚签字 |

“已实现”表示代码和离线自动化存在，不表示已经部署或通过真实 tenant canary。

## 13. 验证策略

| 层级 | 内容 | 外部依赖 |
| --- | --- | --- |
| Unit | reducer、policy、MIME、decision、renderer selector | 无 |
| Schema contract | generated schema、manifest、exhaustiveness | 固定产物 |
| Component | broker、CardKit builder、React component | fake/mock |
| Integration | fake app-server → runtime → channel fake API | ephemeral loopback |
| Replay/golden | 脱敏 event/message/card fixture | 无 |
| External contract | scopes、download、CardKit、upload | 真实测试应用，需授权 |
| Browser/device | responsive UI、mobile shell、APK | 需明确授权 |
| Canary | consumer/routing/恢复观察 | 真实账号和变更窗口 |

默认门禁：

```bash
corepack pnpm codex:protocol:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm -r test
```

Golden fixture 必须使用 synthetic identity，保留顺序和关联形状但移除消息内容、token、tenant/user/chat/session ID 和私人路径。snapshot 变化要解释语义，不能无审查批量接受。

## 14. SLO 与可观测性原则

每个任务分别记录 event received、inbox persisted、dispatch、app-server request、turn started、first user-visible event、waiting user、terminal 和 final projection 时间。指标 label 只能使用低基数 enum/fingerprint；prompt、filename、用户文本、token、完整路径和 raw ID 禁止进入 label。

Stuck detector 按阶段判断：accepted 未 dispatch、dispatch 未获得 turn、in-progress 无事件、waiting-user 无 open operation、terminal 后 card 未 terminal、process exit 后 turn 未 terminal。检测器只能安全恢复投影或告警，不能自动批准、重启服务或新建重复 turn。

## 15. 迁移与 Definition of Done

真实 rollout 按 account 逐项进行，保持单消费者不变量。完整步骤、两类主机兼容门禁和 code/runtime/durable-state 回滚见 [Feishu/Lark 渠道迁移与回滚 Runbook](./feishu-migration-runbook.md)。

体验对齐只有在以下条件全部满足后才能标记完成：

- protocol coverage 与 unknown fallback 持续通过；
- live/replay/persisted projection 语义一致；
- 所有 open interaction 有唯一 authority 和 terminal cleanup；
- source-preserving fork、Skills structured input 和安全 export 可用；
- default profile 无 channel side effect；fake-enabled profile 不访问真实 tenant；
- 真实平台 contract、canary、观察窗口和恢复演练获得授权并通过；
- code、runtime、config、consumer routing 和 durable-state rollback 均有验证证据；
- 未完成项使用 blocked/deferred-with-reason，不能静默省略。

## 16. 关键源码索引

- Codex app-server reference（审计环境提供本地快照时）：`references/codex/codex-rs/app-server*`
- Codex CLI/TUI reference（审计环境提供本地快照时）：`references/codex/codex-rs/cli`、`references/codex/codex-rs/tui`
- Generated protocol：`packages/server/src/sdk/providers/codex-protocol/`
- Canonical spine：`packages/server/src/codex-events/`
- Codex bridge/provider：`packages/server/src/codex-bridge/`、`packages/server/src/sdk/providers/codex*`
- Session application layer：`packages/server/src/services/SessionCommandService.ts`、`packages/server/src/routes/sessions.ts`
- Attachment/artifact：`packages/server/src/uploads/`、相关 session routes/provider adapter
- Feishu channel：`packages/server/src/channels/feishu/`
- Shared contracts：`packages/shared/src/`
- Client Codex/Feishu surfaces：`packages/client/src/components/`、`packages/client/src/lib/codex*`

涉及 Codex 协议行为时，先读取仓库内固定 reference，再以目标 runtime generated schema 和 tests 为准；reference 只作只读语义来源，不作为 merge base。
