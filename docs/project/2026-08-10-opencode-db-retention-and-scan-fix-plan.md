# OpenCode 数据库增长、冷归档与扫描阻塞修复方案

> 历史资料：Yep 已于 2026-08-18 退役 OpenCode 集成，且不会自动清理或修改用户的 OpenCode 数据库；本文不再是现行运维方案。
>
> 状态：方案评审稿，仅包含现场调研、设计与实施计划，不包含数据库清理、服务重启或生产代码修改。
>
> 日期：2026-08-10
>
> 调研对象：本机 OpenCode `1.18.3`，数据库 `~/.local/share/opencode/opencode.db`；OpenCode 行为同时参考仓库内 `references/opencode/` 源码。

## 1. 结论

当前 `opencode.db` 缺少真正的容量维护机制。Yep Anywhere 虽然有“7 天自动归档”，但该定时任务只处理 Claude/Codex；OpenCode 只支持手动归档，而且当前实现仅写入 `session.time_archived`，不会迁移或删除任何消息、part 或 durable event，也不会缩小 SQLite 文件。

本机数据库约为 **8.11 GiB（8.71 GB 十进制）**。其中：

- `event` 表约占 **7.49 GiB / 90%**，是首要增长来源；
- `part` 表约占 493 MiB；
- `message` 表约占 196 MiB；
- `session` 表本身只有约 0.4 MiB。

`event` 表保存 OpenCode 的 durable event history。每次 `message.updated` 和 `part.updated` 都会保存完整 JSON payload；流式 part 被反复更新时，相近内容会以多个历史版本重复落盘。本机 553,136 条事件中有 357,531 条 `message.part.updated.1`，因此“会话数只有几百，但数据库达到 8GB”是符合当前写入模型的。

磁盘膨胀与 Yep Anywhere 的 8022 卡顿是两个相关但不完全相同的问题：

1. Yep Anywhere 当前没有查询 `event` 表，所以并非每轮都直接扫描全部 8.11 GiB。
2. 但 Yep 会周期性全表扫描不断增长的 `message`/`part`，并用同步 `DatabaseSync` 在 Node 主线程执行；本机现场曾观测一次 OpenCode 变更扫描耗时 **72,538 ms**，期间 API 无法及时响应。
3. 因此必须同时修复“热库无限增长”和“主线程全量扫描”。只做归档标记或只执行 `VACUUM` 都不能解决问题。

推荐最终方案是：

- 7 天无活动的 OpenCode session 家族进入可恢复的冷归档候选；
- 先导出并校验完整归档包，再通过 OpenCode 自己的 session delete 边界移出热库；
- 冷归档包先长期保留，不默认永久删除；
- SQLite 物理缩容只在明确维护窗口内用 `VACUUM INTO` 重建并原子切换；
- Yep 的 OpenCode 查询移出主线程，并改为增量索引/有界查询，禁止常态全表聚合。

## 2. 本次现场数据

### 2.1 文件与 SQLite 状态

| 项目 | 现场值 | 说明 |
| --- | ---: | --- |
| 主数据库文件 | 8,707,776,512 bytes | 约 8.11 GiB |
| WAL | 约 358 KiB | 当前大文件不是 WAL 未 checkpoint 导致 |
| journal mode | `wal` | OpenCode 正常使用 WAL |
| page size | 4096 bytes | SQLite 页大小 |
| page count | 约 2,125,934 | 与主文件体量一致 |
| freelist count | 0 | 当前几乎没有可直接复用的空闲页 |
| auto vacuum | 0 | 删除数据后也不会自动缩小文件 |
| 可用磁盘 | 约 93 GiB | 当前具备制作备份和重建副本的空间，但仍需维护窗口 |

`freelist_count = 0` 很关键：当前直接执行 `VACUUM` 之前没有大量“已删除但未回收”的页。必须先安全移除热数据，之后重建文件才会显著缩容。

### 2.2 表体量

以下为 `dbstat` 的只读统计，采用约数：

| 对象 | 行数 | 分配空间 | payload | 判断 |
| --- | ---: | ---: | ---: | --- |
| `event` | 553,136 | 7,487 MiB | 7,371 MiB | 绝对主因 |
| `part` | 169,177 | 493 MiB | 449 MiB | Yep 当前扫描热点之一 |
| `message` | 40,594 | 196 MiB | 191 MiB | Yep 当前扫描热点之一 |
| `session` | 785 | 约 0.4 MiB | 很小 | 不是空间问题 |
| `event` 两个业务索引及主键索引 | - | 约 92 MiB | - | event 总成本的一部分 |

事件类型分布：

| event type | 数量 |
| --- | ---: |
| `message.part.updated.1` | 357,531 |
| `message.updated.1` | 153,207 |
| `session.updated.1` | 41,651 |
| `session.created.1` | 737 |
| `message.removed.1` | 10 |

OpenCode 当前发布 `PartUpdated` 时会复制完整 part，发布 `MessageUpdated` 时会保存完整 message。因此，流式文本、reasoning 和 tool part 的连续更新会在 `event.data` 中保留大量历史版本，而 `part`/`message` 表只保留最终 projection。

### 2.3 会话年龄和归档状态

| 类型 | 状态 | 会话数 | 超过 7 天 | 超过 30 天 |
| --- | --- | ---: | ---: | ---: |
| root | visible | 419 | 358 | 104 |
| root | archived | 116 | 102 | 15 |
| child | visible | 244 | 202 | 5 |
| child | archived | 6 | 6 | 1 |
| 合计 | - | 785 | 668 | 125 |

补充观察：

- 737 个 `event_sequence` aggregate 全部可以映射到现存 session，没有发现非 session aggregate。
- 超过 7 天未更新的 session aggregate 拥有 446,153 条 event，约占事件条数的 80.7%。这说明按 session 生命周期做冷归档具备很大的容量收益潜力。
- 已标记 archived 的 122 个 session 仍保留 17,742 条 event，再次证明 `time_archived` 只影响可见性，不等于清理。
- 事件大小分布并不均匀；80.7% 是事件条数占比，不应直接当作可回收字节比例。正式清理前必须在维护 worker 中按候选 session 计算真实字节估算。

## 3. 当前是否有维护

### 3.1 Yep Anywhere 的 7 天自动归档

`packages/server/src/app.ts` 定义了 `AUTO_ARCHIVE_AGE_DAYS = 7`，`SessionArchiveService` 每天北京时间 04:00 调度一次。但是 provider 归一化函数明确只返回 `claude` 或 `codex`，OpenCode 不在自动扫描范围内。

因此，当前结论是：

- Claude/Codex：有 7 天自动冷移文件逻辑；
- OpenCode：没有自动归档；
- OpenCode 已归档的 122 个 session 可能来自手动操作或 OpenCode 自身操作，不能视为 Yep 的自动维护结果。

### 3.2 OpenCode 手动归档

`SessionArchiveService.archiveSession()` 对 OpenCode 的处理是：

```sql
UPDATE session SET time_archived = ? WHERE id = ?;
```

恢复时只是把该字段改回 `NULL`。它不会：

- 移动 session 数据到 Yep archive 目录；
- 删除 `message` 或 `part`；
- 删除 `event` 或 `event_sequence`；
- 产生 SQLite 空闲页；
- 缩小 `opencode.db`。

这是一种“逻辑隐藏”，不是“物理归档”。

### 3.3 OpenCode 自身的删除边界

随仓 OpenCode 参考源码中，官方 session delete 的语义是永久移除 session、messages 和 history。实现顺序为：

1. 递归删除 child session；
2. 发布 `Session.Deleted`，projection 删除 `session`；
3. SQLite 外键级联删除关联的 `message`、`part` 等 projection；
4. `events.remove(sessionID)` 删除 `event_sequence` 以及该 aggregate 的全部 `event`。

这正是后续热库清理应使用的业务边界。Yep 不应自行执行零散的 `DELETE FROM event ...`，原因包括：

- `event` 没有时间列，无法可靠按“事件超过 7 天”判断；
- durable event 使用每个 aggregate 的连续 sequence；任意裁剪中段事件会破坏 replay/sync 语义；
- OpenCode 版本升级可能改变 projection 和关联表；直接 SQL 容易留下孤儿数据；
- 本机运行的是 OpenCode `1.18.3`，随仓参考源码当前是 `1.18.14`，正式实现必须对实际部署版本做契约测试，不能只依据较新源码假设。

此外，参考实现的 session remove 会捕获并记录内部删除异常。即使 HTTP 返回成功，维护任务仍必须复查 `session`、`event_sequence` 和 `event` 是否全部消失，不能只相信状态码。

### 3.4 OpenCode 自身的 retention

在当前随仓参考源码中，没有发现针对 `event`/`event_sequence` 的按龄 prune、TTL、compaction 或定期 GC。`event` history 还被 workspace sync/history 使用，所以不能把它视为普通日志表直接截断。

## 4. 为什么现有扫描会拖慢 8022

### 4.1 15 秒变更监视器

当 session title generation 开启且 OpenCode provider 可用时，`OpenCodeSessionChangeMonitor` 默认每 15 秒运行。查询把 `session`、`message`、`part` 的 `time_updated` 做 `UNION ALL`，再按 session 聚合和排序。

当前实际索引只有：

- `session(project_id)`、`session(workspace_id)`、`session(parent_id)`；
- `message(session_id, time_created, id)`；
- `part(session_id)`、`part(message_id, id)`。

三张表都没有以 `time_updated` 开头的索引。现场 `EXPLAIN QUERY PLAN` 因此显示全表扫描和临时 B-tree。即使 cursor 很新、最终零结果，SQLite 也必须检查所有 message/part 行。

### 4.2 session index 的全量统计

`SESSION_STATS_SQL` 会对全库 `message` 和 `part` 执行：

- `GROUP BY session_id`；
- `COUNT(*)`；
- `MAX(time_updated)`；
- `SUM(LENGTH(data))`。

虽然当前代码把多个项目的重复扫描合并为每个数据库一次，但每次快照仍要读取所有 JSON payload 来计算长度。更重要的是，`s.time_archived IS NULL` 在 message/part 全量聚合之后才生效；即使把 358 个旧 root session 标记为 archived，旧数据仍然参与重扫描。

### 4.3 主线程同步 I/O

`withOpenCodeDbResult()` 使用 `node:sqlite` 的 `DatabaseSync`。函数外层虽然返回 Promise，但 SQL callback 本身仍同步执行在 8022 的 Node 主线程。一次几十秒的查询会阻塞 REST、WebSocket、心跳和其他 timer。

因此，“把超过一周的 session 设置为 archived”目前最多减少最终返回行数，不会消除扫描，也不会防止主线程阻塞。

## 5. 目标状态与保留策略

### 5.1 三种状态必须分开

| 状态 | 数据位置 | 可恢复性 | 是否减少热扫描 | 是否缩小主库 |
| --- | --- | --- | --- | --- |
| 逻辑归档 | 仍在 `opencode.db`，只设置 `time_archived` | 立即恢复 | 查询改造后可以 | 否 |
| 冷归档 | 导出到独立压缩包并从 OpenCode 热库删除 | 通过 Yep 查看；回放恢复需验证 | 是 | 删除后产生可回收页 |
| 永久清理 | 冷归档包也删除 | 不可恢复 | 是 | 是 |

本方案不把“归档”偷换成“永久删除”。第一版自动策略只允许产生可验证的冷归档包，不默认删除冷归档包。

### 5.2 推荐的默认策略

建议按整个 session family（root 及其 children）判断，而不是逐行判断：

1. family 内所有 session 连续 7 天无活动后，进入候选报告。
2. 第一阶段只 `report`，连续观察至少 7 天，核对误判和空间估算。
3. 开启 `enforce` 后，先导出 family 的完整 projection 与 durable events，校验成功后再从热库删除。
4. 冷归档包默认保留 180 天；第一版不自动执行 180 天后的永久删除，待用户明确确认后再启用。
5. 热库文件超过容量水位时可以提前提示维护，但不能跳过 7 天和保护规则强制删除。

以下任一条件存在时，family 必须被保护：

- session 或 child 当前 running、queued、waiting input、pending approval；
- Yep metadata 中标记 starred；
- 存在活动的 4520 bridge/外部 tracker；
- 存在未完成的飞书 operation、会话绑定或待发送回复；
- family 中任何 child 在 7 天内有更新；
- archive 导出未完成、校验失败或 schema 不兼容；
- 无法确认 OpenCode 版本与删除契约；
- 用户显式 pin/keep。

对于本机当前数据，358 个 visible root 超过 7 天，只代表“年龄候选上限”；应用 family 和运行态保护规则后才能得到正式清理清单。

## 6. 正式修复设计

### 6.1 总体流程

```mermaid
flowchart LR
    A[只读 inventory] --> B[family 保护规则]
    B --> C[dry-run 报告]
    C --> D[导出冷归档包]
    D --> E[计数/哈希/可读性校验]
    E --> F[OpenCode session delete]
    F --> G[热库级联结果复查]
    G --> H[更新 Yep archive manifest]
    H --> I[维护窗口 VACUUM INTO]
    I --> J[integrity_check + 原子切换]
```

导出、删除和缩容不是一个不可分割的大事务，但每一步都必须是幂等、可恢复且有审计记录的状态机。任何一步失败都停止在当前阶段，不继续处理下一批。

### 6.2 P0：先解除 8022 主线程阻塞

容量维护上线前先完成运行时止血：

1. 把所有 OpenCode SQLite 重查询放入专用 worker thread；API 主线程只等待异步结果并允许超时/取消。
2. 给变更扫描设置硬预算，例如单批 500 ms；超时后保留 cursor，延迟重试，不允许连续占用主线程。
3. 去掉常态 `SUM(LENGTH(data))`。session index 的变化标识使用持久化增量状态，不以每次重算 JSON 总字节数作为 freshness 条件。
4. 避免每 30 秒做全库 validation；常态使用 DB change signal + 每 session 增量统计，完整校验降为低频后台任务。
5. 对所有查询记录 `durationMs`、rows scanned、DB size、timeout/cancel 和 cursor progress。

在正式代码落地前，现有 `OPENCODE_SESSION_CHANGE_MONITOR=false` 可以作为临时开关；提高 `SESSION_INDEX_FULL_VALIDATION_MS` 也能降低频率。但两者都需要部署/重启且会降低外部 OpenCode session 的标题/索引更新及时性，所以只能作为经用户确认后的临时缓解，不是最终修复。

### 6.3 P1：把扫描改为增量和有界查询

长期路径按优先级排序：

1. **优先接入 OpenCode 事件流**：由已有 OpenCode event subscription 把受影响的 session ID 写入 Yep sidecar queue，索引器只读取这些 session。
2. **持久化 sidecar cursor/stats**：以 DB identity + schema version 为作用域，保存每个 session 的 message/part count、latest update 和索引摘要。
3. **只对候选 session 定点读取**：利用现有 `message(session_id, ...)` 和 `part(session_id)` 索引，不再先聚合全库。
4. **低频对账**：每天或启动后的空闲窗口做一次 worker 内完整核对，发现差异时修复 sidecar，而不是阻塞请求。

如果事件流无法覆盖外部进程写入，可在兼容性验证后增加三个 Yep 命名的辅助索引：

```sql
CREATE INDEX IF NOT EXISTS yep_session_time_updated_id_idx
  ON session(time_updated, id);
CREATE INDEX IF NOT EXISTS yep_message_time_updated_session_idx
  ON message(time_updated, session_id);
CREATE INDEX IF NOT EXISTS yep_part_time_updated_session_idx
  ON part(time_updated, session_id);
```

这些索引只能作为版本受控的 fallback：创建前检查 schema，创建后验证 `EXPLAIN QUERY PLAN`，并测试 OpenCode 写入开销和升级兼容。更理想的最终归属是把必要索引贡献给 OpenCode 上游，而不是由 Yep 永久维护对上游数据库的私有 DDL。

### 6.4 P2：只读 inventory 与 dry-run

新增 OpenCode maintenance inventory，输出：

- DB、WAL、freelist、page count、schema/user version；
- 各表和索引的页数/估算字节；
- session family 的 root/children、最后活动时间、归档/星标/运行态；
- 每个 family 的 message、part、event 行数和估算 payload；
- 保护原因和候选原因；
- 预计逻辑删除量与预计物理缩容量。

inventory 必须在 worker 中运行，默认只读，支持超时和进度日志。常态检查不执行 `dbstat` 或 `SUM(LENGTH(event.data))`；精确字节估算只在手动 maintenance dry-run 中执行。

### 6.5 P3：可恢复冷归档包

每个 family 生成独立、不可变的归档包，建议路径：

```text
~/.yep-anywhere/archive/opencode/YYYY/MM/<root-session-id>.jsonl.gz
~/.yep-anywhere/archive/opencode/YYYY/MM/<root-session-id>.manifest.json
```

归档包至少包含：

- root 和全部 child 的 session projection；
- message、part 及其他与 session 关联的 projection；
- 按 aggregate/seq 排序的完整 durable event history；
- Yep custom title、starred、飞书关联等应用侧元数据；
- OpenCode version、DB schema/user version、导出时间；
- 每张表的行数、event 最小/最大 seq；
- 压缩前后字节数和 SHA-256；
- 归档状态机版本。

安全写入顺序：临时文件写入 → flush/close → 重新读取校验 → 原子 rename → manifest 标记 `verified`。只有 `verified` 包才允许触发热库删除。

第一版必须支持 Yep 内的只读历史查看。把归档事件 replay 回未来版本 OpenCode 需要对实际 OpenCode 版本做 round-trip 测试；在该测试通过前，UI 应明确显示“冷归档可查看，不保证原位恢复运行”，不能伪装成现有 `time_archived` 的即时 restore。

### 6.6 P4：通过 OpenCode 业务 API 移出热库

每次只处理一个 root family，并从 child 到 root 调用 OpenCode session delete，或确认 OpenCode 当前版本会递归删除 children。每次调用后必须验证：

```sql
SELECT COUNT(*) FROM session WHERE id = ?;
SELECT COUNT(*) FROM message WHERE session_id = ?;
SELECT COUNT(*) FROM part WHERE session_id = ?;
SELECT COUNT(*) FROM event_sequence WHERE aggregate_id = ?;
SELECT COUNT(*) FROM event WHERE aggregate_id = ?;
```

全部为 0 才将 manifest 标记为 `evicted`。若 HTTP 成功但仍有残留，停止该批次并报警；不允许用裸 SQL 自动补删。

建议每批最多 5 个 family，批间让出 I/O，并记录删除前后 page/freelist 变化。运行中的 OpenCode、4520 bridge、Yep session reader 都必须能继续工作；如果实际版本的 delete 会引发明显锁竞争，则把 eviction 也限制在维护窗口。

### 6.7 P5：SQLite 物理缩容

删除数据只会增加 freelist，不会自动缩小 `opencode.db`。本机 `auto_vacuum = 0`，所以需要单独的物理重建步骤。

不建议在服务运行时直接执行原地 `VACUUM`。正式流程应为：

1. 进入明确维护窗口，停止所有会写该 DB 的 OpenCode 实例和依赖它的 bridge；
2. checkpoint WAL 并制作可恢复备份；
3. 对源库执行 `quick_check`/必要时 `integrity_check`；
4. 使用 `VACUUM INTO` 生成新文件，不覆盖源文件；
5. 对新文件再次执行 integrity、schema、关键行数和抽样会话校验；
6. 保留旧库，原子切换新库；
7. 启动后验证 OpenCode 和 Yep，再按保留期删除旧库。

这个步骤会暂时需要接近“源库 + 新库 + 备份”的额外空间。部署脚本必须先检查空间，建议至少保留 `2 × 当前 DB + 10 GiB` 的安全余量。任何自动任务都不得自行停止服务或替换数据库；必须由用户明确发起维护。

## 7. 建议配置

以下均为拟新增配置，不是当前已经存在的环境变量：

| 配置 | 建议默认值 | 作用 |
| --- | --- | --- |
| `OPENCODE_MAINTENANCE_MODE` | `report` | `off | report | enforce` |
| `OPENCODE_AUTO_ARCHIVE_DAYS` | `7` | family 无活动多久进入候选 |
| `OPENCODE_COLD_ARCHIVE_RETENTION_DAYS` | `180` | 冷包保留提示阈值；第一版不自动删 |
| `OPENCODE_DB_WARN_GIB` | `4` | 容量告警，不触发强制清理 |
| `OPENCODE_MAINTENANCE_BATCH_SIZE` | `5` | 每批最多处理的 root family |
| `OPENCODE_MAINTENANCE_QUERY_BUDGET_MS` | `500` | 常态 inventory/scan 单批预算 |
| `OPENCODE_MAINTENANCE_WINDOW` | 空 | 未配置时禁止自动 eviction/compact |

策略应同时支持管理页面和 CLI dry-run，先展示“哪些 session、为什么、预计多少空间、哪些被保护”，再允许用户确认。

## 8. 观测与审计

至少新增以下结构化事件：

- `opencode_db_inventory_completed`；
- `opencode_retention_candidate_selected` / `protected`；
- `opencode_cold_archive_exported` / `verified` / `failed`；
- `opencode_hot_eviction_started` / `completed` / `residue_detected`；
- `opencode_db_compaction_started` / `completed` / `rolled_back`；
- `opencode_db_query_budget_exceeded`。

日志不能写 session 正文、event payload、用户 prompt 或凭据。记录 session ID 时沿用现有日志隐私约定；汇总日志优先只写数量、字节和耗时。

建议暴露的指标：

- DB/WAL/freelist bytes；
- session/message/part/event rows；
- hot、logical archived、cold archived family 数；
- OpenCode query p50/p95/p99 和最大值；
- worker queue depth、timeout、cancel；
- 最近一次 inventory、eviction、compaction 时间和结果。

## 9. 测试计划

### 9.1 查询与响应性

- 构造包含大量 message/part 的 SQLite fixture，证明 cursor 较新时不再全表扫描。
- 对关键 SQL 固定 `EXPLAIN QUERY PLAN` 断言，禁止回退为 `SCAN message` / `SCAN part`。
- 在 worker 执行长查询时，用 event-loop heartbeat 证明 API 主线程持续响应。
- 验证 timeout/cancel 后 cursor 不前移，下一轮可以安全重试。

### 9.2 归档安全

- root + 多层 child 作为一个 family 导出。
- running、waiting input、starred、飞书待处理、近期 child 均被保护。
- 导出中断只留下临时文件，不产生 `verified` manifest。
- 修改归档包后哈希校验失败，禁止 eviction。
- 对实际 OpenCode `1.18.3` 做 delete 契约测试：session、message、part、event_sequence、event 全部清零。
- HTTP 返回成功但数据库有残留时，任务停止并可重试。

### 9.3 恢复与压缩

- Yep 可以从冷包展示完整只读 transcript。
- 在隔离数据库验证 event replay/restore；未通过时不开放“恢复运行”入口。
- `VACUUM INTO` 新库通过 integrity、schema、计数和抽样内容校验。
- 原子切换失败时继续使用旧库；新库不得覆盖唯一备份。

### 9.4 回归

- OpenCode CLI、4520 bridge、Yep session page、搜索、归档列表均可读取近期 session。
- 新消息能即时进入 sidecar 增量索引。
- logical archived session 不参与常态聚合。
- 冷归档 session 不出现在 OpenCode 热列表，但可在 Yep archive 中查看。

浏览器/UI 自动化不属于本方案默认执行范围；实现阶段如需做 UI 回归，应先按项目约定获得用户确认。

## 10. 上线顺序

### 阶段 A：查询止血

- SQLite 重查询迁移到 worker；
- 取消 `SUM(LENGTH(data))` 常态全量统计；
- 引入查询预算和慢查询观测；
- 证明 8022 不再因 OpenCode 扫描长时间无响应。

### 阶段 B：report-only retention

- inventory、family 保护规则、容量报告上线；
- 默认 `report`，至少观察 7 天；
- 不删除任何热库数据。

### 阶段 C：冷归档

- 先在数据库副本上完成 export → delete → read-only view/restore 测试；
- 小批量人工确认执行；
- 核对空间收益、锁竞争和误判。

### 阶段 D：首次物理缩容

- 用户明确安排维护窗口；
- 备份、`VACUUM INTO`、校验、原子切换；
- 旧库保留到新库稳定运行后再处理。

### 阶段 E：有限自动化

- 只有经过至少一轮稳定人工执行后才允许 `enforce`；
- 自动化只做“已验证冷归档 + 热库 eviction”；
- 永久删除冷包和数据库物理替换仍保持人工确认。

## 11. 回滚策略

- 查询改造：保留 feature flag，可切回旧 reader；切回时不得重新启用主线程无限时全扫。
- sidecar：可删除并从热库重建，不作为唯一事实来源。
- export 前失败：删除临时包即可，OpenCode DB 未变。
- export 后、eviction 前失败：保留 `verified` 包，重试或人工取消。
- eviction 后失败：热库数据已被官方 delete；从冷包只读访问，或在隔离环境验证后 replay 恢复。
- compaction 失败：不切换，继续使用旧数据库。
- compaction 切换后异常：停止写入并原子切回保留的旧库。

## 12. 验收标准

功能完成必须同时满足：

1. OpenCode 变更监视和 session index 常态路径不再全表扫描 `message`/`part` payload。
2. 任何 OpenCode SQLite 查询都不能同步阻塞 8022 主线程超过 100 ms。
3. 压测期间 `/api/version`、session list 和 WebSocket heartbeat 不出现由 DB 扫描导致的秒级停顿。
4. 7 天候选按 family 计算，所有保护规则有单测和可解释原因。
5. 没有 `verified` 冷包时绝不删除热库 session。
6. 删除后 session、message、part、event_sequence、event 均无残留。
7. 冷归档内容可在 Yep 中只读查看，校验失败会明确报警。
8. SQLite 文件只有在维护窗口、备份和新库校验完成后才允许替换。
9. 容量报告可以解释“新增空间来自哪个表、哪些 session family”。
10. 运行 30 天后热库增长率可观测，并由 retention 阈值稳定约束，不再无限增长。

## 13. 预计代码范围

| 范围 | 预计文件 |
| --- | --- |
| SQLite worker 与预算 | `packages/server/src/sessions/opencode-db.ts`、新增 worker 模块 |
| 增量变更发现 | `packages/server/src/projects/opencode-scanner.ts`、`packages/server/src/services/OpenCodeSessionChangeMonitor.ts` |
| session stats sidecar | `packages/server/src/sessions/opencode-reader.ts`、`SessionIndexService` 相关模块 |
| retention inventory/state machine | 新增 `packages/server/src/opencode-maintenance/*` |
| 归档 manifest 与只读访问 | `packages/server/src/archive/SessionArchiveService.ts` 及 archive routes |
| OpenCode 官方删除调用 | OpenCode bridge HTTP client/maintenance adapter |
| 运行态/飞书保护规则 | supervisor、bridge view、Feishu binding/operation store 的只读查询接口 |
| 配置与诊断 API | `packages/server/src/config.ts`、settings/debug routes |
| 测试 | server unit/integration fixtures；隔离 SQLite 与 OpenCode contract test |
| 发布记录 | `CHANGELOG.md` 的 `[Unreleased]` |

## 14. 明确不做的事

- 不直接 `DELETE FROM event WHERE ...`。
- 不把 `time_archived` 当作数据已迁移或空间已释放。
- 不在 8022 主线程运行 `dbstat`、全量 payload 求和、`VACUUM`。
- 不在没有冷包、校验和用户策略的情况下按日期永久删除会话。
- 不在服务在线写入时自动替换 `opencode.db`。
- 不仅靠增加轮询间隔掩盖全表扫描。

## 15. 建议决策

建议批准以下实施顺序：

1. 先做 P0/P1，消除 8022 主线程阻塞；
2. 再做 7 天 family retention 的 report-only inventory；
3. 完成可验证冷包和 OpenCode `1.18.3` 删除契约测试；
4. 小批量人工 cold eviction；
5. 最后安排一次维护窗口执行物理缩容；
6. 观察稳定后再决定是否开启自动 enforce。

这样既能处理当前 8.11 GiB 数据库，也能避免以后数据库继续无界增长，同时不会因为一句“超过一周归档”而把不可恢复的永久删除悄悄引入生产环境。
