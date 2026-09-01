# Session 展示语义压缩与工具详情按需加载方案

> 日期：2026-09-01<br>
> 状态：阶段 A–C 已实施（2026-09-01），保留 `?history=legacy` 兼容回退<br>
> 范围：Yep Anywhere 的 session 读取与展示链路<br>
> 前置文档：[已废弃的 Session Outline、语义化加载与行为验证开发计划](./2026-08-31-session-outline-semantic-loading-development-plan.md)

## 0. 决策摘要

本方案只解决一个问题：长 session 在 Yep 中首次打开、浏览历史和查看问题目录时，当前 raw-message
分页会携带大量默认不可见的工具输入/结果，并在客户端不断累积，造成网络、解析、预处理、布局和滚动卡顿。

核心决策：

1. Codex、Pi、Kimi、Claude、Gemini、ZCode 等 provider 的原始 session 文件、上下文构造和模型请求流程
   保持不变。
2. Yep 新增一份**只用于展示的、可重建的轻量 session 投影**；它不是新的权威 session，也不反写
   provider 文件。
3. 主时间线按用户 turn 展示：用户原始问题、agent 的中途文本/进度和最终回复保持可读；连续的常规工具
   调用压缩成一个工具组。
4. 工具组默认只返回数量、状态和安全摘要；用户展开时才读取该组的原始工具调用与结果，并复用现有
   renderer。
5. 右侧用户问题目录独立读取，不再依赖当前已加载的 raw message 窗口。
6. 极端长 session 仍保留 cursor，但 cursor 按语义 turn 分页，由界面自动加载轻量页；不再让用户机械地
   加载一页页 raw transcript 才能找到历史问题。
7. 右侧 Session Inspector 是默认可见的会话索引；桌面侧栏显示或移动抽屉打开后自动补齐文件、检查、
   Plan、Goal 和子智能体，不允许用一个手动加载按钮把整块索引隐藏起来。只有完整工具输入/结果需要用户展开。

本方案不包含全文搜索索引、产品埋点、Artifacts 中心、Overview/Trace 实验或默认信息架构切换。这些问题
分别进入后续独立文档。

---

## 1. 当前问题与实测

### 1.1 当前链路

当前 Session 页面：

1. 首次请求 `view=canonical&tailCompactions=2&maxMessages=100`。
2. 服务端读取 provider session，normalize 后返回最多 100 条 raw message。
3. 客户端把完整 `Message[]` 放入 state，再由 `preprocessMessages()` 扫描全部消息、配对
   `tool_use/tool_result`、生成摘要并分组为 turn。
4. `ToolCallRow` 最后才决定视觉折叠；此时完整 tool input/result 已经传输、解析并进入内存。
5. Load older 会把新页永久 prepend 到 `messages`，随后重新执行合并、预处理、turn 分组、虚拟列表测量和
   滚动锚点修正。
6. Inspector 虽会合并 `session.userQuestions`，但 Codex app-server、ZCode 和截断索引等来源可能没有完整
   server questions，最终仍只看到当前窗口中的问题。

虚拟列表只减少 DOM 挂载量，不能减少服务端响应体、JSON parse、React state 和预处理成本。

### 1.2 指定长会话样本

对用户给出的 `8022` 会话做只读 API 取样，不输出正文：

| 指标 | 首次响应 |
| --- | ---: |
| HTTP 状态 | 200 |
| 响应体 | 601,767 bytes |
| 返回 messages | 70 |
| tool uses / results | 34 / 34 |
| tool use JSON 字符量 | 9,643 |
| tool result JSON 字符量 | 553,130 |
| tool result 占响应体近似比例 | 91.9% |
| Server-Timing `pageRead` | 5.5 ms |
| history source | `codex-app-server` |
| question coverage | `partial / provider_page_only` |
| indexed questions | 0 |

这个样本说明当前主要矛盾不是 DOM 行数，也不是服务端 page read 本身；默认不可见的工具结果占据了绝大
多数载荷。远端连接下会进一步放大传输成本，客户端还会为这些隐藏内容支付 JSON parse、配对、摘要计算和
内存成本。

### 1.3 问题边界

这里有三个独立问题：

- **展示载荷过重**：本方案处理。
- **右侧用户问题目录不完整**：本方案处理，因为它直接影响同一页面的导航。
- **全文搜索索引只读到部分 Codex 历史**：本方案不处理，另立文档。

---

## 2. 目标与非目标

### 2.1 目标

- 打开长 session 时，默认响应不携带成功常规工具的完整 input/output。
- 用户无需加载 raw older messages，即可看到完整或明确标记为 partial 的用户问题目录。
- 时间线保留用户问题、agent 中途文本/进度和最终回复的原始可读内容与顺序。
- 连续工具调用在其原始位置显示为工具组，展开后仍能查看现有 renderer 提供的详情。
- 展开工具不会修改 provider session，也不会影响 agent 恢复、branch、rollback、fork 或模型上下文。
- 历史分页以 turn 为边界，不切开用户问题、工具调用/结果配对或最终回复。

### 2.2 非目标

- 不改变 Codex/Pi/Kimi 等 CLI 写入的 session 格式。
- 不使用展示投影作为模型下一轮输入。
- 不建设新的 canonical transcript 数据库。
- 不在第一阶段持久化第二份完整 session。
- 不在本方案中设计产品埋点、A/B 实验或新的首页/Overview。
- 不重做现有工具 renderer、文件查看器、审批和 AskUserQuestion 交互。
- 不解决全文搜索索引、产物中心或跨 session 报告。

---

## 3. 目标展示模型

原始 session：

```text
用户：修复这个问题
Agent：我先检查现状
Tool A
Tool A result
Tool B
Tool B result
...数十次
Agent：已经定位到原因，继续修改
Tool C
Tool C result
...数十次
Agent：修复完成，验证通过
```

默认展示：

```text
用户：修复这个问题
Agent：我先检查现状
34 个工具调用 · 已完成                     [展开]
Agent：已经定位到原因，继续修改
18 个工具调用 · 1 个失败                   [展开]
Agent：修复完成，验证通过
```

规则：

- 一个用户问题开始一个 turn，直到下一个真实用户问题。
- assistant 文本保持原顺序；Codex commentary/final phase 可用时保留，但公共协议只需要
  `progress | final | text` 三种简单语义。
- 两段 assistant 可读文本之间的连续工具调用组成一个工具组，因此同一 turn 可以出现多个工具组。
- pending approval、AskUserQuestion、运行中工具和错误必须立即可见，不能只藏在成功工具组的总数中。
- 第一阶段对成功 Edit/Write/Check 仍可进入工具组，但组头应显示 changed files/check/error 数量；不建设独立
  Artifacts UI。
- thinking/reasoning 默认不进入轻量响应；如 provider 能稳定定位，可作为按需详情。

---

## 4. 轻量展示协议

建议只定义满足当前页面的最小协议：

```ts
interface SessionDisplayPage {
  sessionId: string;
  revision: string;
  turns: SessionDisplayTurn[];
  nextCursor?: string;
}

interface SessionDisplayTurn {
  id: string;
  question: {
    messageId: string;
    content: PublicUserContent;
    timestamp?: string;
  };
  segments: Array<
    | {
        type: "assistant_text";
        id: string;
        phase: "progress" | "final" | "text";
        content: string;
        timestamp?: string;
      }
    | {
        type: "tool_group";
        id: string;
        status: "running" | "completed" | "failed" | "mixed";
        count: number;
        failedCount: number;
        changedFileCount?: number;
        checkCount?: number;
        detailRef: string;
      }
    | {
        type: "action_required";
        id: string;
        action: "approval" | "question";
      }
    | {
        type: "error";
        id: string;
        message: string;
      }
  >;
}
```

约束：

- `SessionDisplayPage` 不包含完整 tool input/output、raw reasoning 或 provider event。
- `detailRef` 是 session/revision scoped 的不透明引用，不暴露本地文件路径。
- `revision` 变化后旧 detail ref 返回明确的 stale 响应，客户端刷新当前轻量页后允许重试一次。
- 第一版不把投影落成新的长期磁盘格式。先基于现有 reader/normalize 生成并测量；只有冷读取 p95 证明需要时，
  再讨论可重建 sidecar cache。

### 4.1 用户问题目录

问题目录使用独立轻量响应：

```ts
interface SessionQuestionPage {
  questions: Array<{
    messageId: string;
    turnId: string;
    preview: string;
    timestamp?: string;
  }>;
  coverage: "complete" | "partial" | "unavailable";
  nextCursor?: string;
}
```

- 问题页不携带工具结果。
- 客户端打开 session 后顺序、可取消地自动取完问题页；不要求用户点击 Load older。
- 极端 session 加载过程中显示已索引数量和 coverage，不能把当前数量伪装成总数。
- 点击问题直接请求对应 turn 的轻量页；只有进入工具详情时才读取 raw tool 数据。

### 4.2 工具组详情

展开工具组时请求该组详情：

```http
GET /api/projects/:projectId/sessions/:sessionId/display/tool-groups/:detailRef
```

第一阶段响应返回该组所需的、范围受限的 normalized tool messages，客户端复用现有
`preprocessMessages()` 和 `ToolCallRow`。这样不需要重写所有 provider renderer。

单组过大时允许 cursor 分页；点击组头只加载第一页，继续展开时再取下一页。

---

## 5. 读取流程

### 5.1 首次打开

```text
并行请求
├── session metadata/runtime
├── display page（最近若干 user turns）
├── question pages（后台自动补全）
└── Inspector 安全索引（Inspector 可见时自动补全，只返回路径、检查、Plan/Goal/子智能体等
    body-free 元数据；失败后提供显式重试）
```

主时间线只持有 `SessionDisplayTurn[]`。它不再先构造完整 `Message[]` 后才视觉折叠。

### 5.2 浏览更早历史

- 以 `nextCursor` 自动加载更早的轻量 turn。
- cursor 必须落在 user turn 边界。
- 客户端只 prepend 少量 display segments，不运行跨全部历史的 tool result pairing。
- 虚拟列表继续保留，但它成为额外优化，不再承担减少网络载荷的职责。

### 5.3 展开工具

1. 用户点击工具组。
2. 以 `detailRef + revision` 请求组内 normalized tool messages。
3. 只对该组运行现有 `preprocessMessages()`。
4. 关闭后可保留一个有界内存 LRU；不写入主 session state。

---

## 6. 服务端实施策略

### 6.1 第一版先复用现有 normalize

第一版目标是先消除网络和客户端的主要成本，不要求同时重写所有 provider reader：

1. reader 继续读取当前有界 raw page。
2. 服务端在返回前把 normalized messages 投影为完整语义 turn。
3. 如 raw page 在 turn 中间结束，服务端内部继续读取到该 turn 闭合；raw page 不暴露给客户端。
4. 记录 server projection、响应字节和客户端渲染基线。

只有 server cold read/projection 成为实测瓶颈后，再为具体 provider 下沉轻量扫描。不要预先建设覆盖所有
provider 的复杂磁盘索引。

### 6.2 Provider 适配原则

- **Codex app-server**：复用 `thread/turns/list(itemsView="summary")` 的 turn 身份与 cursor，再以有界并发读取
  对应 turn items。display 保留中途 progress 与工具组边界；问题目录立即丢弃非用户 item，以免 Codex summary
  只保留每个 turn 第一条 user message 时漏掉同 turn steer。展开详情继续使用原生 item/turn 身份。
- **Codex rollout**：复用当前 byte-offset/cursor 扫描和 branch/rollback reducer；投影时丢弃工具正文，
  detailRef 保存服务端私有 byte locator。
- **Pi**：复用原生 session tree/active branch；参考 pi-web 的 ancestor-tail 分页，但返回 Yep display
  segments，而不是完整 tool result text。
- **Kimi/ZCode/Gemini/Claude**：先在现有 normalized page 上投影，保持现有 message identity、branch 与
  tool pairing；实测后再决定是否需要 provider-native 快路径。

### 6.3 活跃 session 边界

实现补充（2026-09-01）：active/external 首开也读取 metadata/display，raw 例外被收窄到最新 assistant 可读输出
之后唯一尚未封口的 `liveTail`。历史工具组即使 session 仍 active 也不下发正文；self-owned session 仅恢复该
live tail 的 bounded detail 并接续 WebSocket/SSE，external session 仅自动展开该 tail。progress/commentary、
普通 assistant 文本或 final 会封口并立即收拢它之前的连续工具行；客户端随后在 80ms–2s 的有界窗口内等待
display 确认该 assistant message 已持久化，确认后删除闭合 raw 前缀，失败则保留 raw。thinking、内部
system/provider 行不参与分界，AskUserQuestion/plan progress 保持独立。显式 `?history=legacy` 仍可恢复完整
raw 链路。

这不会撤回工具运行期间已经通过 live stream 发送的字节，但保证闭合批次不再通过后续 snapshot 重发；重新打开
active session 时也只传 display 摘要加当前 live tail。若后续还要压缩 live tail 本身，再另立 server-side
summary event 协议，继续复用同一 `SessionDisplayTurn`/detailRef 模型。

---

## 7. 同类项目对照

本轮核对版本：

- [pi-web](https://github.com/agegr/pi-web) `main@28bab3c`
- [OpenCode](https://github.com/anomalyco/opencode) `origin/dev@1ead9e3`
- [agent-session-view](https://github.com/dotneet/agent-session-view) `main@0092c74`

| 项目 | 已采用做法 | 仍存在的边界 | 对 Yep 的启发 |
| --- | --- | --- | --- |
| pi-web | 服务端按 active-branch ancestor tail 返回最近 50 entries；thinking 和 tool-result image 可延迟读取；工具默认折叠 | `SessionManager.getEntries()` 仍先读取整份 session；文本 tool result 仍随当前页返回 | 可借鉴 turn-safe ancestor pagination 和 thinking/media detail route，但不能只做视觉折叠 |
| OpenCode | opaque cursor 分页；数据库一次 hydrate 当前页 messages + parts；context tools 分组；重工具 body 分帧延迟挂载 | tool output 已在 page parts 和客户端 store 中，`deferToolContent` 只是延迟 DOM mount | 可借鉴 cursor、工具分组和有界 store；Yep 需要进一步把载荷与 UI body 分离 |
| agent-session-view | 默认隐藏 tool use/result 和 thinking；Claude tool result 截断到 500 字符 | 面向只读查看/导出，没有按需读取完整工具详情的 live 协议 | 证明 answer-first 默认展示合理，但 Yep 不能以永久截断替代可达详情 |

结论：同类项目普遍已经确认“默认不突出工具详情”的产品方向，但目前多数实现只做到过滤、截断、折叠或
延迟挂载。Yep 的目标应是更明确的**载荷分层**：默认响应中根本不出现完整工具结果。

---

## 8. 分阶段实施

### 阶段 A：契约与只读投影

- 固定一个真实长 Codex 样本和一个 Pi/Kimi fixture。
- 实现最小 `SessionDisplayPage` 与 question page schema。
- 在服务端基于现有 normalized messages 生成 turn/tool-group 投影。
- 不接 UI、不写 sidecar、不改变 provider session。

退出条件：投影顺序、工具计数、问题 identity 与当前 transcript oracle 一致。

### 阶段 B：轻量 API 与工具组详情

- 增加 display、questions、tool-group detail 三条读取路径。
- 接入 revision/cursor 失效处理。
- Codex app-server、Codex rollout、Pi 各完成一个真实读取路径；其他 provider 允许先走 normalized fallback。

退出条件：指定长会话首次响应不包含完整成功工具结果，展开工具组能恢复原有详情。

### 阶段 C：客户端替换历史读取

- 主时间线改读 display page。
- Inspector 改读 question pages，并在后台自动补全。
- 工具组展开时局部复用现有 renderer。
- 移除该路径对 raw Load older 的依赖；保留兼容回退开关直到验证完成。

退出条件：长 session 的浏览、问题跳转、历史自动加载和工具详情均可用，旧 transcript route 仍可回退。

活跃 turn 的 summary streaming、全文搜索、Artifacts 和产品实验分别进入后续文档，不纳入 A–C。

---

## 9. 验收标准

- provider 原始 session 文件在所有验证前后保持 byte-for-byte 不变。
- 指定 Codex 样本默认响应中完整 tool result 字节为 0；总响应体相比当前 601,767 bytes 至少下降 70%。
- 初始 UI 不构造隐藏工具详情对应的完整 `Message[]`/`ToolCallItem.toolResult`。
- 右侧问题目录不依赖已加载 timeline 页；partial/unavailable 必须明确显示。
- 任一 assistant 中途文本和最终回复的顺序、内容与当前 normalized transcript 一致。
- 工具组 count、失败数和运行状态与展开后的工具列表一致。
- pending approval、AskUserQuestion、错误和运行中工具不会被成功工具组吞掉。
- 展开工具组后，现有 copy、diff、文件链接和 renderer 行为保持可用。
- branch/rollback/fork 后旧 cursor/detailRef 不会展示错误分支内容。
- 自动加载更早 display turn 时不发生明显主线程长任务或滚动位置跳变。

---

## 10. 待评审决策

进入实现前只需要确认三件事：

1. 成功 Edit/Write/Check 是否默认进入工具组，还是保留一行独立摘要。
2. 主时间线初始加载多少个 user turns；实测工具正文剥离后默认采用 40 个 turn，而不是沿用 100 条 raw message。
3. 工具组展开是否一次返回整个组，还是固定每页 50 个工具；建议默认 50，极端组继续分页。

其余缓存、磁盘 sidecar、增量索引和 live summary transport 都由实测或后续文档决定，不在第一阶段提前
设计。
