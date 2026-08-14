# Codex 事件 journal 内存索引有界化方案

> 状态：方案待评审（2026-08-13）。审查结论来自静态代码分析；replay/dedupe 语义边界是「待确认问题」。
>
> 日期：2026-08-13
>
> 关联文档：docs/project/2026-08-10-codex-canonical-overlay-performance-plan.md

## 1. 结论

`JsonlCodexEventStore` 的磁盘侧已有 rotation：活跃 journal 到 256 MiB 后切为带时间戳的 segment，仅保留 3 个 segment + 活跃文件，单 journal 磁盘上界约 1 GiB（`packages/server/src/codex-events/store.ts:148-152,519-533`）。但内存侧的三个索引 `eventsBySession` / `eventsByIdentity` / `eventsByDedupeKey`（store.ts:167-169）从不裁剪，`rotateIfNeeded()` 的注释明确写了这是刻意设计：让本进程内 replay、dedupe 与 per-session sequence 保持连续（store.ts:513-518）。

结果是：长寿、高负载的 8022 服务端上，store 层内存随「进程启动以来的全部事件量」无界增长，事件对象化后约为磁盘 JSONL 的 2–3 倍（估算，见 §10.4）。磁盘有 1 GiB 上界，内存没有。

推荐分三步：

- **P0：只加观测**。暴露索引条数与估算字节的水位日志/维护端点指标，不改任何语义。
- **P1：rotation 时按水位裁剪内存索引 + 完整 replay 按需回源磁盘**（方案 A/A1）。裁剪与磁盘 segment 保留窗口对齐，杀掉无界增长，同时保持 replay 接口语义不变。
- **P2：按 P0 实测决定是否再做加载窗口**（方案 C），缩小冷启动内存基线。

与 2026-08-10 文档 §6.4 已实施的 P2「有内存水位的 projection cache」（`codex-events/projection-cache.ts:25-26,46-60,225-234`）是互补关系，不重复：projection cache 限的是**投影状态副本**（每 session 一份 reducer 输出），本文档限的是 **store 层原始事件 envelope 索引**，是 replay 的数据源。前者已落地，后者是本次审查发现的后续缺口。

## 2. 背景与现状

### 2.1 journal 的职责与两份生产 journal

canonical event spine 用 append-only JSONL 持久化 Codex 事件，提供 `append`（幂等判重 + per-session sequence）与 `replay`（按 sequence 窗口回放）两个原语（store.ts:32-39）。生产有两份独立 journal，sequence 空间互不混合（source.ts:46-52）：

- provider journal：`{dataDir}/codex-events/events.jsonl`（`sdk/providers/codex.ts:5725-5727`）；
- bridge journal：`{dataDir}/codex-bridge/codex-events.jsonl`（`routes/codex-transcript.ts:52-56`）。

每份 journal 在同一进程里至少有两个长寿命 `JsonlCodexEventStore` 实例：写入方（provider：`codex.ts:1239-1257`；bridge：`codex-bridge/CodexBridgeEventSpine.ts:235-249`）和读取方（transcript/sessions 路由共享的 `jsonlSource`，`codex-transcript.ts:195-210`，在 `app.ts:1379,1502-1505` 装配一次）。每个实例各自持有全量内存索引，同一份字节在内存里最多驻留 4 份。

### 2.2 磁盘 rotation

`rotateIfNeeded()`（store.ts:519-533）：`lastKnownFileSize ≥ rotateMaxBytes`（默认 256 MiB，store.ts:149）时把活跃文件 rename 成时间戳 segment，`pruneSegments()` 保留最近 `keepSegments` 个（默认 3，store.ts:152,555-569）。provider 侧可用 `YEP_CODEX_EVENT_STORE_ROTATE_BYTES` / `YEP_CODEX_EVENT_STORE_KEEP_SEGMENTS` 覆盖（codex.ts:5728-5735），bridge 侧只用代码默认值。磁盘上界 ≈ (3+1) × 256 MiB ≈ 1 GiB/journal。

全量 `load()` 会按时间序读全部保留 segment + 活跃文件（store.ts:433-459,571-583），所以进程重启后内存天然对齐磁盘窗口。**但本进程自己触发的 rotation 不走全量 load**（store.ts:524-530 只重置文件快照簿记），单进程长稳态下内存与磁盘窗口脱钩。

### 2.3 内存索引结构与消费者

三个索引的分工：

- `eventsBySession`：replay 的数据源（store.ts:244-254）、sequence 赋值的来源（尾部 +1，store.ts:210-215）、`latestSequence`（store.ts:256-262）；
- `eventsByIdentity` / `eventsByDedupeKey`：append 幂等判重（`findExisting`，store.ts:655-667）；key 为 `sessionId\0eventId` / `sessionId\0dedupeKey`（store.ts:699-701）。三索引持有同一 envelope 对象的引用（store.ts:669-683），额外开销是 key 字符串与 Map 桶。

replay 的消费者（除标注外都是**全量 session replay**）：

1. `CodexEventIngress.create()`（ingress.ts:101-112）：重建 projection 并恢复 request→turn、server-request secret 关联（ingress.ts:410-450）；
2. session GET canonical 刷新：`selectCodexEventSourceWithCache`（source.ts:82-105，`routes/sessions.ts:1348`），注释明确候选时间戳、交互与 generated-artifact 溯源需要完整历史（source.ts:73-81）；
3. transcript 导出：`loadCanonicalCodexTranscript`（transcript-store.ts:25-41，支持 `throughSequence` 上限）；
4. generated artifacts 恢复：直接消费 replay 出的事件数组（sessions.ts:1357-1361）；
5. 测试/shadow：`replayCodexSession`（reducer.ts:267-273）。

`afterSequence` 窗口目前无生产调用方，仅测试使用（`test/codex-events/store-replay.test.ts:87`）。

sequence 连续性的依赖方：投影消息的 `codexEventSequence`（session-projection.ts；写入点 codex.ts:4251,5497）、飞书卡片排序键（rich-card-projection.ts:1254）、projection cache 的增量 apply 高水位（projection-cache.ts:106-116,168-170）与前缀校验 `matchesReplaySnapshot`（projection-cache.ts:177-214）。

dedupe 语义窗口：`dedupeKey` 是生命周期键（`turn/started|completed`、`item/started|completed`，ingress.ts:484-504），用于 app-server reconnect/resume 后同一生命周期通知重发的幂等；eventId 判重还保护 tail-read/重载时不重复入索引（store.ts:418-423,631-632）。当前两者窗口都是「内存里有的全部历史」；重启后窗口收缩为磁盘保留窗口——即现行语义本就随重启降级。

## 3. 问题

### 3.1 增长模型

内存索引条数 ≈ 最近一次全量 `load()` 以来的全部事件量。内存重置只在全量 load 时发生（`resetLoadedState`，store.ts:635-643），触发条件是冷启动、`refreshFromDisk()` 检测到截断/换文件/回卷（store.ts:284-329）或 tail-read 失败兜底（store.ts:383-387）。写入方进程自转 segment 不在此列。因此长稳态下单实例内存无界，磁盘有界，两者随运行时长持续拉大。

### 3.2 量级估算

以 2026-08-10 文档 §2.3 现场为锚：bridge journal 30 MB / 11,167 事件。若跑满磁盘窗口（1 GiB ≈ 约 35 万事件），按 envelope 对象化 2–3 倍估算（§10.4 待实测），单实例驻留约 2–3 GB；provider + bridge、写方 + 读方最多 4 份索引叠加，叠加后量级数倍 GiB。对照：`DEFAULT_LOAD_CHUNK_BYTES = 8 MiB`（store.ts:146）保证的是「再大的 journal 也能 load」，不控制驻留。

### 3.3 证据

| 事实 | 位置 |
| --- | --- |
| 三个全量内存索引 | store.ts:167-169 |
| 磁盘 rotation 常量（256 MiB / 3 segments） | store.ts:148-152 |
| 内存刻意保留 rotated 事件的注释 | store.ts:513-518 |
| 唯一内存重置点 | store.ts:635-643（由 store.ts:438 等全量 load 路径调用） |
| 本进程 rotation 不触发全量 load | store.ts:524-530 |

## 4. 目标与非目标

目标：

- 每个 `JsonlCodexEventStore` 实例的内存索引有硬上界，量级与磁盘保留窗口同阶；
- `CodexEventStore` 接口语义不降级：完整 replay 仍返回全历史，append 幂等不失效，per-session sequence 单调连续；
- 水位风格对齐 projection cache：模块常量默认值 + 构造期 `RangeError` 校验 + 显式失效边界（projection-cache.ts:46-60）。

非目标：

- 不改磁盘 rotation 策略、segment 命名与保留数；
- 不改 reducer、overlay、projection cache、前端展示；
- 不引入 SQLite/外部存储；`InMemoryCodexEventStore` 保持现在的简单参考实现不动（store.ts:45-117，非生产路径）。

## 5. 方案设计

每个方案先回答：**裁掉旧事件后，replay / dedupe / per-session sequence 语义是否仍成立？**

### 5.1 P0：观测（无语义变更）

在 append、rotation、全量 load 后记录 `eventsBySession` 总条数、`eventsByIdentity`/`eventsByDedupeKey` 条数与粗估字节，走现有日志通道（参考 `codex_event_store_rotated`，codex.ts:5736-5747）；维护服务暴露当前值。语义影响：无。产出用于 §10.4 实测与 P1 水位定值。

### 5.2 P1 方案 A：rotation 时按水位裁剪内存索引（推荐）

rotation/prune 成功后，把「只存在于被丢弃历史区间」的 envelope 从三个索引中移除。归属判定二选一：a) 索引时记录事件所属 segment epoch，prune segment 即裁该 epoch；b) 更简单：每 session 仅保留最近 N 条（sequence 高水位窗口），与 segment 解耦。

语义回答：

- **sequence**：必须新增不可裁剪的 `sessionId → maxSequence` 高水位表，append 赋值改读它（替代 store.ts:213-215 的数组尾部读取）。表大小上界是 session 数，可再配 LRU。连续性成立。
- **replay**：被裁区间若直接从内存 replay，历史缺失会破坏 ingress 关联恢复（ingress.ts:410-450）、canonical 刷新的完整历史需求（source.ts:73-81），并触发 `matchesReplaySnapshot` 误判 journal 被替换而清掉好缓存（projection-cache.ts:177-214）。因此推荐 **A1：完整 replay 回源磁盘**——replay 请求超出内存窗口时，从保留 segment 按 sequence 补读旧事件，只填充本次返回值（沿用现有 structuredClone 返回约定，store.ts:250-252），不长期驻留索引。接口语义不变；代价是冷区间 replay 多一次有界磁盘读（≤ 磁盘窗口）。
- **dedupe**：被裁窗口内 eventId/dedupeKey 重发会 miss。两点缓解：eventId 重读本就只发生在 tail-read/重载场景，源文件仍在磁盘保留窗口内时 A1 的补读路径可选地顺带恢复判重；lifecycle dedupeKey 重发只在 reconnect/resume 时出现，其「是否需要跨 segment 幂等」列入 §10.1。注意重启后 dedupe 窗口本来就收缩到磁盘窗口，裁剪只是把同一语义提前到进程内。
- **触发时机**：与 prune 同步（方案 a）语义最整齐——「磁盘丢什么，内存丢什么」，进程内行为与重启后行为完全一致。

### 5.3 P1 备选 方案 B：总条数/字节水位裁最旧事件

给 `eventsBySession` 加 `maxTotalEvents` / `maxTotalBytes` 双水位（风格同 projection-cache.ts:25-26），超水位从最久未活跃 session 的最旧事件裁起。语义回答：sequence 高水位表与 replay 回源需求同方案 A；额外问题是触发时机与 rotation 脱钩，可能在一个仍在写入的 session 中段裁剪，「磁盘有、内存无」的区间形状更不规则，A1 补读仍是必须。取舍：水位语义直观、对齐既有风格，但与磁盘窗口不等价，行为解释成本更高。**作为 A 的退化实现保留**（若 segment 归属判定落地困难，先上 B 也能止血）。

### 5.4 P2 方案 C：load 时只加载最近窗口

全量 `load()` 只索引最近 N 个 segment 或每 session 最近 M 条，更早区间只在完整 replay 时按需读。语义回答：与 A1 共用同一套「内存窗口 + 磁盘回源」机制，差别只在冷启动基线。取舍：进一步压低重启后内存，但读路径复杂度集中在 load；待 P0 实测证明冷启动基线也是问题后再做。

### 5.5 影响对照

| 语义 | 现状 | A/A1 | B | C |
| --- | --- | --- | --- | --- |
| 完整 replay 返回全历史 | 是（内存） | 是（内存+磁盘回源） | 是（同 A1） | 是（同 A1） |
| sequence 单调连续 | 是 | 是（高水位表） | 是（高水位表） | 是（高水位表） |
| 旧 dedupeKey 重发幂等 | 进程内全窗口 | 内存窗口内（与重启后语义一致） | 同 A | 同 A |
| 内存上界 | 无 | ≈ 磁盘窗口 | ≈ 水位定值 | 冷启动更低 |

## 6. 不推荐的方案

- **缩短磁盘 keepSegments 间接减内存**：减的是磁盘与重启后基线，对进程内无界增长无效，且损害 transcript 导出与审计窗口。
- **周期性强制全量 `load()`「冲洗」内存**：确实能把内存对齐磁盘窗口，但每次要对最多 1 GiB/journal 做全量重读重索引，IO/CPU 尖峰落在服务路径上，且只是周期性止血，没有硬上界。
- **改用 SQLite/外部 KV 存事件**：过度工程；JSONL + 分段已满足持久化，问题只在索引驻留策略。
- **只给 `InMemoryCodexEventStore` 加上限**：它是测试/嵌入参考实现，不是 8022 的生产路径，改了不解决现场问题。

## 7. 实施顺序

- 阶段 A：P0 观测（水位日志 + 维护端点），上线后收集 8022 现场数据，确认 2–3 倍估算与增长斜率。
- 阶段 B：P1 方案 A——高水位表、rotation 同步裁剪、A1 磁盘回源 replay、构造期水位校验。
- 阶段 C：按 P0 数据决定方案 C 是否立项；同时收口 §10 的待确认问题为断言。

## 8. 测试与验证

现有回归锚点：rotation 与跨 segment replay（`test/codex-events/store-jsonl.test.ts:117-197`）、幂等判重与 live/replay 投影一致（`test/codex-events/store-replay.test.ts:57-91`）。

新增断言：

- 裁剪后被裁 session 再次 append，sequence 接续高水位表不重排；
- prune 后完整 replay 仍返回全历史（A1 磁盘回源），且返回对象不驻留索引；
- 内存窗口内重发 lifecycle dedupeKey 仍幂等；窗口外重发的行为按 §10.1 结论固化；
- `matchesReplaySnapshot` 在裁剪后对 warm cache 不误判失效（projection-cache 单测）；
- 水位非法值构造抛 `RangeError`（对齐 projection-cache.ts:49-58）。

校验命令：`pnpm lint`、`pnpm typecheck`、`pnpm test`。按仓库纪律不重启 8022 等运行中服务，验证留在单元与脚本层。

## 9. 回滚

裁剪都是进程内行为：代码回退后下一次全量 `load()`（含重启）即恢复全量索引，磁盘数据从未受影响。另提供 `YEP_CODEX_EVENT_STORE_MEMORY_MAX_EVENTS`（命名对齐既有 `YEP_CODEX_EVENT_STORE_*`，codex.ts:5728-5735）配置水位，设为 0/未设时禁用裁剪、完全退回现行为，作为灰度开关。

## 10. 待确认问题

1. **dedupe 窗口下限**：app-server reconnect/resume 是否会重发落在被裁区间的 lifecycle 通知？验证：读 `sdk/providers/codex.ts` 的 resume/reconcile 路径与 `references/codex/codex-rs/app-server*`，加「resume 重放旧 turn/started」断言。
2. **ingress 全量 replay 的真实需求**：`restoreCorrelations`（ingress.ts:410-450）恢复的 turn/secret 关联是否只需覆盖在飞 turn？若只需尾部窗口，ingress 可改增量建联，降低对完整历史的硬性依赖。验证：`test/codex-events/ingress.test.ts` 加裁剪窗口用例。
3. **projection cache 前缀校验兼容性**：A1 保证完整 replay 后 `matchesReplaySnapshot` 输入不变；若未来接受有界 replay，该校验需要改为容忍前缀缺失。验证：projection-cache 单测先行。
4. **对象化内存倍数**：2–3 倍为审查估算。验证：P0 观测上线后用 `process.memoryUsage()` 与索引条数做回归标定。
5. **canonical 刷新完整历史的字段级需求**：source.ts:73-81 注释列了候选时间戳/交互/artifact 溯源三类；确认能否改为「快照 + 增量」，决定方案 C 的收益上限。验证：读 session-projection 候选构造与 sessions.ts:1348 调用侧。
