# Codex Session 列表与切换性能开发计划

> 日期：2026-08-22  
> 状态：scope review/remediation 完成（可合并、未部署）  
> 适用范围：Yep Anywhere 的 Codex / Codex OSS session 列表、session detail、4510 bridge 状态同步、canonical event journal  
> 事实来源：本仓库实现、`references/codex/`、本机只读基准与 OpenAI App Server 协议

## 1. 目标与结论

本计划解决以下用户可见问题：

- Codex session 数量增加后，全局 session 列表和 project 列表出现越来越明显的延迟尖峰。
- 在多个 Codex session 之间来回切换时，每次都显示 loading skeleton，并重复支付 REST、rollout 扫描、normalize 和渲染成本。
- 超长 rollout 即使客户端只请求最近 100 条消息，服务端仍然从头到尾扫描 JSONL；已分页化的 Codex session 也没有使用 app-server 的 SQLite 历史索引。
- 4510 bridge 已经轻量化，但主服务仍每秒获取两份全量 bridge session snapshot，并在活跃状态变化时重复解析全量列表。
- provider canonical journal 的全局冷加载与长期对象索引继续推高 8022 RSS、首次 Codex 初始化时间和 GC 压力。

核心架构决策：

1. **4510 继续只做轻量协议接管代理**，不把普通历史读取、session 搜索或内容缓存塞回 bridge。
2. **8022 新增 Codex history read adapter**，通过 app-server 协议读取 `thread/list`、`thread/read`、`thread/turns/list` 和 `thread/items/list`。
3. **paginated session 优先使用 app-server 的 SQLite history store**；legacy session、能力探测失败和语义不兼容场景继续回退当前 bounded rollout reader。
4. **客户端增加小型跨 session snapshot LRU + stale-while-revalidate**，切回最近 session 时先画缓存，再后台校正。
5. **Codex provider-wide catalog 独立承担本问题的物理 root 列表职责**；通用
   `SessionIndexService` 与 Gemini/Pi/Kimi/ZCode reader 保持 HEAD 行为，避免跨 project 污染。
6. **canonical event store v2 不属于本轮 session switching 快路径**；继续使用既有 JSONL
   event store/projection，不新增 SQLite、双存储或迁移开关。

## 2. 已核验基线

### 2.0 Codex protocol 版本边界

- 2026-08-22 M0 只读 smoke 实测本机 `codex-cli` 为 `0.149.0`。
- 仓库 `packages/server/src/sdk/providers/codex-protocol/manifest.json` 当前 generated
  protocol 仍固定为 `0.147.0`。
- 本计划使用的 `thread/list(useStateDbOnly=true)`、metadata-only `thread/read`、
  `thread/turns/list` 与 `thread/items/list` 已在 0.149.0 smoke 通过，但 M2 仍必须按
  “CLI version + generated schema hash” 做 capability cache；不得假设本机 CLI 与仓库
  generated types 永远同版，也不得因 smoke 通过而跳过 runtime method fallback。

### 2.1 4510 bridge

只读现场快照：

| 指标 | 当前值 |
| --- | ---: |
| bridge session 数 | 111 |
| 当前连接数 | 0 |
| journal mode | `lifecycle` |
| Node RSS | 约 93 MiB |
| event-loop lag p95 | 约 2.5 ms |
| `/sessions` | 约 1.6 ms / 97.8 KiB |
| `/session-views` | 约 2.6 ms / 87.1 KiB |

结论：4510 的 frame forwarding 和内存问题已经通过 lifecycle 轻量化得到控制；当前仍有全量 snapshot 随 session 数线性增长的次要问题，但不是 session detail 慢的首要原因。

### 2.2 Codex rollout 与 detail

| 指标 | 当前值 |
| --- | ---: |
| `~/.codex/sessions` rollout 文件数 | 273 |
| retained rollout 总字节 | 约 575.6 MB |
| p50 / p90 / p99 | 0.86 / 2.56 / 10.45 MB |
| 最大 rollout | 188.7 MB |
| 最大 rollout 初始 detail | 约 1.50–1.56 s |
| 最大 rollout summary scan | 约 0.64–0.71 s |
| 最大 rollout `getSession` | 约 1.24–1.25 s |
| bounded page normalize | 约 1 ms |
| 最近普通 Codex session | 约 18–76 ms |

最大 rollout 没有 rollback marker，且已经是 `history_mode=paginated`。其 Codex thread-history DB 中有 45 turns、11,110 items，索引读取最近 25 turns 的只读查询低于当前计时精度 10 ms。

结论：超长 session 的主要时间花在 Yep 自己的 summary 全扫 + page 全扫，不在 normalize，也不在 Codex 已有的分页索引。

### 2.3 SessionIndex 与列表

| 指标 | 当前值 |
| --- | ---: |
| persisted index 文件 | 155 |
| external/project scope index | 120 |
| `/api/sessions?limit=100` | 约 9–535 ms |
| `/api/projects` | 约 4–736 ms |
| 同一轮 provider full validation | 约 630–666 ms |

`allowStale` 虽然先返回旧 index，但 `refreshSessionsInBackground()` 仍在 8022 Node 主线程启动大量扫描/解析。该工作没有被 await 不等于真正后台化；多个 scope 并发运行时仍会阻塞当前 HTTP 请求和 WebSocket 事件。

### 2.4 Canonical event journal

| 指标 | 当前值 |
| --- | ---: |
| provider journal retained bytes | 约 915 MB |
| legacy bridge journal retained bytes | 约 989 MB |
| 8022 RSS | 约 2.4 GiB |
| 本次进程首次 Codex session 初始化 | 约 3.89 s |
| 当前进程 shadow mismatch warning | 2,981 条 |

普通 canonical overlay 已因 512 MiB admission 立即 fallback rollout；但 provider writer 首次 append 仍会加载所有 retained segment，并长期持有按 session、method、identity 和 dedupe key 建立的索引。

## 3. 作用域与非目标

### 3.1 本计划包含

- Codex session 列表、定位、detail、上下页历史读取。
- 客户端切换缓存、SWR 和请求竞态处理。
- SessionIndex / Codex manifest 的扫描与失效策略。
- 4510 到 8022 的 session-state 同步效率。
- canonical event store 的内存与冷加载治理。
- 聚焦单测、协议 smoke、离线基准和发布前验证。

### 3.2 本计划不包含

- 不改变 Codex rollout 的上游格式。
- 不直接读写或依赖 Codex 私有 SQLite schema；只读基准可以查询，产品实现必须走 app-server protocol。
- 不自动运行 `codex migrate-rollouts --apply`，不替用户迁移 legacy rollout。
- 不删除、归档、压缩或搬迁现有 provider/bridge journal。
- 不把增大 Node heap 当作修复。
- 不新增 4510 的普通 transcript/history 服务职责。
- 未经用户明确授权，不重启、停止或部署 4510/8022，不运行浏览器/Playwright/UI 自动化。
- 不处理与当前任务无关的 dirty worktree 文件。

## 4. 目标架构

```text
React client
  ├─ session list metadata
  │    └─ 8022 SessionCatalog
  │         ├─ CodexHistoryClient.thread/list(useStateDbOnly=true)
  │         └─ legacy manifest/index fallback + background reconcile
  │
  └─ session detail
       ├─ client snapshot LRU hit -> immediate paint
       └─ 8022 CodexHistoryReader
            ├─ paginated -> thread/read(false)
            │              + thread/turns/list
            │              + thread/items/list
            └─ legacy/unsupported -> current bounded CodexSessionReader

4510 bridge
  ├─ WebSocket forwarding / MCP profile
  ├─ ownership / pending input / lifecycle snapshot
  └─ one incremental or conditional session-state feed to 8022

Canonical events
  └─ existing JSONL event store / projection (unchanged in this scope)
```

## 5. 关键契约

### 5.1 History capability

新增 server 内部能力类型：

```ts
type CodexHistoryReadMode = "paginated-app-server" | "legacy-rollout";

interface CodexHistoryCapability {
  protocolVersion: string;
  supportsThreadListStateDbOnly: boolean;
  supportsThreadTurnsList: boolean;
  supportsThreadItemsList: boolean;
}
```

决策规则：

1. `thread/read(includeTurns=false)` 返回 `historyMode=paginated` 且 turns/items API 可用时，使用 app-server page reader。
2. `historyMode=legacy` 时使用 rollout reader；不要调用伪分页后再假设成本已变成 O(page)。
3. app-server 返回 unsupported/unknown method、协议版本不匹配或分页 cursor 无效时，记录 typed fallback reason，并回退 rollout。
4. app-server 超时、进程退出和 state DB 暂时不可用不得让整个 provider session 列表失败。

### 5.2 Cursor 与 revision

客户端 pagination 统一暴露不透明 cursor，server 内部记录来源：

```ts
interface SessionPageCursor {
  source: "codex-app-server" | "codex-rollout";
  revision?: string;
  cursor: string;
}
```

- app-server cursor 原样封装，不由 Yep 解析。
- 当前已核验的 app-server `thread/turns/list` / `thread/items/list` 响应不提供独立
  history revision；Yep 不得从 Codex 私有 SQLite 补造该字段。app-server 路径先锁定
  cursor source，并把上游 invalid cursor 映射为稳定 stale error；只有协议能够提供或
  通过公开 metadata 严格证明 snapshot revision 时才填 `revision`。
- rollout cursor 继续使用 byte offset + file revision。
- 同一请求链不得混用两个 source 的 cursor。
- fallback 导致 source 改变时返回稳定的 `SESSION_HISTORY_CURSOR_STALE`，客户端重新加载首屏。

### 5.3 Snapshot cache

客户端缓存 key：

```text
projectId + sessionId + branchId + historySource
```

value 只包含：

- 最近 bounded message window；
- pagination/cursor；
- session metadata；
- snapshot revision 和写入时间。

默认约束：

- 最多 5 个 session；
- 总估算 JSON bytes 默认 32 MiB；
- 单 session 超过 12 MiB 不进入缓存；
- 不缓存 inline media、完整 reasoning 历史或完整 agentContent；
- route remount 时保留模块级 LRU，但保留现有 stream/approval state 重置语义。

### 5.4 列表一致性

`thread/list(useStateDbOnly=true)` 是快速候选源，不是无条件完整事实源：

- 校验返回的 rollout path 是否存在；
- 与 bridge live session、Supervisor-owned session 合并；
- 首屏 DB 为空或不可用时才同步走 scan-and-repair fallback；
- 非空 DB 首屏先返回，后台低优先级 reconcile 缺失/陈旧记录；
- 同一 session ID 只保留一个 canonical list row。

## 6. 实施里程碑

### 6.0 2026-08-22 修复审计状态

此前“已完成”结论被 correctness/performance 与 scope 审计推翻；历史数字仅作背景，不能
作为本轮验收。本轮保留 direction-aware/source-locked 双向分页、typed parity fallback、
四类用户可见 source catalog、TTL/reconcile/cheap metadata、Codex manifest 专用 worker、
4510 ETag + 单 session 定向刷新，以及避免主线程双重序列化的 client cache。通用 M4 与
SQLite M6 已撤回；真实 CLI/基准和最终全量检查尚未完成，不得提前标记可合并。

### 6.1 CODEX-SESSION-PERF-SCOPE-REVIEW-002 scope review（收缩前）

本轮从 `HEAD=4da7a6b2c838a5d37693d6f31812dd4f062b4768` 重新读取完整 diff，
不以此前“里程碑完成”作为保留理由。收缩前共有 57 个 tracked 文件（`+3459/-475`）和
21 个 untracked 文件（5506 行），合计 78 个文件、`+8965/-475`。分类如下：

| 类别 | tracked | untracked | 收缩前 LOC | 文件 |
| --- | ---: | ---: | ---: | --- |
| A 必要 fast path | 19 | 7 | `+3203/-193` | `package.json`；client `api/client.ts`、`hooks/useSessionMessages.ts`、`lib/mergeMessages.ts`、`lib/sessionSnapshotCache.ts`；server `app.ts`、`index.ts`、`codex-history/*`、`projects/codex-scanner.ts`、`routes/{global-sessions,projects,provider-catalog,sessions,server-timing}.ts`、`sessions/{codex-reader,codex-session-manifest,provider-resolution,types}.ts`、`indexes/session-file-scan-worker.ts`、bridge notifier/client/service |
| B correctness/privacy guard | 1 | 0 | `+102/-25` | `packages/server/src/sdk/providers/codex.ts` |
| C tests/benchmark/docs | 11 | 8 | `+3862/-74` | `CHANGELOG.md`、现有计划、`scripts/{bench-session-load,smoke-codex-history-read}.ts`、client cache/hook/merge tests、server codex-history fixture/tests、bridge tests、route tests、provider-resolution tests、worker test |
| D 删除或延期 | 18 | 3 | `+1203/-76` | M4 通用 `SessionIndexService`/Gemini/Pi/Kimi/ZCode physical inventory；M6 event SQLite/source/query transaction；message-count accuracy；native type-label renderer；`session-index-observation.ts` 及只为这些抽象存在的 tests |
| E 无关既有 dirty | 8 | 3 | `+595/-107` | `MessageInput.tsx`、`NewSessionForm.tsx`、`SessionPage.tsx`、两份 i18n、`agentCommands.ts` 及其 tests、`context.md`、`codexInputCommands.ts` 及 test |

逐个 production 文件的裁决与必要性（tests/docs 仅随对应行为保留）：

| 文件 | 分类 | 裁决与当前问题的直接关系 |
| --- | --- | --- |
| `package.json` | A | 只保留只读 history smoke 入口，便于发布前重复验证。 |
| `packages/client/src/api/client.ts` | A/D | 保留 history source/cursor 响应；删除无 UI 消费的 message-count accuracy。 |
| `packages/client/src/hooks/useSessionMessages.ts` | A | bounded LRU/SWR 的唯一页面接线与竞态保护；本轮禁止改动。 |
| `packages/client/src/lib/sessionSnapshotCache.ts` | A | 跨 session 小型有界缓存；直接消除 A→B→A skeleton。 |
| `packages/client/src/lib/mergeMessages.ts` | A | revalidate 保留未变消息引用，避免大 payload 序列化比较。 |
| `packages/client/src/lib/preprocessMessages.ts` | D | hook/review/sleep 只有 type 标签，不构成 parity；删除该增量，改由 history typed fallback。 |
| `packages/server/src/app.ts` | A | 只保留长驻 history client、catalog、Codex watcher 接线。 |
| `packages/server/src/index.ts` | A | graceful shutdown 关闭长驻只读 history client。 |
| `packages/server/src/codex-history/CodexHistoryClient.ts` | A | 复用 app-server transport 的长驻只读 list/read client。 |
| `packages/server/src/codex-history/CodexAppServerHistoryReader.ts` | A/B | bounded history、双向 cursor、source lock、脱敏与 typed fallback 的核心。 |
| `packages/server/src/codex-history/CodexSessionCatalog.ts` | A | provider-wide `thread/list`、sourceKinds、TTL/manifest cheap metadata。 |
| `packages/server/src/codex-history/types.ts` | A | history capability、cursor envelope 与固定 fallback reason。 |
| `packages/server/src/projects/codex-scanner.ts` | A | project 列表直接复用 provider-wide catalog，避免 rollout scope 扫描。 |
| `packages/server/src/routes/provider-catalog.ts` | A | 把同一 Codex catalog snapshot 交给 list/provider resolution。 |
| `packages/server/src/routes/global-sessions.ts` | A/D | 保留 catalog/bridge 合并；删除 accuracy 与 M4-only observation。 |
| `packages/server/src/routes/projects.ts` | A/D | 保留 catalog session list；删除 accuracy 与 M4-only observation。 |
| `packages/server/src/routes/sessions.ts` | A/B | app-server detail、cheap metadata、mixed-provider fast path、typed stale 响应。 |
| `packages/server/src/routes/server-timing.ts` | A | 小型无内容 timing，用于真实 cold/warm 证据，不改变 source of truth。 |
| `packages/server/src/routes/session-index-observation.ts` | D | 仅支撑被撤回的通用 M4 统计，删除。 |
| `packages/server/src/sessions/codex-reader.ts` | A/D | 保留 rollout fallback timing/source；删除通用 physical-index 接口。 |
| `packages/server/src/sessions/codex-session-manifest.ts` | A | Codex 专用 worker header batch，直接服务 catalog fallback。 |
| `packages/server/src/sessions/provider-resolution.ts` | A | mixed-provider project 从 catalog 解析 Codex，不冷扫 rollout。 |
| `packages/server/src/sessions/types.ts` | A/D | 保留 history source/timing；删除 physical inventory projectPath 接口。 |
| `packages/server/src/codex-history/CodexManifestScanWorker.ts` | A | Codex manifest 专用 discovery/stat/plain-header worker；不接入通用 SessionIndex。 |
| `packages/server/src/indexes/SessionIndexService.ts` | D | Codex 已由 catalog 绕开；恢复 HEAD，避免跨 provider scope 污染。 |
| `packages/server/src/sessions/gemini-reader.ts` | D | 恢复 HEAD；当前 Codex 卡顿不需要 Gemini physical inventory。 |
| `packages/server/src/sessions/pi-reader.ts` | D | 恢复 HEAD；当前 Codex 卡顿不需要 Pi physical inventory。 |
| `packages/server/src/sessions/kimi-reader.ts` | D | 恢复 HEAD；当前 Codex 卡顿不需要 Kimi physical inventory。 |
| `packages/server/src/sessions/zcode-reader.ts` | D | 恢复 HEAD；当前 Codex 卡顿不需要 ZCode 全库查询。 |
| `packages/server/src/sessions/pagination.ts` | D | 仅新增 accuracy 字段，无消费，恢复 HEAD。 |
| `packages/server/src/supervisor/types.ts` | D | 仅新增 accuracy 字段，无消费，恢复 HEAD。 |
| `packages/shared/src/app-types.ts` | A/D | 删除 accuracy；仅保留不复制 native payload 所需的稳定 item ID provenance。 |
| `packages/server/src/codex-events/{index,rollout,source,store}.ts` | D | M6 默认关闭且不在 history/catalog/bridge 快路径，恢复 HEAD。 |
| `packages/server/src/codex-events/sqlite-store.ts` | D | 删除；不引入第二 event source/retention 架构。 |
| `packages/server/src/routes/codex-transcript.ts` | D | 删除 M6 双存储 wiring，恢复 JSONL source。 |
| `packages/server/src/sqlite/query-worker.ts` | D | 删除只为 M6 增加的 transaction 协议。 |
| `packages/server/src/watcher/EventBus.ts` | D | 删除只为 bridge goal 里程碑增加的 trigger 扩张。 |
| `packages/server/src/bridge-common/BridgeEventNotifier.ts` | A | SSE 只携带 revision 与 changed IDs。 |
| `packages/server/src/bridge-common/BridgeHttpClient.ts` | A/D | 保留完整 SSE frame 解析和定向调度；删除 `BridgePollBatch` 状态机。 |
| `packages/server/src/bridge-common/util.ts` | D | content-length 泛化不是当前问题所需，恢复 HEAD。 |
| `packages/server/src/codex-bridge/CodexBridgeHttpClient.ts` | A | startup/interval 单 snapshot ETag/304；change 用既有单-session view。 |
| `packages/server/src/codex-bridge/CodexBridgeService.ts` | A/D | 保留 ETag/revision/changed ID 与既有单-view route；删除 delta endpoint，goal 只触发通用 refresh。 |
| `packages/server/src/sdk/providers/codex.ts` | A/B/D | 保留 transport export 与穷举公共脱敏；删除 M6 store wiring/default projection 改动。 |

收缩目标：M4 通用 physical index 与 M6 event-store v2 均改为 deferred/out-of-scope；
最终只保留轻量 Web Codex 的 LRU/SWR、只读 app-server history/catalog、4510 单 snapshot
ETag/304 + 单 session 定向刷新、必要 fallback/脱敏/测试与只读基准。

### 6.2 scope review 结果（final）

final worktree 为 43 个 tracked + 18 个 untracked；其中 8 tracked + 3 untracked 是本 Goal
明确不触碰的并发改动。归属本 Goal 的 50 个文件分为：27 个 production（`+3355/-209`）
和 23 个 tests/docs/support（`+4138/-77`）。相对启动时 57 tracked / 21 untracked，净减少
14 tracked、3 untracked，共 17 个文件；总体从 78 降到 61，且不含并发改动的 Goal 范围为
50。撤回项包括通用 SessionIndex physical inventory、Gemini/Pi/Kimi/ZCode reader 改造、
M6 SQLite/event-source/query-worker、accuracy 全栈字段、delta endpoint/批协议与 label-only
native renderer。final diff 搜索未发现残留 feature flag、第二 event source、跨 provider
production 修改或大 payload signature stringify。

### M0：观测、协议探测与基准固化

状态：**实现完成；本轮真实只读 probe 已通过**。

实施结果：

- session detail 通过 `Server-Timing` 暴露计划中的九个固定阶段；global/project list
  同样暴露 bounded route stages，未改变 JSON response shape。
- 4510 main-server poll client 记录 snapshot bytes、poll reason、targeted row 数与 304；不再
  添加通用 SessionIndex observation 层。
- `scripts/bench-session-load.ts` 支持 `rollout|app-server|both`、cold/warm、historyMode
  和 JSON/gzip bytes；新增的 read-only smoke 只发送 initialize、thread/list、
  metadata-only thread/read、turns/items list。
- 本轮真实只读 probe：Codex 0.149.0，catalog 101 sessions / 8 projects，source counts
  `cli=3/vscode=92/exec=6/appServer=0`，first/warm 56/0 ms；输出仅含 hash、计数与耗时。

验证：

- 相关 Biome check 通过。
- `@yep-anywhere/server` TypeScript check 通过。
- routes/index/bridge 五个 focused suites 共 98 tests 通过。
- `pnpm test:codex-history-read-smoke` 通过；未 resume/start turn、未发送模型请求。

目标：在改变读取路径前，让每个耗时阶段可观测并建立回归门槛。

任务：

1. 为 session detail 添加 `Server-Timing` 或结构化 debug 字段：
   - `projectLookup`
   - `bridgeView`
   - `historyCapability`
   - `summaryScan`
   - `pageRead`
   - `normalize`
   - `canonicalSelect`
   - `canonicalOverlay`
   - `augment`
2. 为 global/project list 增加：
   - physical store scan 数；
   - logical scope 数；
   - main-thread work duration；
   - worker queue duration；
   - stale hit / targeted refresh / full reconcile 计数。
3. 给 4510 poll 增加 snapshot bytes、poll reason、unchanged poll 计数。
4. 扩展 `scripts/bench-session-load.ts`：
   - 现有脚本已经走 streaming summary + bounded rollout detail，不再是旧全文基准；
     M0 在此基础上补齐以下维度；
   - 输出 `historyMode`；
   - 分开 cold/warm；
   - 支持 app-server page reader 与 rollout reader A/B；
   - 输出响应 JSON/gzip bytes。
5. 新增只读 app-server history smoke：
   - initialize；
   - `thread/list(useStateDbOnly=true)`；
   - `thread/read(includeTurns=false)`；
   - 对 paginated thread 请求 turns/items page；
   - 不 start turn、不发模型请求、不修改 rollout。

建议改动：

- `packages/server/src/routes/sessions.ts`
- `packages/server/src/routes/global-sessions.ts`
- `packages/server/src/indexes/SessionIndexService.ts`
- `packages/server/src/codex-bridge/CodexBridgeHttpClient.ts`
- `scripts/bench-session-load.ts`
- 新增 `scripts/smoke-codex-history-read.ts`

验收：

- 基准结果不包含 session 文本、cwd、tool output 或 secret。
- 在未重启服务的离线 fixture 上能稳定拆分各阶段耗时。
- 不改变现有 API 响应结构。

### M1：客户端跨 session snapshot LRU / SWR

状态：**已完成（remediation 结构估算、结构共享与近上限基准通过）**。

实施结果：

- 新增模块级 snapshot LRU：默认 5 sessions、32 MiB 总量、12 MiB 单条目；key
  包含 project/session/branch/history source，value 记录 revision/writtenAt/估算 bytes。
- 缓存仅接纳非空 Codex bounded snapshot；reasoning blocks 与 inline media 在写入前
  剔除，不包含 agentContent、pending input 或 approval state。
- hook 首次 render/remount 即可读取缓存，cache hit 不进入 full-screen loading；REST
  revalidate 始终继续，按 message ID merge，并保留未变化 message 对象引用。
- session generation guard 阻止旧 route response 覆盖当前 session；file change、显式
  history rewrite、edit truncation 按 project/session/branch 失效，branch/source 由 key 隔离。

验证：

- 相关 Biome check 与 client TypeScript check 通过。
- `useSessionMessages`、`sessionSnapshotCache`、`mergeMessages` 三个 focused suites
  共 59 tests 通过；覆盖 A → B → A、route remount、late response、LRU/bytes、媒体与
  reasoning 剔除、revision invalidation 和对象引用稳定性。

目标：优先消除来回切换时的 skeleton 和重复首屏等待。

任务：

1. 新增 `sessionSnapshotCache.ts`：
   - LRU 条目数和字节双上限；
   - project/session/branch/source key；
   - 显式 invalidate；
   - 测试辅助 reset。
2. 初始 load effect：
   - cache hit 时同步 `applySessionSnapshot`；
   - 不进入全屏 loading；
   - REST revalidate 继续发送；
   - generation guard 防止旧 session 响应覆盖新 session。
3. revalidate 使用按 ID merge，未变化消息保留对象引用。
4. file-change/history rewrite/branch switch 时按 revision 精确失效。
5. 不缓存尚未 materialize、响应错误或超过单条目预算的 snapshot。

建议改动：

- 新增 `packages/client/src/lib/sessionSnapshotCache.ts`
- `packages/client/src/hooks/useSessionMessages.ts`
- `packages/client/src/lib/mergeMessages.ts`
- 对应 hook/cache tests

验收：

- A → B → A 切换时，第二次 A 首屏在 100 ms 内显示缓存内容。
- 后台 revalidate 不闪空、不倒序、不重复消息。
- 缓存达到上限后 LRU 顺序正确，移动端内存有硬上界。
- stream、pending input、approval state 仍按 session remount 清理。

### M2：CodexHistoryClient 与 app-server 分页读取

状态：**已完成（remediation 双向分页、parity 与脱敏验收通过）**。

实施结果：

- 生产 `CodexHistoryClient` 复用 provider 的 app-server transport；单例长驻、apps/plugins
  disabled、同请求 single-flight、10 s timeout、失败指数退避，并在 graceful shutdown
  关闭。错误只向上暴露固定 reason，不转发可能含路径/config 的 stderr。
- capability 以实际 CLI version + pinned experimental schema hash 为 key；真实 0.149.0
  CLI 对 0.147.0 generated types 的 list/read/turns/items smoke 通过。
- `CodexAppServerHistoryReader` 对 paginated thread 使用 metadata-only read + bounded
  turns/items page；opaque cursor 只封装 source/cursor，不解析或伪造 SQLite revision。
- legacy、unmaterialized、unsupported、timeout、unavailable、backoff、protocol mismatch 和
  不支持的 query shape 都返回 typed rollout fallback；invalid app cursor 统一为
  `SESSION_HISTORY_CURSOR_STALE`。`YEP_CODEX_HISTORY_READ_MODE=rollout` 可立即关闭新路径。
- user/assistant/thinking/tool 复用已有 renderer，仅保留 thread/turn/item/lifecycle provenance；
  plan/collab/subagent 才携带有真实 renderer 的 bounded native payload。base64 imageGeneration、
  local media、imageView、hook/review/sleep、未知 item 或 turns metadata 不足时 typed fallback，
  不返回“成功但残缺”的 page。app-server history 不 replay 大型 canonical journal。
- 公开 Thread metadata 缺失的 model/codexModelProvider 优先由 Yep session metadata 补齐；
  messageCount 可由 live bridge 覆盖，其他限制按 §7.2 保守保留到 M3 catalog。

验证：

- server/client TypeScript check、相关 Biome check、`git diff --check` 通过。
- history client/reader/routes/normalization/partial parity 共 88 server tests 通过；M1 的
  59 client regression tests 继续通过。
- 只读真实 CLI smoke 通过；未 resume/start turn、未发送模型请求。
- 本轮 188.7 MB paginated session、window=100、5 runs：history client 在计时内 initialize，
  cold 114 ms、warm 3–4 ms；首屏 375 KiB / gzip 82 KiB，older/newer round-trip
  13–37 ms、boundary overlap=false、roundTrip=true。源码扫描确认产品路径未引用 Codex
  私有 SQLite schema。

目标：让 paginated Codex session 的首屏读取成本与 page 大小相关，而不是与 rollout 总字节相关。

任务：

1. 从 `codex.ts` 中抽取/复用通用 app-server transport client，避免复制 request/response、timeout、stderr redaction 和 protocol diagnostics。
2. 新增 `CodexHistoryClient`：
   - 单例、长驻、apps/plugins disabled；
   - 只暴露 read/list 方法；
   - 请求 single-flight；
   - idle shutdown 可选，但不能每个 session request 重启进程；
   - 进程失败后指数退避恢复。
3. capability probe 缓存在 CLI version + schema hash 上。
4. 增加 `CodexAppServerHistoryReader`：
   - metadata-only read；
   - turns page；
   - items page；
   - typed cursor；
   - historyMode 判断。
5. 将 app-server `ThreadItem` 映射到 Yep 已有 Codex native item / Message 表达；优先复用 generated protocol types 和既有 native renderer contract。
6. legacy/unsupported 自动回退当前 `CodexSessionReader`。

建议改动：

- 重构 `packages/server/src/sdk/providers/codex.ts`
- 新增 `packages/server/src/codex-history/CodexHistoryClient.ts`
- 新增 `packages/server/src/codex-history/CodexAppServerHistoryReader.ts`
- 新增 `packages/server/src/codex-history/types.ts`
- `packages/server/src/routes/sessions.ts`
- `packages/shared/src/codex-schema/`
- server tests / protocol fixtures

验收：

- 188.7 MB paginated fixture warm首屏 server time p95 ≤ 150 ms。
- history client 冷启动 + 首屏 ≤ 500 ms。
- page 读取不会读取完整 rollout，也不会让 8022 RSS 随 rollout 字节线性增长。
- legacy fixture 与当前 normalized output 保持 parity。
- app-server unavailable 时 typed fallback 成功，不返回空历史。

### M3：Codex 列表改为 state DB-first

状态：**已完成（remediation catalog/metadata/mixed-provider 验收通过）**。

实施结果：

- 新增 provider-wide `CodexSessionCatalog`，通过同一 M2 client 分页调用
  `thread/list(useStateDbOnly=true, sortKey=updated_at)`，校验 rollout path、过滤
  subagent、按 canonical cwd 分桶，并以 2 s TTL + single-flight 供所有 logical project
  复用。
- ProjectScanner、global list 和 project session list 从同一 catalog snapshot 计算
  Codex path/sessionCount/lastActivity；provider resolution 命中 catalog 时不再进入
  project-scoped SessionIndex/rollout reader。
- bridge/live session 与 Yep metadata 继续在 route enrichment 层合并；bridge messageCount
  优先。public app-server metadata 没有精确总数时 REST 省略 `messageCount`，不把内部 presence
  sentinel 当成精确值，也不新增无 UI 消费的 accuracy 字段。
- DB 为空/不可用或 `YEP_CODEX_LIST_SOURCE=manifest` 时同步保留原 scan-and-repair；DB
  非空但缺 row 时首屏先返回，后台 manifest reconcile 只补真实存在且非 subagent 的
  missing rows，DB row 对重复 ID 保持权威。该后台 manifest 工作将在 M4 移入 worker。

验证：

- 相关 Biome、server TypeScript、`git diff --check` 通过。
- catalog/global/project/provider-resolution 共 44 focused tests 通过，另有 5 个 catalog
  tests 覆盖分页、path validation、single-flight、empty fallback、kill switch、missing-row
  reconcile 与 1,000-thread warm budget。
- 真实只读 smoke：state DB 首轮 catalog 43 ms；后台 reconcile 从 88 rows 补到 96 个
  有效 top-level sessions / 9 projects；warm snapshot 0 ms。合成 1,000-thread snapshot
  的 20 次 warm p95 < 50 ms。

目标：让 session 数增加不再导致每次 list 都扫描全部 rollout header 和每个 project scope。

任务：

1. 使用 `thread/list`：
   - `useStateDbOnly=true`
   - `sortKey=updated_at`
   - cursor + limit
   - cwd/source/provider filters
2. 将 state DB rows 与：
   - bridge live session views；
   - Supervisor process snapshots；
   - Yep metadata；
   - legacy manifest fallback
   合并。
3. 只在 DB 首屏不可用时同步 scan-and-repair。
4. DB 非空但可能陈旧时后台 reconcile，不阻塞 list response。
5. project list 的 Codex sessionCount/lastActivity 从同一 catalog snapshot 计算，不对每个 project 重建 reader scope。

验收：

- 1,000+ Codex thread 的 warm list p95 ≤ 50 ms。
- 首屏 limit=100 不扫描 1,000 个 rollout header。
- 新建 session 在 watcher 信号后 5 秒内出现。
- stale DB path 不产生幽灵 session；缺失 DB row 能由 fallback 恢复。

### M4：SessionIndex / manifest 真后台化与增量失效

状态：**deferred / out-of-scope**。

本轮已撤回 `SessionIndexService` 的 physical inventory、logical project filter，以及
Gemini/Pi/Kimi/ZCode reader 接口改造；这些跨 provider 变化不是 Codex session switching
快路径的必要条件，并曾造成 modify 后 session 跨 project scope 污染。回归测试固定
Gemini/Kimi 的 `beforeB=[]`、`afterB=[]`。

仅保留 Codex manifest 专用 worker：provider-wide catalog 在 state DB 为空/缺 row 时需要
一次 discovery/stat/plain header fallback；该 worker 不接入通用 SessionIndex，不改变其他
provider 的索引或 watcher 语义。因 compressed header 与通用 full summary reconcile 尚未全部
移出主线程，本计划不再声称 M4 或“full summary reconcile 真后台化”已完成。

### M5：4510 session-state feed 去全量化

状态：**实现完成，最终全量验证待 M7**。

实施结果：

- startup/interval 只请求一个 `/session-views` snapshot，直接使用其中的
  SessionSummary/activity/pending input/liveness 字段，不再并行获取 `/sessions`。
- sidecar notifier 维护 monotonic revision；`/session-views` 返回 revision + ETag，条件请求
  revision 未变化时返回 304，main client 复用 known snapshot 且记录 0 payload bytes。
- SSE 完整 frame 携带 `{revision, baseRevision, changedSessionIds}`；连续 revision 对每个 ID
  复用既有 `/sessions/:id/view`，`null`/隐藏 row 作为 tombstone。成功后同步推进 snapshot
  ETag；revision gap 留给下一 interval full recovery。没有新增 delta endpoint、批协议或长 URL。
- 未修改普通 transcript/history/journal 职责；4510 继续是 lifecycle bridge。

验证：

- 相关 Biome 与 server TypeScript check 通过。
- 当前 focused tests 覆盖 1,000-session 单变更只解析 1 row、删除/隐藏、连续 interval 304、
  丢事件 full recovery，以及 1,001 changed IDs 使用独立短 URL；全量结果在 M7 回填。

目标：移除 bridge session 数增加后的常驻 JSON 分配和重复 HTTP payload。

任务：

1. startup/interval 只请求 `/session-views`；该 view 已包含构建 poll state 所需字段。
2. 给 snapshot 增加 monotonic revision 和 ETag。
3. interval fallback 使用条件请求；未变化返回 304。
4. SSE change signal携带最新 revision 与 changed session IDs。
5. 保持 4510 不读取普通 transcript，不加载旧 full journal。

验收：

- 空闲 bridge 无变化时不再每秒传输约 185 KiB 全量 JSON。
- 1,000 session 下单个状态变化的传输/解析成本与 changed count 相关。
- pending input、ownership、activity、goal/name/status 时延不回归。

### M6：Canonical event store v2

状态：**deferred / out-of-scope**。

本轮已删除 `SqliteCodexEventStore`、query-worker transaction 扩展、provider/route/source
双存储 wiring、retention/1M-event tests 与环境开关，并恢复 HEAD 的 JSONL event store 和
projection 行为。原因是 app-server history、catalog 与 4510 定向刷新均不依赖该架构；默认
关闭的第二存储会扩大 correctness、retention、coverage 与迁移风险，却不缩短本次 session
读取/切换路径。现有 journal 保持原样，不迁移、不删除；若未来有独立的 event-store 性能
问题，应另立目标和证据，不在本计划中预留侵入式实现。

### M7：验证、灰度与发布

状态：**完成（可合并、未部署）**。

修复后验证：

- `pnpm typecheck` 已通过；`pnpm lint` 与最终 `git diff --check` 在 final review 重跑。
- focused：history/catalog/M4 scope regression 71 tests、client cache/merge 44 tests、bridge
  client/service 51 tests 通过；包含真实 base64 fallback、path redaction、manifest invalidation、
  1,000-session 单变更/连续 304/删除/丢事件恢复和 1,001 changed IDs。
- `pnpm test` 最终全量通过：shared 407、server 3225、client 813。较早一次运行仅暴露并
  修正 Feishu 集成仍期待 common message 完整 native payload 的旧断言。
- 真实 Codex CLI 0.149.0 `--read-only` probe 通过：cursor first/older/newer/round-trip 一致；
  catalog 101 sessions / 8 projects，source counts `cli=3/vscode=92/exec=6/appServer=0`，
  first/warm 56/0 ms。
- 188.7 MB paginated session、window=100：真实 history client cold（含 initialize）114 ms，
  warm 3–4 ms；首屏 375/82 KiB JSON/gzip，round-trip 13–37 ms、无 boundary overlap、
  roundTrip=true，RSS 153→184 MiB。rollout 对照为 2.0–2.2 s、589/117 KiB、
  RSS 518→604 MiB。
- 最终从 HEAD 重读全部 diff；`pnpm lint`、`pnpm typecheck`、`git diff --check` 通过。
  四个硬门槛 probe（base64 image、跨 project watcher、targeted 后 interval、path redaction）
  再次通过；未发现未解释 production 文件或计划/实现状态漂移。
- 未部署、未重启/停止 8022 或 4510、未运行 browser/Playwright/UI 自动化；真实移动端 UI
  仍是部署前人工或另行授权项。

以下保留修复审计前的历史验证记录：

验证结果：

- `pnpm lint`：通过（1145 files）。
- `pnpm typecheck`：通过（shared build + 全 workspace non-mobile TypeScript）。
- `pnpm test`：通过；shared 407 tests、server 3204 tests，client 与其余 workspace 同轮
  完成，根命令 exit 0。第一次全量运行暴露一个 cold worker admission 测试调度竞态，按
  相邻测试既有模式等待 blocker 实际占 slot 后，focused 与第二次全量均通过。
- 只读真实 CLI smoke：0.149.0 initialize/list/read/turns/items/catalog 全通过；未
  resume/start turn、未发模型请求。
- 最大 188.7 MB paginated session，window=100，5 runs：production app-server reader
  cold 172 ms、warm 4–5 ms；response 368 KiB / gzip 82 KiB。满足 cold ≤500 ms、
  warm p95 ≤150 ms。
- catalog 实测 first/warm 48/0 ms；合成 1,000-thread warm p95 <50 ms；500-file
  worker event-loop lag p95 ≤20 ms。
- `pnpm version:status` 正确报告 development worktree 为 dirty、`[Unreleased]` 23
  entries；未执行 version bump/check、deploy 或 restart。正式发布前仍需按 CalVer 提升版本。
- 最终 `git diff --check` 与私有 SQLite 依赖扫描通过；命中私有 DB 名称仅存在于本文的
  禁止/风险说明，产品源码未引用。

灰度/回滚开关：

- `YEP_CODEX_HISTORY_READ_MODE=auto|rollout|app-server`
- `YEP_CODEX_LIST_SOURCE=auto|manifest|app-server`
- `YEP_CODEX_EVENT_SPINE_MODE=legacy|shadow|primary`（默认 `legacy`）

发布边界：本轮没有部署、重启/停止 4510/8022、browser/UI 自动化或 rollout migration；
真实服务灰度、版本提升和 release check 仍需用户之后明确授权。

#### 聚焦检查

```bash
pnpm lint
pnpm typecheck
pnpm test
```

按阶段增加：

```bash
pnpm --filter @yep-anywhere/server test -- \
  test/codex-history \
  test/routes/sessions \
  test/codex-bridge \
  test/codex-events

pnpm --filter @yep-anywhere/client test -- \
  src/hooks/__tests__/useSessionMessages.test.ts \
  src/lib/__tests__/sessionSnapshotCache.test.ts
```

只读基准：

```bash
pnpm exec tsx scripts/bench-session-load.ts <sessionId> --runs 5 --window 100
pnpm exec tsx scripts/smoke-codex-history-read.ts --read-only --summary
```

#### 灰度开关

建议：

```text
YEP_CODEX_HISTORY_READ_MODE=auto|rollout|app-server
YEP_CODEX_LIST_SOURCE=auto|manifest|app-server
YEP_CODEX_EVENT_SPINE_MODE=legacy|shadow|primary
```

- `auto`：能力探测后 paginated 用 app-server，legacy 用 rollout。
- `rollout` / `manifest`：一键回到现状。
- app-server history/catalog 可独立回滚；本轮没有 event store v2。

#### 发布要求

- 每个进入产物的阶段更新 `CHANGELOG.md` `[Unreleased]`。
- 开发阶段不提升版本。
- 正式部署前运行 `pnpm version:status` / `pnpm version:check`。
- 部署或重启 8022/4510 前单独取得用户确认。
- UI 只维护 `en` 和 `zh-CN`。

## 7. 风险与处理

### 7.1 App-server private DB 漂移

风险：直接读 `state_5.sqlite` / `thread_history_1.sqlite` 会绑定 Codex 私有 schema。

处理：生产只使用 app-server generated protocol；SQLite 仅用于只读诊断和 upstream source verification。

### 7.2 Legacy 与 paginated 输出不一致

风险：同一 ThreadItem 与当前 rollout normalization 的消息分组、ID、工具状态不同。

处理：建立 golden parity fixtures；paginated path 先按 session allowlist 灰度，输出差异时自动 fallback。

补充事实（M2 核验）：公开 `thread/read` 的 `Thread` metadata 不包含当前 model、context
usage 或全量 messageCount，turn/item page 也不返回 thread total count。产品实现不得为补齐这些
字段读取私有 SQLite；M2 由已有 Yep metadata、live process/bridge snapshot 覆盖能证明的字段，
未命中的 inactive session 暂以 bounded page count/unknown model 展示，M3 再从同一 app-server
catalog snapshot 统一列表元数据。消息 parity 与 history correctness 仍是 M2 的切换门槛。

### 7.3 Active session 磁盘滞后

风险：state/history DB 可能落后于 live WebSocket notification。

处理：首屏使用 persisted page，随后合并现有 live SDK stream；message identity 使用稳定 native item ID，不以数组位置命名。

### 7.4 Snapshot 显示短暂旧内容

风险：SWR 会先画旧 snapshot。

处理：这是有意行为；显示轻量 refreshing 状态，revision 不一致后增量 merge 或替换，禁止旧 response 覆盖新 route。

### 7.5 多 app-server 进程

风险：history client 与 active provider app-server 同时访问 Codex state store。

处理：history client 只发送 read/list；不 resume、不 start、不 mutate metadata；复用一个长驻进程并做 lifecycle/lock smoke。

### 7.6 计划跨度过大

风险：一次性修改 client、reader、index、bridge、journal 难以审查和回滚。

处理：严格按 M0→M7 分提交；M1、M2/M3、M4、M5、M6 分别独立 feature flag 和验收，不跨阶段堆积未验证代码。

## 8. 推荐提交拆分

1. `perf(codex): add session history timing and read-only smoke`
2. `perf(client): cache bounded session snapshots across navigation`
3. `feat(codex): add read-only app-server history client`
4. `feat(codex): page paginated thread history through app-server`
5. `perf(codex): list state-db threads before rollout repair`
6. `perf(index): reconcile provider stores outside the main event loop`
7. `perf(codex-bridge): collapse duplicate session snapshots`
8. `feat(codex): add per-session event store v2`
9. `docs(changelog): record Codex session performance rollout`

每个提交前先审查当前 dirty worktree，只包含本阶段相关文件。

## 9. 新 Codex Session 启动说明

建议新 session 使用一个无 token budget 的 Codex goal，完整计划以本文档为事实来源。启动提示词：

```text
你将在 yepanywhere 仓库中实施 Codex session 列表与切换性能优化。

第一步必须完整阅读：
1. AGENTS.md
2. docs/project/2026-08-22-codex-session-switching-performance-development-plan.md
3. docs/project/2026-08-18-codex-bridge-4510-implementation-and-benchmark.md
4. docs/project/2026-08-18-codex-session-oom-and-interruption-repair-plan.md
5. references/codex 中计划文档指向的 app-server、thread-store、TUI history/resume-picker 源码

然后创建一个不设置 token budget 的 goal，objective 为：
“按开发计划分里程碑实现 Codex session 列表与切换性能优化；保持 4510 为轻量 bridge，优先完成观测、客户端 snapshot LRU 和 paginated app-server history path，并在每个里程碑后运行聚焦验证、审查 diff、更新计划状态与 CHANGELOG。”

执行规则：
- 严格按 M0、M1、M2……顺序推进；一次只让一个里程碑处于 in_progress。
- 每个里程碑开始前复核当前源码与 references/codex，不能凭印象实现协议。
- 每个里程碑完成后运行对应 lint/typecheck/tests/benchmark，确认通过后再进入下一阶段。
- 工作树已有无关改动；只编辑当前里程碑文件，不回滚、不覆盖、不暂存无关内容。
- 未经用户明确确认，不部署、不重启或停止 4510/8022，不运行浏览器自动化，不执行 codex migrate-rollouts --apply。
- 不直接依赖或修改 Codex 私有 SQLite schema；产品路径通过 app-server protocol。
- 发现计划假设与源码不一致时，先更新计划中的事实与风险，再实现。
- 如果一个里程碑过大，先拆成可独立验证的逻辑提交；不要把多个高风险阶段合并。
```

## 10. 完成定义

本计划整体完成需同时满足：

- 最近访问 session 切回能在 100 ms 内显示 bounded snapshot。
- paginated 大 session 首屏 warm p95 ≤ 150 ms，且不完整扫描 rollout。
- 1,000+ Codex thread warm list p95 ≤ 50 ms。
- provider/index refresh 不再产生数百毫秒 Node 主线程 stall。
- 4510 空闲不再持续传输两份全量 session snapshot。
- provider event append 不再冷加载所有 retained journal。
- legacy session、rollback、branch、subagent、pending input、artifact provenance 和 live stream 不回归。
- 所有产物变更记录在 `CHANGELOG.md`，聚焦测试、typecheck、lint 和性能基准通过。
