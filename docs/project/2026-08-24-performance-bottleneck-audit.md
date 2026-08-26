# Yep Anywhere 性能瓶颈审计（2026-08-24）

> 方法：本机只读观测（不重启任何服务）+ 代码审阅。
> 被测运行时：`8022` 主服务 pid 215，build `2026.8.5-d96e9b33dbb0`（= 当前 HEAD）；
> `4510` Codex bridge pid 23306，已运行 2 天 4 小时，build 早于 `dab6db4fe`（**滞后**）。

## 0. 现场基线

| 指标 | 实测 |
| --- | ---: |
| 8022 RSS（启动 18 分钟后） | 2.8–3.2 GiB，持续增长 |
| 4510 RSS | 96 MiB（健康） |
| `~/.yep-anywhere` 总占用 | 5.7 GB |
| provider canonical journal (`codex-events/`) | 892 MB（4 段），今日单日新增 111 MB |
| legacy bridge journal (`codex-bridge/codex-events*.jsonl`) | 989 MB（最后写入 8-19，已停写但仍计入 source） |
| `archive/sessions` | 1.8 GB |
| `logs/` | 356 MB（`server-launchd.out.log` 单日 24 MB） |
| `~/.codex/sessions` rollout | 361 个文件 / 761 MB，最大 188 MB |

REST 只读时延（warm / cold）：

| 端点 | 结果 |
| --- | --- |
| `/api/version` | 1–2 ms |
| `/api/projects` | cold 157 ms → warm 3–15 ms |
| `/api/sessions?limit=100` | 6–9 ms / 108 KB |
| `/api/projects/:p/sessions?limit=50` | 4–5 ms / 200 KB |
| Codex detail（188 MB rollout, paginated） | **8–13 ms**，`pageRead≈3–6 ms` |
| Codex detail（普通 650 KB 响应） | 25–27 ms，`summaryScan 6–8 ms` + `pageRead 6–9 ms` |
| Pi detail | cold 48 ms → warm 4 ms |
| `/api/search?q=…` | cold 0.5–2.5 s → warm 55 ms |
| 4510 `/sessions` / `/session-views` | 2.2–2.7 ms，101 KB / 90 KB |

**结论先行**：M2（app-server 分页历史）与客户端 LRU/SWR 已经把「session 加载/切换」的
读路径压到几十毫秒量级，**读路径已经不是主要瓶颈**。当前真正的瓶颈集中在
**写路径与常驻内存**：canonical event journal 的影子投影与全量内存索引。

---

## P0：canonical Codex event journal（影子模式）——内存与流式热路径双重浪费

### 证据

- `resolveCodexEventProjectionMode` 默认 `shadow`（`codex-events/rollout.ts:47`），
  运行日志确认 `projectionMode: "shadow"`。
- `JsonlCodexEventStore` 轮转配置：`maxBytes 256 MB × keepSegments 3`
  （`codex-events/store.ts:265-271`）→ 磁盘保留上限 ~1 GB。
- writer 的 `append()` 先 `ensureLoaded()`，而 `load()` 会遍历**全部保留段**
  （`store.ts:625-645`），把 892 MB JSONL 解析成对象，并同时维护 4 份索引：
  `eventsBySession` / `eventsBySessionMethod` / `eventsByIdentity` / `eventsByDedupeKey`。
  这直接解释了 8022 的 2.8–3.2 GiB RSS。
- 而读侧 `CODEX_EVENT_STORE_ADMISSION_BYTES = 512 MB`（`codex-events/source.ts:7-15`），
  892 MB > 512 MB ⇒ **每次 canonical overlay 都立即 admission 失败**，日志中
  `CodexEventSourceAdmissionError` / `Canonical Codex session overlay unavailable; using legacy normalization`。
  也就是说：**写进去的东西从来没被读出来用过**。
- 每条流式通知在 shadow 模式下要做（`sdk/providers/codex.ts:3090-3170`）：
  1. `redactCodexPayload` 深度遍历；
  2. `store.append()`：`stat()` + `structuredClone ×2` + `JSON.stringify` + 一次
     `appendFile`（open/write/close）**每事件一次**，且串行持锁；
  3. `notificationFromEvent()` 再 `structuredClone` 一次 payload；
  4. `convertNotificationToSDKMessages` **执行两遍**（canonical + legacy）；
  5. `projectionHash ×2`：sanitize 深拷贝 + `JSON.stringify` + sha256；
  6. 不一致时 `log.warn`，而实际上**几乎每条都不一致**——最近 3000 行日志中 235 条
     mismatch 警告，历史进程累计 2,981 条。
- 事件量级（最近 40 MB journal 抽样 24,174 条，均值 1,735 B/事件）：
  `item/agentMessage/delta` 13,924、`item/commandExecution/outputDelta` 6,174；
  `turn/diff/updated` 只有 198 条却占 8.7 MB（**44 KB/事件**，全量 diff 反复落盘）。
  空闲期约 4–6 事件/秒，一次密集 turn 会数量级放大。

### 影响

- 常驻内存 2–3 GiB，GC 压力大 → 事件循环抖动、流式 token 到达不均匀。
- 每个 delta 的 CPU 成本翻倍以上，直接体现在「打字机」卡顿和 `/stop` 响应延迟。
- 磁盘每天增长 ~100 MB，日志被 mismatch 警告淹没（单日 24 MB 日志）。

### 建议（按性价比）

1. **立刻可做（零代码）**：`YEP_CODEX_EVENT_SPINE_MODE=legacy`。
   注意：`legacy` 只跳过双投影与 parity hash，**仍然 ingest 持久化**
   （`rollout.ts` 注释明确「event ingestion stays enabled in every mode」），
   所以内存问题不会解决，只解决 CPU 与日志。
2. **需要小改动**：给 store 增加「writer 不需要全量 hydrate」的模式——
   append 只需要 per-session 的 `lastSequence` 与 dedupe 窗口，不需要把三年历史
   全部驻留。可用「只加载 active 段 + 每 session 尾部 N 条」替代全量索引。
3. **retention 按内存预算而非磁盘预算**：把 `keepSegments` 从 3 降到 1，
   或把 `maxBytes` 降到 32–64 MB，使保留总量落在 admission 预算之内。
   否则 writer 写的内容永远无法被 reader 使用，纯负收益。
4. **mismatch 警告限流**：同一 `method` 只记一次 + 计数聚合，不要每事件一条。
5. **批量 append**：`appendMany` 目前是 `for` 循环逐条 `append`（`store.ts:381`），
   每条一次 `stat` + 一次 `appendFile`。改成单次拼接写入。
6. **`turn/diff/updated` 不应全量入 journal**：44 KB/条，考虑只存摘要或跳过。
7. 归档 989 MB 的 legacy bridge journal（已停写），它仍然参与
   `selectFreshestSourceStore` 的 `getStorageBytes()` 与潜在冷加载。

---

## P1：4510 bridge 的部署滞后 + 无条件全量快照同步

### 证据

- 运行中的 4510 进程启动于 8-22，晚于 `dab6db4fe`（8-23 11:59，「make the 4510
  session-state feed conditional」）。实测 `GET /session-views` **没有返回 ETag**，
  条件请求返回 200 + 90 KB 全量。
- `BridgeHttpClient` 默认 `pollIntervalMs = 1000`（`bridge-common/BridgeHttpClient.ts:71`）。
  当前 111 个 bridge session ⇒ 8022 每秒解析 ~90–190 KB JSON，永久占用主线程。
- `/sessions`（101 KB）在服务端也没有 ETag（`CodexBridgeService.ts:906`），
  只有 `/session-views` 加了 `W/"revision"`（:911-920）。

### 影响

- 单次 2.5 ms 看似便宜，但这是 **1 Hz × 永久**，且与流式 turn 的 CPU 抢占叠加。
- session 数线性增长 ⇒ 快照体积线性增长，是「session 越多越卡」的次要来源。

### 建议

1. 重新部署 4510（需用户授权）让 ETag/304 生效——这是零成本收益。
2. 给 `/sessions` 也加同一 revision ETag，或让 8022 完全不再轮询 `/sessions`。
3. 长期：把 1 Hz 轮询换成 SSE 推 `revision + changedIds`（`BridgeEventNotifier`
   已具备），只在 revision 变化时拉单 session view。

---

## P2：session 读路径的剩余成本

读路径整体健康，但仍有可摘的低垂果实：

1. **`summaryScan` 6–8 ms**：paginated session 的 detail 里仍在做独立 summary 扫描
   （最大 rollout 是 0 ms，说明走了 catalog；中等 session 反而付了 8 ms）。
   建议统一由 catalog cheap metadata 提供 summary。
2. **detail 响应无 ETag / Cache-Control**：实测 `/api/projects/:p/sessions/:s` 只有
   `content-encoding: gzip`，没有 `etag`。客户端 SWR revalidate 时每次都要重新传
   650 KB（gzip 后仍有上百 KB）。移动端切回 session 的主要感知成本在这里。
   建议：基于 `revision + limit + branchId` 生成 ETag，命中返回 304。
3. **`/api/search` 冷启动 0.5–2.5 s**：`SessionContentIndexService` 冷读 26 MB
   content index + 重新解析变更文件，全在主线程。建议移入 worker 或启动预热。
4. **`/api/projects` 冷 157 ms**：`SessionIndexService.refreshSessionsInBackground()`
   的「后台」仍在 8022 主线程（计划文档 §2.3 已指出，未修）。真正后台化需要
   worker_threads——目前只有 `CodexManifestScanWorker` 和 `sqlite/query-worker`
   两处用了 worker。
5. **启动期 title backfill**：`SessionTitleService` 启动即扫 20 projects × 25 sessions
   （concurrency 2），与首屏请求抢主线程。建议延后到首个 idle 或降优先级。

---

## P3：客户端切换与渲染

现状比较好，问题不多：

- `sessionSnapshotCache`（5 条 / 32 MiB / 单条 12 MiB 上限）实现规范：
  `estimateStructuralBytes` 是无分配估算，不走 `JSON.stringify`；
  `mergeMessages` 保留未变引用；`preprocessMessagesCached` 支持尾部增量。
- `MessageList` 在 >80 行时启用 `@tanstack/react-virtual`，`overscan 6`。
- 产物体积健康：`client-dist` 共 2.0 MB，最大 chunk `SessionPage` 408 KB（gzip 112 KB）。

可改进：

1. 快照缓存仅存在于模块内存，**刷新/重开 PWA 即全丢**。移动端最常见的正是冷启动，
   考虑把「最近 1 个 session 的 bounded window」写入 IndexedDB。
2. 缓存上限 5 条对「A→B→A」有效，对多项目频繁跳转命中率有限；由于有字节上限兜底，
   可以把条目数提到 8–10。
3. `SessionPage.tsx` 2,499 行 + `useSession.ts` 2,117 行，单组件 state 面积过大，
   任何一次流式更新都可能触发大范围 re-render；建议按「输入区 / 转录区 / 侧栏」
   拆 context，减少 streaming 期间的 reconcile 面积。

---

## P4：存储与运维

- `~/.yep-anywhere` 5.7 GB，其中 archive 1.8 GB + 两份 journal 1.9 GB + logs 356 MB。
  没有任何自动清理策略覆盖 archive 与 logs。
- `server-launchd.out.log` 单日 24 MB，主要是 mismatch 警告与
  `[ExternalSessionTracker] Cannot emit session-created - project not found: …`
  的重复刷屏（同一条消息在 3000 行内出现数十次）。建议对这类稳定失败做去重节流。

---

## 优先级建议

| 优先级 | 动作 | 预期收益 | 风险 |
| --- | --- | --- | --- |
| 1 | journal retention 降到 admission 预算内 + writer 不再全量 hydrate | RSS 3.2 GiB → 数百 MiB | 中，需改 store 加载策略 |
| 2 | shadow 双投影 + parity hash 降级为采样（或默认 legacy） | 流式 CPU 减半、日志止血 | 低 |
| 3 | 重新部署 4510 使 ETag 生效；`/sessions` 补 ETag | 1 Hz 常驻开销归零 | 低（需授权重启） |
| 4 | session detail 加 ETag/304 | 移动端切换流量与延迟 | 低 |
| 5 | `appendMany` 批量写、`turn/diff/updated` 瘦身 | 写放大 | 低 |
| 6 | search/index 冷路径移入 worker | 冷启动 2.5 s → 亚秒 | 中 |
| 7 | 客户端快照持久化 + SessionPage 拆分 | 冷启动与流式渲染 | 中 |

## 未做的验证

- 未重启任何服务；4510 的 ETag 行为只能在下次部署后复测。
- 未跑浏览器/UI 自动化，客户端 re-render 面积是代码推断而非 profiler 实测。
- 未执行 `codex migrate-rollouts`，legacy rollout 占比未统计。
