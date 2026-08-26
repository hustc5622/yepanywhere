# Codex canonical journal 治本方案（P0）

> 日期：2026-08-24
> 状态：A/B/D 已实施（未部署）；C 经核查为死代码优化，已放弃
> 事实来源：本仓库实现、`references/codex/codex-rs/{state,thread-store}`、本机只读实测
> 前置：`docs/project/2026-08-24-performance-bottleneck-audit.md`

## 1. 根因

不是「内存泄漏」，也不是「读路径慢」。是**写策略缺失 + writer 全量水合**两个独立缺陷叠加。

### 1.1 provider 侧 journal 从未做过 method 分类

4510 bridge 早在 `493a4629f` 就引入了 `journal-policy.ts`：把通知分成
`delta / lifecycle / terminal / diagnostic`，`lifecycle` 模式只落 lifecycle+terminal，
高频 delta 直接转发不入账。

**provider 侧（`sdk/providers/codex.ts` → `CodexEventIngress`）从来没有对应策略**：
`ingestNotification` 无条件持久化 app-server 的每一条通知。

同一套事件流，两种策略的实测结果：

| journal | 策略 | 体积 |
| --- | --- | ---: |
| `codex-bridge/lifecycle.jsonl` | 有分类 | **2.1 MB** |
| `codex-events/events.jsonl` | 无分类 | **176 MB**（当日，仍在涨） |

约 84 倍差距。

### 1.2 delta 占了 83% 的字节

最近 62.9 MB / 37,592 事件抽样：

| method | 字节 | 条数 | 类别 |
| --- | ---: | ---: | --- |
| `item/commandExecution/outputDelta` | 22.5 MB | 15,084 | delta |
| `item/agentMessage/delta` | 21.0 MB | 18,410 | delta |
| `turn/diff/updated` | 8.6 MB | 289 | delta（**30 KB/条**，全量 diff 反复落盘） |
| `item/completed` | 6.3 MB | 1,237 | lifecycle |
| `item/started` | 2.2 MB | 1,239 | lifecycle |

delta 全是增量片段，其最终形态已经由我们保留的 `item/completed` 和原生 rollout 覆盖。

### 1.3 writer 为了 append 一条事件，水合全部历史段

`JsonlCodexEventStore.append()` → `ensureLoaded()` → `load()` 遍历**所有**保留段
（`store.ts:625-645`），把 892 MB JSONL 解析成对象，并常驻四份索引
（`eventsBySession` / `eventsBySessionMethod` / `eventsByIdentity` / `eventsByDedupeKey`）。

实测：8022 重启后 **2 分 12 秒即稳定在 2.51 GiB RSS 且不再增长** —— 证明这是启动期
一次性冷加载的常驻开销，不是运行期泄漏。

而 writer 实际只需要：
- **per-session 的 last sequence**（`sessionEvents.at(-1)?.sequence`）用于定序；
- **dedupe 判重**。

且 `eventId = ${connectionId}:${counter}`，`connectionId` 是每进程 `randomUUID()`
（`ingress.ts:101,385`）—— **新进程不可能与历史 eventId 冲突**。跨历史的 identity
索引对 writer 是纯粹的死重量。

### 1.4 结果：写进去的东西从来没被读用过

读侧 admission 预算 512 MB（`source.ts:7`），retained 892 MB > 预算 ⇒
`CodexEventSourceAdmissionError` 永远抛出，canonical overlay 永远回退 legacy。

**journal 因为太大而无法被使用，而它之所以太大，正是因为没人管它写什么。**

## 2. 消费方实际需求（决定能砍多少）

| 消费方 | 触发 | 需要的 method |
| --- | --- | --- |
| provider error overlay（`sessions.ts:1830`） | **每次 Codex session detail** | `error`、`turn/completed` |
| canonical view（`sessions.ts:1645`） | 仅 `?view=canonical` 显式请求 | 全量 |
| transcript export（`routes/codex-transcript.ts`） | 显式导出动作 | 全量 |

**常开消费方只需要 0.06% 的条数 / 0.123% 的字节**（62.9 MB 抽样里 23 条 / 0.077 MB）。

### 2.1 为什么不能直接删掉 journal 改用 app-server

`thread/turns/list` 的 `Turn` 自带 `status: TurnStatus` 和 `error: TurnError`
（`generated/v2/Turn.ts`），覆盖 `lastTurnStatus` 和终态失败信息。

但**覆盖不了 `willRetry === true` 的瞬态错误** —— 一个 turn 重试后成功了，
app-server 记录的终态是 `completed`，中途那次 429 只存在于实时通知流里
（`session-projection.ts:837`）。这是 journal 唯一不可替代的价值。

结论：**保留 journal，但只保留不可从 Codex 自身持久化恢复的部分。**

## 3. 上游先例

`references/codex/codex-rs` 的做法：

- **`thread-store/src/local/thread_history/segment_paging.rs`**：SQLite + 分段分页，
  按 cursor 取 bounded page，永不全量载入。
- **`state/src/log_db.rs`**：有界后台队列 + 批量写入
  （`LOG_QUEUE_CAPACITY: 512`、`LOG_BATCH_SIZE: 128`），显式说明目的是
  "keep logging overhead low"。
- **`state/src/runtime/memories.rs`**：`max_age_days` + `prune_*_for_retention` 按龄清理。
- **`state/src/sqlite.rs:284`**：incremental auto-vacuum。

我们的 4510 已经落地了前两条（bounded/coalescing background writer）。provider 侧一条都没有。

GitHub 通用仓库检索无有效先例（结果均为 0-star 玩具项目，code search 需鉴权）；
真正可依据的先例就是上游 codex-rs 与本仓库自己的 4510。

## 4. 方案

四层，按依赖顺序。

### A. 写得更少 —— provider journal 分类策略（根因）

新增 provider 侧策略，复用既有 `CODEX_BRIDGE_DELTA_METHODS` 与
`classification.ts` 的分类表，不新造词汇：

- **永远保留**：`error`、`turn/completed`、`turn/started`、`thread/*` 生命周期、
  `item/started`、`item/completed`
- **永远丢弃**：`CODEX_BRIDGE_DELTA_METHODS` 全集（含 `turn/diff/updated`）
- 模式开关 `YEP_CODEX_EVENT_JOURNAL_MODE=minimal|lifecycle|full`，默认 `lifecycle`，
  `full` 保留今天的行为作为回退

实测效果（按抽样比例外推到当前 892 MB）：

| 策略 | 保留占比 | 892 MB 等效 |
| --- | ---: | ---: |
| `minimal`（仅 error + turn/completed） | 0.12% | **1.0 MB** |
| `lifecycle`（丢 delta，留生命周期） | 14.7% | **131 MB** |
| `full`（今天） | 100% | 892 MB |

**关键收益**：`lifecycle` 让 retained 落到 131 MB，**首次低于 512 MB admission 预算 ——
canonical overlay 会从「永久失效」变成「真正可用」**。这不只是省内存，是让 journal
恢复它存在的意义。

### B. writer 不再水合历史

`append()` 路径改为只维护：
- per-session `lastSequence`（可从活动段尾部增量恢复）
- 有界的近期 dedupe 窗口（而非全历史 identity/dedupeKey 索引）

依据：`connectionId` 每进程随机，跨进程 eventId 不可能碰撞（§1.3）。
需在实施时确认 `dedupeKey` 的生成域是否同样是连接内（`envelope.ts:16` 为可选字段）。

读路径（`replay`）保持现状，仍按需全量载入单 session —— 它已经有 admission 预算兜底，
且 A 之后单 session 的事件量级下降一个数量级。

### C. 批量写入

`appendMany` 目前是 `for` 循环逐条 `append`（`store.ts:381`），每条一次 `stat` +
一次 `appendFile` open/write/close，且全程持锁。改为单次拼接写入，
参照上游 `LOG_BATCH_SIZE` 与我们 4510 已有的 coalescing writer。

### D. 存量清理

- `codex-bridge/codex-events*.jsonl` 共 989 MB，最后写入 8-19，已停写，但仍作为
  `legacy-bridge-full` source 参与 `selectFreshestSourceStore` 的 `getStorageBytes()`
  与潜在冷加载 —— 归档或删除。
- retention 从「按磁盘」改为「按内存预算」：`keepSegments 3 × 256 MB` 重设，
  使保留总量在 A 之后稳定处于 admission 预算内。

## 5. 不做什么

- 不引入 SQLite 第二存储 / 双写 / 迁移开关（上一轮 M6 已撤回，不重开）。
- 不改 Codex rollout 上游格式，不读写 Codex 私有 SQLite schema。
- 不把调大 Node heap 当修复。
- 不删除用户的 Codex rollout。
- 不在本轮改动 4510 的转发/journal 行为（它已经是正确的那一侧）。

## 6. 待确认的决策点

**provider journal 默认保留哪一档？**

- `lifecycle`（推荐）：892 MB → ~131 MB，overlay 恢复可用，canonical view 与
  transcript export 保留「除 delta 外」的完整结构。代价：导出的 transcript 不再含
  逐字符增量（但 `item/completed` 已含最终文本，实际观感无损）。
- `minimal`：892 MB → ~1 MB，内存问题彻底消失。代价：`?view=canonical` 和
  transcript export 实质降级为仅错误/终态信息，这两个功能基本等于放弃。

我倾向 `lifecycle`：它同时解决内存和「功能因过大而失效」两个问题，且与 4510 已验证的
策略一致。选 `minimal` 的唯一理由是彻底不要 canonical 这条线 —— 那应该是个显式的
产品决定，而不是靠 retention 悄悄实现。

## 8. 实施结果（2026-08-24）

采纳 `lifecycle`。已落地：

| 步骤 | 状态 | 说明 |
| --- | --- | --- |
| A 分类策略 | 已实施 | `codex-events/journal-mode.ts`，默认 `lifecycle`，`YEP_CODEX_EVENT_JOURNAL_MODE` 可切 `full`/`minimal` |
| B1 跳过无用 replay | 已实施 | 未显式传 `connectionId` 时不再 replay+reduce 整个 session journal |
| B2 writer 只建索引 | 已实施 | `JsonlCodexEventStore({ appendOnly: true })`，不驻留 envelope，`replay` 直接拒绝 |
| C 批量写 | **放弃** | `appendMany` 无任何生产调用方，属死代码优化；A 之后写入量已降 ~85% |
| D retention | 已实施 | provider 默认 64 MiB × 2，落在 512 MiB admission 预算内 |

用真实 journal（60 MB 尾部 / 33,835 事件）跑通过后的策略函数实测：

| 模式 | 保留 | 892 MB 等效 |
| --- | ---: | ---: |
| `minimal` | 0.09% | 0.8 MB |
| `lifecycle` | **15.26%** | **136 MB** |
| `full` | 100% | 892 MB |

136 MB < 512 MB ⇒ canonical overlay 首次具备可用条件。

验证：`pnpm lint`、server `tsc --noEmit`、server 全量测试 **3252 passed**
（新增 `test/codex-events/journal-mode.test.ts` 11 条）。

### 8.1 一处契约变更

`test/channels/feishu/codex-bridge-integration.test.ts` 原先断言 journal 含
`item/agentMessage/delta`。该断言已更新为「settled 记录入账、delta 不入账」。
同文件中「delta 文本渲染进飞书卡片」的断言未改动且继续通过，证明实时投影未受影响。

### 8.2 尚未处理

- 存量 989 MB 的 `codex-bridge/codex-events*.jsonl`（8-19 停写）与既有 892 MB
  provider 段属用户数据，未自行删除，需确认后清理。
- 新策略只对**新写入**生效；存量段仍会在 reader 冷加载时参与 `getStorageBytes()`。
- shadow 模式的双投影 + parity hash + 每事件 mismatch 告警仍在（属先前「止血」项，未在本轮范围）。

## 9. 验证方式

- 单测：分类策略的保留/丢弃矩阵；writer 在不水合历史下的 sequence 与 dedupe 正确性；
  批量 append 的原子性与 crash 后可读性。
- 离线基准：用现有 `scripts/bench-codex-overlay.ts` 对比改动前后的冷加载与 overlay 耗时。
- 现场只读复测：8022 稳定态 RSS、`CodexEventSourceAdmissionError` 是否消失、
  journal 日增速率。
- 回归：`pnpm lint`、`pnpm typecheck`、`pnpm test`。
