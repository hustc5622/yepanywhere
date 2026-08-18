# 多 Provider 会话枚举：重复扫描与细粒度归属方案

状态：**调研完成，未实施**。前置的节流/串行化改动已实施并部署（见 §7.1）。

本文回答四个问题：五个 provider 的会话存在哪里、为什么会重复扫描、每个 provider 做细粒度归属分别需要什么、以及"把 session 统一放到一个大目录"这类替代手段是否可行。

所有数据为撰写本文时在本机实测，是方案的事实基础。

---

## 1. 结论摘要

三条结论，顺序即重要性：

1. **固有扫描成本并不高**（实测冷启 3–215 ms、热 0–2 ms）。生产日志里出现的中位 1–4 秒、峰值 60 秒，**主要是放大效应**——扇出制造大量并发校验 → 事件循环饱和 → 每次校验更慢 → 堆积更多。已实施的节流/串行化针对的正是这一层。
2. **剩余的结构性浪费有三处**：脏标记扇出到所有 scope、pi/kimi 的扫描缓存是实例级（跨 scope 重复同一份全局扫描）、以及非 Claude provider 缺少 session 级归属因而永远无法走增量路径。
3. **"统一目录"不可行，但它指向的直觉是对的**。provider 的存储由各自 CLI 拥有，我们只读；应该建的是**我们自己的派生定位索引**，而不是搬动 provider 的文件。详见 §6。

---

## 2. 现状核准：五个 provider 的存储布局

| Provider | 存储位置 | 本机体量 | 布局 | 路径是否含项目归属 | 路径是否含 sessionId |
| --- | --- | --- | --- | --- | --- |
| **codex** | `~/.codex/sessions/` | 659 MB / 322 文件 | `YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | ✗ 按日期分区，cwd 在文件内 `session_meta` | ✓ 文件名含 uuid |
| **pi** | `~/.pi/agent/sessions/` | 22 MB / 23 文件 | `--<编码后的 cwd>--/<ts>_<uuid>.jsonl` | ✓ **目录名即编码后的 cwd** | ✓ 文件名含 uuid |
| **kimi** | `~/.kimi-code/sessions/` | 71 MB / 332 文件 | `wd_<名>_<hash>/session_<uuid>/agents/<agent>/wire.jsonl` | △ 目录按工作区分组，需 hash→cwd 映射 | ✓ 目录名含 uuid |
| **opencode** | `~/.local/share/opencode/opencode.db` | 8.9 GB | sqlite | ✓ `session.directory` 列 | ✓ `session.id` 主键 |
| **zcode** | `~/.zcode/cli/db/db.sqlite` | 79 MB | sqlite | ✓ `session.directory` 列 | ✓ `session.id` 主键 |

补充事实：

- **pi 的目录编码规则**（`references/pi` `session-manager.ts:479`）：
  ```js
  `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
  ```
  **不可逆**（真实路径里的 `-` 与分隔符混淆），但**可正向计算并匹配**——归属只需要正向匹配，不需要反解。这一点决定了 pi 的归属可以零读取实现。
- **kimi 的 `workDir`** 存在每个 `session_<uuid>/state.json` 里；本机有 9 个工作区目录，实测 `wd_api-testing_d473f2189355` 形如 `wd_<basename>_<hash>`。hash 算法未确认，但**不需要**：读 9 个 `state.json` 建一次映射即可（见 §5.3）。
- **opencode 的 8.9 GB** 里 `session` 只有 803 行。体积由 **`event` 表主导：7,655 MB / 577,869 行**（`dbstat` 实测），`part` 507 MB、`message` 201 MB；`freelist` 为 0，即不是碎片而是真实数据。仓库内已有专门方案 `docs/project/2026-08-10-opencode-db-retention-and-scan-fix-plan.md` 分析此事，本文不重复。
- **zcode 的 `session` 表**同样有 `directory`、`parent_id`，本机 72 行。

---

## 3. 现状核准：枚举机制

### 3.1 索引与 scope

索引文件位于 `~/.yep-anywhere/indexes/ext-<hash>.json`，一个文件对应一个 **scope**：

```
scope key = <provider>::<sessionDir>::<projectPath>
```

即**每个 (provider, 项目) 一个 scope**。本机实测：**154 个 scope**，索引内会话条目合计 **821** 条，覆盖 43 个项目。

每条会话记录 `fileMtime` + `indexedBytes`，读取时比对，变了才重读。

### 3.2 三条读取路径

`SessionIndexService.getSessionsWithCacheInternal` 分三路：

| 模式 | 行为 | 能否发现新会话 | 能否发现已删除会话 |
| --- | --- | --- | --- |
| `fast` | 直接返回索引内容 | ✗ | ✗ |
| `incremental` | 只重读**被单独标脏**的已知 session | ✗ | ✗ |
| `full`（枚举） | `listSessionFiles()` 扫全店 → 比对 → **剪掉索引里已不存在的** | ✓ | ✓ |

**发现新增与发现删除，都只能靠 `full`。** 这就是"枚举"无法简单去掉的原因。

### 3.3 脏标记的来源，以及扇出的根源

`SessionIndexService.handleFileChange`：

```ts
if (event.provider === "claude") {
  this.markSessionDirty(sessionDir, sessionId);      // 精确到单个 session
  if (create || delete) this.markDirDirty(sessionDir); // 只有增删才需要枚举
  return;
}
if (event.provider === "codex") { this.markMatchingScopesDirty("codex::"); return; }
if (event.provider === "pi")    { this.markMatchingScopesDirty("pi::");    return; }
// gemini / kimi / opencode 同上
```

**只有 Claude 有 session 级归属**，因为它的路径形如 `<projects>/<编码 cwd>/<sessionId>.jsonl`，`sessionId` 就是文件名。

其余 provider 的分支带着这样的注释：

> *"a raw file event does not tell us which project scope owns the changed session"*

于是退化为 `markMatchingScopesDirty(prefix)`——把该 provider **所有已加载 scope** 标脏。后果：

- 无法走 `incremental`（不知道哪个 session 变了）
- 一次文件写入 → N 个 scope 都要枚举（N = 该 provider 已加载 scope 数）

注意 `FileChangeEvent` 本身**带完整 `path`**（`EventBus.ts:33`），所以归属信息在事件里并不缺失，只是当前没有被解析。

---

## 4. 实测数据：固有成本 vs 观测成本

### 4.1 固有枚举成本（空闲机器，同一 reader 连续 3 次）

| Provider | 第 1 次 | 第 2 次 | 第 3 次 | 会话数 | 缓存作用域 |
| --- | --- | --- | --- | --- | --- |
| codex | 215 ms | 0 ms | 0 ms | 37 | **进程级共享**（`manifestCache`，TTL 5 s）|
| pi | 11 ms | 2 ms | 2 ms | 10 | **实例级**，且被 `scan(true)` 绕过 |
| kimi | 28 ms | 0 ms | 0 ms | 5 | **实例级**（TTL 5 s）|
| opencode | 40 ms | 0 ms | 0 ms | 25 | **进程级共享**（`openCodeSessionStatsCache`，TTL 3 s）|
| zcode | 3 ms | 0 ms | 0 ms | 9 | 无缓存，但**查询本身已按项目收窄** |

### 4.2 生产日志里的观测成本（风暴期间，节流实施前）

| Provider | 全量校验次数 | durationMs 中位 | max | statCalls | parseCalls |
| --- | --- | --- | --- | --- | --- |
| kimi | 2319 | **3943** | 59589 | 0 | 0 |
| pi | 1651 | 1029 | 24765 | 0 | 659 |
| codex | 739 | 1231 | 32022 | 0 | 484 |
| opencode | 968 | 411 | 24297 | 0 | 616 |
| claude | 82 | 442 | 26084 | 66 | 0 |

### 4.3 差距的解释

kimi 观测中位 3943 ms 是实测固有成本 28 ms 的 **140 倍**，且 `statCalls=0 parseCalls=0`（时间不在读文件）。结合峰值 **29 次全量校验/秒**，只有一个解释：**排队与 CPU 争抢**。

这是一个自我放大的循环：

```
一次文件写入 → N 个 scope 标脏 → N 次并发全量校验
  → 事件循环饱和 → 每次校验耗时上升 → 期间又有新的写入 → 堆积更多
```

**结论：优化单次扫描的收益远小于消除扇出与并发。** 这修正了一个容易犯的直觉错误——不必先去优化 SQL 或扫描算法。

两个曾被怀疑、已被证伪的假设，记录在此避免重复走弯路：

- ~~opencode 的全表聚合 SQL 是瓶颈~~：该聚合在 sqlite CLI 实测 **0.02 s**，reader 层 13–40 ms。
- ~~索引写入的跨进程锁竞争是瓶颈~~：锁按 scope 分文件（`<indexPath>.lock`），跨 scope 不冲突。

---

## 5. 细粒度归属：逐 provider 拆解

目标：把 `handleFileChange` 从"标脏所有 scope"改成"标脏一个 session"，从而走 `incremental` 路径。

需要的能力是一个函数：

```ts
// 给定 watcher 事件的绝对路径，回答：这是哪个 session、属于哪个项目
attributeSessionPath(path: string): { sessionId: string; projectPath: string } | null
```

### 5.1 pi —— 最容易，零读取

路径 `~/.pi/agent/sessions/--<编码 cwd>--/<ts>_<uuid>.jsonl` 同时含两项信息。

需要：
- 新增正向编码函数 `encodePiSessionDirName(cwd)`，复刻 `--${cwd.replace(/^[/\\]/,"").replace(/[/\\:]/g,"-")}--`
- 归属时取路径倒数第二段与已知项目的编码值比较；`sessionId` 从文件名 `_` 之后取

风险与对策：
- 编码不可逆 → **只做正向匹配，不反解**。若某路径匹配不到任何已知项目，回退整店枚举（保持现有行为）。
- 需要一个"已知项目 → 编码目录名"映射，随项目列表变化刷新。

附带收益：`PiSessionReader.listSessionFiles` 目前调用 `scan(true)` **强制绕过自己的 5 秒缓存**，且逐个读每个文件首行取 cwd——而目录名已经给出 cwd。改为按目录过滤后，pi 的枚举可以只 `readdir` 目标项目的一个子目录，成本从 O(全部会话) 降到 O(该项目会话)。

### 5.2 codex —— 需要一次有界读取

路径 `YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` 只给出 `sessionId`，**不含项目**。cwd 在文件首行 `session_meta.payload.cwd`。

需要：
- 归属时读首行（`readCodexRolloutFirstLine`，已存在且流式、遇首个换行即停）
- 更好的做法：复用已有的 `getCodexSessionManifest`，它**已经**为每个文件建立了 `id → {cwd, filePath, mtime, size}` 映射。归属只需查 manifest，无需额外读盘

风险与对策：
- manifest 有 5 秒 TTL；新文件在 TTL 内查不到 → 该情况回退整店枚举
- 已压缩为 `.jsonl.zst` 的文件已被 manifest 覆盖（见 CHANGELOG `.zst` 兼容改动）

### 5.3 kimi —— 需要一次映射，之后零读取

路径 `wd_<名>_<hash>/session_<uuid>/agents/<agent>/wire.jsonl`：
- `sessionId` = `session_` 之后那段 → 零成本
- 项目 = 工作区目录对应的 `workDir`，在 `<session_dir>/state.json` 里

需要：
- 建一个 `wd_* 目录名 → workDir` 映射：每个工作区目录读**任意一个** `state.json` 即可。本机 9 个工作区 → 9 次读取，可缓存到目录 mtime 变化
- 不需要逆推 hash 算法

风险与对策：
- 同一工作区目录理论上可能混有不同 `workDir`（未观察到）。对策：映射按"工作区目录 → workDir 集合"存储，集合大小 > 1 时对该目录回退读取单个 session 的 `state.json`

附带收益：kimi 的枚举同样可以收窄到目标项目对应的工作区目录，而不是遍历全部 9 个。

### 5.4 opencode / zcode —— sqlite，归属靠查询

watcher 只能观察到 `.db` 文件变动，**事件里没有 session 粒度**。这是与文件型 provider 的本质差异。

`session` 表都有 `id` 主键与 `directory` 列，所以可以做"变更发现"查询：

```sql
SELECT id, directory, time_updated
FROM session
WHERE time_updated > ?   -- 上次已知水位
```

需要：
- 在索引里为每个 scope 记录一个 `lastSeenUpdatedAt` 水位
- 收到 `.db` 变动事件时，用一次全局水位查询拿到"变了哪些 session、属于哪个 directory"，据此对相应 scope 做 session 级标脏
- 一次查询服务所有 scope（扇出从 N 降到 1）

**关键校验（已实测）**：`session.time_updated` **不足以**作为 mtime 依据——本机 434 个活跃会话中有 **351 个**其 `message`/`part` 的 `MAX(time_updated)` 新于 `session.time_updated`。所以：

- 用于**变更发现**（发现"有东西变了"）：可以，但会漏掉只有 part 更新的会话
- 用于**mtime 判定**：不行，必须保留现有 join

对策：变更发现的水位查询改为对三张表取并集：
```sql
SELECT s.id, s.directory FROM session s
WHERE s.time_updated > ?
UNION
SELECT m.session_id, s.directory FROM message m JOIN session s ON s.id = m.session_id
WHERE m.time_updated > ?
UNION
SELECT p.session_id, s.directory FROM part p JOIN session s ON s.id = p.session_id
WHERE p.time_updated > ?
```
`part` 有 `part_session_idx`，但**没有 `time_updated` 索引**——这条查询需要新增索引才划算。而我们**不应该给 provider 的数据库加索引**（那是 opencode/zcode 拥有的 schema，加索引会污染他们的库、且可能被其迁移覆盖）。

因此 sqlite 型 provider 的现实方案是：**保留整店快照 + 缩短扇出**，即维持已有的进程级共享快照（opencode 已有，zcode 应补上），并让一次快照服务所有 scope。不追求 session 级标脏。

### 5.5 归属能力汇总

| Provider | 归属难度 | 所需机制 | 归属后能否走 incremental | 枚举能否收窄到单项目 |
| --- | --- | --- | --- | --- |
| pi | 低 | 正向编码目录名匹配 | ✓ | ✓ 只读一个子目录 |
| kimi | 低 | `wd_* → workDir` 映射（9 次读取，可缓存）| ✓ | ✓ 只读一个工作区目录 |
| codex | 中 | 查已有 manifest（无额外读盘）| ✓ | ✗ 日期分区，仍需全 manifest |
| opencode | 高 | 需给 provider 库加索引才划算 → **不做** | ✗ | ✓ 已按 directory 切片 |
| zcode | 高 | 同上 → **不做** | ✗ | ✓ 查询已按项目收窄 |

---

## 6. 替代手段评估：能不能"把 session 统一放到一个大目录"

### 6.1 直接搬动 / 软链 provider 的会话文件：不可行

- **我们不拥有这些存储**。codex / pi / kimi / opencode / zcode 各自的 CLI 决定写到哪里，且会持续写入。搬走文件后 CLI 仍按自己的路径写，我们看到的会是残缺快照。
- codex 明确会**改写文件位置**：冷却 7 天后压缩为 `.jsonl.zst` 并**删除原文件**，恢复会话时再解压回来（见 `codex-rs/rollout/src/compression.rs`）。软链会在这个循环里断裂。
- opencode / zcode 是 sqlite，"目录统一"这个概念不适用。
- 风险不对称：读路径慢是性能问题，动了 provider 的存储是**数据问题**。

### 6.2 我们自己的派生定位索引：这才是那个直觉的正确形态

用户直觉里"统一到一个地方"的价值，是**一次查询就能回答归属**。这个价值可以在不碰 provider 存储的前提下拿到：建一张**我们拥有的** locator 表。

```
locator(sessionId TEXT PRIMARY KEY, provider TEXT, projectPath TEXT,
        filePath TEXT, mtime INTEGER, size INTEGER, updatedAt INTEGER)
```

- **写入**：由 watcher 事件驱动，按 §5 的归属逻辑增量维护；启动时或水位落后时做一次全量重建
- **读取**：`path → sessionId/projectPath` 与 `sessionId → project` 都是单次索引查询
- **与现有代码的关系**：`session-locator.ts` 已经实现了**反方向**（`sessionId → 项目`）的"最省成本级联"查找，其文档注释写着 *"only the final fallback pays for the full per-project, per-provider reader fan-out"*。本方案正是把那个 fallback 变得几乎不必要，并补上正方向（`path → session`）。

代价：
- 多一份派生状态需要保证与真相一致（陈旧、遗漏、provider 绕过 watcher 直接改文件）
- 需要明确的"重建"触发条件与自检
- 对 sqlite 型 provider 收益有限（他们本来就能按 directory 查）

### 6.3 中间形态：只统一"变更发现"，不统一存储

比 6.2 更轻：不建持久表，只在内存里维护 `wd_* → workDir`（kimi）、`编码目录名 → project`（pi）两张小映射，加上 codex 已有的 manifest。三者合起来就足以支撑 §5 的 session 级标脏。

这是**投入产出比最高**的形态，建议先做这个。

---

## 7. 实施计划

### 7.1 已完成（前置）

- **全量校验节流 + 串行化**：dir-dirty 触发的全量校验受 `SESSION_INDEX_FULL_VALIDATION_MIN_MS`（默认 5000）约束，并由 `SESSION_INDEX_MAX_CONCURRENT_FULL_VALIDATIONS`（默认 1）限制并发。
  - 实测效果：峰值 29 次/秒 → 观察窗口内 0 次；`SessionIndexService` 日志占比 993/2000 行 → 11/3000 行；空闲 CPU 31.5% → 3.9%；同一 pi 会话 TTFB 从 0.02–22 s 收敛到 0.015–0.124 s。
  - 遗留代价：新建或被外部修改的会话，在**列表视图**里最多延迟 5 秒出现。详情页不受影响（走 `reader.getSession` 直读 + mtime/size 校验的 summary 缓存），活跃会话由 WebSocket 推送。

### 7.2 阶段 A：消除跨 scope 的重复扫描（纯优化，不改产品行为）

1. **pi**：去掉 `listSessionFiles` 里的 `scan(true)` 强制刷新，改用实例缓存；并把实例缓存提升为**进程级按 sessionsDir 共享**（对齐 codex/opencode 的做法）。
2. **kimi**：同样把 `sessionFileCache` 提升为进程级按 sessionsDir 共享。
3. **zcode**：补一个进程级快照缓存（当前无缓存，虽然单次仅 3 ms）。
4. 收益：N 个 scope 的枚举合并为 1 次扫描。风险低，无行为变化。

### 7.3 阶段 B：pi / kimi / codex 的 session 级归属

1. 新增 `packages/server/src/sessions/session-attribution.ts`，导出 `attributeSessionPath(path)`，内部按 §5.1–5.3 分派。
2. `SessionIndexService.handleFileChange` 对这三个 provider 改为：能归属则 `markSessionDirty(scopeOf(projectPath), sessionId)`；归属失败回退现有 `markMatchingScopesDirty`。
3. 只有 create/delete 才 `markDirDirty`（对齐 Claude 分支的语义）。
4. 收益：这三个 provider 的常规写入不再触发任何枚举，5 秒延迟对它们消失。

### 7.4 阶段 C：枚举收窄到单项目（可选）

pi / kimi 的枚举改为只 `readdir` 目标项目对应的目录。codex 因日期分区无法收窄，继续依赖 manifest 共享。

### 7.5 阶段 D：locator 表（可选，视 A–C 后的剩余问题决定）

按 §6.2 实施。建议在 A–C 完成并观察一段时间后再评估是否必要。

### 7.6 测试要求

每个阶段都需要：

- **归属正确性**：给定构造路径，`attributeSessionPath` 返回预期的 `sessionId` + `projectPath`；含 `-` 的项目路径、含空格的路径、非本机项目的路径（应返回 null 并回退）
- **回退路径**：归属失败时仍能通过枚举发现会话（防止"优化把发现能力优化掉了"）
- **变异验证**：把归属逻辑改坏后测试必须失败。前置改动中曾出现过因 getter 展开导致计数器固化为 0 的**假通过**测试，此类错误必须用变异验证拦住
- **新增/删除仍可发现**：这是枚举的核心职责，不能被回归

---

## 8. 需要决策的事项

### D1. 列表视图的枚举时机（产品行为）

三个选项：

| 选项 | 行为 | 外部新会话出现时机 |
| --- | --- | --- |
| **现状** | 自动枚举，每 scope 最快 5 秒一次 | ≤ 5 秒 |
| **A：普通加载不枚举 + 显式刷新绕过节流** | 打开页面只读索引；下拉/点击刷新走权威路径 | 手动刷新时立即 |
| **B：阶段 B 完成后** | pi/kimi/codex 靠归属即时更新；opencode/zcode 仍靠节流枚举 | 前三者近实时 |

代码里已有 `allowStale` 开关（`app.ts:1106` 用 `true`，`:922` 用 `false`），选项 A 落点明确。

**我的建议**：选 B 作为目标，过渡期保留现状。不建议单独做 A——因为"外部启动的会话自动出现"是 Yep 的核心场景（终端跑 agent、手机审批），完全依赖手动刷新会削弱产品定位。若你希望立即降低开销，可先把 `SESSION_INDEX_FULL_VALIDATION_MIN_MS` 调大（如 15000）观察体感，这是纯配置、可回退。

### D2. opencode 的 8.9 GB 数据库

体积由 `event` 表主导（**7,655 MB / 577,869 行**，`dbstat` 实测），`part` 507 MB、`message` 201 MB、`session` 仅 803 行。

这**不是**当前枚举瓶颈——枚举只碰 `session`/`message`/`part`，快照查询实测 13–40 ms，完全不读 `event`。所以清理 `event` 对本文讨论的枚举性能**基本没有帮助**。

仓库内已有专门方案：`docs/project/2026-08-10-opencode-db-retention-and-scan-fix-plan.md`（2026-08-10，评审稿），其结论与本次实测一致（该文记录 `event` 占 7.49 GiB / 90%）。

需要你决定的是**是否推进那份方案**，与本文的阶段 A–D 相互独立。**这是你的数据，我不会自行清理。**

### D3. 是否接受"归属失败即回退"的语义

阶段 B 的所有归属逻辑都以"匹配不到则回退整店枚举"为兜底。这保证不会丢失发现能力，但也意味着某些边界情况（例如项目列表尚未加载、路径编码冲突）仍会触发枚举。

需要确认：这个兜底是否可接受，还是希望归属失败时**记录告警**以便发现覆盖盲区。我倾向加告警（debug 级别 + 计数器），否则回退会静默发生、掩盖归属逻辑的缺陷。

### D4. 阶段顺序

建议 A → B → 观察 → 视情况 C/D。A 是纯优化零风险，B 是根治。

需要确认是否同意，或希望直接做 B。

---

## 9. 参考位置

| 主题 | 位置 |
| --- | --- |
| 索引服务 / 三条路径 / 脏标记 | `packages/server/src/indexes/SessionIndexService.ts` |
| watcher 事件结构 | `packages/server/src/watcher/EventBus.ts:29` |
| provider 解析顺序 | `packages/server/src/sessions/provider-resolution.ts:278`（`buildCandidateGroups`）|
| sessionId → 项目 的反向定位 | `packages/server/src/sessions/session-locator.ts` |
| codex manifest（已含 id → cwd 映射）| `packages/server/src/sessions/codex-session-manifest.ts` |
| pi 目录编码（上游）| `references/pi` `packages/coding-agent/src/core/session-manager.ts:479` |
| codex 压缩与 `.zst` 循环（上游）| `references/codex/codex-rs/rollout/src/compression.rs` |
| opencode 共享快照 | `packages/server/src/sessions/opencode-reader.ts:1250` |
| zcode 按项目收窄的查询（范本）| `packages/server/src/sessions/zcode-reader.ts:583` |
