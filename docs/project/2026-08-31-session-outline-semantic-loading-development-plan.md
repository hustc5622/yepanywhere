# Session Outline、语义化加载与行为验证开发计划

> 日期：2026-08-31<br>
> 状态：**已废弃（2026-09-01）**，仅保留为历史分析材料，不再作为设计或实施依据<br>
> 适用范围：Yep Anywhere Web/PWA、Hono session API、所有已支持 provider<br>
> 关联文档：
> - [Session 切换加载性能与内容缓存方案](./2026-08-13-session-switching-performance-plan.md)
> - [Codex Session 列表与切换性能开发计划](./2026-08-22-codex-session-switching-performance-development-plan.md)
> - [Codex Session 切换轻量化后续优化](./2026-08-22-codex-session-switching-lightweight-followups.md)
> - [Yep Anywhere 性能瓶颈审计](./2026-08-24-performance-bottleneck-audit.md)

> [!CAUTION]
> 本文档把 session 展示加载、用户问题目录、全文搜索索引、工具详情懒加载、成果展示、产品埋点和
> Overview 实验合并成了一项计划，问题边界过大，实施路径也产生了不必要的耦合。后续工作将按独立问题
> 拆分为可单独评审、实现和回滚的文档；第一份替代文档为
> [Session 展示语义压缩与工具详情按需加载方案](./2026-09-01-session-display-compression-and-lazy-tool-details-plan.md)，
> 不改变 Codex、Pi、Kimi 等 provider 的原始 session 文件、上下文或模型请求流程。

## 0. 执行摘要

当前 Session 页面以 provider transcript 的消息顺序为主模型：客户端首次请求最近的有界消息窗口，
继续向上滚动时按 cursor 加载旧消息；右侧 Inspector 再从当前已加载的 `messages` 中推导用户问题、
文件、检查、Plan、Goal 和子代理。

这种实现已经解决了“不要一次渲染整个长 transcript”的性能问题，但没有解决“用户进入 session 时最先
需要理解什么”的产品问题。当前主要缺口如下：

1. 用户问题虽然在部分 provider 的 `SessionSummary.userQuestions` 中有摘要缓存，但并非所有历史源都
   提供，且没有完整性标记；Codex app-server 和 ZCode 是明确缺口。
2. 工具调用在 UI 中大多是折叠的，但完整 input/result 通常已经随消息页传输、解析并进入客户端内存；
   这是视觉折叠，不是真正的详情懒加载。
3. 原始消息分页可能切开 user turn 或 `tool_use` / `tool_result`，导致窗口内的临时状态不完整。
4. 现有右侧计数看起来像“全 session 统计”，实际经常只是“当前消息窗口统计”。
5. 当前没有独立的产品行为事件系统，无法用真实数据验证用户主要在看问题、回复、产物还是工具详情。

本计划的核心决策是：

> **用户问题是 session 的目录；agent 的人类可读回复是正文；生成物和文件变更是成果；成功工具调用是
> 默认折叠的证据；完整 tool input/result 和 provider event 是按需加载的审计详情。**

目标不是删除完整 transcript，而是把 Web 默认视图从 transcript-first 改造成 overview-first，并保留
Trace 视图满足调试、审计和兼容需求。

计划分十个里程碑实施：

1. 建立基线、术语和性能样本；
2. 建立本地优先、无正文的产品行为埋点；
3. 统一用户问题索引及完整性语义；
4. 建立可重建的 Session Outline 索引；
5. 完成各 provider 的 Outline projector；
6. 提供 Outline、可读 turn 和 item detail API；
7. 上线 Web Overview 与新的 Session Inspector；
8. 把 tool summary/detail 从视觉折叠升级为真正的载荷分层；
9. 接入生成物、文件变更与验证结果；
10. 完成实验评估、默认切换并逐步收敛旧逻辑。

任何阶段都不得要求替换 provider 的权威 session 存储，也不得建立第二份完整 raw transcript。

---

## 1. 目标、非目标与成功定义

### 1.1 产品目标

用户打开一个任意长度的 session 后，应能快速回答以下问题：

1. 我之前向 agent 提出了哪些问题？
2. agent 当前在做什么，是否需要我处理审批、问题或错误？
3. agent 已经给出了哪些人类可读的进展和最终回复？
4. agent 生成、修改或引用了哪些重要产物？
5. 如果需要审计，某一步具体调用了什么工具、输入和结果是什么？

这些问题必须按优先级逐层回答，而不是要求用户先加载完整 transcript。

### 1.2 工程目标

- 所有 provider 对外暴露统一的 `SessionOutline` 语义。
- 用户问题可在不加载工具结果的前提下发现、分页、搜索和定位。
- 首屏不再因为一个巨大 tool result 而携带整个结果正文。
- 最近/当前 turn 可读内容优先加载；旧 turn 按语义单元加载。
- item 详情使用稳定、受 revision 约束的引用按需获取。
- Outline 是可重建缓存，不成为新的权威数据源。
- 任何“不完整”都必须显式返回 `coverage`，不允许用 `0` 或缺省值伪装完整。
- 保留现有完整 transcript 和 provider-native history 的可达性。

### 1.3 非目标

本计划不做以下事情：

- 不把 provider 的 JSONL、JSON、SQLite 或 app-server 数据迁移到 Yep 自有 canonical 数据库。
- 不复制和长期保存完整 tool output、raw reasoning 或 provider event。
- 不在第一阶段实现 AI 自动总结所有历史内容；首版摘要应尽量使用确定性投影。
- 不删除现有 Session Search、history pagination、branch/rollback/edit 能力。
- 不把行为埋点默认上传到第三方或 Yep 官方服务器。
- 不为了统一接口而破坏 provider 的稳定身份、分支或 cursor 语义。
- 不在没有用户明确授权的情况下使用浏览器自动化或重启现有服务做验证。

### 1.4 最终成功标准

以下条件全部满足，才能认为本计划完成：

- 用户进入长 session 后，无需加载旧 transcript，即可看到最新问题、当前状态、最新回复和完整问题目录的
  可达入口。
- 任意历史用户问题都能通过 Outline/Search 直接定位，不能要求盲目连续点击“Load older messages”。
- 成功的 Read/Grep/Search/Skill/Wait 等工具默认只传摘要；点击后才获取完整详情。
- 审批、AskUserQuestion、错误、重试、危险文件变更不会因为摘要化而被隐藏。
- 现有 branch、rollback、session edit、search deep-link、subagent 和 live streaming 行为无回归。
- 代表性长 session 的默认首屏压缩后响应体积相比基线至少下降 50%，或达到评审时确定的更严格预算。
- 行为数据可以回答“用户看什么、展开什么、为什么加载旧历史”，且事件中不包含 prompt、回复、命令、
  路径或 tool output 正文。

---

## 2. 已验证的现状基线

### 2.1 权威存储仍属于 provider

各 provider 的权威存储不同：

| Provider | 权威存储形态 | 当前 reader 入口 |
| --- | --- | --- |
| Claude Code | 项目目录下 JSONL，包含 DAG/branch | `packages/server/src/sessions/reader.ts` |
| Codex / Codex OSS | rollout JSONL；可选 app-server paginated history | `codex-reader.ts`、`codex-history/` |
| Gemini | `session-*.json`，线性 `messages[]` | `gemini-reader.ts` |
| Pi | session JSONL/tree | `pi-reader.ts` |
| Kimi | `state.json` + `agents/main/wire.jsonl` | `kimi-reader.ts` |
| ZCode | `~/.zcode/cli/db/db.sqlite` 的 session/message/part 表 | `zcode-reader.ts` |

Yep 当前只做读取、normalize、投影和附加 metadata。这个边界应继续保留。

### 2.2 已有 Session summary 索引

`SessionIndexService` 会把每个 session 的轻量 summary 持久化到 Yep 数据目录，使用 mtime/size 与
FileWatcher 事件做失效。缓存字段已经包含：

- title / fullTitle；
- createdAt / updatedAt；
- messageCount；
- `userQuestions?`；
- context/cumulative usage；
- compact 信息；
- provider/model/reasoning effort；
- 最近错误、终态和 fork parent。

这证明项目已经接受“provider 是权威源、Yep 保存可重建索引”的架构。但当前 `userQuestions` 只是
summary 的一个可选数组，不是 provider-independent 的强保证。

### 2.3 用户问题索引的现状

`SessionQuestion` 当前包含 `id/text/timestamp`，文本会压缩到约 140 字。其目标本来就是让历史问题在
消息窗口分页后仍能出现在 outline UI。

现有覆盖：

- Claude/Gemini/Pi/Kimi 的 summary reader 会从完整或 active branch 数据中提取问题。
- Codex rollout summary scan 会跨文件扫描问题，并使用 entry byte offset 形成稳定 anchor；默认最多保留
  2048 个 summary item。
- Codex app-server `threadSummary()` 不提供 `userQuestions`。
- ZCode `buildSummary()` 不查询 message/part，因此不提供 `userQuestions`。
- 当前 DTO 没有 `complete/partial/stale` 标记，客户端无法知道缺失是“没有问题”还是“没有索引”。

### 2.4 已有自然语言内容索引

`SessionContentIndexService` 会懒构建 user/assistant 文本索引，用于全局和 session 内搜索：

- 每条索引保存 message ID、role、原始文本和 lowercase 文本；
- 每条文本最多 2000 字；
- thinking、tool input、tool result 被主动排除；
- 索引存储为 JSON，查询仍是内存数组遍历，不是 FTS；
- 首次搜索会为变化的 session 重新读取/normalize；
- 正常 Codex rollout reader 未传 `maxMessages` 时默认读取最近 100 条，存在内容索引不完整风险。

该服务可以继续服务全文搜索，但不应直接承担新的 Outline 索引：两者的数据形状、更新频率和完整性要求
不同。

### 2.5 当前 transcript 加载

客户端初始请求：

```text
view=canonical
tailCompactions=2
maxMessages=100
branchId=<optional>
```

旧历史请求使用 `beforeMessageId`；目标跳转使用 `aroundMessageId`；中间窗口向后浏览使用
`afterWindowMessageId`。客户端会把旧消息 prepend 到现有 `messages`。

长列表超过 80 个 row 时使用 `@tanstack/react-virtual`，因此 DOM 挂载已有上界；但分页和虚拟化不能
降低进入消息页之前的 tool result 传输、JSON parse 和 preprocess 成本。

### 2.6 当前 tool result 只是视觉折叠

`ToolCallRow` 已经支持：

- 标题、状态、摘要；
- 默认折叠；
- Edit/TodoWrite 默认展开；
- renderer-specific collapsed preview；
- live command output 最后 12 行；
- 点击后 modal 或 expanded content。

但工具完整 input/result 通常已存在于 `Message[]` 和 `ToolCallItem`：

- Claude normalization 会 pass through content block 的所有字段；
- `preprocessMessages()` 会扫描当前所有消息，并通过 `tool_use_id` 关联完整结果；
- tool summary 本身可能读取 structured result 或完整 result 文本；
- collapsed preview 也可能解析完整结果。

因此当前是“先加载全部详情，再选择不显示”，不是“先加载摘要，按需获取详情”。

### 2.7 当前已有语义收敛的先例

项目中已有以下可复用经验：

- 同一 user turn 内的 Plan/Todo 多次快照折叠成最新状态；
- 连续 Codex wait/poll 折叠成一个记录；
- Subagent 内容支持独立加载；
- 飞书富卡把内容拆成 `status/progress/tools/artifacts/answer` 五个区域，并对工具、commentary、
  reasoning、diff 和 artifact 设置有界数量。

这些行为说明“状态投影优先、原始事件退居详情”已经在局部功能验证过，可以上升为 Web 的统一模型。

### 2.8 当前行为观测不足

现有 `ClientLogCollector` 仅在 Developer Mode remote logging 打开时抓取 console、异常和连接状态，并把
日志写入 `logs/client-logs/*.jsonl`。它没有 typed product event，也没有 viewport exposure、工具展开、
Outline 点击、历史加载原因等信息。

因此在改变默认信息架构前，必须先建立无正文、可聚合的行为观测。

---

## 3. 用户注意力假设与产品原则

### 3.1 注意力优先级

默认优先级不是固定 transcript 顺序，而是下面的动态层级：

| 优先级 | 内容 | 例子 | 默认策略 |
| --- | --- | --- | --- |
| P0 | 需要用户行动或存在风险 | Approval、AskUserQuestion、失败、重试、删除/覆盖 | 始终可见、置顶提示 |
| P1 | 用户意图和当前目标 | 用户 prompt、Goal、当前 turn | Session 目录骨架 |
| P2 | Agent 人类可读输出 | commentary、progress、final answer | 当前 turn 完整、历史摘要 |
| P3 | 任务成果和验证证据 | 生成文档、图片、diff、测试结论 | 独立区域、直接可打开 |
| P4 | 成功操作步骤 | Read、Grep、Search、Skill、Wait | 一行摘要、详情懒加载 |
| P5 | 原始审计信息 | 完整 tool input/result、reasoning、provider event | Trace/详情模式 |

### 3.2 必须区分输入上下文与输出产物

- Skill instructions、AGENTS.md、被 Read 的参考文档是 agent 消费的上下文，通常放在“过程/证据”。
- Agent 新生成或修改的 Markdown、代码、图片、报告和 spreadsheet 是输出产物，应放在“成果”。
- 测试、lint、typecheck 的最终结论是验证证据，应比普通 Bash 操作更显眼。
- Edit/Write/Patch 的文件和 diff 摘要具有审核价值，不能按普通成功工具完全隐藏。

### 3.3 活跃 session 与历史 session 的展示不同

活跃 session：

- 当前状态、pending action、最新 commentary 和正在运行的工具优先；
- running tool 可以展示有界 live tail；
- completed tool 立即收敛成摘要；
- final answer 到达后提升到当前 turn 主体。

历史 session：

- 首先展示问题目录、最终回复和产物；
- commentary 默认收起为 checkpoint；
- 工具按 turn 聚合，失败/危险变更单独标记；
- raw trace 只有用户主动进入时才加载。

### 3.4 不允许静默丢失

摘要化不等于删除。任何详情必须满足：

- 有稳定 item/message/turn 身份；
- 有明确的 `hasDetail` 和 detail endpoint；
- detail 不可用时显示原因，而不是空白；
- source revision 变化后拒绝使用旧引用，返回可恢复错误；
- Trace 模式仍能访问 provider 支持的完整历史。

---

## 4. 目标用户体验

### 4.1 默认 Overview 结构

建议 Session 页面默认分为：

```text
Header
├── session title / provider / model
├── running / waiting / failed / completed
└── pending action（如有）

Current turn
├── 当前用户问题（完整或较长 preview）
├── 当前 Goal / Plan
├── 最新 progress/commentary checkpoints
├── final answer（如有）
├── artifacts / changed files / checks
└── tools summary（默认折叠）

Previous turns
├── 用户问题 preview
├── turn status / timestamp
├── final answer preview
├── artifact/file/check badges
└── tool/error counts

Trace
└── 当前完整 transcript 分页视图
```

### 4.2 问题目录

右侧 Inspector 的 Questions 改为读取 Outline turn/question index，不再依赖当前 `messages`：

- 显示总问题数和 coverage；
- 支持 question-only cursor，不携带工具结果；
- 点击问题时优先打开对应 turn；需要 raw transcript 时复用 `aroundMessageId`；
- 历史问题未加载到 transcript 不影响目录展示；
- branch 切换后只展示 selected/active branch 的问题，或明确展示 branch scope。

验收定义是“所有问题可发现、可定位”，而不是强制一次响应返回无限数量的问题。极端 session 可以对
question index 单独分页，但这个分页必须轻量，不能要求加载 transcript。

### 4.3 人类可读回复

- 当前 turn 的 user prompt、commentary 和 final answer 作为一个语义 envelope 加载。
- Codex `commentary/final_answer` phase 应保留。
- 没有 phase 的 provider 继续使用确定性规则区分 question prelude/progress 和 turn answer。
- 历史 turn 默认展示 final answer preview，点击后加载 readable turn 全文。
- Copy、file link、artifact link 和 Markdown 渲染继续工作。

### 4.4 工具摘要

工具摘要必须是 server/provider-neutral 数据，不再要求客户端拿到完整 result 才能生成。

| 类别 | 首屏/Outline 数据 | 点击后详情 |
| --- | --- | --- |
| Approval/Question | 类型、标题、状态、必要选项元数据 | 完整交互由现有 broker 提供 |
| Read/Glob/Grep/Search/Fetch | 名称、目标安全摘要、数量、状态 | 完整输入/结果 |
| Skill/Instructions | skill 名、加载状态 | 完整 instructions |
| Bash/Command/Check | 命令安全摘要、exit、行数、状态；running 时 tail | 完整 command/output |
| Edit/Write/Patch | 文件安全摘要、变更数、diff stats、状态 | 完整 input/diff/result |
| Agent/Subagent | 描述、profile、状态、耗时/工具数/token stats | child transcript |
| Image/Generated file | artifact manifest、类型、大小、状态 | preview/download |
| Unknown/MCP | server/tool 名、状态、schema-safe 摘要 | redacted raw detail |

失败、拒绝、aborted、pending 的工具不可只显示一个无信息的 “done”。

### 4.5 Trace 模式

Trace 继续使用现有 `MessageList`、pagination、virtualization 和 provider renderer：

- 保留 Load older/newer；
- 保留搜索定位；
- 保留 branch/edit/fork；
- 保留完整 tool renderer；
- 对已实施 lazy detail 的 item，Trace 展开时调用 detail endpoint；
- feature flag 关闭时可以完全退回现有行为。

---

## 5. 目标数据模型

以下为建议的共享类型方向。实际实现使用 Zod 作为事实来源，并同步生成/导出 TypeScript 类型。

### 5.1 Coverage 与 revision

```ts
type OutlineCoverage =
  | { state: "complete" }
  | { state: "partial"; reason: string; through?: string }
  | { state: "stale"; indexedRevision: string; currentRevision: string }
  | { state: "unavailable"; reason: string };

interface OutlineRevision {
  value: string;
  source: "file" | "provider" | "database" | "bridge";
}
```

规则：

- `complete` 必须表示 selected branch 的所有可见 turn 已投影。
- provider 只能提供当前 page 时必须返回 `partial`。
- 文件/database 已变化但索引尚未重建时返回 `stale`，不能冒充 complete。
- 不支持时返回 `unavailable`，客户端退回 Trace。

### 5.2 SessionOutline

```ts
interface SessionOutline {
  schemaVersion: 1;
  projectId: string;
  sessionId: string;
  provider: ProviderName;
  branchId?: string;
  revision: OutlineRevision;
  coverage: OutlineCoverage;

  status: {
    activity?: AgentActivity;
    lastTurnStatus?: SessionLastTurnStatus;
    pendingInputType?: PendingInputType;
    errorCode?: string;
  };

  counts: {
    turns?: number;
    questions?: number;
    toolCalls?: number;
    errors?: number;
    artifacts?: number;
    changedFiles?: number;
  };

  currentGoal?: GoalSummary;
  latestTurnId?: string;
  turns: TurnOutline[];
  nextTurnCursor?: string;
}
```

`counts.*` 只有完整或 provider 能权威给出时才返回。未知值省略，不用 `0`。

### 5.3 TurnOutline

```ts
interface TurnOutline {
  id: string;
  index?: number;
  status: "running" | "waiting" | "completed" | "failed" | "interrupted";
  startedAt?: string;
  completedAt?: string;

  question: {
    messageId: string;
    preview: string;
    hasMore: boolean;
    timestamp?: string;
    attachmentKinds?: string[];
  };

  response: {
    commentaryCount: number;
    latestCommentaryPreview?: string;
    finalMessageId?: string;
    finalPreview?: string;
    hasReadableDetail: boolean;
  };

  summary: {
    toolCallCount: number;
    runningToolCount: number;
    failedToolCount: number;
    changedFileCount: number;
    checkCount: number;
    artifactCount: number;
    subagentCount: number;
  };

  importantItems: OutlineItemSummary[];
  hasReadableDetail: boolean;
}
```

`importantItems` 只包含 P0/P3 内容，例如错误、审批、重要 diff、check 结果和 artifact。普通成功 Read/Grep
不需要全部进入 session-level outline；它们在 readable turn 中以 summary list 返回。

### 5.4 ToolSummary 与 detailRef

```ts
interface ToolSummary {
  id: string;
  turnId?: string;
  category:
    | "approval"
    | "question"
    | "read"
    | "search"
    | "command"
    | "check"
    | "change"
    | "skill"
    | "subagent"
    | "artifact"
    | "mcp"
    | "other";
  name: string;
  title: string;
  status: "pending" | "running" | "complete" | "error" | "aborted";
  stats?: Record<string, number | string | boolean>;
  risk?: "normal" | "review" | "action_required";
  hasDetail: boolean;
  detailRef?: string;
}
```

`detailRef` 要求：

- 对客户端是 opaque string；
- 不暴露绝对路径、SQLite rowid、原始 provider cursor 或 secret；
- 服务端内部绑定 project/session/provider/branch/revision/item identity；
- revision 不一致时返回 `SESSION_DETAIL_REF_STALE`（409）；
- 不允许一个 session 的 ref 读取另一个 session 的内容。

### 5.5 ReadableTurn

```ts
interface ReadableTurn {
  outline: TurnOutline;
  question: PublicUserContent;
  commentary: ReadableMessage[];
  finalAnswer?: ReadableMessage;
  tools: ToolSummary[];
  artifacts: GeneratedArtifactManifest[];
  fileChanges: FileChangeSummary[];
  checks: CheckSummary[];
}
```

ReadableTurn 不包含：

- raw reasoning；
- 完整 tool input/result；
- 大型 command output；
- 完整 Read 文件正文；
- provider-private payload。

---

## 6. Outline 索引与存储设计

### 6.1 新建独立、可重建的 Outline 索引

建议新增 `SessionOutlineIndexService`，而不是继续扩大单个 `SessionIndexService` JSON：

```text
<YEP_ANYWHERE_DATA_DIR>/indexes/outlines/
└── <provider-scope-hash>/
    └── <session-id-hash>.json
```

选择 per-session 文件的原因：

- 一个活跃 session 更新时不需要重写整个 project/provider 的大索引；
- 易于 mtime/size/revision 校验和单 session 失效；
- 易于设置单项大小预算；
- schema 升级时可以逐 session 懒重建；
- 不形成新的集中式 canonical transcript。

### 6.2 索引内容边界

允许持久化：

- 用户问题 preview；
- assistant commentary/final preview；
- tool name/category/title/status/stats；
- artifact manifest；
- 安全的文件相对路径摘要和 diff stats；
- message/turn/item 的稳定公共身份；
- 服务端私有的 detail locator（必须经过单独序列化和权限审计）。

禁止持久化：

- 完整 tool result/output；
- 完整 command output；
- raw reasoning；
- base64 图片/附件；
- provider token、credential 或连接配置；
- 未经投影的 provider event payload；
- 对客户端公开绝对路径。

### 6.3 构建与失效

首版构建策略：

1. 第一次请求某 session Outline 时懒构建。
2. 内存 LRU 保存最近 Outline，磁盘保存可重建投影。
3. FileWatcher 命中精确 session 时标记 dirty。
4. provider 只能标记整个 scope 时使用现有 provider scope dirty 机制。
5. 每次返回前以 reader 提供的 revision/mtime/size 做兜底校验。
6. 活跃 session 的 live message 可以先更新客户端临时 Outline；持久化文件变化后再权威 revalidate。
7. 写盘使用 temp file + rename 和现有跨进程 lock 模式。

### 6.4 增量构建

第一版允许 full rebuild，但必须先记录真实成本。满足以下任一条件后再实现增量：

- Outline 冷构建 p95 超过 300 ms；
- 单 session 文件超过 32 MiB 且每次更新重建明显影响事件循环；
- 活跃 session 每分钟触发多次重复 full rebuild；
- 行为数据表明 Outline 是高频入口。

增量方向：

- append-only JSONL：记录最后已扫描 byte offset + source revision；
- Codex rollout：复用 entry byte offset anchor；
- ZCode SQLite：使用 `time_updated/sequence` 增量查询；
- app-server：使用 provider revision/cursor，只追加新 completed items；
- Gemini JSON：文件整体替换时仍 full rebuild；
- branch/rollback/compact：强制重建受影响的 branch projection。

### 6.5 大小预算

在实现前通过 fixture 测量后固定常量。初始建议预算：

- 单个 question preview：最多 280 个可见字符；
- commentary/final preview：最多 500 个可见字符；
- tool title：最多 160 个可见字符；
- error summary：最多 240 个可见字符；
- session-level `importantItems`：默认最多 100 个，其他内容通过 turn API 获取；
- 单个持久化 Outline：软预算 4 MiB，超过后改用 turn cursor，不截断问题可达性；
- API 单页 turns：默认 100，最大 500；
- 单次 item detail：默认最大 8 MiB，超出时提供 range/download 或明确错误。

所有截断必须有 `hasMore` 或 coverage，不允许静默截断。

---

## 7. Provider projector 设计要求

### 7.1 公共接口

建议在 session reader 旁新增可选接口，而不是把所有 provider 强塞进一个 parser：

```ts
interface ISessionOutlineProjector {
  getOutline(
    sessionId: string,
    projectId: UrlProjectId,
    options: OutlineOptions,
  ): Promise<ProjectedOutline | null>;

  getReadableTurn(
    locator: TurnLocator,
    revision: string,
  ): Promise<ReadableTurn | null>;

  getItemDetail(
    locator: ItemDetailLocator,
    revision: string,
  ): Promise<ItemDetail | null>;
}
```

项目可先在 `SessionOutlineIndexService` 内适配现有 reader，稳定后再决定是否提升到正式 reader interface。

### 7.2 Claude

实施：

- 使用 `buildClaudeBranchView`/DAG active branch 结果，不能从物理文件顺序直接生成 turns。
- user prompt 使用 `uuid ?? id`，过滤 tool_result-only user message、session setup 和 synthetic prompt。
- 以用户 prompt 为 turn 边界，收集后续 assistant text/tool calls，直到下一个用户 prompt。
- tool result 通过 `tool_use_id` 关联；detail locator 指向稳定 message/block identity。
- branch 切换、rewind、fork 后 Outline revision 必须变化。

验收：

- dead branch 问题不会进入 active branch Outline；
- AskUserQuestion 的答案边界不会与普通 user prompt 重复计数；
- tool result-only message 不会变成用户问题；
- 点击问题可定位到与现有 UI 相同的 user bubble。

### 7.3 Codex rollout

实施前置：

- 必须先查看 `references/codex/codex-rs/app-server*`、CLI/TUI 和仓库现有 Codex schema，不凭印象定义
  item/turn 语义。

实施：

- 复用 `scanCodexRolloutSummary` 已收集的 response/event user questions、branch turns 和 byte anchors。
- 扩展 bounded summary facts，记录 commentary/final preview、turn status、tool category/stats 和 detail locator；
  不把完整 output 放入 summary scan。
- 继续以 `hasResponseItemUser` 决定 response/event 去重来源。
- rollback marker 路径必须使用完整 branch view 的可见 entries，不能把已回滚 turn 放进 Outline。
- `CODEX_MAX_SUMMARY_ITEMS` 到达上限时 coverage 必须变成 partial，并返回明确 reason。

验收：

- 188 MiB 级 rollout 的 Outline 构建不执行无界对象 materialization；
- response_item/event_msg 重复用户输入只出现一次；
- commentary 与 final phase 正确；
- byte offset detail ref 在 revision 未变化时稳定，变化后返回 409；
- rollback 后旧分支 Outline 不冒充 active branch。

### 7.4 Codex app-server history

实施：

- 只使用公开 app-server 协议，不读取私有数据库。
- 使用 `thread/turns/list` 和 `thread/items/list` 的真实 schema；需要新请求结构时先对参考源码和真实
  app-server 做只读探测。
- metadata 无法提供完整问题目录时，通过 paginated items 构建 Outline cache；不可把当前 page 当 complete。
- 缺失 turn metadata 但不影响 item 正文/身份时允许降级；影响正确性时 coverage partial。
- history source 从 app-server 切到 rollout 时必须显式处理 revision/source，不能复用不兼容 cursor。

验收：

- 超过 100 turns 的问题目录仍可继续分页；
- app-server cursor 翻页不会让右侧问题列表倒序、重复或丢失；
- source switch 不会把用户送回最新尾部；
- app-server 不支持的 item 显示安全摘要/unknown，而不是破坏整页 Outline。

### 7.5 Gemini

实施：

- 从完整 `messages[]` 线性构建 turns。
- Gemini user message ID 与客户端 normalized ID 保持一致。
- 文件整体变化时 full rebuild。
- tool schema 不支持稳定详情时返回 `hasDetail=false`，不伪造 ref。

验收：

- 问题数与 reader active transcript 一致；
- user/assistant 文本 search 与 Outline 定位一致；
- 大 JSON 文件构建有明确性能基线。

### 7.6 Pi

实施：

- 复用 `derivePiSession/convertPiSession` 的 active entries 和 compaction/branch 语义。
- 不把 toolResult role=user 当成用户问题。
- image/media 只保存类型和 deferred 标记，不保存 base64。
- thinking 默认不进入 readable turn，除非未来用户明确开启 Trace policy。

验收：

- deferred media Outline 不包含 data URL；
- fork/branch question 目录正确；
- tool result 详情与 Pi native toolCallId 正确关联。

### 7.7 Kimi

实施：

- 以 `wire.jsonl` 的 turn prompt/ended 和 loop/tool event 重建 turns。
- 复用已有 goal、subagent metrics 和 provisional/authoritative agent mapping 语义。
- `blobref:` 只投影安全 artifact/media 元数据。
- AgentSwarm 摘要保留 fan-out 数量和 child status，child transcript 继续独立加载。

验收：

- pending swarm 不会因目录稍晚创建而永久缺失；
- completed swarm 的所有 child 都可从 Outline 到达；
- Kimi ACP compatibility title 不影响 question preview。

### 7.8 ZCode

实施前置：

- 协议事实以 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` 和真实 SQLite schema 为准。
- 若修改 app-server 请求 params，必须遵守 strict schema 并先做临时只读探测。
- 不替用户安装 ZCode hook plugin。

实施：

- summary 问题目录通过 message + text part 查询构建，不依赖 session title。
- 使用 message/part sequence 和 time 维持顺序。
- tool part 的 state input/output 只在 detail endpoint 读取；Outline 只保留 name/status/stats。
- snapshot/patch/file/timeline 等 metadata-only part 先定义确定性摘要策略；无法确认则 partial/unknown。

验收：

- 真实 DB fixture 中所有 user text message 都能进入问题目录；
- tool output 不进入 Outline 持久化文件；
- sequence 相同/缺失时沿用现有稳定排序；
- read-only smoke 通过；任何会发起模型请求或写诊断 session 的 smoke 必须另行取得用户授权。

---

## 8. API 设计

### 8.1 Session Outline

```http
GET /api/projects/:projectId/sessions/:sessionId/outline
  ?branchId=<optional>
  &turnCursor=<optional>
  &turnLimit=100
```

响应：

```json
{
  "outline": { "schemaVersion": 1 },
  "etag": "...",
  "build": {
    "cache": "hit|miss|stale",
    "durationMs": 12
  }
}
```

要求：

- 支持 `If-None-Match` / 304；
- ETag 至少包含 source revision、branch、cursor、limit 和 schema version；
- `build` 只在 Developer Mode 或 Server-Timing 中公开，正式 payload 可省略；
- Outline 构建失败不能影响现有 session detail endpoint。

### 8.2 Question/turn index

可以复用 Outline turns cursor，也可以提供专用端点：

```http
GET /api/projects/:projectId/sessions/:sessionId/outline/turns
  ?cursor=<optional>
  &limit=200
  &kind=questions
```

验收原则：

- 只返回问题/turn 摘要，不返回 tool result；
- total count 只有权威时才给出；
- 500 个问题的响应体应保持在可接受的移动网络预算内；
- 点击任意问题能得到 turn/message target。

### 8.3 Readable turn

```http
GET /api/projects/:projectId/sessions/:sessionId/turns/:turnId
  ?view=readable
  &revision=<outlineRevision>
```

要求：

- 返回完整 user prompt、commentary/final、tool summaries 和 artifacts；
- 不返回完整 tool details；
- stale revision 返回 409 和新 revision，不返回可能错误的 turn；
- response size 有硬上限；超大 final answer 使用 message detail/range。

### 8.4 Tool/item detail

```http
GET /api/projects/:projectId/sessions/:sessionId/items/:detailRef
  ?revision=<outlineRevision>
```

要求：

- 严格验证 ref scope；
- 根据 tool category 做公开字段投影和 redaction；
- 保留现有安全路径投影规则；
- 大文本支持 preview/range/download，不一次返回无限数据；
- 响应包含 `contentType/size/truncated/hasMore`；
- 审批类 item 不能通过这个只读 endpoint 绕过 InteractionBroker。

### 8.5 Live 更新

第一版不必新增复杂 WebSocket delta 协议：

- 当前 turn 的 live message 继续由现有 session stream 驱动；
- 客户端本地更新当前 turn card；
- 收到 `session-updated/process-state-changed/file-change` 后条件 revalidate Outline；
- 同一 revision 的请求单飞；
- 实测请求过多后，再新增 `session-outline-updated { sessionId, revision }` 轻量事件。

---

## 9. 行为埋点与验证模型

### 9.1 原则

- local-first：默认只写当前 Yep 实例；不向第三方出站。
- typed：使用共享 Zod schema，不用任意 console string。
- content-free：禁止记录 prompt、回复、命令、文件路径、URL query、tool output。
- bounded：客户端先聚合 exposure/scroll，再批量提交。
- opt-in/可见：设置页明确展示是否启用、本地保留时间和删除入口。
- 可重建分析：原始事件 append-only，本地分析脚本生成聚合报告。

### 9.2 公共字段

```ts
interface ProductEventBase {
  schemaVersion: 1;
  event: string;
  timestamp: number;
  viewId: string;
  sessionKey: string; // install-local HMAC，不是 raw sessionId
  provider: ProviderName;
  deviceClass: "mobile" | "tablet" | "desktop";
  sessionAgeBucket: string;
  turnCountBucket?: string;
  historySource?: string;
  outlineCoverage?: string;
  activity?: string;
}
```

### 9.3 首批事件

| 事件 | 触发 | 允许字段 |
| --- | --- | --- |
| `session_view_started` | Session 页面 ready | cache hit、窗口大小桶、hasOlder、状态 |
| `session_first_action` | 首个明确用户动作 | action kind、elapsed bucket |
| `content_exposure_summary` | 退出/周期聚合 | 各内容类型可见次数和 dwell bucket |
| `history_requested` | 加载 older/newer/target | reason、page index、bytes bucket、duration |
| `outline_opened` | 展开右侧 Outline | presentation、coverage、question count bucket |
| `outline_item_selected` | 点击问题/文件/check/artifact | item kind、是否已在当前窗口、target success |
| `tool_detail_opened` | 手动展开并请求详情 | category、status、size bucket、turn distance |
| `tool_detail_closed` | 关闭详情 | dwell bucket、load success |
| `artifact_opened` | 打开产物 | kind、preview/download、turn distance |
| `assistant_response_action` | copy/link/file | action、phase、turn distance |
| `search_used` | session/global search | scope、result count bucket、selected |
| `prompt_submitted` | 新问题/edit/queue | submission kind、session state |
| `session_view_ended` | 页面退出/隐藏 | foreground duration、max depth、action counts |

### 9.4 Exposure 判定

不能把 React render 视为用户看过。建议：

- 使用 IntersectionObserver；
- 元素至少 60% 可见；
- 连续可见至少 1.5 秒才记一次 exposure；
- 页面 hidden 时停止 dwell；
- 同一个 view 内按 semantic kind 聚合，不逐 token/逐 tool 高频上报；
- virtualized row 重挂载不得重复累计同一 exposure window。

### 9.5 本地存储与分析

建议新增：

- 客户端 IndexedDB batch collector；
- `POST /api/product-events`；
- `<dataDir>/analytics/product-events-YYYY-MM-DD.jsonl`；
- 默认保留 30 天，可配置；
- `scripts/analyze-product-events.ts` 生成不含正文的 Markdown/JSON 汇总。

不要复用 `ClientLogCollector`：console 日志可能带错误正文和调试 payload，产品事件需要更严格 schema 与
保留策略。

### 9.6 用于产品决策的指标

核心指标：

1. `time_to_orientation`：打开到首次问题/final exposure 或首次有效动作的时间。
2. `first_action_distribution`：问题目录、滚历史、搜索、工具详情、复制回复、发 follow-up 的比例。
3. `history_load_rate`：session view 中请求旧 transcript 的比例及原因。
4. `tool_detail_open_rate`：按 category/status/turn age 切分。
5. `answer_attention_share`：commentary/final dwell 与 tool detail dwell 的相对占比。
6. `artifact_open_rate`：文档、图片、diff、report 的打开率。
7. `question_target_success`：问题目录点击后成功定位的比例。
8. `follow_up_without_history`：未加载旧 transcript 即发送 follow-up 的比例。
9. `initial_payload_bytes`、Outline/turn/detail p50/p95 latency。

初始决策规则（上线后可调整）：

- completed Read/Grep/Search/Skill detail open rate 长期低于 10%：默认只加载摘要。
- error/aborted/check/change detail open rate显著高于普通成功工具：维持高优先级和 richer preview。
- 进入 session 后 30 秒内因为找问题而加载旧页的比例仍高：问题目录不够显眼或不完整。
- Outline 点击 target failure 超过 1%：暂停默认切换，先修 identity/revision。
- Overview 使 `time_to_orientation` 改善但 artifact/check 打开率下降：说明成果入口被过度折叠。

---

## 10. 分阶段实施与验收

每个阶段必须独立提交、可独立回滚。进入下一阶段前先满足当前阶段的退出条件。

### 阶段 M0：契约、基线与 fixture

#### 目标

在改数据协议前固定术语、代表性数据集、性能基线和正确性 oracle。

#### 实施任务

1. 在 shared 定义仅供测试/设计使用的 semantic kind 枚举草案。
2. 建立匿名 fixture 矩阵：
   - 小 session；
   - 100+ turns；
   - 多次 compact；
   - 巨大 Bash/Read/tool result；
   - tool_use/result 跨当前分页边界；
   - branch/rollback/edit-fork；
   - AskUserQuestion；
   - subagent/swarm；
   - generated artifact/diff/check；
   - unknown/new provider item。
3. 增加只读 benchmark 脚本，记录：
   - session detail 压缩前/后 bytes；
   - server timing；
   - normalize/preprocess 时间；
   - Outline 预计 item 数；
   - tool result 占响应体比例。
4. 记录现有右侧 questions/files/checks 在不同加载页数下的结果，作为行为回归样本。

#### 建议文件

- `packages/shared/src/session-outline.ts`（先放 schema draft 或正式 schema）
- `packages/server/test/fixtures/session-outline/`
- `scripts/benchmark-session-outline.ts`
- `docs/project/` 本文档补充实测章节

#### 验收

- 每个受支持 provider 至少一个不含真实敏感内容的 fixture。
- 至少一个 fixture 能证明当前 tool result 占 session detail 主要体积。
- 至少一个 fixture 能复现 userQuestions/Inspector 随 load-older 才补齐。
- 基线报告包含 p50/p95 或至少多次稳定样本，不只记录单次值。
- benchmark 只读，不启动模型请求、不修改真实 session。

#### 退出条件

基线报告经评审确认，后续性能收益都能相对该报告计算。

---

### 阶段 M1：本地产品行为事件

#### 目标

在改变默认 UI 前，先能测量用户真实注意力和操作路径。

#### 实施任务

1. 新增共享 `ProductEventSchema` 和事件 allowlist。
2. 新增客户端 collector：
   - IndexedDB buffer；
   - bounded queue；
   - 断线重试；
   - visibility-aware aggregation；
   - 本地开关。
3. 新增 server endpoint 和 daily JSONL store。
4. 新增 retention 清理和本地删除 API/设置入口。
5. 先接入当前 UI 的事件：session open/end、load older、search、tool expand、copy、Inspector tab/click。
6. 新增本地分析脚本和示例报告。

#### 建议文件

- `packages/shared/src/product-events.ts`
- `packages/client/src/lib/analytics/ProductEventCollector.ts`
- `packages/client/src/hooks/useProductAnalytics.ts`
- `packages/server/src/routes/product-events.ts`
- `packages/server/src/analytics/ProductEventStore.ts`
- `scripts/analyze-product-events.ts`
- `packages/client/src/pages/settings/DevelopmentSettings.tsx` 或新的 Privacy/Analytics 设置区

#### 单元/集成测试

- schema 拒绝任何未声明字段。
- payload 中出现 `prompt/text/output/path/command/url` 等高风险字段时测试失败。
- queue 上限、离线重试、重复 flush、retention 和删除可测试。
- server 拒绝超大 batch 和非法 event。
- sessionKey 使用 install-local HMAC，同一安装稳定、不同 salt 不同。

#### 验收

- 打开本地开关后，完成一次 session 浏览可以生成完整 view start/end 聚合。
- 关闭开关后不创建或上传 product event。
- 网络面板/route test 证明无第三方出站。
- 事件文件中不含用户正文、文件路径、命令和 tool result。
- 高频滚动不会生成逐像素事件；单 view 的事件数量有明确上限。
- 分析脚本能输出 first action、history load、tool expand 和 dwell 分布。

#### 退出条件

先在内部/自有设备收集足够 session views，确认事件质量，再开始默认 UI 实验。功能开发可以继续，但不能
仅凭埋点空数据删除 Trace 能力。

---

### 阶段 M2：用户问题索引完整性

#### 目标

先解决最关键的信息正确性：用户问题不再依赖 transcript 加载窗口。

#### 实施任务

1. 新增 `QuestionIndexCoverage`、`questionCount?` 和 source revision。
2. 统一 `createSessionQuestion` 的 preview、synthetic/setup/attachment 过滤规则。
3. Claude/Gemini/Pi/Kimi 保留现有提取，但补 coverage 和 branch scope 测试。
4. Codex rollout：
   - 保留 byte-offset anchor；
   - 达到 summary 上限时返回 partial；
   - 校验 rollback/branch 可见性。
5. Codex app-server：
   - 增加公开 items/turns 分页构建问题目录；
   - 或在能够证明 revision/source parity 时复用 rollout question summary；
   - 否则诚实返回 partial/unavailable。
6. ZCode：查询 user message 的 text parts 构建问题目录。
7. metadata/detail route 返回统一 question index metadata。
8. Inspector Questions 改用 server questions 为主，messages 只做 live optimistic merge。

#### 建议文件

- `packages/shared/src/app-types.ts`
- `packages/server/src/sessions/user-questions.ts`
- 各 provider reader
- `packages/server/src/codex-history/CodexAppServerHistoryReader.ts`
- `packages/server/src/indexes/SessionIndexService.ts`
- `packages/server/src/routes/sessions.ts`
- `packages/client/src/components/SessionInspector.tsx`

#### 测试

- 每个 provider 的问题提取 fixture。
- 100+、500+ 问题的分页和顺序测试。
- tool_result-only user message 不计入问题。
- synthetic setup/bridge metadata 不泄漏。
- branch/rollback/edit-fork 问题可见性。
- app-server cursor 和 rollout anchor 不混用。
- ZCode SQLite query ordering。

#### 验收

- 初次打开长 session、`messages=[]` 时，Inspector 仍能显示 server question index。
- 所有问题可通过 question-only pagination 到达。
- 点击一个未加载 transcript 的问题，可以直接定位或打开对应 turn。
- partial/unavailable 在 UI 明确展示，不能显示错误的“0 个问题”。
- Codex app-server 和 ZCode 不再只能靠连续 load-older 补问题。

#### 退出条件

Questions 已完全脱离当前 `messages` 窗口，且 provider coverage 语义稳定。

---

### 阶段 M3：SessionOutlineIndexService 核心

#### 目标

建立不含原始工具详情的 provider-neutral、可重建 Outline 存储。

#### 实施任务

1. 完成 Zod schema：Outline、TurnOutline、ToolSummary、coverage、revision、detail ref。
2. 实现 per-session disk index、atomic write、cross-process lock。
3. 实现 memory LRU 和单项/总字节预算。
4. 实现 mtime/size/provider revision 校验。
5. 接入 EventBus dirty tracking。
6. 实现 schema version 升级时懒重建。
7. 实现 safe serializer，阻止 forbidden fields 落盘。
8. 提供 debug stats，但不返回正文和私有 locator。

#### 建议文件

- `packages/shared/src/session-outline.ts`
- `packages/server/src/indexes/SessionOutlineIndexService.ts`
- `packages/server/src/indexes/session-outline-safety.ts`
- `packages/server/test/indexes/SessionOutlineIndexService.test.ts`

#### 测试

- cache hit/miss/stale/dirty。
- mtime/size 相同与变化。
- lock timeout、stale lock、atomic rename。
- LRU 条目数和字节预算。
- schema migration/rebuild。
- forbidden field/property fuzz test。
- 多 project/provider scope 不串数据。

#### 验收

- server restart 后索引可从磁盘复用。
- source 变化后不会返回 complete 的旧 Outline。
- 删除/损坏索引不会损坏 provider session，下一次可重建。
- Outline index 中不存在完整 tool output、base64、credential 或未经投影 payload。
- 单个异常 session 不阻断其他 session。

#### 退出条件

核心服务可用，但尚未替代任何现有 session UI；关闭 feature flag 时零行为变化。

---

### 阶段 M4：Provider Outline projector

#### 目标

让所有 provider 至少能生成问题、turn 状态、可读回复 preview 和工具计数；能力不足时返回 coverage。

#### 实施任务

1. 先完成 Claude 和 Codex rollout，验证两类最复杂 identity/branch 模型。
2. 接入 Codex app-server，并覆盖 source switch。
3. 接入 Gemini、Pi、Kimi。
4. 最后接入 ZCode，严格遵守真实 schema。
5. 为工具建立公共 category/title/status/stats mapper。
6. 为 commentary/final/legacy assistant text 建立公共 readable phase mapper。
7. 为 error/approval/question/change/check/artifact 建立 important-item policy。
8. 输出 provider capability matrix。

#### 建议文件

- `packages/server/src/sessions/outline/`
- `packages/server/src/sessions/outline/types.ts`
- `packages/server/src/sessions/outline/tool-summary.ts`
- `packages/server/src/sessions/outline/readable-response.ts`
- `packages/server/src/sessions/outline/providers/*.ts`

#### 测试

- 每个 M0 fixture 生成 snapshot；只对安全、稳定 DTO 做 snapshot。
- 同一源重复构建结果 deterministic。
- live started/completed item 合并。
- user turn 边界和 tool pairing。
- unknown item forward compatibility。
- generated artifacts 不暴露本地路径。

#### 验收

- provider capability matrix 中每项标明 complete/partial/unavailable。
- 同一 session 的 Outline question/turn 顺序与现有可见 transcript 一致。
- 当前/最新 final answer preview 正确。
- 成功工具有摘要，失败工具有可读错误状态。
- provider-specific detail locator 不进入公共 DTO。

#### 退出条件

所有正式 provider 至少有安全降级；不允许某个 provider 因 Outline 异常导致 Session 页面 500。

---

### 阶段 M5：Outline、Readable Turn 与 Detail API

#### 目标

提供稳定、可缓存、受 revision 保护的三层读取 API。

#### 实施任务

1. 实现 `/outline` 和 turn cursor。
2. 实现 `/turns/:turnId?view=readable`。
3. 实现 `/items/:detailRef`。
4. 接入 ETag/If-None-Match 和 Server-Timing。
5. 定义统一错误码：
   - `SESSION_OUTLINE_UNAVAILABLE`；
   - `SESSION_OUTLINE_STALE`；
   - `SESSION_TURN_NOT_FOUND`；
   - `SESSION_DETAIL_REF_STALE`；
   - `SESSION_DETAIL_TOO_LARGE`；
   - `SESSION_HISTORY_SOURCE_SWITCH_REQUIRED`。
6. 增加 auth/scope/redaction/size limit。
7. 在 API client 添加类型和取消请求支持。

#### 建议文件

- `packages/server/src/routes/session-outline.ts`
- `packages/server/src/app.ts`
- `packages/client/src/api/client.ts`
- `packages/shared/src/session-outline.ts`

#### 测试

- route unit/integration。
- ETag 304。
- stale revision 409。
- cross-session/cross-project ref 拒绝。
- detail size limit/range。
- branchId/cursor 参数校验。
- provider unavailable fallback。

#### 验收

- Outline 请求不携带完整 tool result。
- Readable turn 请求不携带 tool detail。
- Detail 请求只返回一个受 scope 约束的 item。
- 相同 revision 重复 Outline 请求返回 304。
- 错误响应不暴露本地路径、cursor、provider payload 或正文。
- 现有 session detail endpoint 行为保持不变。

#### 退出条件

API 可以被新 UI 独立消费，并可通过 feature flag 完全关闭。

---

### 阶段 M6：Web Overview 与 Inspector 重构

#### 目标

让用户默认围绕问题、回复和成果浏览，而不是围绕原始消息页浏览。

#### 实施任务

1. 新增 `useSessionOutline`，支持 cache、ETag revalidate、cursor 和 live optimistic patch。
2. Session 页面增加 Overview/Trace 切换；第一轮 feature flag 下保持 Trace 默认。
3. 实现 CurrentTurnCard：问题、状态、Plan/Goal、progress、final、artifact/check/change badges。
4. 实现 PreviousTurnCard：问题 preview、final preview、状态和计数。
5. Inspector Questions 改读 Outline；Files/Checks/Subagents 改读 outline/readable turn。
6. 点击历史 turn 加载 readable turn，而不是先替换整个 transcript window。
7. 只有进入 Trace 或选择 raw target 时才调用 `aroundMessageId`。
8. 保留 pending input、approval、editing、branch 和 MessageInput 行为。
9. 增加 loading/partial/stale/unavailable UI。

#### 建议文件

- `packages/client/src/hooks/useSessionOutline.ts`
- `packages/client/src/components/session-overview/`
- `packages/client/src/components/SessionInspector.tsx`
- `packages/client/src/pages/SessionPage.tsx`
- `packages/client/src/i18n/locales/en.ts`
- `packages/client/src/i18n/locales/zh-CN.ts`

#### 测试

- React component/hook tests。
- initial outline success/partial/failure。
- turn cursor 和 question click。
- Overview/Trace 状态保持。
- live current turn update。
- approval/question/error 永远可见。
- branch/session route 切换不串 Outline。
- en/zh-CN 文案同步。

#### 验收

- 打开长 session 后首屏明确显示最新用户问题和 agent 状态。
- 不加载旧 transcript 也能浏览问题目录。
- 点击历史问题优先出现 readable turn，不会跳回页面尾部。
- pending approval/AskUserQuestion 的处理流程不增加额外点击。
- Overview 失败时可一键退回 Trace，Session 页面仍可用。
- UI 不把 partial count 显示为 total。

#### UI 验证说明

先使用 component tests 和不干扰现有服务的只读 API 验证。Playwright、截图检查或真实浏览器自动化只有在
用户明确授权后执行；需要重启服务时也必须先取得授权。

#### 退出条件

Feature flag 用户可以完整使用 Overview，且关键交互与 Trace 无功能缺口。

---

### 阶段 M7：Tool summary/detail 真正分层

#### 目标

把“视觉折叠”升级为“网络、内存、预处理都不加载完整详情”。

#### 实施任务

1. 客户端 `ToolCallItem` 支持 summary-only 状态：
   - `summary`；
   - `detailState: unloaded/loading/loaded/error/stale`；
   - `detailRef`；
   - 可选 loaded detail。
2. `ToolCallRow` header 不再依赖完整 result 生成摘要。
3. 用户展开时调用 detail API；关闭后按 LRU/大小预算决定是否保留。
4. 请求去重和 abort：同 item 多组件只发一次，关闭/切 session 取消无用请求。
5. 详情 cache 以 project/session/revision/detailRef 为 key。
6. category policy：
   - completed read/search/skill/wait 默认 unloaded；
   - running 显示 live tail；
   - error/change/check 返回 richer summary；
   - approval/question 继续现有交互路径；
   - artifact 走 manifest/preview，不塞进 tool result。
7. Trace renderer 适配 loaded detail，不重写每个 tool renderer。
8. 服务端 session overview/detail 响应明确禁止重带 raw result。

#### 建议文件

- `packages/client/src/types/renderItems.ts`
- `packages/shared/src/render-items.ts`
- `packages/client/src/components/blocks/ToolCallRow.tsx`
- `packages/client/src/components/renderers/tools/`
- `packages/client/src/lib/preprocessMessages.ts`
- `packages/client/src/lib/toolDetailCache.ts`
- `packages/server/src/sessions/outline/tool-detail.ts`

#### 测试

- summary-only render 不访问 `toolResult.content`。
- 点击展开的 loading/error/retry/stale。
- 同 item 请求去重和切 session abort。
- detail cache 字节预算/LRU。
- 各 tool category 的 policy table。
- unknown/MCP 安全 fallback。
- tool_use/result 跨 raw page 时，Overview summary 状态仍完整。

#### 性能验收

在 M0 长 session fixture 上：

- 默认 Overview/session 首屏响应压缩后 bytes 至少下降 50%。
- 客户端初始 state 中不包含未展开工具的完整 output。
- preprocess 不再扫描未加载详情正文。
- 80+ row virtualization 继续工作。
- detail 首次打开本地 p95 目标小于 200 ms；达不到时记录 provider/source 原因。
- 关闭再打开同一 detail 在预算内命中 cache。

#### 功能验收

- 展开后显示内容与改造前 renderer 等价。
- Copy、modal、diff、file preview、search result 等功能无回归。
- 错误工具不能因为 detail 未加载而看不到错误摘要。
- Trace 保持完整审计可达性。

#### 退出条件

至少 Claude、Codex 两个主路径完成真实 lazy detail；其他 provider 要么完成，要么明确 capability fallback。

---

### 阶段 M8：Artifacts、文件变更与验证结果

#### 目标

把用户真正关心的成果从普通工具步骤中提升出来。

#### 实施任务

1. 统一 GeneratedArtifact、report、file change、check summary 的 Outline projection。
2. 将 image/document/spreadsheet/presentation/text/video manifest 展示到 CurrentTurn/Artifacts。
3. Markdown/报告链接优先使用现有安全 viewer/Reports 页面。
4. 文件变更显示 relative path、kind、additions/deletions、状态；完整 diff 按需加载。
5. 检查命令显示 lint/typecheck/test/build 类别和结果，不依赖完整 stdout。
6. Skill/Read 文档归入 Context/Evidence，不与 generated output 混在一起。
7. artifact retention 到期、下载失败和安全阻断有明确 UI。

#### 测试

- artifact manifest scope、expiry、preview/download。
- absolute path 不进入客户端。
- diff stats 与现有 renderer 一致。
- check 分类正则和 exit/error 状态。
- report/local file viewer 路由。
- 敏感/高风险 artifact 不被自动公开。

#### 验收

- 用户无需展开 Bash/Write/Edit 原始结果即可看到主要成果和验证结论。
- 点击成果可打开对应 viewer/download。
- 生成物与输入上下文在 UI 上明确区分。
- artifact 失效不会导致整个 turn 加载失败。

#### 退出条件

P3 内容已经从工具 trace 中独立出来，Overview 不再只是“另一种 transcript”。

---

### 阶段 M9：实验、默认切换与旧逻辑收敛

#### 目标

用真实行为与性能数据决定 Overview 是否成为默认，并删除明确无用的重复投影。

#### 实施任务

1. Feature flag 分组：
   - Trace-first（现状）；
   - Overview-first；
   - Overview-first + lazy detail。
2. 收集足够 view 数后比较核心指标和 guardrails。
3. 访谈/手动反馈补充解释定量数据。
4. 根据 tool category 展开率调整 summary richness。
5. 达到门槛后将 Overview 设为默认，Trace 永久保留入口。
6. 删除 Inspector 对当前 `messages` 的重复全量 preprocess；live optimistic 数据除外。
7. 评估 SessionContentIndex 是否应升级为真正 FTS；这不是默认切换的阻断项。
8. 更新项目文档、CHANGELOG 和运行时能力说明。

#### 对比指标

主要指标：

- time_to_orientation p50/p90；
- 首次有效动作时间；
- 初始 payload bytes；
- follow-up submission rate/time；
- 因寻找问题触发的 history load rate。

Guardrails：

- approval/question 响应率和响应时间不能变差；
- error/check/change 的可见和展开率不能异常下降；
- question target failure < 1%；
- session load error 不上升；
- branch/edit/rollback 回归为 0；
- Trace 可达率 100%。

#### 验收

- Overview 在主要指标上优于或不劣于 Trace-first。
- 初始 bytes 和长 session 内存达到 M7 预算。
- 用户不是因为找不到细节而频繁切回 Trace；若切回率高，先修能力缺口。
- 所有 product event 可本地删除，保留策略生效。
- 功能/兼容变更已经写入 `CHANGELOG.md` 的 `[Unreleased]`。

#### 退出条件

Overview 成为默认；旧 window-derived Inspector 逻辑被移除或仅作为 unsupported provider fallback。

---

## 11. 总体验收矩阵

### 11.1 正确性

- [ ] 所有 provider 返回明确 Outline coverage。
- [ ] 所有用户问题可发现、可分页、可定位。
- [ ] user prompt、tool_result-only user message、AskUserQuestion answer 不混淆。
- [ ] active/selected branch Outline 正确。
- [ ] rollback/edit/fork 后 revision 与可见 turns 正确。
- [ ] tool_use/result 即使跨 raw page，Outline 状态仍正确。
- [ ] source switch 不会把用户重置到最新尾部。
- [ ] stale detail ref 返回 409 并可恢复。

### 11.2 用户体验

- [ ] 首屏能看到最新问题、状态、回复和成果。
- [ ] P0 action 始终突出。
- [ ] 历史问题无需加载旧 transcript 即可浏览。
- [ ] 历史 turn 可独立加载 readable 内容。
- [ ] 工具默认有可理解标题和状态。
- [ ] 失败/change/check 比普通成功工具更显眼。
- [ ] Overview 失败时可退回 Trace。
- [ ] en 和 zh-CN 文案同步。

### 11.3 性能

- [ ] 代表性长 session 默认首屏压缩 bytes 至少下降 50%。
- [ ] 未展开工具完整结果不进入客户端 state。
- [ ] Outline cold/warm p50/p95 有记录。
- [ ] Outline cache 有内存/磁盘预算。
- [ ] detail request 有大小上限、取消和去重。
- [ ] session streaming 不因 Outline revalidate 明显抖动。
- [ ] 现有 MessageList virtualization 无回归。

### 11.4 隐私与安全

- [ ] Product events 不含正文、路径、命令、URL query 或 output。
- [ ] 默认无第三方 analytics 出站。
- [ ] Outline 公共 DTO 不暴露绝对路径或 provider-private locator。
- [ ] detail ref 绑定 project/session/revision。
- [ ] artifact 继续通过现有安全 managed route。
- [ ] base64/media 不进入 Outline index。
- [ ] index/debug/error 不记录 credential 或 provider payload。

### 11.5 兼容与回滚

- [ ] 现有 session detail/history/search endpoints 保留。
- [ ] Feature flag 可分别关闭 Outline UI、Outline API 使用和 lazy detail。
- [ ] 关闭 flag 后恢复 Trace-first，不要求删除索引。
- [ ] Outline 索引损坏可重建，不影响 provider session。
- [ ] unsupported provider 有明确 fallback。
- [ ] 不需要重启/迁移 provider 存储。

---

## 12. 验证命令与测试策略

源码改动完成后按范围执行：

```bash
pnpm lint
pnpm typecheck
pnpm test
```

聚焦测试优先：

```bash
pnpm --filter @yep-anywhere/server test -- SessionOutline
pnpm --filter @yep-anywhere/client test -- SessionOverview
pnpm --filter @yep-anywhere/shared test -- session-outline
```

具体 filter 命令以仓库实际 package scripts 为准，实施时不得假设不存在的命令一定可用。

只在确实增加 E2E 覆盖且用户明确授权浏览器/UI 自动化时执行：

```bash
pnpm test:e2e
```

辅助验证：

```bash
npx tsx scripts/validate-jsonl.ts
npx tsx scripts/validate-tool-results.ts --summary
npx tsx scripts/benchmark-session-outline.ts --summary
npx tsx scripts/analyze-product-events.ts --summary
```

ZCode 只读验证：

```bash
pnpm test:zcode-app-server-smoke -- --read-only --summary
```

任何会发起模型请求、写诊断 session、安装 ZCode plugin、重启 8022/4510 或使用浏览器自动化的验证，
都必须在当次实施中再次取得用户明确授权。

---

## 13. Feature flag 与回滚方案

建议使用三个独立运行时能力开关，名称在实施时统一进入 config，不散落读取环境变量：

1. `sessionOutline`：启用 Outline 构建/API。
2. `sessionOverview`：客户端显示 Overview。
3. `lazyToolDetails`：summary-only tool payload 和详情请求。
4. `localProductAnalytics`：本地行为事件。

回滚顺序：

1. 关闭 `lazyToolDetails`，恢复现有完整消息 payload 和 renderer。
2. 关闭 `sessionOverview`，恢复 Trace-first，但保留 Outline API 供诊断。
3. 关闭 `sessionOutline`，session detail/history 完全走现状。
4. 关闭 `localProductAnalytics`，collector 停止写入；已有本地数据按设置删除/保留。

Outline index 是可重建缓存。回滚时不需要删除它；新版本可以忽略旧 schema。不得在自动回滚中递归删除
用户数据目录。

---

## 14. 风险清单

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Provider identity 不统一 | 点击问题/详情定位错误 | stable ID + revision + provider fixture |
| Branch/rollback 投影错误 | 显示已失效内容 | active branch oracle、source-specific rebuild |
| Tool 摘要过度简化 | 用户无法判断是否需查看 | category policy、失败/change richer preview、埋点 |
| Detail ref stale | 展开失败 | 409 + revalidate + retry once |
| Outline full rebuild 太重 | 活跃 session 卡顿 | lazy build、LRU、基线、达到条件后增量 |
| Outline 文件过大 | 移动端传输/内存回升 | session/turn 两级摘要、cursor、字节预算 |
| Live 与 persisted 不一致 | 状态闪烁或回退 | optimistic current turn + revision convergence |
| Product event 泄漏正文 | 隐私风险 | Zod allowlist、forbidden-field tests、local-only |
| 埋点只测“渲染”不测“看见” | 错误产品结论 | visibility+dwell 聚合 |
| Overview 掩盖审计信息 | 专业用户不信任 | 永久保留 Trace、详情明确可达 |
| 跨 provider 大重构失控 | 交付周期过长 | 按 provider/里程碑独立提交和 capability fallback |

---

## 15. 推荐提交拆分

建议至少按以下逻辑提交，避免把 schema、所有 provider、UI 和 telemetry 混成一个不可审核提交：

1. `docs: define session outline and semantic loading plan`
2. `feat(shared): add product event schemas`
3. `feat(server): add local product event store`
4. `feat(client): instrument current session behavior`
5. `feat(shared): add question coverage and outline schemas`
6. `fix(server): make question indexes provider-complete or explicitly partial`
7. `feat(server): add session outline index core`
8. `feat(server): add Claude and Codex outline projectors`
9. `feat(server): add remaining provider outline projectors`
10. `feat(server): expose outline readable-turn and detail APIs`
11. `feat(client): add session overview and outline navigation`
12. `feat(client): lazy-load tool details`
13. `feat(client): promote artifacts changes and checks`
14. `chore: enable overview experiment and add analysis report`

每个会进入部署产物的提交组都需要同步更新 `CHANGELOG.md` 的 `[Unreleased]`。开发和临时验证不提升
版本；正式部署/发布时再按项目 CalVer 流程执行 `pnpm version:status`、`pnpm version:bump` 和
`pnpm version:check`。

---

## 16. 最终交付物

计划完成时应交付：

- provider-neutral Session Outline Zod schema；
- 完整性与 revision 协议；
- 可重建 Outline 索引；
- 所有 provider 的 projector/capability matrix；
- Outline、Readable Turn、Item Detail API；
- Web Overview、问题目录、成果区和 Trace fallback；
- 真正按需加载的 tool details；
- 本地行为事件、保留/删除机制和分析脚本；
- fixture、单元/集成测试和性能基线/对比报告；
- CHANGELOG、用户文档和运维/回滚说明。

完成后的产品心智应从：

```text
打开 session → 加载最近 100 条消息 → 往上翻 → 逐渐理解发生了什么
```

转变为：

```text
打开 session
→ 立即看到“我问了什么 / agent 当前怎样 / 回复与成果是什么”
→ 需要证据时展开工具摘要
→ 需要审计时再加载完整详情或进入 Trace
```
