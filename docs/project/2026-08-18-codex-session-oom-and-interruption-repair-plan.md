# Codex 会话 OOM 崩溃与错误中断归因修复计划

> Task：`codex-session-oom-and-interruption-repair`
>
> 状态：**有条件通过评审；按本文“实施前必须收口”修订后再实施**
>
> 计划日期：2026-08-18
>
> 现状审核日期：2026-08-18 15:39 CST
>
> 审核基线：仓库 HEAD `dcd6c811b767556c9deb4b559a646c7469e74e18`；当前 8022 运行构建 `ef8fb1f038c2fc3f19d0afb6adb1771e0d04b5f5`
>
> 关联文档：[`2026-08-13-codex-event-journal-memory-plan.md`](./2026-08-13-codex-event-journal-memory-plan.md)

## 1. 概述

修复 Yep 8022 服务读取超大 Codex rollout / canonical event journal 时触发 Node OOM 并中断会话的问题；同时把通用 `turn_aborted` 从误导性的 “Conversation stopped by user” 改为基于可验证证据的中断原因展示。

计划按“止血与观测 → journal 内存有界化 → rollout 流式分页 → 中断 provenance → 验证与发布”推进。本计划阶段不重启、不部署、不改动当前运行服务。

## 2. 审核结论

### 2.1 总体判断

计划方向正确，里程碑顺序基本合理，可以作为正式修复的主计划；但当前版本仍有若干契约没有定义清楚，原样实施会在“内存下降”和“历史正确性”之间留下新的灰区。因此结论是**有条件通过**，不是直接进入全量编码。

当前证据支持一个高置信度的复合故障模型：canonical journal 的长期常驻索引把 Node 推到很高的内存基线，超大 rollout 的 `readFile → string → split → JSON.parse → entries[] → branch/message projection` 再产生瞬时峰值，最终触发 OOM。现有日志能证明 OOM、`StringSplit` / `JSON.parse` 分配栈和相邻的 `turn_aborted`，但没有足够的逐操作内存水位把两次崩溃唯一归因到某一个调用点；M0 的观测与 admission 正是用来补齐这条证据链。

### 2.2 当前状态总览

| 领域 | 当前源码现状 | 评审判断 |
| --- | --- | --- |
| 错误中断文案 | server normalization 与 client preprocessing 都把任意 `turn_aborted` 固定写成 “Conversation stopped by user” | 误归因已确认，M0 应同时改 server fallback 与 client renderer，不能只改 `preprocessMessages.ts` |
| maintenance memory | `/status` 已有 `rss`、`heapUsed`、`heapTotal`、`external` 和 `process.memoryUsage()` raw 值 | 属于“扩展现有观测”，仍缺 V8 heap limit、实例 ID、clean shutdown、工作水位；当前部署的 8023 端口不可达 |
| rollout reader | `codex-entries-reader.ts` 仍全文读、全文 `split("\n")` 并保留完整 `entries[]` | 直接攻击面成立；single-flight 只把同路径并发 N 份降到 1 份，不限制单份峰值 |
| reader / 分页 | summary、branch projection、normalization 完成后，route 才切 `maxMessages` / cursor page | 当前客户端虽会请求 `tailCompactions=2&maxMessages=...`，但只缩小响应与 augmentation，不降低 reader 峰值 |
| SessionIndex | cache miss 仍调用完整 `getSessionSummary()`；full-validation 是全局 shaping，但按 scope 历史和等待超时允许绕过 | 不是硬并发上限，也没有单文件或加权字节 admission |
| event journal | 已有 8 MiB chunk cold load、rotation/prune、gap 报告和有界 projection cache | 四类长期索引仍不裁剪；同一路径的 writer/reader 仍可能各持一份 store；source freshness 会冷加载所有候选 journal |
| rollout 流式基础 | 已有 offset anchor、zstd 支持、first-line streaming、tail-read safety helper 与 partial-read parity 测试 | 是良好基础，但生产 detail/summary 尚未接入 tail/page scanner |
| provenance | rollout schema 保存 coarse `reason`，session health 只有 `interrupted`；没有 actor/cause provenance | M3 尚未实现；Codex 参考协议也只把 `turn_aborted` 映射成 `interrupted`，不会证明 actor |
| runtime journal | `RuntimeEventStore` 配置了 10 MiB 单文件 rotation、512 MiB 总量与 7 天保留；总量/保留期 prune 目前只在 initialize 执行 | 它当前按 process 存完整 stream message、没有单 record cap，且 session replay 默认只找最新 process；不能直接等同于服务实例 lifecycle ledger |
| benchmark / 发布 | 已有 `scripts/bench-session-load.ts`，但它刻意测旧的全文路径；`CHANGELOG.md [Unreleased]` 当前为空 | M4 有脚手架，尚无新实现的受限 heap 验收与变更记录 |

### 2.3 实施前必须收口

1. **定义 journal coverage，而不是含糊使用“完整 replay”**。磁盘 segment 会被物理删除，因此裁剪内存后最多保证“保留窗口内完整”。`replay()` 或旁路 API 必须返回 `firstAvailableSequence` / `lastSequence` / leading-gap 等 coverage；要求完整前缀的 consumer 遇到 gap 时必须 fallback 或显式失败。
2. **明确 sequence 高水位的重启语义**。只加不可裁剪的内存 Map，无法解决“某 session 所有 event 都已被 prune，重启后 sequence 回到 1”。若验收要求跨 prune + restart 单调，必须持久化紧凑 high-water metadata；如果不要求，就要把契约和限制写进验收条件。
3. **把预算实现为集中式、加权 admission reservation**。仅检查一次 `heapUsed` 或只设并发数存在 TOCTOU；应按预计读取/索引字节先 reserve、`finally` release，并定义 rollout detail、summary/index、canonical overlay、export/clone 各自的拒绝或 fallback 语义。
4. **给 cursor 加文件 revision / snapshot 语义**。rollout 在分页期间可能 append、replace 或新增 rollback marker。仅凭 message UUID/byte offset 不足以证明跨页仍属于同一历史快照；旧 cursor 需兼容，新 cursor 需能检测 stale revision 并重试或返回稳定错误。
5. **把 M0 的文案修复放到真实渲染边界**。server `codex-turn-aborted.ts` / `normalization.ts` 要给旧客户端中性英文 fallback；新 client 应在 `RenderItemComponent` 按 subtype/provenance 走 i18n。`preprocessMessages.ts` 不应继续硬编码最终用户文案。
6. **让 interrupt 成功结果携带精确 turn identity**。当前 `AgentSession.interrupt?: () => Promise<void>`、`Process.interrupt(): Promise<boolean>` 和 runtime API 都丢失 `turnId`。M3 要扩展这条 contract，不能靠“session 当前最后一个 turn”猜测。
7. **区分 runtime instance 与 web shell instance**。external runtime 模式下 web/API shell 重启不会中断 agent；provenance 的 `runtimeInstanceId` 必须指真正持有 provider process 的 runtime。clean shutdown marker 也必须在终止 active provider 之前 durable flush。
8. **补齐受影响文件与测试**。至少还包括 client renderer/types/list propagation、runtime HTTP/control protocol、server shutdown owner、provider `AgentSession` contract，以及现有 runtime/maintenance tests；“files to modify”只能作为起始清单，不能作为封闭边界。

## 3. 目标

- 阻止单个大 rollout、session index 冷扫、canonical journal replay 及其并发组合耗尽 Node 堆。
- 保证历史正确性：无法在预算内严格还原 rollback/branch 历史时，显式降级或报错，绝不返回看似成功但错误的 transcript。
- 区分用户主动中断、受控服务重启、非正常 runtime 退出、上游失败和未知原因；旧数据缺证据时默认 `unknown`。
- 给 rollout、event journal、session index 与运行时生命周期增加不泄露 prompt/stdout 的可观测性。
- 保持 Pi、Codex、压缩 rollout、message UUID、分页 cursor、event replay/dedupe 和旧客户端兼容。

## 4. 非目标与约束

- 不把增大 Node heap 当成修复；它只会延后故障并扩大主机竞争。
- 不删除 rollout / journal，不用数据丢失换内存下降。
- 不在本计划阶段部署、重启或接管当前 8022 / 4510 服务。
- 不默认启用 heap snapshot；snapshot 可能包含 prompt、tool output、secret 和路径。
- 不运行浏览器自动化；后续若确需 UI/browser 验证，先取得用户明确授权。
- 不修改、删除、暂存或提交用户的未跟踪文件 `context.md`。
- UI 只维护 `en` 与 `zh-CN`。
- 正式修复必须更新 `CHANGELOG.md` 的 `[Unreleased]`。

## 5. 事故事实与现状核验

### 5.1 事故事实

1. 目标 Codex session `01a01391-…` 在本地时间 14:32:57 与 14:33:59 两次写入 `turn_aborted(reason="interrupted")`，两个 marker 都带不同且明确的 `turnId`。
2. Yep Node 进程 `62854`、`74117` 的 stderr 都记录了约 4 GiB heap 使用后的 `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`；native stack 落在 `JSON.parse`，同一保留日志中也存在 `Runtime_StringSplit` OOM 栈。
3. 捕获的该 session canonical journal 共 310 个 event，没有 `turn/interrupt` method，也没有其他名称含 `interrupt` 的 control event，因此没有用户主动停止的正证据。
4. 原 Pi session 在 14:29 的 `provider_transport_failure: WebSocket error` 与后续 Codex backend overloaded 应作为独立上游失败保留，不能被 server OOM 修复覆盖。该条来自事故输入；本次静态审核未在当前保留的定向日志片段中重新定位到原记录，因此实施 incident 文档时应补入原始证据引用或标记来源。

### 5.2 2026-08-18 15:39 CST 运行态快照

- 8022 listener 为 PID `80455`，启动时间 14:33:59，RSS 为 `3,797,696 KiB`，约 **3.62 GiB**；事故输入中的“约 2.7 GB”应视为更早快照，不再是当前值。
- 独立 Codex bridge PID `62826` RSS 约 **690 MiB**。
- 8023 maintenance `/status` 当前不可达，PID `80455` 只监听 8022；因此当前运行实例无法通过 maintenance 获取 `heapUsed` / `heapTotal`，只能从 `ps` 得到 RSS。
- provider journal 为 3 个 closed segment + active，总计 `866,151,263 bytes`，约 **826.0 MiB**。
- bridge journal 为 2 个 closed segment + active，总计 `740,800,240 bytes`，约 **706.5 MiB**。
- 运行实例版本为 `2026.8.5`，build commit 是 `ef8fb1f0`；当前仓库 HEAD 是 `dcd6c811`。核心 rollout/event-store 文件在这段差异内没有被替换，但 routes/index/client 有后续变更，后续复现必须记录 buildId，不能只记录版本号。

### 5.3 已定位的 rollout 攻击面

- `~/.codex/sessions` 下已核验到一份 api-testing rollout：`188,688,377 bytes`、`32,341` 行、最大单行 `2,301,299 bytes`、`53` 个 `compacted` entry、无 `thread_rolled_back` marker。
- `packages/server/src/sessions/codex-entries-reader.ts` 当前流程是全文 `readFile → UTF-8 string → split("\n") → JSON.parse → entries[]`。一个大文件会同时存在 Buffer / external allocation、UTF-16 string、行数组、JSON 对象、branch/message 投影；OOM 栈与该分配形态吻合。
- `CodexSessionReader.getSession()`、`getSessionSummary()` 和 `routes/sessions.ts` 在 reader 全量解析、branch projection、normalization 后才切 page；现有 `maxMessages` 只能缩小最终响应和 augmentation。
- 当前客户端初始加载已经发送 `tailCompactions=2` 与 `maxMessages`，所以客户端 UX 的分页协议已有基础；问题是该窗口没有前推到 reader。
- `SessionIndexService.runFullValidation()` 的 cache miss 会调用全量 `getSessionSummary()`。其 full-validation slot 是全局 shaping，但 cheap-scope 与 1 秒 wait timeout 都允许绕过，无法作为大 rollout 的硬内存上限。
- 已有 `codexEntryAnchor`、zstd 解压、streaming first-line reader、`codexRolloutSupportsTailRead()` 与 `codex-partial-read-parity.test.ts`；这些是 M2 可复用基础，不代表生产 tail read 已经落地。
- `fork.ts` clone、agent mapping、subagent content 等残余 consumer 仍可能走全文读取，必须一起审计。

### 5.4 已定位的 journal 攻击面

- `JsonlCodexEventStore` 磁盘 cold load 已按 8 MiB chunk 读取，但长期保留 `eventsBySession`、`eventsBySessionMethod`、`eventsByIdentity`、`eventsByDedupeKey` 四类索引。
- rotation / prune 已落地，且会报告 per-segment session counts 与 cold-load leading gaps；但 `rotateIfNeeded()` 明确保留已 rotation/prune event 的内存索引，运行越久常驻内存越大。
- sequence 仍取 `eventsBySession[session].at(-1) + 1`；某 session 的历史全部被 prune 并经历重启后，当前实现无法知道过去高水位。
- route reader 与 provider / bridge writer 各自构造 store，同一 file path 在同一进程内可能有两份长期索引。
- `source.ts` 为比较 freshness 会调用每个 source 的 `latestEventAtMs()`，冷态会加载所有候选 journal；选中后再为该 session materialize replay。
- projection cache 已有 LRU / event-count waterline，但它限制的是 reducer output，不限制原始 envelope store；不能把二者混为同一修复。

### 5.5 已定位的错误归因

- `packages/server/src/sessions/codex-turn-aborted.ts` 把展示常量固定为 “Conversation stopped by user”。
- `normalization.ts` 将任意 `turn_aborted` 转成相同固定文案，并丢掉 raw `reason` / `turnId`。
- `packages/client/src/lib/preprocessMessages.ts` 再次无条件覆盖为相同文案。
- `RenderItemComponent.tsx` 只显示 `SystemItem.content`，没有按 subtype/provenance 走 i18n。
- upstream Codex `TurnAbortedEvent` 的结构化 reason 至少包括 `interrupted | replaced | review_ended | budget_limited`；`interrupted` 只表示结果状态，不携带 actor。app-server 的 `turn/completed(status="interrupted")` 同样不证明是用户触发。
- Codex app-server 的 `turn/interrupt(threadId, turnId)` 成功响应在收到 `TurnAborted` 后才返回，因此“同 turn 的成功 RPC response”是可靠的 confirmed user-control 证据；HTTP 到达或请求发出本身不是。

## 6. 总体方法

采用五个有明确退出检查的里程碑，遵循三个原则：

1. **先保证真实性，再追求完整性**：无法证明用户中断时不显示用户中断；无法在预算内严格恢复历史时不伪造完整历史。
2. **先切断无界分配，再优化性能**：硬 admission、event-store 常驻内存上界先落地；流式读取、分页、索引与 provenance 再逐步替换全文路径。
3. **预算要可组合**：单文件预算、全局加权 reservation、单行预算、replay response budget 和持久索引 waterline 必须共同成立，不能只靠一个并发数字。

里程碑顺序：

- M0：止血、基线、观测、admission 与 UI `unknown` fallback。
- M1：canonical event journal 的内存有界化、coverage 与 source replay admission。
- M2：Codex rollout 的流式 scanner、reader 前分页与 rollback-safe 语义索引。
- M3：持久化中断 provenance、受控 restart / 非正常 runtime 退出恢复与双语 UI。
- M4：压力验证、回归、文档、变更日志和经授权的部署演练。

## 7. M0：止血、基线和可观测性

### 7.1 目标

在不伪造历史语义的前提下立即停止错误归因，并让后续实施能量化 heap、rollout、journal 与读路径增长；在流式 reader 落地前，用硬 admission 阻止已知危险输入继续进入全文路径。

### 7.2 实施步骤

1. 同时修改 server 与 client 的 `turn_aborted` fallback：
   - server `codex-turn-aborted.ts` / `normalization.ts` 给旧客户端返回中性英文 “Conversation interrupted”，同时保留 raw `reason`、`turnId` 和时间字段；
   - `preprocessMessages.ts` 只产生语义化 `SystemItem`，不再硬编码最终文案；
   - `RenderItemComponent.tsx` 按 `turn_aborted` subtype 使用 i18n，新增 `en` / `zh-CN` 文案。
2. 扩展 `packages/server/src/maintenance/server.ts` 的既有 `/status`：补充格式化的 `arrayBuffers`、V8 heap limit、runtime instance ID、进程启动时间、上次 clean shutdown 状态和各重型工作水位。保留 raw numeric bytes，避免只有格式化字符串。
3. 为 Codex rollout read、session index scan、canonical overlay/replay 加结构化低频指标：路径 hash、文件大小、预估/实际读取字节、最大行字节、解析 entry 数、输出 message 数、耗时、admission wait、reservation bytes、拒绝/降级原因；禁止记录 prompt、tool output、路径明文或 secret。
4. 新增集中式 heavy-read admission controller：
   - 配置最大单行、最大单次扫描字节、最大 canonical replay bytes/events、最大紧凑索引字节、全局 reservation bytes、重型 scan 并发和内存软阈值；
   - admission 在调用全文 reader / replay 前完成，按预估字节 reserve，所有出口 `finally` release；
   - 超限返回稳定 code，不得偷偷进入旧全文路径。
5. 明确每条路径的降级矩阵：
   - session detail：返回结构化 `SESSION_HISTORY_BUDGET_EXCEEDED` / `SESSION_HISTORY_UNAVAILABLE`，不返回错误 transcript；
   - summary/index：优先带 `stale/incomplete` 标记返回已验证缓存；无缓存时记录不可索引项，不能把空 summary 当成真实空会话；
   - canonical overlay：只有 legacy rollout view 已被安全取得时才 fallback；否则传递 detail error；
   - export/clone/fork：显式拒绝并说明需要的预算，不做部分成功。
6. 增加独立 child-process benchmark / stress 基础设施：使用生成的临时 JSONL 与 `--max-old-space-size`，不在当前 8022 或普通 unit test 内生成 188 MiB fixture。

### 7.3 完成检查

- 新建/回放的 generic `turn_aborted` 不再显示 “stopped by user”；旧 client 也至少收到中性英文 fallback。
- maintenance status 可返回 heap/RSS/V8 limit、runtime instance 与无内容泄露的工作水位。
- 所有新增 metrics 字段都有单测，异常路径不记录原始 transcript 或路径明文。
- 预算超限能够返回结构化错误/显式降级，且 spy 证明未调用全文 reader。
- focused tests 至少覆盖 preprocess、renderer、normalization、maintenance 与 admission controller。

## 8. M1：Canonical event journal 内存有界化

### 8.1 目标

消除 `JsonlCodexEventStore` 将运行期全部历史常驻内存的行为，同时明确 retained-history coverage，保持 sequence、replay、method filtering、dedupe 和 canonical projection 的可验证契约。

### 8.2 实施步骤

1. 在 `packages/server/src/codex-events/store.ts` 暴露受限 `getDebugStats()`：每类索引条数、估算字节、已载 segment/epoch、first/last available sequence、eviction、磁盘回源次数与 budget rejection；在 cold load、append、rotation/prune 后更新。
2. 引入 compact sequence/freshness/coverage metadata：
   - `sessionId → lastSequence` 不再依赖可裁剪 session array；
   - 若要求跨“全部 event 已 prune + restart”连续，metadata 必须 durable、原子更新且按 session 数设 admission 上限，不能只放内存 Map；
   - metadata 同时提供 source freshness，避免仅为比较 provider/bridge 而 cold load 全部 journal。
3. 给 replay 增加 coverage contract。热窗口直接从内存返回；请求穿越内存裁剪边界时流式回读**仍保留在磁盘上的** segment，只构建本次受预算约束的 response，不重新进入长期索引。若磁盘已有 leading gap，要求完整前缀的调用方必须 fallback/失败。
4. 引入 segment epoch 或明确的总 byte/event waterline。rotation/prune 后同步从 `eventsBySession`、method、identity、dedupe 索引移除不允许常驻的 event；四类索引和辅助 bookkeeping 都必须计入 stats。
5. 明确 dedupe window：
   - hot/retained window 内继续严格幂等；
   - 内存 miss 时可对 retained segment 做受预算的磁盘验证；
   - 已物理 prune 的 key 无法验证，必须把该限制写入 contract，或另建 durable compact dedupe metadata；不能声称 lifetime dedupe 仍然成立。
6. 审计 `createDefaultCodexTranscriptStoreSources()`、`app.ts`、provider writer、bridge writer 的 store 所有权。同一 8022 进程内同一 path 只保留一个 owner；优先显式依赖注入 writer store 到 readers，若采用 registry，必须解决 rotation options、callbacks、close/reset 和测试隔离冲突。4510 bridge 仍保留独立 source 和独立 sequence 空间。
7. 改造 `source.ts` freshness 选择：优先 compact metadata；metadata 不可用或 coverage 不安全时回退 legacy view 并记录固定 reason code，不允许为了 source ranking 无条件 cold load 所有大 journal。
8. 验证 `CodexEventIngress`、projection cache、artifact 恢复、Feishu 排序和 reconnect dedupe。任何 consumer 若依赖完整前缀，必须显式声明 `requiresCompletePrefix` 或检查 coverage，不能默认部分 replay 等价于完整历史。

### 8.3 完成检查

- 长时间 append/rotation 后 store 的四类内存索引有明确 byte/event 上界，stats 能显示水位、eviction 和 coverage。
- 裁剪后的 session 再 append 时 sequence 单调；若验收包含进程重启和全量 prune，则 durable high-water 用例也必须通过。
- retained-history replay、`afterSequence`、`throughSequence`、methods filter、latest event time、projection cache 前缀校验通过回归。
- leading gap 不再静默投影为“完整 canonical history”。
- 8022 内同 path 不再保留 writer/reader 两份完整 event 索引。
- replay response 本身也受 bytes/events budget，不因“store 已有界”而允许单请求重新 materialize 无界数组。

## 9. M2：流式 Codex rollout 与 reader 前分页

### 9.1 目标

消除 rollout 正文路径的全文字符串、全文 split、完整 entries[] 以及“先全量后分页”；保持 message UUID/cursor、rollback/branch、compaction 和 tool call/result 语义正确。

### 9.2 分阶段实施

M2 是本计划风险最高、影响面最大的里程碑，拆成四个可独立退出的子阶段：

- M2a：统一 line iterator + streaming summary。
- M2b：无 rollback 文件的 reader 前 page。
- M2c：rollback-safe semantic index 与 branch page。
- M2d：残余全文 consumer 收口。

### 9.3 实施步骤

1. 在 `packages/server/src/sessions/codex-rollout-file.ts` 新增统一 `openCodexRolloutStream()` 与 async byte-line iterator：plain 使用 `createReadStream`，zstd 使用 streaming decompressor；offset 按解压后的原始 JSONL bytes 计算。
2. iterator 在累积完整巨行前按 bytes 检查 `maxRolloutLineBytes`，并处理 BOM、严格 UTF-8、CRLF/LF、跨 chunk 字符、partial final line、stream abort 和 decompressor error。超限时不调用 `JSON.parse`，返回稳定 `entry_too_large` / `scan_budget_exceeded`。
3. 每次 scan 使用打开文件的 identity + pre/post stat 形成 `rolloutRevision`。扫描期间发生 replace/truncate 或不允许的 append 时重试有限次数或返回 `ROLLOUT_CHANGED_DURING_SCAN`，不能混合两个文件版本。
4. 将 `codex-entries-reader.ts` 拆成：
   - `scanCodexRolloutSummary()`：流式聚合 title/count/model/usage/compaction/last status；
   - `scanCodexRolloutPage()`：按 page/cursor/branch 只保留页面需要的 entry 和有限上下文；
   - 紧凑 semantic index：offset、turn/branch/compaction/tool correlation 与 file revision，不缓存原始 prompt/tool output。
5. summary 与 semantic index 都设硬 byte/entry 上限。`userQuestions`、branch options、compact events 等天然随历史增长的 summary 字段要么有明确 cap/分页，要么进入有界持久索引；不能把“对象比 entries 小”当成内存有界。
6. single-flight 只共享同一 path + revision + budget profile 的紧凑 scan/index；全局 admission 使用预估字节加权，不只按请求个数设 semaphore。
7. `CodexSessionReader.getSessionSummary()`、`getSessionSummaryIfChanged()`、`listSessions()` 与 `SessionIndexService.runFullValidation()` 改走 streaming summary；cache 只保存 summary、stat、revision 和受限 branch/offset metadata。
8. 扩展 `GetSessionOptions`，把 `maxMessages`、`tailCompactions`、`beforeMessageId`、`aroundMessageId`、`afterWindowMessageId`、`afterMessageId`、selected branch、rollout revision 和 budget profile 在 `getSession()` 前传入；`routes/sessions.ts` 只 augmentation reader 返回的 page。
9. 对无 rollback marker 的文件，先实现 latest page、向前 page、around page 和 forward page；沿用 `codexEntryAnchor`，但 cursor 同时携带 revision。旧 message-id cursor 继续兼容，无法证明 snapshot 一致时保守重扫或报 stale。
10. `convertCodexEntries()` 当前有多次全数组 pre-pass（compaction timestamp、image generation、patch apply、direct edit、tool context）。page scanner 必须把这些依赖显式建入有限 semantic context；不能简单把 tail entries 传给旧 converter 就宣称 parity。
11. 对含 `thread_rolled_back` 的文件，先流式建最小 branch/turn/compaction index，再按选定 branch 读取 page。若索引尚不能证明与全文 reference 严格等价，返回 `SESSION_HISTORY_UNAVAILABLE` / budget error，禁止盲目 tail read。
12. 审计并改造残余全文入口：agent mappings/subagent content、`normalization.ts` 调用方式、`fork.ts` clone、rollback/edit、archive/export。必须流式、分页或有明确上限，不能绕过新 admission。
13. 无参数 detail 默认返回受限 page，防止旧客户端/直接 API 调用拿到全量；当前新客户端已有分页加载能力，但仍需为旧 client 固化 response/pagination compatibility tests。

### 9.4 完成检查

- 生产 summary/detail/index 路径不再出现 `readFile → split → 完整 entries[]`。
- 初始 detail、older/newer/around cursor 都在 reader 前生效；route 不再先 normalize 全 transcript。
- 文件在 scan/page 之间 append、replace、rollback 时不会混合 revision 或返回错误 branch。
- 188 MiB fixture 在受限 heap child process 中完成 cold summary、默认 detail、cursor page、index cold scan 和受控并发；超预算用例在分配前稳定失败。
- 无 rollback、仅 compaction、含 rollback、跨页 tool call/result、`beforeMessageId`、`aroundMessageId`、zstd 与 partial final line 的新 scanner 对全文 reference fixture 严格 parity；不能 parity 的情形显式失败。
- clone/export 等大文件 consumer 不再通过另一条全文入口复发 OOM。

## 10. M3：中断 provenance 和恢复 UX

### 10.1 目标

只有具备按 turn 精确关联的证据时才归因给用户；受控 runtime restart、非 clean runtime exit、结构化 provider abort reason、上游失败和 unknown 各自可见且可回放。

### 10.2 Provenance contract

实施前先固定 schema。原提案的 `CodexTurnStopProvenance` 可以保留为 Codex-only 类型，但更推荐 provider-neutral `TurnStopProvenance`，因为 runtime lifecycle、status badge 和 restart 语义并非 Codex 独有。

至少包含：

- `cause`：`user_interrupt | server_restart | server_unavailable | upstream | unknown`；
- `confidence`：固定枚举 `confirmed | inferred`，不用任意字符串/分数；
- `sessionId`、`turnId`、`processId`、`runtimeInstanceId`；
- `source` 与 `sourceId`；只有 sequence 而没有 sourceId 会在 provider/bridge 独立 sequence 空间中产生歧义；
- 可选 `sourceSequence`、`recordedAt`、结构化 `providerReason`。

Codex 的 `replaced | review_ended | budget_limited` 不能硬塞成 “user” 或普通 “upstream failure”。可选择扩展 `cause`，或保留 `providerReason` 并由 UI 显示更精确的中性文案；这一点必须在编码前决定。

### 10.3 实施步骤

1. 在 shared app types 中增加可选 provenance，并明确挂载位置：
   - turn-aborted system message：描述历史中这一 turn；
   - session last-turn health：只描述最新 terminal turn；
   - 两处使用同一 resolver 结果，不能各自猜测。
2. 扩展 Codex persisted schema，显式保留 `turn_id`、`reason`、`started_at`、`completed_at`、`duration_ms`；原始结构化字段用于诊断，但不从自由文本推断 actor。
3. 扩展 `AgentSession.interrupt` → `Process` → `Supervisor` → `RuntimeController` → HTTP/control protocol 的返回值，成功时携带 provider 确认的 `turnId`。external runtime protocol version 需要同步提升并做 mismatch 测试。
4. 建立紧凑 lifecycle ledger，而不是把服务实例状态隐式塞进现有 message replay：记录 runtime instance start、turn active、explicit interrupt confirmed、graceful shutdown intent/completed、turn terminal。记录 payload 有严格 byte cap，不包含 prompt/tool output。
5. 评估复用 `RuntimeEventStore` 还是新建专用 ledger：当前 store 按 process 分文件、session replay 默认只选最新 process、保留 7 天且存完整 stream message。若复用，必须增加跨 process 查询、runtime instance 记录、单 record size limit 与 lifecycle retention；否则使用独立小型 store 更清晰。
6. 在以下成功边界写 control record：
   - `/processes/:id/interrupt` 的 provider-confirmed success；
   - Stop fallback 的 `/processes/:id/abort`，仅当调用前能绑定 active turn；
   - 会导致 turn 中断的 confirmed permission-deny/input decision；
   - `SessionCommandService` / Codex native control 中其他明确终止 active turn 的路径。

   HTTP 到达、unsupported、RPC failure、缺 turn ID、终止属于另一 turn 时不得标 user。
7. graceful shutdown 在 abort active providers **之前** durable 写入并 flush per-turn restart intent；provider terminal 后写 completed。external web shell shutdown只 detach，不得生成 runtime restart provenance。
8. 新 runtime 启动恢复上一个 instance：
   - exact active turn + controlled shutdown intent → `server_restart/confirmed`；
   - exact active turn + instance start/heartbeat 但无 clean terminal → `server_unavailable/inferred`；
   - 没有可靠 turn 关联 → `unknown`，不事后伪造 “OOM”。
9. `codex-turn-aborted.ts` 变为纯 resolver；`normalization.ts` 与 `session-projection.ts` 保留 raw reason/message/turnId，但展示只使用 resolver 输出。
10. 客户端按 provenance 格式化 system item、status badge 和 tooltip：confirmed user stop 才显示 “Conversation stopped by user”；unknown 为中性文案；同步 `en.json` 与 `zh-CN.json`。

### 10.4 完成检查

- 同一 `(sessionId, turnId, runtimeInstanceId)` 的 provider-confirmed Stop → `user_interrupt/confirmed`。
- 受控 embedded runtime restart → `server_restart`；非 clean 前例 runtime → `server_unavailable/inferred`。
- 只有 `turn_aborted(reason="interrupted")`、bridge disconnect 或 HTTP request 到达 → `unknown`。
- `replaced/review_ended/budget_limited` 不显示为 user stop。
- 历史 JSONL、旧 bridge state、旧 journal 没有新字段时可正常读回并显示 unknown，不会被改写为 user stop。
- event 乱序、重复 replay、同 session 多 turn、retry 后成功、bridge 重连、control failure、记录写入失败和 service OOM after-RPC-before-record 场景均有单测。

## 11. M4：压力验证、文档和经授权部署

### 11.1 实施步骤

1. 扩展 `scripts/bench-session-load.ts` 或新增专用 benchmark：输出读入/扫描字节、最大行、解析条目、输出条目、reservation、RSS/heap/external/arrayBuffers 峰值、耗时与降级原因；默认只输出 path hash，不输出真实路径。
2. 建立两级压力测试：
   - 普通 CI：较小 fixture + 更低 `--max-old-space-size`，稳定复现旧实现失败而新实现通过；
   - opt-in/manual pre-deploy：不小于 `188,688,377 bytes` 的真实量级 fixture 和多 segment journal，不进入普通 `pnpm test`。
3. 用多 segment journal 压测长时间 append、rotation、prune、retained replay、warm replay、leading gap 和 source selection，验证长期索引不随运行时间无界增长。
4. 更新 `CHANGELOG.md [Unreleased]`、incident 文档、operator playbook 和既有 journal memory plan 的状态；明确 budget、coverage、降级、回滚、unknown interruption 与 heap snapshot 安全限制。
5. 运行 focused suites，再运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`。
6. 仅在用户明确授权后使用 `scripts/deploy.sh --server-only`。部署后核对 `/api/version`、`/build-info.json`、maintenance status、真实 session resume、confirmed Stop 与 unknown interruption。

### 11.2 完成检查

- 受限 heap 与 RSS 峰值验收通过，不只检查 child exit code。
- journal 内存曲线在达到 waterline 后稳定，不随 append 时长继续线性增长。
- 所有拒绝路径都有固定 code、可观测 reason，且不泄露 transcript。
- 文档、双语 UI、CHANGELOG 与实际 contract 一致。
- 未获授权前没有 browser 自动化、部署或服务重启。

## 12. 预计修改文件

### 12.1 服务端：内存与 Codex session

- `packages/server/src/sessions/codex-rollout-file.ts`
- `packages/server/src/sessions/codex-entries-reader.ts`
- `packages/server/src/sessions/codex-reader.ts`
- `packages/server/src/sessions/codex-entry-anchor.ts`
- `packages/server/src/sessions/codex-tail-read.ts`
- `packages/server/src/sessions/codex-rollback.ts`
- `packages/server/src/sessions/normalization.ts`
- `packages/server/src/sessions/types.ts`
- `packages/server/src/sessions/pagination.ts`
- `packages/server/src/sessions/fork.ts`
- `packages/server/src/indexes/SessionIndexService.ts`
- `packages/server/src/routes/sessions.ts`
- `packages/server/src/codex-events/store.ts`
- `packages/server/src/codex-events/source.ts`
- `packages/server/src/codex-events/session-projection.ts`
- `packages/server/src/routes/codex-transcript.ts`
- `packages/server/src/app.ts`
- `packages/server/src/sdk/providers/codex.ts`
- `packages/server/src/maintenance/server.ts`

### 12.2 服务端：中断 lifecycle

- `packages/server/src/runtime/RuntimeEventStore.ts`，或新增专用 lifecycle ledger
- `packages/server/src/runtime/EmbeddedRuntimeController.ts`
- `packages/server/src/runtime/HttpRuntimeController.ts`
- `packages/server/src/runtime/control-server.ts`
- `packages/server/src/runtime/standalone.ts`
- `packages/server/src/runtime/types.ts`
- `packages/server/src/supervisor/Supervisor.ts`
- `packages/server/src/supervisor/Process.ts`
- `packages/server/src/sdk/providers/types.ts`
- `packages/server/src/routes/processes.ts`
- `packages/server/src/routes/server-admin.ts`
- `packages/server/src/services/SessionCommandService.ts`
- `packages/server/src/index.ts`
- `packages/server/src/codex-bridge/CodexBridgeService.ts`（仅在确认它是相关 lifecycle owner 后）
- `packages/server/src/sessions/codex-turn-aborted.ts`

### 12.3 Shared / client

- `packages/shared/src/app-types.ts`
- `packages/shared/src/codex-schema/session.ts`
- `packages/client/src/lib/preprocessMessages.ts`
- `packages/client/src/api/client.ts`
- `packages/client/src/hooks/useSessionMessages.ts`
- `packages/client/src/types/renderItems.ts`
- `packages/client/src/components/RenderItemComponent.tsx`
- `packages/client/src/pages/SessionPage.tsx`
- `packages/client/src/hooks/useSession.ts`
- `packages/client/src/components/StatusBadge.tsx`
- `packages/client/src/components/SessionListItem.tsx`
- `packages/client/src/components/Sidebar.tsx`
- `packages/client/src/pages/GlobalSessionsPage.tsx`
- `packages/client/src/i18n/en.json`
- `packages/client/src/i18n/zh-CN.json`

### 12.4 测试、文档、基准

- `packages/server/test/sessions/codex-entries-reader.test.ts`
- `packages/server/test/sessions/codex-partial-read-parity.test.ts`
- `packages/server/test/sessions/codex-rollout-file.test.ts`
- `packages/server/test/sessions/codex-compressed-rollout.test.ts`
- `packages/server/test/sessions/codex-rollout-zstd-unsupported.test.ts`
- `packages/server/test/sessions/codex-normalization.test.ts`
- `packages/server/test/sessions/codex-reader-oss.test.ts`
- `packages/server/test/indexes/SessionIndexService.test.ts`
- `packages/server/test/codex-events/store-jsonl.test.ts`
- `packages/server/test/codex-events/store-replay.test.ts`
- `packages/server/test/codex-events/ingress.test.ts`
- `packages/server/test/codex-events/session-projection.test.ts`
- `packages/server/test/routes/sessions-canonical-overlay.test.ts`
- `packages/server/test/routes/codex-transcript.test.ts`
- `packages/server/test/routes/processes.test.ts`
- `packages/server/test/services/SessionCommandService.test.ts`
- `packages/server/test/codex-bridge/CodexBridgeService.test.ts`
- `packages/server/test/runtime/RuntimeEventStore.test.ts`
- `packages/server/test/runtime/EmbeddedRuntimeController.test.ts`
- `packages/server/test/runtime/HttpRuntimeController.test.ts`
- `packages/server/test/maintenance/server.test.ts`
- `packages/client/src/lib/__tests__/preprocessMessages.test.ts`
- `packages/client/src/components/__tests__/RenderItemComponent.test.tsx`
- `packages/client/src/components/__tests__/StatusBadge.test.tsx`
- `packages/client/src/components/__tests__/SessionListItem.test.tsx`
- `scripts/bench-session-load.ts` 或新 benchmark / stress child harness
- `CHANGELOG.md`
- `docs/project/` 下 incident、operator playbook 与既有 journal-memory plan 的状态更新

清单是当前静态审核得到的预计影响面，不是禁止修改其他必要文件的封闭列表；新增跨 runtime protocol 字段时还应由 typecheck/`rg` 追踪所有 consumer。

## 13. 风险与边界条件

- 真实 188 MiB rollout 没有 rollback，所以 latest/older page 能先受益；不能把这条优化直接推广到含 `thread_rolled_back` 的历史。
- 流式读取不会自动解决超大单行；真实最大行约 2.3 MiB，必须在构造完整字符串和 `JSON.parse` 前做 bytes budget。
- zstd offset 必须使用解压后的 JSONL byte position；Node 不支持 zstd 时保留现有“压缩 session 不可读但不拖垮服务”的降级。
- rollout 可能在扫描期间 append/replace/rollback。cursor 没有 revision 时，offset 稳定不等于 branch snapshot 稳定。
- `convertCodexEntries()` 依赖多次全数组 pre-pass；page scanner 若遗漏 tool/image/patch/compaction context，会出现表面分页成功但历史错误。
- event-store 裁剪涉及 sequence、dedupe、ingress correlation、artifact/projection cache；没有 coverage 与可靠回源时不能把 partial replay 当完整 replay。
- 磁盘已 prune 的 event 不可能被“流式回源”恢复；文档和 API 必须区分 retained history 与 lifetime history。
- provider/bridge journal sequence 空间彼此独立，任何优化不得合并或重排序二者 event；`sourceSequence` 必须配 `sourceId`。
- OOM 可能发生在“control RPC 成功、provenance 尚未落盘”之间；此时必须 unknown，不能根据结果反推用户。
- 受控 web shell restart 与 embedded/external agent runtime restart 语义不同；只有真正终止 active runtime 的控制路径才标 `server_restart`。
- `RuntimeEventStore` 当前会存完整 message；新增 lifecycle record 本身不含敏感内容，不代表现有 store 已经内容安全。metrics/debug API 绝不能暴露 record data。
- lifecycle ledger 自身需要单 record、单文件、总量、保留期和 replay budget，不能成为下一条无界路径。
- 当前未跟踪 `context.md` 是用户文件，绝不修改、删除、暂存或提交。
- browser 验证、部署和重启均须用户之后明确授权。

## 14. 测试计划

### 14.1 Focused tests

1. M0 / UI / maintenance：

   ```bash
   pnpm --filter @yep-anywhere/server test -- \
     test/sessions/codex-normalization.test.ts \
     test/maintenance/server.test.ts

   pnpm --filter client test -- \
     src/lib/__tests__/preprocessMessages.test.ts \
     src/components/__tests__/RenderItemComponent.test.tsx \
     src/components/__tests__/StatusBadge.test.tsx
   ```

2. 流式 rollout / reader：

   ```bash
   pnpm --filter @yep-anywhere/server test -- \
     test/sessions/codex-entries-reader.test.ts \
     test/sessions/codex-partial-read-parity.test.ts \
     test/sessions/codex-rollout-file.test.ts \
     test/sessions/codex-compressed-rollout.test.ts \
     test/sessions/codex-rollout-zstd-unsupported.test.ts \
     test/sessions/codex-reader-oss.test.ts
   ```

3. index 与 canonical journal：

   ```bash
   pnpm --filter @yep-anywhere/server test -- \
     test/indexes/SessionIndexService.test.ts \
     test/codex-events/store-jsonl.test.ts \
     test/codex-events/store-replay.test.ts \
     test/codex-events/ingress.test.ts \
     test/codex-events/session-projection.test.ts \
     test/routes/sessions-canonical-overlay.test.ts \
     test/routes/codex-transcript.test.ts
   ```

4. provenance / runtime：

   ```bash
   pnpm --filter @yep-anywhere/server test -- \
     test/runtime/RuntimeEventStore.test.ts \
     test/runtime/EmbeddedRuntimeController.test.ts \
     test/runtime/HttpRuntimeController.test.ts \
     test/routes/processes.test.ts \
     test/services/SessionCommandService.test.ts \
     test/codex-bridge/CodexBridgeService.test.ts
   ```

### 14.2 独立内存验证

- 普通 CI 使用较小 fixture + 较低 heap；pre-deploy stress 生成不小于 `188,688,377 bytes` 的有效 JSONL。
- 在独立 child process、受限 `--max-old-space-size` 下跑 cold summary、默认 detail page、older/newer/around cursor、index cold scan、summary/detail 并发读取。
- 建立多 segment journal，验证 append、rotation/prune、warm/retained replay、leading gap、source selection 的 RSS/heap 上界。
- 断言所有 budget rejection 路径不回退到全文 `readFile/split`。
- 测量 `heapUsed`、`rss`、`external`、`arrayBuffers`；只限制 old-space 不足以约束 Buffer/external memory。
- zstd supported / unsupported 两类 runtime 通过真实 CI matrix 或现有 capability-mocking tests 覆盖。

### 14.3 全量与上线后验证

```bash
pnpm lint
pnpm typecheck
pnpm test
```

未获授权前不做 browser 自动化、不重启现有服务。部署获授权后才使用：

```bash
scripts/deploy.sh --server-only
```

部署后核对 `/api/version`、`/build-info.json`、maintenance status、session resume、confirmed user stop、unknown interruption 和 budget error UX。

## 15. 验收标准

- 已知 188,688,377-byte rollout、当前量级 retained journal 与受控并发在受限 heap child process 下不触发 OOM；summary、默认 detail 和 index cold scan 都有明确的 bytes/line/entry/output/reservation budget。
- 生产 Codex summary/detail/index 路径不再全文 `readFile → split → 完整 entries[]`；分页在 reader 前生效；超预算、stale cursor 或无法保证 rollback 正确性时返回结构化降级，不返回错误历史。
- page response 带可验证的 rollout revision；append/replace/rollback 并发测试不会混合快照。
- `JsonlCodexEventStore` 四类长期内存索引有明确上界和 stats；rotation 后 sequence、retained replay、method filtering、dedupe window、ingress correlation、projection cache 通过回归，且同 path store 不重复常驻完整索引。
- replay coverage 明确。leading gap 不会被投影成完整 canonical history；已物理 prune 的 lifetime history 不被声称可恢复。
- 若 sequence 验收包含“session 全部 event 被 prune 后重启再 append”，durable high-water 用例必须单独通过；否则限制必须写入 API/文档。
- 无确认证据的 `turn_aborted` 显示 “Conversation interrupted” 及中文对应文案；只有同一 `(sessionId, turnId, runtimeInstanceId)` 的 confirmed control record 才显示 “Conversation stopped by user”。
- controlled embedded runtime restart、inferred unclean runtime exit、结构化 provider reason、upstream failure、unknown 有保守、可回放的状态；旧 JSONL/bridge state/journal 缺新字段时兼容并默认 unknown。
- UI 英文/简体中文、`CHANGELOG.md [Unreleased]`、incident/operator 文档同步更新。
- focused suites、`pnpm lint`、`pnpm typecheck`、`pnpm test` 通过，或剩余既有失败已明确隔离并有证据证明与本改动无关。

## 16. 回滚与发布边界

- M0 admission、M1 memory waterline 和新 provenance projection 都需要独立 feature/config gate，便于先降级到“显式不可用/unknown”，不能降级回错误历史或 user-stop 误归因。
- event-store 内存裁剪回滚不得依赖已被 prune 的磁盘 event；部署前先验证 coverage/retention 语义。
- rollout 新 reader 应保留受 budget 保护的 reference path 仅用于测试/灰度 parity，不允许生产自动 fallback 到无界全文 reader。
- 开发阶段只更新 `[Unreleased]`，不提升版本。正式部署/发布前按项目 CalVer 流程运行 `pnpm version:status` / `pnpm version:bump` / `pnpm version:check`。
- 本文落盘与静态审核不构成部署或重启授权。
