# 4510 Codex Bridge 轻量化与延迟治理计划

> 状态：已完成实现审核，按本文修订后待排期
>
> 创建日期：2026-08-18
>
> 审核日期：2026-08-18
>
> 核心结论：4510 应作为协议感知的接管代理，而不是全量 canonical event journal 的同步写入端；生产默认 journal mode 已确定为 `lifecycle`。
>
> 关联计划：
>
> - [Codex 事件 journal 内存索引有界化方案](./2026-08-13-codex-event-journal-memory-plan.md)
> - [Codex 会话 OOM 崩溃与错误中断归因修复计划](./2026-08-18-codex-session-oom-and-interruption-repair-plan.md)
> - [Session 切换加载性能与内容缓存方案](./2026-08-13-session-switching-performance-plan.md)

## 1. 结论

现有调查对“终端流式内容晚于 Yep UI”的根因判断成立：Codex app-server 发出的每条 JSON-RPC notification，必须先经过 bridge 的 redaction、canonical envelope、JSONL append、索引更新和 reducer 投影，完成后才会转发给 TUI。

但原计划把主要优化放在“同一 WebSocket frame 批量 append”和“单写者 append 快速路径”上，仍然保留了全量 delta journal、全量内存索引、首次连接全历史 replay，以及逐事件 reducer 克隆。它只能降低一部分文件系统调用，不能解决 4510 的架构性重量。

本计划改为：

1. native Codex rollout 是会话历史、终态内容和 token usage 的事实来源；
2. 4510 的核心职责限定为透明代理、MCP profile、连接保活、ownership 和 pending input 接管；
3. 高频 delta 默认不进入 bridge durable journal；
4. bridge 只保存有界的 session/lifecycle 最新状态，必要时保存小型异步 lifecycle journal；
5. canonical transcript、历史刷新和统计优先从 rollout 或 app-server 原生 replay 能力恢复；
6. bridge journal 是可降级增强能力，写入失败不得拖慢或杀死核心代理连接；
7. 生产默认使用 `lifecycle`，`off` 仅作为极简故障回退和对照基线。

评审结论：**修改后通过；不得按旧版 P0-1 → P0-2 → P1-1 的顺序直接实施。**

## 2. 4510 的产品职责

### 2.1 必须保留

4510 的关键价值是“接管”，具体包括：

- 作为 Codex TUI 的 remote WebSocket 入口；
- 按 `clear | light | full` profile 管理或选择常驻 app-server；
- 在 `thread/start | thread/resume | thread/fork` 时注入 thread-level MCP config；
- 保持 JSON-RPC 请求、响应和 server request identity 的连接级映射；
- TUI 断开但 turn 仍活跃时保留 upstream 连接；
- 向 Yep 主服务暴露 session list、activity、ownership 和 pending input；
- 允许 Yep 对 approval/question 做一次性 resolution；
- Yep 恢复 bridge-owned thread 时复用原 profile，并在活跃 turn 上使用 `turn/steer`；
- 保存少量可恢复 session metadata，例如 cwd、title、model、activity 和 context usage。

这些能力目前主要由 `SessionRecord`、`BridgeConnection`、pending maps 和 `sessions.json` 提供，不依赖全量 canonical journal。

### 2.2 不应成为核心职责

以下能力不能继续阻塞数据面：

- 为每条 token/text/command delta 建立 durable canonical envelope；
- 为所有历史事件维护永久内存索引；
- 每个新连接首次遇到 thread 时 replay 并 reduce 全部历史；
- 因辅助 journal 写入失败而关闭 TUI 与 app-server；
- 为了 transcript 增强能力复制 app-server 已经写入 rollout 的完整流式内容。

### 2.3 与其他性能问题的边界

4510 轻量化直接解决：

- TUI 流式内容的 bridge 附加延迟；
- bridge Node 的高 RSS、GC 压力和冷启动；
- bridge journal 的高速磁盘增长；
- 多连接共享全局 append 锁导致的跨 session 头阻塞。

它不会单独解决 Yep UI 的全部 session 切换耗时。普通 Session GET 仍可能全量读取和解析 Codex rollout；该问题由《Session 切换加载性能与内容缓存方案》处理。

## 3. 当前实现与现场证据

### 3.1 数据路径

```text
Codex TUI
  -> ws://127.0.0.1:4510
  -> CodexBridgeService.observeClientData()
  -> CodexBridgeEventSpine
  -> CodexEventIngress
  -> JsonlCodexEventStore
  -> codex app-server

codex app-server
  -> JsonRpc notification
  -> CodexBridgeService.observeServerData()
  -> CodexBridgeEventSpine
  -> CodexEventIngress
  -> JsonlCodexEventStore
  -> CodexBridgeService lightweight projection
  -> Codex TUI
```

server → TUI 热路径在 `CodexBridgeService.observeServerData()` 中逐消息等待：

1. `observeServerRequest()`、`observeServerNotification()` 或 `observeClientResponse()`；
2. journal append 完成；
3. canonical reducer 完成；
4. bridge session/pending 状态投影；
5. 整个 frame 才发送给下游。

`clientFrameChain` 和 `serverFrameChain` 保证连接内顺序，但任何慢 append 都会阻塞同方向后续所有 frame。所有连接又共享一个 `JsonlCodexEventStore.appendTail`，因此磁盘慢操作还会造成跨连接阻塞。

### 3.2 每事件文件系统成本

当前 `JsonlCodexEventStore.append()` 每次执行：

1. 首次调用时加载所有 retained journal segments；
2. 获取全局 append lock；
3. `stat` 活跃 journal；
4. 从上次文件边界 `open + read` 新 tail；
5. `JSON.parse` tail 并重新判重；
6. `appendFile` 写入一条 JSONL；
7. 更新索引；
8. 故意不推进文件 snapshot，下一次 append 再读回刚写入的行。

`appendMany()` 目前只是循环调用 `append()`。

### 3.3 每事件 CPU 与 GC 成本

文件 IO 不是唯一成本。

`CodexEventIngress.persist()` 会为每条事件创建 canonical draft，store 又对 draft 和返回 envelope 做 clone。事件写入后，`reduceCodexEvent()` 会：

- `structuredClone(currentState)`；
- 重新建立 applied id/dedupe Set；
- 把 event id、observation 和 notification count 加入 state；
- 对 delta 累加 assistant text、command output、reasoning 或 patch；
- 保留完整的 `appliedEventIds`、`appliedDedupeKeys` 和 `observations`。

因此，单个长 session 的 live reducer 成本会随已应用事件数量增长，而不是稳定的 O(1)。

离线基准使用 `InMemoryCodexEventStore`，不含任何文件 IO，仅向一个新 session 连续 ingest 一字符 `item/agentMessage/delta`：

| delta 数 | 总耗时 | 单事件均值 |
| ---: | ---: | ---: |
| 100 | 6.6 ms | 0.066 ms |
| 500 | 91.8 ms | 0.184 ms |
| 1,000 | 323.4 ms | 0.323 ms |
| 2,000 | 1,237.7 ms | 0.619 ms |

该结果已表现出明显的超线性增长，而且尚未叠加生产 journal、长历史 replay、磁盘压力和多个连接。

### 3.4 内存结构

`JsonlCodexEventStore` 实际有四类长期索引：

- `eventsBySession`
- `eventsBySessionMethod`
- `eventsByIdentity`
- `eventsByDedupeKey`

四个索引长期持有 event envelope；`eventsBySession` 与 `eventsBySessionMethod` 还分别持有数组引用。每个 connection-local ingress 又保存一份 reduced state，并在首次连接 thread 时 replay 该 session 的全部历史。

在 bridge-owned thread 被 Yep 接管后，bridge 和 Codex provider 还可能分别观察并写入各自的 canonical journal，进一步形成重复存储和重复 reduce。

### 3.5 2026-08-18 现场快照

只读检查得到：

| 项目 | 当前值 |
| --- | ---: |
| 4510 Node RSS | 约 1.506 GiB |
| 当前 managed app-server Node wrapper | 约 0.034 GiB |
| 当前 managed app-server native process | 约 0.189 GiB |
| 4510 整个进程树 RSS | 约 1.729 GiB |
| bridge journal retained bytes | 约 936 MiB |
| `sessions.json` | 约 98 KiB |
| bridge session 数 | 107 |
| 当前 attached connection 数 | 6 |
| 当前运行 profile | 仅 `clear` |

结论：

- 当前重量不是因为三个 profile 同时常驻；现场只运行了一个 profile；
- 4510 Node 本身远大于 managed app-server；
- 约 98 KiB 的 session metadata 已经足以支撑 107 个 session 的列表与恢复；
- 936 MiB journal 及其对象化索引是主要内存来源；
- 进程显示的约 448 GiB VSZ 是 V8 地址空间预留，不是物理内存占用，评估应看 RSS/heap。

现场运行 build 为 `dcd6c811`，工作树 HEAD 更新；两者的 bridge 转发、event ingress、append 和 reducer 热路径一致。工作树新增的 event-store cold-load admission 只保护 reader，不解决 sidecar writer。

### 3.6 同一 frame 批量不是生产主路径

Codex app-server 的 WebSocket outbound loop 每次从 queue 取出一个 `QueuedOutgoingMessage`，序列化后发送一个 `Text` frame。也就是说，正常 notification 流是：

```text
1 JSON-RPC message
  -> 1 WebSocket frame
  -> 1 bridge append
```

现有 bridge 测试覆盖了人工构造的 JSON-RPC batch frame，但这不是高频 delta 的真实发送方式。因此“同一 WS frame 50 条 delta 合并落盘”不能作为 P0 主验收。

### 3.7 当前 durability 边界被高估

`appendFile()` 成功不等于 `fsync` 成功。当前 store-before-forward 保证的是：

- append Promise 完成后才转发；
- 进程内看到的顺序与文件 write 顺序一致；
- crash 后 partial final line 可以被容错读取。

它不保证断电级 durability。

同时，bridge 的 pending input map、live connection 和 callback 本身没有从 canonical journal 恢复。bridge 重启后 `sessions.json` 只把 session 恢复为 idle；全量 delta journal 并不能重建可响应的 live takeover。

因此不能为了一个并未覆盖核心恢复语义的辅助 journal，让其写入失败关闭正在工作的 TUI 和 app-server。

## 4. 参考实现对照

### 4.1 Codex 官方 remote client / app-server

Codex remote client 负责：

- initialize/initialized handshake；
- JSON-RPC request/response 映射；
- server request resolution；
- notification event queue；
- WebSocket connection 生命周期。

它没有在 remote client 数据面前增加第二份同步 canonical event database。

Codex app-server 自身负责：

- native rollout 持久化；
- thread resume/read/list；
- active turn 和 item snapshot；
- token usage 持久化与连接级 replay；
- 新 connection resume 时重投 pending server requests；
- 无 subscriber 且 thread idle 一段时间后的 unload。

这意味着 bridge 可以依赖 app-server/rollout 恢复历史和终态，而不需要复制所有 delta。

### 4.2 pi-web

pi-web 的关键模式：

- 浏览历史时直接读取 Pi 原生 JSONL，不创建 AgentSession；
- 发送消息时才创建一个 active `AgentSessionWrapper`；
- wrapper 以 session id 注册，并在 idle 10 分钟后回收；
- SDK live event 直接进入 listener，再转发到 per-session SSE；
- SSE 建联阶段只短暂 buffer snapshot race 中的事件，不做长期 replay journal；
- session list 有 30 秒缓存和 concurrent scan coalescing；
- 初次载入可 defer thinking 和 tool-result media。

pi-web 展示的是累计 input/output/cache/cost、context usage 和 active time；当前参考代码没有实现实时 tokens/s。这个统计能力同样不依赖全量 live delta journal。

### 4.3 OpenCode

OpenCode 的 delta path 直接发布 `PartDelta` 到 event stream；完整 part snapshot 在开始、阶段变化和结束时更新。其核心模式也是：

- delta 用于实时展示；
- snapshot/terminal state 用于恢复；
- 不为每条 delta 在 SSE 前追加第二份同步 journal。

## 5. 目标、非目标与不变量

### 5.1 目标

- TUI delta 不再等待 bridge journal 或 canonical reducer；
- 4510 Node RSS 与处理过的历史事件总量解耦；
- bridge 启动和首次连接不加载 936 MiB 旧 journal；
- bridge journal 不再由 delta 驱动线性增长；
- 连接断开后的 active turn、pending input 和 Yep takeover 行为保持不变；
- MCP profile 和 compatibility notification 行为保持不变；
- rollout/session reader 继续提供持久历史和 token usage；
- 可观测性能够区分 parse、profile、projection、queue、append 和 forward 延迟。

### 5.2 非目标

- 不在本计划中重写 Codex rollout reader；
- 不在本计划中实现完整客户端 session SWR cache；
- 不引入 SQLite 或外部数据库；
- 不修改 Codex app-server 协议；
- 不删除现有 bridge journal；
- 不以增大 Node heap 作为修复；
- 不为了保持旧的 full canonical transcript，继续阻塞核心 proxy；
- 不把 VSZ 当作内存验收指标。

### 5.3 功能不变量

实施期间必须保持：

1. JSON-RPC wire 内容默认 byte-for-byte 转发，只有现有 MCP profile 和 compatibility 路径允许修改；
2. 单连接 client/server frame 顺序不变；
3. internal `config/read`、`thread/read` response 不泄漏给下游；
4. server request 在转发前先进入 connection-local pending map，确保 Yep/TUI resolution identity 可用；
5. 同一 pending input 最多 resolution 一次；
6. TUI 断开时，活跃或等待输入的 upstream connection 继续保留；
7. Yep 接管 bridge-owned thread 时不启动第二个冲突 app-server；
8. unknown notification 继续透明转发，diagnostics 不记录 raw payload；
9. optional journal 故障不改变 provider turn 的运行结果；
10. 所有新增持久文件使用 `0600`，目录使用 `0700`。

## 6. 目标架构

```text
                           control plane
Yep main server <----------------------------------+
  |                                                |
  | sessions / active / pending / input / SSE      |
  |                                                v
Codex TUI <---- WebSocket ----> 4510 lightweight bridge
                                   |
                                   | profile injection
                                   | connection ownership
                                   | bounded session state
                                   | pending interaction map
                                   v
                              Codex app-server
                                   |
                                   v
                         ~/.codex/sessions rollout
                                   |
                    +--------------+---------------+
                    |                              |
                    v                              v
              Yep session view              token/history/export

Optional bridge persistence:
  sessions.json                 latest bounded metadata
  lifecycle journal/snapshot    async, compact, no delta
  full diagnostic capture       explicit opt-in, bounded
```

### 6.1 热路径分层

server frame 的处理顺序改为：

1. parse JSON-RPC envelope；
2. 处理 bridge 自己的 internal response；
3. 对 server request/lifecycle event 同步更新有界内存状态；
4. 立即发送原始 frame；
5. 将可选 lifecycle observation 放入后台 writer/coalescer；
6. 后台失败只记录安全 metric，并进入 degraded/circuit-open，不关闭数据面。

client frame 的处理顺序改为：

1. lifecycle method 仍先完成必要的 MCP profile resolution；
2. 同步记录 connection-local request/pending identity；
3. 立即发往 upstream；
4. 可选 lifecycle observation 后台处理。

### 6.2 Bridge journal policy

新增显式 policy，语义如下：

| 模式 | 用途 | 默认行为 |
| --- | --- | --- |
| `off` | 极简代理、故障回退 | 不创建、不加载 bridge event store |
| `lifecycle` | 生产默认 | 只保存 compact lifecycle/terminal snapshot，不保存 delta |
| `full` | 临时诊断/canary | 异步捕获更多事件，仍不得阻塞转发，并受严格字节/事件上限 |

产品决策已确定：生产默认 `lifecycle`。未配置 `YEP_CODEX_BRIDGE_JOURNAL_MODE` 时必须解析为 `lifecycle`；`off` 只作为显式极简回退、性能对照或故障隔离模式，不作为正常生产默认值。

不建议继续提供“full blocking store-before-forward”作为正常运行模式；它只能作为短期兼容开关，并必须显式标记会引入延迟。

### 6.3 事件分类

| 类别 | 示例 | 热路径行为 | 持久化策略 |
| --- | --- | --- | --- |
| 高频 delta | agent text、reasoning、command output、file output、MCP progress | 立即转发 | 默认不持久化 |
| item snapshot | `item/started`、`item/completed` | 更新必要 live state，立即转发 | 通常只保留 completed；若 rollout 已覆盖则不保存 |
| turn lifecycle | `turn/started`、`turn/completed`、non-retryable error | 同步更新 activity | 保存 compact terminal snapshot |
| thread metadata | started/status/name/token usage/goal | 同步更新最新值 | 按 session+field coalesce，只保留最新 snapshot |
| server request | approval/question/elicitation | 同步进入 pending map再转发 | 可保存安全 metadata；callback 以 live map/app-server replay 为准 |
| resolution | client response、`serverRequest/resolved` | 同步完成一次性状态 | 保存 compact resolved marker |
| account/config/diagnostic | rate limit、config warning、unknown | 透明转发 | aggregate/fingerprint only |

### 6.4 为什么不异步保存全部 delta

只把旧 journal 改成 50ms buffer 仍会保留：

- 约 90% 的 delta 磁盘数据；
- 四类原始 event 索引；
- 每连接 reduced state；
- transcript replay 的超大历史；
- 重启后的冷加载；
- 多 journal 重复记录。

它能降低 write syscall 次数，却不能把 4510 变轻。正确方向是省略可由 terminal snapshot/rollout 恢复的 delta，而不是更高效地永久复制它们。

### 6.5 Feishu/Lark channel 兼容边界

Feishu/Lark 机器人不是 4510 的子模块，而是独立的 `FeishuChannelRuntime`。它拥有自己的 account/secret store、scope→session binding、durable inbox、operation projection 和 InteractionBroker。正常的飞书新 session 与 Yep-owned session 直接使用主 runtime；只有绑定 session 正被外部 TUI/4510 持有时，Codex provider 才通过 `/active` 探测后使用 bridge WebSocket resume。

当前 Feishu 实时卡片不读取 bridge JSONL journal。其数据链路为：

```text
Codex provider canonical ingress
  -> runtime SDKMessage
  -> SessionCommandService.subscribe()
  -> FeishuReplyManager / FeishuReplyController
  -> FeishuRichCardProjection
```

因此 `lifecycle` 模式必须遵守：

1. 只移除 `CodexBridgeService` 热路径中的 connection-local ingress，不删除或降级 Codex provider 自己的 canonical ingress；
2. “delta 不持久化”只影响 bridge journal，所有 app-server notification 仍透明转发；
3. server request 必须先进入 bridge pending map，再向下游转发，确保 Feishu/InteractionBroker 能查询和绑定 operation；
4. 保留 `/active`、execution profile、detached connection 和 bridge-owned resume 语义，避免飞书恢复时启动竞争 app-server；
5. provider 继续接收 `codexEventAccountId`，保证 Feishu account attribution、native item、rich card 和 generated artifact provenance 不丢失；
6. bridge journal 写入失败不得把已接受的飞书 turn/card 标记为 runtime failure。

`off` 与 `lifecycle` 都不能恢复 bridge crash 前的 live provider callback；飞书 operation store 的 durable card metadata 仍需等待 app-server resume 后重投 pending request。不得把 lifecycle snapshot 描述成 callback recovery。

## 7. 开发阶段

### 7.1 M0：基线与观测先行

#### 目标

先建立能验证真实热路径的基线，避免继续用人工 batch frame 代表生产 delta。

#### 改动

新增低频聚合指标：

- `codex_bridge_frame_parse_ms`
- `codex_bridge_profile_resolution_ms`
- `codex_bridge_state_projection_ms`
- `codex_bridge_forward_ms`
- `codex_bridge_journal_enqueue_ms`
- `codex_bridge_journal_flush_ms`
- `codex_bridge_journal_queue_bytes`
- `codex_bridge_journal_dropped_events_total`
- `codex_bridge_event_loop_lag_ms`
- bridge `rss/heapUsed/heapTotal/external`
- active connection、detached connection、pending input、ingress/cache/index 数量

日志不得包含 prompt、tool output、command、路径、raw method 或 secret。

新增 `scripts/bench-codex-bridge-forward.ts`：

- fake upstream 连续发送 N 个独立 WS frames；
- 每个 frame 只包含一条 notification；
- 支持 delta 大小、frame 间隔、连接数、session 历史长度；
- 测量 downstream receive 时间；
- 对比 no-journal、lifecycle 和 legacy-full；
- 支持注入慢 store、append failure 和 event-loop pressure；
- 在独立 child process 中测 RSS/heap，避免污染测试 runner。

#### 验收

- 基准明确输出 p50/p95/p99/max；
- 能复现 legacy journal 下的累计延迟；
- 能证明同-frame batching 对真实单-message frame 流量无显著收益；
- 指标开销在 no-journal baseline 中可忽略。

### 7.2 M1：把 delta journal 移出热路径

#### 目标

先解决用户可见延迟和主要增长源。

#### 改动

1. 为 `CodexBridgeServiceOptions` 增加 journal policy；
2. production sidecar 显式选择 `lifecycle`；
3. delta method 使用静态 audited allowlist 分类；
4. delta 不调用 `CodexBridgeEventSpine` / `CodexEventIngress`；
5. delta frame 完成必要 parse 后立即转发；
6. optional writer 使用有界 queue：
   - 全局字节上限；
   - 单连接字节上限；
   - 单 item 合并；
   - overflow 时优先丢弃/合并 delta，不丢 terminal；
7. optional writer failure：
   - 记录固定错误码和 counter；
   - journal circuit-open；
   - proxy 继续运行；
   - 不关闭 downstream/upstream；
8. shutdown 时对 lifecycle queue 做有超时的 best-effort flush。

#### 必须同步修改的测试

旧测试“所有 requests/responses/notifications 在转发前持久化”拆为：

- connection-local critical state 在转发前完成；
- delta 可以在任何 journal flush 前转发；
- terminal/lifecycle journal 不改变 wire order；
- journal failure 不关闭核心 proxy；
- pending request 仍先投影再允许外部 resolution。

#### 验收

- lifecycle 模式下 delta 不产生 bridge journal bytes；
- 100ms artificial append latency 不增加 TUI delta p95；
- 10,000 个独立 delta frames 不形成线性未完成 Promise 链；
- 多连接之间不再因 bridge journal append lock 互相阻塞。

### 7.3 M2：从 bridge 热路径移除 connection-local canonical ingress

#### 目标

消除首次 full replay、逐事件全 state clone 和 connection-local reduced history。

#### 改动

1. `CodexBridgeService` 直接维护已存在的：
   - pending client requests；
   - pending server requests；
   - resolved request ids；
   - thread ids；
   - bounded `SessionRecord`；
2. 对需要持久化的 lifecycle event，构建 compact bridge-specific record，不走通用 `CodexEventIngress`；
3. compact record 不保存：
   - applied event id 全表；
   - observation 全表；
   - 完整 delta payload；
   - connection-scoped secret；
4. request id correlation 只在 connection 存活期保留；
5. app-server resume/replay 重新发出的 pending request 重新建立 live binding；
6. session metadata snapshot 使用 replacement/coalescing，不为每次状态变化追加永久事件。

不得跨连接共享可变 `CodexEventIngress`。如果其他 provider 仍需要 canonical ingress，保留通用实现，但 bridge 不再使用。

#### 验收

- 新连接 resume 不调用 bridge event store 的全 session replay；
- resume 延迟不再随旧 bridge journal 大小增长；
- 100,000 个 delta 后 bridge 内不存在对应数量的 event envelope/index/observation；
- request id 在不同 connection 冲突时仍严格隔离；
- experimental/stable initialize profile 不互相污染。

### 7.4 M3：Canonical consumer 与旧 journal 迁移

#### 目标

停止写新全量 bridge journal，同时不静默破坏已有 transcript/export/overlay 调用方。

#### 消费方审计

逐一确认：

- normal Session GET；
- `view=canonical` overlay；
- canonical transcript export；
- provider error reconstruction；
- generated artifact provenance；
- Feishu projection；
- interaction history；
- diagnostics/coverage tests。

每个 consumer 必须归类：

1. rollout 已完整覆盖；
2. app-server `thread/read/turns/list/items/list` 可恢复；
3. 只需要最新 snapshot；
4. 必须依赖旧 full journal；
5. 可以显式降级或返回 typed unavailable。

#### 迁移策略

- normal UI/history：继续使用 rollout；
- token/context：使用 rollout `token_count` 和 live `thread/tokenUsage/updated`；
- active pending interaction：使用 bridge live map 和 app-server replay；
- goal/name/status：保存最新 bounded snapshot；
- canonical export：优先从 rollout/app-server 构建；无法等价时明确标注 coverage；
- old bridge journal：只读兼容，不在 4510 启动时加载；
- 超出 reader admission 的旧 journal：fallback rollout 或返回稳定 typed error，不触发 OOM；
- 不在本阶段删除、压缩或搬迁用户现有 journal。

停止写入后，现有约 936 MiB 文件保持原位。是否清理或归档必须作为独立维护操作，经用户授权后执行。

#### 验收

- 旧 session 普通查看不依赖 bridge journal；
- 显式 canonical export 能说明 source 和 coverage；
- journal 不可读或超预算时普通 Session GET 仍可用；
- external session 的 goal、pending input、terminal status 不回归；
- generated artifact 不能因 source 降级而绕过 provenance 校验。

### 7.5 M4：仅优化仍然存在的小型 writer

#### 进入条件

只有 lifecycle/full diagnostic 模式仍有明确 durable 需求时才实施。不得为了“已经写了 store”而继续优化无用路径。

#### 改动

- 真正的跨 frame batch，而不是只处理 JSON-RPC batch frame；
- 持久 `FileHandle`，减少每次 open/close；
- 明确 writer lease/lock，不能只用 `assumeSoleWriter` 声明；
- 按实际写入字节推进本进程 snapshot；
- rotate 时安全更换 handle；
- terminal/lifecycle boundary 可选 `datasync`，并明确其 SLO；
- index 只覆盖 retention/window 所需字段；
- replay 冷数据按需回源，不长期驻留；
- index/debug stats 与 generic M1 journal 方案共享，不重复实现。

#### 不采用

- provider 与 bridge 默认无条件开启 `assumeSoleWriter=true`；
- 每条 append 仍执行 `stat` 后声称已接近纯 append；
- 在转发前等待 50ms 跨 frame batch；
- 用同步写 memory buffer、异步 fsync 描述当前不存在的 durability；
- 通过增加 rotate segment 数或 Node heap 延后问题。

### 7.6 M5：统计与体验补充

#### Token 统计

不依赖 delta journal：

- live context fill：`thread/tokenUsage/updated`；
- persisted cumulative usage：rollout `token_count.info.total_token_usage`；
- compaction：沿用 Codex reader 的 segment 规则；
- 可选 tokens/s：
  - 记录 turn/model generation 开始时间；
  - 使用 turn 完成时 output token 增量；
  - 明确标注 wall-clock average 或 generation-only average；
  - 工具执行时间较长时不能把两者混为同一指标。

#### Session 切换

沿用独立计划：

- 服务端 rollout parse/content cache；
- 客户端最近 session snapshot LRU/SWR；
- defer 大 reasoning/media；
- 活跃 session 增量刷新；
- 不把“4510 TUI delta 快”当成“Yep session 切换快”的替代验收。

## 8. 测试计划

### 8.1 单元测试

- event method classification 完整性；
- delta/lifecycle/terminal policy；
- lifecycle coalescing；
- queue 字节和事件上限；
- overflow 优先级；
- journal circuit breaker；
- connection-local request id 隔离；
- pending input at-most-once；
- session snapshot 权限和 redaction；
- old journal source fallback/coverage。

### 8.2 Bridge 集成测试

使用 fake WebSocket upstream/downstream：

- 10,000 个独立 single-message frames；
- 同一连接严格顺序；
- 多连接并发；
- 慢 journal；
- append rejection；
- TUI 断开但 active turn 继续；
- TUI 断开后 Yep 获取和解决 pending input；
- Yep 连接 bridge 后 resume active turn；
- `turn/steer` race fallback；
- clear/light/full profile；
- `config/read` 和 resume 缺 cwd 的 `thread/read`；
- compatibility MCP startup sentinel；
- unknown event 透明转发和安全 diagnostics。

### 8.3 Store/consumer 回归

- provider canonical journal 现有测试保持；
- bridge 不再写 delta 的 golden；
- rollout transcript 与旧 canonical transcript 的明确 coverage 对照；
- canonical overlay fallback；
- generated artifact provenance；
- Feishu/interaction consumer；
- old retained segments read-only。

### 8.4 Feishu × Bridge 兼容测试

现有 Feishu 测试大多 mock `SessionCommandService`，缺少真实 `FeishuChannelRuntime`/reply pipeline 与 `CodexBridgeService` 的跨组件覆盖。新增：

- 飞书绑定 session 被外部 TUI 持有时，通过 `bridge-websocket` resume，不启动竞争 app-server；
- `lifecycle` 模式下飞书仍收到 text delta、`codexThreadItem`、turn terminal 和 card update；
- bridge-owned approval/question 能投影为飞书卡片，并经 InteractionBroker 完成一次性 resolution；
- bridge journal 慢写、拒绝或 circuit-open 不使飞书 turn/card 失败；
- provider canonical ingress 仍生成 native item 与 generated artifact provenance；
- old-turn terminal、runtime generation replacement 和 pending request identity 不因 bridge 模式变化而串线。

### 8.5 性能与内存测试

在独立进程、固定 Node 版本下：

- no-journal baseline；
- lifecycle mode；
- legacy full mode；
- 1/4/8 connections；
- 1 KiB/16 KiB/64 KiB delta；
- short session 和预热 long session；
- 100,000 delta steady state；
- slow disk 和 journal failure；
- GC 后 heapUsed、RSS、external；
- event-loop p95/p99；
- journal bytes/event。

性能结果必须记录 buildId、Node 版本、Codex protocol version、journal mode 和 fixture 参数。

## 9. 验收门槛

### 9.1 功能

- `cf` TUI 可正常 start/resume/fork；
- clear/light/full profile 行为不变；
- TUI 断开后 active turn 继续；
- Yep 能看到 ownership、activity 和 pending input；
- Yep 能接管并 steer active turn；
- approval/question 不重复响应；
- unknown/newer app-server event 不被 bridge 吞掉；
- native rollout 历史完整可读；
- journal 故障不终止 provider turn；
- 飞书机器人账号、scope binding、durable inbox 和 operation store 行为不变；
- bridge-owned session 的飞书实时回复、approval/question 和 generated artifact projection 不回归。

### 9.2 延迟

独立 loopback 基准建议门槛：

- lifecycle 模式 delta bridge added latency：p95 ≤ 5 ms，p99 ≤ 20 ms；
- 或在跨平台 CI 中使用相对门槛：p95 不超过 no-journal baseline + 5 ms；
- artificial 100ms journal flush 不增加 delta p95 超过 5 ms；
- 多连接场景一个慢 journal consumer 不影响其他连接；
- 首次 resume 不随 bridge journal retained bytes 线性增长。

### 9.3 内存与磁盘

- 100,000 delta 后 bridge heap 不保留对应数量的 envelope/observation；
- synthetic steady-state 额外 heap 增长 ≤ 50 MiB；
- 现场重启后的 4510 Node 稳态 RSS 目标 < 300 MiB，不含 managed app-server；
- lifecycle 模式下 delta 造成的 bridge journal 增长为 0；
- lifecycle state 的内存与 session/active connection 数相关，而不是历史事件总量；
- old journal 不被 sidecar writer 冷加载。

绝对 RSS 目标需在 M0 基线后允许一次评审调整，但不得只用“增长明显趋缓”作为模糊验收。

## 10. 风险与处理

### 10.1 Canonical transcript 信息减少

风险：不保存 delta 后，旧 canonical transcript 可能失去逐 chunk 时间线。

处理：

- terminal item snapshot 和 rollout 是内容权威；
- export metadata 明确 source/coverage；
- 只有确有审计需求时才启用 bounded full capture；
- 不为了逐 chunk 时间线牺牲默认代理性能。

### 10.2 Bridge crash 时 pending input

风险：connection-local callback 无法由普通 snapshot 恢复。

处理：

- 不伪装 journal 能恢复 callback；
- app-server resume 时重投 pending server request；
- live takeover 依赖 retained upstream；
- bridge restart 恢复为 idle/unknown，重新连接后以 app-server snapshot 为准；
- 若未来要求跨 bridge crash 无缝接管，应单独设计 managed app-server daemon/reattach，而不是保存更多 delta。

### 10.3 Optional writer 背压

风险：磁盘长期不可写导致 queue 增长。

处理：

- queue 有硬字节上限；
- snapshot 同 key coalesce；
- delta 不入队；
- terminal 优先；
- circuit-open 后停止继续分配；
- 仅输出低频安全告警。

### 10.4 Old journal 兼容

风险：停止写后旧 transcript/export 行为变化。

处理：

- read path 与 write path 分离；
- old source 只在显式请求时创建；
- admission 前置；
- fallback 和 typed error 有稳定测试；
- 不自动删除用户数据。

### 10.5 Profile 与多 app-server

风险：为了减少进程数错误合并 clear/light/full。

处理：

- profile app-server 继续按需启动；
- 当前只运行一个 profile，进程数不是主要问题；
- apps/plugins 等 process-level 差异未证明可安全统一前，不合并 profile。

### 10.6 误伤 Feishu provider projection

风险：实现者把“移除 bridge ingress”误扩展为删除 Codex provider canonical ingress，或把“不持久化 delta”实现成“不转发 delta”，导致飞书卡片失去正文、native item、工具状态或 generated artifact provenance。

处理：

- bridge journal mode 与 provider event-spine rollout config 使用不同配置和类型；
- provider `CodexEventIngress`、`attachCanonicalCodexItem()` 和 artifact materializer 保持原语义；
- wire forwarding policy 与 persistence policy 分开测试；
- 增加 8.4 的跨组件测试作为发布门禁。

## 11. 回滚与灰度

建议使用一个面向语义的总开关，而不是多个实现细节 flag：

```text
YEP_CODEX_BRIDGE_JOURNAL_MODE=off|lifecycle|full|legacy-blocking
```

- `lifecycle`：生产默认模式；未设置环境变量时使用该值；
- `off`：最小安全回退；
- `full`：有界异步诊断；
- `legacy-blocking`：仅短期灰度回退，明确会恢复延迟和内存问题，后续删除。

灰度步骤：

1. 离线 fake upstream 基准；
2. 单元/集成测试；
3. lifecycle 模式本地 canary；
4. 比较 TUI latency、RSS、journal bytes 和 pending input；
5. 观察一段真实 session；
6. 再决定是否移除 legacy mode。

部署、重启 4510/8022、真实 canary 和 journal 清理都需要单独授权。

## 12. 预计改动范围

核心：

- `packages/server/src/codex-bridge/CodexBridgeService.ts`
- `packages/server/src/codex-bridge/CodexBridgeEventSpine.ts`
- `packages/server/src/codex-bridge/standalone.ts`
- `packages/server/src/codex-bridge/types.ts`
- `packages/server/src/config.ts`

可能新增：

- `packages/server/src/codex-bridge/event-policy.ts`
- `packages/server/src/codex-bridge/LifecycleJournal.ts`
- `packages/server/src/codex-bridge/metrics.ts`
- `scripts/bench-codex-bridge-forward.ts`

Canonical consumer：

- `packages/server/src/codex-events/source.ts`
- `packages/server/src/routes/codex-transcript.ts`
- `packages/server/src/routes/sessions.ts`
- `packages/server/src/codex-events/session-projection.ts`

测试：

- `packages/server/test/codex-bridge/CodexBridgeService.test.ts`
- `packages/server/test/codex-events/store-jsonl.test.ts`
- `packages/server/test/codex-events/store-replay.test.ts`
- `packages/server/test/codex-events/ingress.test.ts`
- `packages/server/test/routes/sessions-canonical-overlay.test.ts`
- `packages/server/test/channels/feishu/inbound-processor.test.ts`
- `packages/server/test/channels/feishu/reply-manager.test.ts`
- `packages/server/test/channels/feishu/reply-controller.test.ts`
- `packages/server/test/channels/feishu/interaction-manager.test.ts`
- canonical transcript、artifact、Feishu/bridge integration 相关测试

不应默认修改：

- Codex protocol generated files；
- `references/codex`；
- native rollout 格式；
- Pi provider；
- 客户端 locale 以外的语言。

## 13. 验证命令

聚焦测试：

```bash
corepack pnpm --filter @yep-anywhere/server test -- \
  test/codex-bridge/CodexBridgeService.test.ts \
  test/codex-events/store-jsonl.test.ts \
  test/codex-events/store-replay.test.ts \
  test/codex-events/ingress.test.ts \
  test/routes/sessions-canonical-overlay.test.ts \
  test/channels/feishu/reply-manager.test.ts \
  test/channels/feishu/reply-controller.test.ts \
  test/channels/feishu/interaction-manager.test.ts
```

全局检查：

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
```

只有新增 E2E 覆盖确有必要时才运行 `pnpm test:e2e`。浏览器自动化、服务重启、部署和真实 app-server model smoke 均需先取得用户授权。

## 14. 发布要求

实现会改变正式部署产物中的 Codex bridge 性能、失败语义和 journal 行为，因此开发时必须：

- 更新 `CHANGELOG.md` 的 `[Unreleased]`；
- 在日志/build 信息中可识别 journal mode；
- 发布前运行 `pnpm version:check`；
- 不在开发阶段擅自提升版本或部署；
- 不自动删除现有 bridge journal。

## 15. 实施前待确认

进入编码前需确认以下产品选择：

已确认：生产默认使用 `lifecycle`；`off` 不是默认模式。

仍需确认：

1. external Codex session 的逐 chunk canonical transcript 是否是硬需求；
2. lifecycle snapshot 是否需要保存 completed item，还是完全依赖 rollout；
3. goal/plan 是否进入 `sessions.json` 最新状态；
4. bridge restart 后 pending input 的目标语义是“重新 resume 恢复”还是要求无缝 reattach；
5. old full journal 的保留周期和未来清理方式；
6. 现场 4510 Node RSS 目标是否采用 <300 MiB；
7. full diagnostic capture 的最大字节、最长持续时间和自动关闭策略。

在这些选择收口前，可以先完成 M0 基准、M1 的 lifecycle 默认配置和 policy/test scaffolding，但不应删除旧路径。
