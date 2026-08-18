# Codex 会话 OOM 修复剩余工作计划

> 状态：已提交实现与本文剩余工作衔接
>
> 日期：2026-08-18
>
> 关联文档：
> - [`2026-08-18-codex-session-oom-and-interruption-repair-plan.md`](./2026-08-18-codex-session-oom-and-interruption-repair-plan.md)
> - [`2026-08-13-codex-event-journal-memory-plan.md`](./2026-08-13-codex-event-journal-memory-plan.md)
>
> 基线：已提交到 `main` 的 5 个提交（`2382f478d`、`804b3277a`、`78ba2644a`、`0ebb2f7ff`、`7464b6901`）。

## 1. 背景与范围

原计划覆盖 M0–M4。当前已提交代码主要完成了：

- M2a 流式 line iterator + streaming summary（`codex-rollout-file.ts`、`codex-reader.ts`）
- M2b 无 rollback 文件的 reader 前分页（latest/older/around/afterWindow/incremental + rolloutRevision）
- M2 步骤 10 的全局 semantic context 注入（patch apply / direct edit / image generation）
- 部分预算与降级：Codex rollout admission、409/413/503 错误码、canonical overlay 超阈值跳过、event source 超阈值跳过
- Pi session 解析缓存、summary/message 一次遍历、deferMedia/deferThinking 快路径
- `fork.ts` clone 与 agent mapping 的流式化
- 文档与 CHANGELOG

**尚未实现、需要继续工作的四个方向**：

1. 分页正确性收尾
2. 含 `thread_rolled_back` 的大文件支持
3. Canonical event journal 内存有界化
4. 中断归因（provenance）与恢复 UX

运行态注意：本机 8022 进程加载的 `dist` 是 17:18 从改动中工作树构建的初版 reader，**不包含最后提交里的 `appendAfterCursor` 方向修复和 admission waiter 竞态修复**；`build-info.json` 仍报告 `dcd6c811b`。完成本文对应修复后需要重新构建并部署，且必须重新校验 build-info 与提交一致。

---

## 2. 工作流 1：分页正确性收尾

### 2.1 现状

已完成：

- 无 rollback 文件的分页在 reader 前生效，byte-offset cursor 携带 `rolloutRevision`。
- `afterWindow` / `incremental` 已改为保留 cursor 后的第一批消息（`appendAfterCursor`），避免“加载更新消息”返回文件尾部。
- admission waiter 已改为 `while` 重新检查，避免 TOCTOU 超预算准入。
- `convertCodexEntries` 接收全局 `patchApplyCallIds` / `directEditCallIds` / `responseImageGenerationIds` / `imageGenerationEndIds`，避免跨页 patch/image 语义不一致。
- 新增 `codex-streaming-reader.test.ts` 覆盖 tail、older、around、afterWindow、revision stale。

### 2.2 剩余问题

1. **compaction dedupe 上下文仍未注入转换器。**
   `scanCodexRolloutPageOnce` 在扫描全文件过程中维护了全局 `compactedTimestamps`（用于 `codexEntryOutputCount` 和 `totalCompactions`），但 `convertCodexEntries` 仍然只从 page entries 重新收集 `compactedTimestamps`。当 `afterWindowMessageId` 或 `aroundMessageId` 的页面起点落在 `compacted` marker 与紧随其后的 `context_compacted` 之间时，页面内缺少 `compacted` marker，会把本应去重的 `context_compacted` 再次转成 compaction 消息，导致输出消息数与 `returnedMessageCount` 不一致。

2. **cursor 与 branch 选择的组合场景未完全固化。**
   当前无 rollback 文件只有线性 branch，`visibleEndOffset` 依赖 `buildCodexBranchState` 的线性假设；一旦 M2c 引入 rollback branch index，`scanCodexRolloutPageOnce` 的 `visibleEndOffset` / `selectedBranchIndex` 必须按新的 branch tree 重新推导，并保持 cursor 指向的 entry 与 page 归属一致。

3. **旧 cursor 兼容路径测试不足。**
   `hasLegacyCodexCursor` 当前会回退到 `loadSessionEntries` + `buildCodexBranchView`（有 32 MiB 上限）。需要固化旧 cursor 行为：无 revision 时若文件已变化，应保守重扫或返回 stale，不能混用两个 snapshot。

4. **并发扫描 / revision 变化缺少系统性测试。**
   当前 `scanCodexRolloutSummary` 和 `scanCodexRolloutPage` 各自做 pre/post stat，文件变化时重试一次后抛错。缺少 append、replace、truncate、扫描中新增 rollback marker 的并发测试，也没有断言“同一响应中 summary 与 page 不会来自不同 revision”。

5. **客户端对分页错误只处理了 `SESSION_HISTORY_CURSOR_STALE`。**
   `useSessionMessages` 只对 cursor stale 做 `refreshSessionMessages`。`SESSION_HISTORY_CHANGED` / `SESSION_HISTORY_BUDGET_EXCEEDED` / `SESSION_HISTORY_UNAVAILABLE` 仍会走原静默失败路径，用户会看到加载失败但没有明确反馈。

### 2.3 实施步骤

1. 扩展 `CodexContextSnapshotOptions`，增加 `compactedTimestamps?: readonly number[]` 或等价的 `contextCompactedDedupeByOffset`，由 page scanner 在扫描过程中为每条 `context_compacted` 记录“是否与 `compacted` 配对”的布尔标记；`convertCodexEntries` 优先使用该标记，不再依赖页面内局部 `compactedTimestamps`。
   - 优先方案：page scanner 为 `CodexSessionEntry` 附着一个非枚举的 `__yepContextCompactedPaired` 标记（类似 `__yepByteOffset`），转换器直接读取。
2. 在 `scanCodexRolloutPageOnce` 与 `convertCodexEntries` 之间固化 contract：page 返回的 `entries` 必须与 `totalMessageCount`、`returnedMessageCount`、`hasOlderMessages`、`hasNewerMessages` 严格一致。
3. 增加分页 parity 测试：
   - `afterWindowMessageId` 光标后消息超过 `maxMessages`；
   - `aroundMessageId` 前后消息均超过半窗口；
   - 光标落在 `compacted` / `context_compacted` 之间；
   - 页面跨 `patch_apply_end` / `function_call_output` / `image_generation_end` 边界；
   - 旧 message-id cursor（无 `@offset`）且文件未变 / 文件已变。
4. 在 client `useSessionMessages` 中为 409/413/503 增加显式状态：cursor stale 继续全量刷新；budget 或 unavailable 时展示可读错误或降级提示，不再静默失败。
5. 部署后手工验证：真实 180 MiB rollout 上依次执行 initial、older、newer、around，确认返回窗口与 UI 展示连续、无重复/缺漏。

### 2.4 完成检查

- `afterWindow` / `around` / `before` 与 route-level slicer 的窗口语义一致，message id 序列连续。
- 页面内消息数、分页信息与实际转换结果一致，`returnedMessageCount` 无偏差。
- 跨 compaction/patch/image 边界的分页 parity 测试通过。
- 旧 cursor 兼容与 stale revision 测试通过。
- 运行中的 8022 已加载包含 `appendAfterCursor` 的构建。

---

## 3. 工作流 2：含 `thread_rolled_back` 的大文件支持（M2c）

### 3.1 现状

- 无 rollback 文件：流式 summary + 流式 page，最大可处理 512 MiB 内 rollout（admission 默认 512 MiB）。
- 含 `thread_rolled_back` 或旧 cursor 的文件：仍调用 `loadSessionEntries`（`readSharedCodexEntries` 全文读） + `buildCodexBranchView`。
- `CODEX_ROLLBACK_FULL_READ_MAX_BYTES` 默认 32 MiB；超过即抛 `CodexHistoryUnavailableError`，route 返回 503 `SESSION_HISTORY_UNAVAILABLE`。
- `getSessionSummary` 对超过 32 MiB 的 rollback 文件直接返回 `null`（列表不可见），没有显式不可索引标记。

### 3.2 剩余问题

1. 大 rollback 文件完全打不开，只能 fail-closed。
2. 小 rollback 文件仍走全文读，存在 32 MiB 内但条目数很大的瞬时分配峰值；`buildCodexBranchView` 会保留完整 `entries[]` 与 branch tree。
3. rollback 文件的 summary 也没有流式路径：要么全文读，要么 null；无法给列表提供可信摘要。

### 3.3 实施步骤

1. 设计并实现 **rollback semantic index**（流式、有界）：
   - 复用 `iterateCodexRolloutLines`；
   - 只保留：session_meta、`thread_rolled_back` marker、user turn 的 offset / prompt / timestamp、`compacted` marker 的 offset / timestamp、以及 branch tree 结构；
   - **不缓存**原始 tool call/output、assistant 正文、token_count 详情；
   - 所有数组/Map 都设置 `CODEX_MAX_BRANCH_ITEMS` / byte 上限，超限直接 `SESSION_HISTORY_UNAVAILABLE`。
2. 用该 index 推导与 `buildCodexBranchView` 一致的 branch tree：
   - branch id 继续使用 `codex-branch-@<offset>`；
   - `selectedBranchId` 的解析、active path、setup entries 语义与旧 reducer 保持 parity；
   - 先在小 fixture 上与全文 reference 做严格 diff。
3. 实现按 branch 的流式 page 读取：
   - 根据选中 branch 的 `visibleStartOffset` / `visibleEndOffset` 和 cursor 类型，复用 `scanCodexRolloutPageOnce` 的窗口逻辑；
   - 只在 `[visibleStartOffset, visibleEndOffset)` 内保留页面 entry；
   - `totalMessageCount` 按选中 branch 的可见范围计算。
4. `getSessionSummary` 使用 rollback index 生成摘要（title/count/usage/compaction 等），不再返回 null；无法在预算内构建 index 时返回 null 并记录不可索引项。
5. 保留 32 MiB 全文 reference path **仅用于测试和灰度 parity**；生产路径不得在 rollback 文件上自动回退到全文读。
6. 错误矩阵：
   - index 超预算：`SESSION_HISTORY_UNAVAILABLE`（503）；
   - 页面 cursor 与 revision 不匹配：`SESSION_HISTORY_CURSOR_STALE`（409）；
   - 扫描中文件变化：`SESSION_HISTORY_CHANGED`（409）。
7. 兼容旧 cursor：无 revision 的旧 cursor 若与当前 index revision 不一致，保守重扫并核对；不能证明一致时返回 stale。

### 3.4 完成检查

- 含 rollback marker 的小 fixture：流式 page 与 `buildCodexBranchView` 全文 reference 严格 parity。
- 含 rollback marker 的大 fixture：不触发全文 `readFile → split → entries[]`，返回正确 branch page 或结构化 `SESSION_HISTORY_UNAVAILABLE`。
- summary 列表对 rollback 文件返回可信摘要，或在索引超预算时显式不可见，不再静默 null。
- 生产路径搜索不到对 `readSharedCodexEntries` 的 rollback 文件无条件调用。

---

## 4. 工作流 3：Canonical event journal 内存有界化（M1）

### 4.1 现状

- `JsonlCodexEventStore` 仍长期保留四类索引：`eventsBySession`、`eventsBySessionMethod`、`eventsByIdentity`、`eventsByDedupeKey`。
- `rotateIfNeeded` 明确保留已 rotation/prune event 的内存索引，运行越久常驻越大。
- sequence 取 `eventsBySession[session].at(-1) + 1`；某 session 事件全部被 prune 且进程重启后 sequence 会回到 1。
- `source.ts` 的 freshness 选择会调用 `latestEventAtMs` / `latestSequence`，冷态会 `ensureLoaded` 全部候选 journal。
- 同一 path 的 provider writer 与 route reader 可能各持一个 `JsonlCodexEventStore`，各自保留完整索引。
- 只有 `getStorageBytes()` 和 512 MiB 硬阈值跳过（`CODEX_EVENT_STORE_ADMISSION_BYTES`），没有 coverage、eviction 或 replay budget。

### 4.2 设计要点

1. **保留窗口 + 磁盘回源**：
   - 内存只保留最近 N MiB / N events（按 journal 或按 session 水位）。
   - 超出窗口的 replay 请求通过 streaming 读磁盘 segment 构建本次 bounded response，不重新建立长期索引。
   - 物理 prune 后不可恢复的数据必须在 API 中体现为 `leadingGap` / coverage，不得伪装完整历史。
2. **durable compact metadata**：
   - 每 journal 维护一个小型 metadata 文件：`lastSequenceBySession`、`firstAvailableSequenceBySession`、`latestEventAtMsBySession`、segment epochs。
   - append / rotation / prune 后原子更新；用于 source freshness 比较，避免冷加载全 journal。
   - 是否支持“全部 prune + 重启后 sequence 仍单调”必须在代码与测试中明确；若不支持，必须在 `replay` / store contract 中写清限制。
3. **四类索引有界化**：
   - 给每个索引和 `sessionCountsByFile` 设 byte/event 上限与淘汰策略；
   - dedupe 语义从“lifetime”降级为“retained window 内严格 + 保留 segment 磁盘验证 + 已 prune key 不可验证”，并写入 contract。
4. **同 path 单 owner**：
   - 在 `app.ts` / provider writer / bridge writer 中显式注入或注册同一 path 的 store；
   - 解决 rotation options、callbacks、close/reset 与测试隔离冲突。
5. **source freshness 改造**：
   - 优先读 compact metadata；
   - metadata 不可用或 coverage 不安全时回退 legacy view 并记录固定 reason code。
6. **replay response budget**：
   - `replay()` 增加 `maxEvents` / `maxBytes` / `afterSequence` / `throughSequence` 的严格校验；
   - 超限抛稳定错误，不在请求层重新 materialize 无界数组。

### 4.3 实施步骤

1. 在 `JsonlCodexEventStore` 增加 `getDebugStats()`：各索引条数、估算字节、loaded segments/epoch、first/last available sequence、eviction、磁盘回源次数、budget rejection。
2. 实现 compact metadata 文件读写与原子更新；`latestEventAtMs` / `latestSequence` / `replay` 优先使用 metadata 判断是否可跳过 cold load。
3. 实现内存索引 eviction 与磁盘 segment 流式回读；rotation/prune 后同步淘汰内存索引。
4. 改造 `source.ts` 的 `selectFreshestSourceStore`：使用 metadata 比较 freshness，避免无条件 `ensureLoaded`；仅对选中 store 做 cold load 或直接磁盘 replay。
5. 建立 store registry / 依赖注入，消除同 path 双实例。
6. 扩展 replay contract：返回或附带 `coverage`；对要求完整前缀的 consumer 增加显式 `requiresCompletePrefix` 检查。
7. 增加 replay / dedupe / sequence 单调性 / leading gap / eviction / rotation / prune / source selection 的回归测试。

### 4.4 完成检查

- 长时间 append/rotation 后，四类索引有明确 byte/event 上界，stats 能显示水位、eviction 和 coverage。
- retained-history replay、`afterSequence`、`throughSequence`、methods filter、latest event time、projection cache 前缀校验通过。
- leading gap 不会被投影为完整 canonical history。
- 8022 内同 path 不再保留 writer/reader 两份完整 event 索引。
- replay response 自身受 bytes/events budget 约束。
- source freshness 在冷态下不 cold load 所有大 journal。

---

## 5. 工作流 4：中断归因（provenance）与恢复 UX（M0 文案 + M3）

### 5.1 现状

- `packages/server/src/sessions/codex-turn-aborted.ts` 固定返回 `"Conversation stopped by user"`。
- `normalization.ts` 把任意 `turn_aborted` 转成该系统消息，丢弃 raw `reason` / `turnId`。
- `packages/client/src/lib/preprocessMessages.ts` 再次硬编码同一文案。
- `RenderItemComponent.tsx` 只显示 `SystemItem.content`，没有按 subtype/provenance 走 i18n。
- `AgentSession.interrupt` / `Process.interrupt` / runtime API 不返回 `turnId`，无法确认中断的是哪个 turn。
- 没有 runtime lifecycle ledger；受控 restart 与异常退出不会生成可回放的 turn 级原因。
- 没有 i18n 文案区分 confirmed user stop / server restart / server unavailable / upstream / unknown。

### 5.2 实施步骤

1. **Schema 设计**：
   - 在 shared app types 增加 provider-neutral `TurnStopProvenance`：
     `cause: user_interrupt | server_restart | server_unavailable | upstream | unknown`，
     `confidence: confirmed | inferred`，
     `sessionId`、`turnId`、`processId`、`runtimeInstanceId`、`source` / `sourceId`、可选 `sourceSequence`、`recordedAt`、`providerReason`。
   - Codex persisted schema 显式保留 `turn_id`、`reason`、`started_at`、`completed_at`、`duration_ms`；原始字段仅诊断用。
2. **服务端 resolver**：
   - `codex-turn-aborted.ts` 改为纯 resolver：输入 `turn_aborted` 事件 + 可选的 confirmed control record，输出 provenance。
   - `normalization.ts` / `session-projection.ts` 保留 raw reason/turnId，但展示文本只来自 resolver。
   - 默认 fallback 为中性英文 `"Conversation interrupted"`，并同步 `en.json` / `zh-CN.json`。
3. **中断 contract 扩展**：
   - `AgentSession.interrupt` → `Process.interrupt` → `Supervisor` → `RuntimeController` → HTTP/control protocol 的返回值携带 provider 确认的 `turnId`。
   - external runtime protocol version 同步提升，并增加 mismatch 测试。
4. **Lifecycle ledger**：
   - 新增紧凑 lifecycle ledger（或明确改造 `RuntimeEventStore`）：记录 runtime instance start、turn active、explicit interrupt confirmed、graceful shutdown intent/completed、turn terminal。
   - 记录 payload 有严格 byte cap，不包含 prompt/tool output。
5. **写入边界**：
   - `/processes/:id/interrupt` 的 provider-confirmed success；
   - `/processes/:id/abort` 仅当调用前能绑定 active turn；
   - 会终止 active turn 的 confirmed permission-deny/input decision；
   - graceful shutdown 在 abort active providers **之前** durable flush。
   - HTTP 到达、unsupported、RPC failure、缺 turn ID、终止属于另一 turn 时不得标 user。
6. **启动恢复**：
   - exact active turn + controlled shutdown intent → `server_restart / confirmed`；
   - exact active turn + instance 有启动记录但无 clean terminal → `server_unavailable / inferred`；
   - 没有可靠 turn 关联 → `unknown`。
7. **客户端**：
   - `preprocessMessages.ts` 只生成结构化 `SystemItem`，不再硬编码最终文案；
   - `RenderItemComponent.tsx` 按 `subtype` + provenance 走 i18n；
   - `StatusBadge.tsx` / `SessionListItem.tsx` 等展示 last-turn health 时使用同一 resolver 结果。
8. **兼容性**：
   - 旧 JSONL / bridge state / journal 缺新字段时默认 `unknown`；
   - 不得因为缺 provenance 就显示 `"Conversation stopped by user"`。

### 5.3 完成检查

- 无确认证据的 `turn_aborted` 显示 `"Conversation interrupted"` 及中文对应文案。
- 同一 `(sessionId, turnId, runtimeInstanceId)` 的 confirmed control record 才显示 `"Conversation stopped by user"`。
- `replaced` / `review_ended` / `budget_limited` 不显示为 user stop。
- 旧数据可读且默认 unknown。
- event 乱序、重复 replay、多 turn、retry 后成功、bridge 重连、control failure、记录写入失败、RPC 成功后记录前 OOM 均有单测。

---

## 6. 建议实施顺序与里程碑

1. **P0 部署修复后的 reader**：先重新构建并部署包含 `appendAfterCursor` / admission race 修复的提交，让运行中 8022 至少具备正确的分页方向。
2. **P1 分页正确性收尾**（工作流 1）：compaction dedupe 注入 + 分页 parity 测试 + client 错误反馈。
3. **P2 rollback 大文件**（工作流 2）：rollback semantic index + branch page + reference parity 测试。
4. **P3 journal 内存有界化**（工作流 3）：compact metadata + 内存 eviction + 磁盘回源 + single owner。
5. **P4 中断归因**（工作流 4）：schema/resolver/ledger/client UI，配合 M0 文案修复一起落地。

建议每个里程碑独立提交、独立测试；P0 和 P1 是当前用户可感知问题，优先级最高。

## 7. 测试与验证

```bash
pnpm lint
pnpm typecheck
pnpm test
```

聚焦测试：

```bash
# 分页
corepack pnpm --filter @yep-anywhere/server test -- test/sessions/codex-streaming-reader.test.ts test/sessions/codex-partial-read-parity.test.ts test/sessions/codex-rollout-file.test.ts

# journal
corepack pnpm --filter @yep-anywhere/server test -- test/codex-events/store-jsonl.test.ts test/codex-events/store-replay.test.ts test/codex-events/ingress.test.ts test/codex-events/session-projection.test.ts test/routes/sessions-canonical-overlay.test.ts

# 中断归因
corepack pnpm --filter @yep-anywhere/server test -- test/runtime test/routes/processes.test.ts
corepack pnpm --filter @yep-anywhere/client test -- src/lib/__tests__/preprocessMessages.test.ts src/components/__tests__/RenderItemComponent.test.tsx
```

独立内存验证（不进入普通 `pnpm test`）：

- 真实量级 180 MiB rollout fixture 在受限 `--max-old-space-size` child process 下完成 summary、initial、older/newer/around、index cold scan 和受控并发；
- 多 segment journal 长时间 append/rotation/prune 后索引内存稳定；
- 断言所有 budget rejection 路径不回退到全文 `readFile/split`。

## 8. 约束与回滚

- 不把增大 Node heap 当成修复。
- 不删除 rollout / journal，不用数据丢失换内存下降。
- 不修改、删除、暂存或提交用户未跟踪文件 `context.md`。
- 未获用户明确授权前不重启、不部署、不运行浏览器自动化。
- journal 裁剪与 provenance 需要独立 feature/config gate，可降级到“显式不可用/unknown”，不可降级回错误历史或 user-stop 误归因。
- 开发阶段只更新 `CHANGELOG.md [Unreleased]`；正式部署/发布前按 CalVer 流程执行 `pnpm version:status` / `pnpm version:bump` / `pnpm version:check`。

## 9. 预计修改文件清单

### 分页与 rollback
- `packages/server/src/sessions/codex-reader.ts`
- `packages/server/src/sessions/codex-rollout-file.ts`
- `packages/server/src/sessions/codex-entries-reader.ts`
- `packages/server/src/sessions/codex-entry-anchor.ts`
- `packages/server/src/sessions/codex-rollback.ts`
- `packages/server/src/sessions/normalization.ts`
- `packages/server/src/sessions/pagination.ts`
- `packages/client/src/hooks/useSessionMessages.ts`

### Journal 内存
- `packages/server/src/codex-events/store.ts`
- `packages/server/src/codex-events/source.ts`
- `packages/server/src/codex-events/session-projection.ts`
- `packages/server/src/routes/codex-transcript.ts`
- `packages/server/src/app.ts`
- `packages/server/src/sdk/providers/codex.ts`

### 中断归因
- `packages/shared/src/app-types.ts`
- `packages/shared/src/codex-schema/session.ts`
- `packages/server/src/sessions/codex-turn-aborted.ts`
- `packages/server/src/sessions/normalization.ts`
- `packages/server/src/runtime/*`
- `packages/server/src/supervisor/*`
- `packages/server/src/routes/processes.ts`
- `packages/server/src/sdk/providers/types.ts`
- `packages/client/src/lib/preprocessMessages.ts`
- `packages/client/src/types/renderItems.ts`
- `packages/client/src/components/RenderItemComponent.tsx`
- `packages/client/src/components/StatusBadge.tsx`
- `packages/client/src/components/SessionListItem.tsx`
- `packages/client/src/i18n/en.json`
- `packages/client/src/i18n/zh-CN.json`

### 测试与文档
- 对应 test 文件（见第 7 节）
- `scripts/bench-session-load.ts` 或新增 stress harness
- `CHANGELOG.md`
- `docs/project/` 下本文件与既有计划的状态更新
