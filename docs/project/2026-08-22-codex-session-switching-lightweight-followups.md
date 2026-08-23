# Codex Session 切换轻量化后续优化

> 日期：2026-08-22  
> 状态：审核结论，待实现  
> 适用范围：Codex / Codex OSS session 历史分页、客户端切换缓存、4510 bridge 增量同步  
> 前置文档：[Codex Session 列表与切换性能开发计划](./2026-08-22-codex-session-switching-performance-development-plan.md)

## 1. 文档目的

前一轮已经完成主要性能实现和 scope remediation：保留 Codex 专用的分页历史、
provider catalog、manifest scan worker、客户端小型 LRU/SWR，以及 4510 的 ETag 与按 session
增量刷新；同时移除了通用 `SessionIndexService` 扩张、SQLite event store v2、
`/session-views/delta`、message-count 全链路精确传播和少见 item 的专用 renderer。

本轮审核确认，当前方向已经比最初方案轻，但还有三个会影响历史可达性或 API 正确性的阻断项，
以及若干可以进一步降低请求数、文件句柄压力和提交耦合的优化点。

本文只记录这些新增发现，不重复大计划中的完整背景和基准。

## 2. 轻量版设计边界

### 2.1 应继续保留

- 客户端最多 5 个 session 的 LRU/SWR snapshot cache，总预算 32 MiB、单项 12 MiB。
- 服务端复用长生命周期、只读的 Codex app-server history client。
- Codex app-server 分页历史与 bounded rollout fallback。
- Codex provider-wide catalog 和 Codex-only manifest scan worker。
- 4510 `/sessions/:id/view`、ETag/304 和小规模 changed-session 定向刷新。
- smoke、聚焦测试、真实超长 rollout 基准和必要的 detail `Server-Timing`。

### 2.2 不再扩回本轮范围

- 不改造通用 `SessionIndexService`，不连带 Gemini、Pi、Kimi、ZCode。
- 不新增 SQLite event store、双写、迁移器或第二套 canonical journal。
- 不读取 Codex 私有数据库；只使用公开 app-server 协议和 rollout 文件。
- 不为了少见 item 类型新增整套 renderer、hook/review/sleep UI。
- 不新增 bridge 全量 delta 协议；已有 ETag 与单 session endpoint 足够表达轻量增量。
- 不追求所有列表场景都返回精确 `messageCount`，未知值应诚实表达为未知。

### 2.3 判断标准

新增实现应至少满足以下一项：

1. 修复历史不可达、游标失效或公开类型错误；
2. 明显减少与 session 数量线性增长的 I/O、HTTP 请求或资源峰值；
3. 删除或隔离现有耦合，降低后续维护成本。

单纯增加诊断字段、抽象层或新存储，不构成本轮新增代码的充分理由。

## 3. P0：必须先修的正确性问题

### 3.1 不支持的历史 item 会让深分页失去 fallback

#### 现状

`CodexAppServerHistoryReader` 对部分无法保证 transcript parity 的 item 主动抛出
`CodexHistoryParityError`，例如内嵌媒体、`imageGeneration`、`imageView`、hook、sleep 和
review 类 item。正常意图是回退到 rollout reader。

但 app-server cursor 已经锁定 history source。发生 parity 错误后，当前
`fallbackOrStale()` 无法直接切换到 rollout cursor，只能返回 `ROLLOUT_CURSOR_STALE`。
客户端加载更早消息捕获该错误后，会执行一次替换式刷新，结果是用户被送回最新尾部，
而包含该 item 的更早历史仍然无法访问。

只读探针已复现：使用旧 app-server cursor 翻到含 base64 image 的页面时返回
`ROLLOUT_CURSOR_STALE`。

#### 简化后的修复原则

- 不增加第三套历史 materializer。
- 不静默替换当前消息，也不把用户送回最新尾部。
- 对能无损映射的小型 item，直接映射为现有 system/content 结构，不新增专用 renderer。
- 对媒体等确实不能保证 parity 的 item，显式执行“history source switch”，并保留稳定锚点。

#### 建议实现

服务端返回可区分的兼容性响应，例如
`SESSION_HISTORY_SOURCE_SWITCH_REQUIRED`，至少携带：

- 当前 session ID；
- 请求方向；
- 当前页边界的稳定 message/item anchor；
- 目标 source（`rollout`）；
- 是否允许客户端自动重试。

客户端应保持当前已渲染消息，在 anchor 处用 rollout source 重试；如果 anchor 暂时无法可靠转换，
则保留当前页面并展示明确的“更早历史需要兼容模式”操作，不得执行 replace-to-tail。

如果实测 Codex app-server item ID 与 rollout message ID 无法稳定互译，第一版可以选择显式提示，
但不能继续把 stale 当作普通刷新处理。

### 3.2 超过最近 100 turns 的历史可能不可达

#### 现状

history reader 当前只加载最近 100 个 turns 的 metadata。投影 item 时又要求
`turnsById` 必须包含其 `turnId`。当用户继续向前翻到第 101 个及更早的 turn，item 本身仍可由
`thread/items/list` 返回，但缺少 metadata 会被判成 parity 错误，继而触发上面的 source-locked
stale 路径。

#### 建议实现

把 turn metadata 从“内容投影前提”降级为“可选增强信息”：

- item 内容、角色、ID 可以确定时继续返回；
- 找不到 turn metadata 时，timestamp、provider error 等增强字段保持 `undefined`；
- 只有缺失信息会改变消息正文、顺序或身份时，才判定 parity 失败。

这是优先方案，因为它不需要新的 turn cursor 协调层。只有在验证发现准确 metadata 是协议必需时，
才增加与 item page 对齐的 turn 分页，不要预先引入双游标状态机。

### 3.3 `messageCount` 的公开类型与运行时不一致

#### 现状

新的 catalog/app-server list 和 metadata detail 在无法低成本得到消息数时会省略
`messageCount`，客户端部分列表类型也已经允许其缺失；但共享 `AppSessionSummary` 仍将其声明为
必填 `number`。这会让 TypeScript 承诺运行时并不保证存在的值。

#### 建议实现

- 把对应公开 DTO 中的 `messageCount` 改为可选或显式 nullable；优先沿用项目现有的“未知即省略”约定。
- 检查所有展示点，只在值存在时显示，不用 `0` 代替未知。
- 不恢复为每个列表 item 扫描 rollout 来追求精确计数。
- 如果内部持久化类型仍要求精确值，拆分 response DTO，不要用类型断言掩盖差异。

## 4. P1：低复杂度、高收益优化

### 4.1 给 4510 定向刷新增加 burst threshold

#### 现状

小规模 changed-session 使用 `/sessions/:id/view` 很划算，但当前实现对大 burst 也会逐 ID 请求。
即使限制为 16 并发，1,001 个 changed IDs 仍会产生 1,001 个 HTTP 请求；此时一次完整 snapshot
更便宜、更稳定。

#### 建议实现

- changed IDs 小于阈值时继续定向刷新。
- 超过阈值时跳过逐项请求，执行一次条件式全量 snapshot。
- 初始阈值建议从 32 开始，通过现有 benchmark 比较 16、32、64 三档。
- 任一定向请求出现一致性错误或 unknown session 时，合并为一次全量恢复，不逐个重试。
- 定时无变化路径继续依赖 ETag/304，不退回每秒全量 JSON 解析。

阈值应集中定义并有边界测试，避免散落在 notifier、service 和 HTTP client 三处。

### 4.2 限制 manifest scan 的文件并发

`CodexManifestScanWorker` 当前收集文件后通过未限流的 `Promise.all` 执行 stat/open。几百个文件时
问题不明显，达到数千 session 后可能形成文件描述符和 I/O 峰值。

建议复用项目已有的并发池工具，或增加一个极小的 worker queue：

- 初始并发 32；
- 单文件失败只记录诊断，不中断整个 catalog；
- 保持结果顺序和现有缓存语义；
- 增加“最大活跃任务数不超过阈值”的单元测试。

不需要引入外部队列、worker thread 或新的持久化层。

### 4.3 让 catalog 缓存从固定短 TTL 走向自适应失效

provider catalog 即使只返回第一页，也可能周期性分页读取完整 state DB，并校验所有 thread path。
当前约 113 个 session 尚可接受，但数量继续增长后，固定 2 秒 TTL 会重复支付相同成本。

优先级低于前两项。建议先记录真实 warm p50/p95 和扫描次数；只有 warm p95 超过 50 ms 或后台扫描
明显干扰请求时，再做以下最小改动之一：

- 有活跃 Codex lifecycle 事件时失效，空闲时延长 TTL；或
- 前台沿用 stale result，单飞后台刷新，并设置 10–30 秒上限。

不要为此恢复跨 provider 的通用物理索引。

### 4.4 修复 SSE 分帧的 chunk 边界假设

`BridgeHttpClient` 当前按每个网络 chunk 执行 CRLF 归一化。如果 `\r` 与 `\n` 恰好落在两个
chunk，frame delimiter 可能识别失败。

建议用一个小型流式 line/frame decoder，保留跨 chunk 的尾部字符；覆盖以下切分测试：

- `\r` / `\n` 分属两个 chunk；
- `\r\n\r\n` 的四个字符被任意切分；
- UTF-8 多字节字符跨 chunk；
- 末帧无额外换行。

该修改只增强 parser，不改变 bridge 协议。

## 5. P2：继续减小实现和提交耦合

### 5.1 把三条能力拆成独立提交

剩余生产改动本质上是三条纵向能力，不应作为一个“大性能重构”提交：

1. 客户端 session snapshot LRU/SWR；
2. Codex history、catalog、manifest worker 与 route wiring；
3. 4510 ETag/SSE、定向刷新与 burst fallback；
4. 可选的 benchmark、smoke、诊断文档。

拆分时每个提交都应有对应测试，并能单独说明回滚方式。

### 5.2 隔离 path projection 的并行改动

当前 history 代码调用 workspace-aware 的 `publicCodexFileChanges(..., { workspaceRoot })`，并受
新的 path projection/canonical redaction 逻辑影响。这组改动不是 session switching 性能本身，
却已形成编译和行为依赖。

合并前必须二选一：

- 先把 path projection 作为独立前置提交完成审核；或
- 移除本轮对新接口的依赖，保持原有公开路径投影行为。

不要把两组改动混成一个提交来解决依赖。

### 5.3 精简长期运行诊断

`Server-Timing` 对 history detail 的 source、fallback 和耗时定位有直接价值，可以保留。
列表路由上只为本轮排查增加、但没有监控消费方的细粒度 timing，可以在性能验收后删除或降为
debug log，减少长期 API 表面积。

同理，测试 fixture、smoke 和 benchmark 应保留能防回归的部分；一次性探针输出不应进入运行时代码。

## 6. 推荐实施顺序

### 阶段 A：先恢复历史可达性

1. 取消 item 对最近 100 turns metadata 的硬依赖。
2. 阻止客户端在 source-locked stale 时 replace-to-tail。
3. 为真正不兼容的 item 定义 source-switch/compatibility 响应和 anchor 行为。
4. 用包含 base64 image、超过 100 turns 的 fixture 做双向分页测试。
5. 修正 `messageCount` response DTO。

阶段 A 完成前，不把当前分支标记为“可合并”。

### 阶段 B：控制请求和资源峰值

1. 增加 bridge burst threshold 与单次 full snapshot fallback。
2. 限制 manifest scan 并发。
3. 修复 SSE 跨 chunk 分帧。
4. 复测定时 304、少量 changed IDs 和大量 burst 三条路径。

### 阶段 C：收口范围和提交结构

1. 隔离 path projection 前置依赖。
2. 按客户端、history/catalog、bridge 三条能力拆分提交。
3. 删除没有长期消费方的诊断代码。
4. 运行完整静态检查、测试和 diff review；不在本阶段顺手加入其他 provider 优化。

## 7. 验收矩阵

| 场景 | 必须满足的结果 |
| --- | --- |
| 含 base64 image 的更早页面 | 不跳回最新尾部；可切换兼容 source，或保留当前页面并给出明确操作 |
| 第 101 个及更早的 turn | item 可继续加载；缺少可选 metadata 不导致 cursor stale |
| `messageCount` 未知 | JSON 可省略，公开类型允许省略，UI 不显示为 0 |
| 1–32 个 changed IDs | 使用定向 `/sessions/:id/view`，合并结果正确 |
| 大量 changed IDs | 请求数不与 ID 数线性增长，只执行一次全量恢复 |
| bridge 定时无变化 | 返回 304，不解析重复 snapshot |
| SSE 任意 chunk 切分 | frame 不丢失、不合并、不重复 |
| 数千 manifest 文件 | 活跃文件任务不超过配置并发，局部失败不清空 catalog |
| 188.7 MB rollout true cold | 初始 detail 保持约 100 ms 量级，不退回全文件扫描 |
| 初始 detail payload | 维持当前约 375 KiB JSON / 82 KiB gzip，不因修复恢复全量历史 |
| 切回最近 session | 命中 5-entry LRU 时先画缓存，后台校正不重复插入消息 |

聚焦验证至少覆盖：

```bash
pnpm typecheck
pnpm lint
pnpm test
```

另运行 Codex history、bridge、global/project/session routes 的聚焦测试，以及
`scripts/bench-session-load.ts` 的 true-cold 模式。只有任务明确涉及 E2E 或用户授权后，才进行浏览器
自动化；本轮不要求重启 4510 或 8022。

## 8. 回滚与运行开关

- history 读取异常时可将 `YEP_CODEX_HISTORY_READ_MODE` 切回 `rollout`。
- catalog 异常时可将 `YEP_CODEX_LIST_SOURCE` 切回 `manifest`。
- bridge 定向刷新异常时，应在代码内降级为条件式 full snapshot；不要依赖人工逐 session 恢复。
- 客户端 LRU 可以独立关闭，不应影响 REST 分页正确性。

回滚开关只用于止损，不能替代 P0 的历史可达性修复。

## 9. 最终审核清单

- [ ] 不支持 item 不再导致已加载历史被替换为最新尾部。
- [ ] 超过最近 100 turns 的分页已有回归测试。
- [ ] `messageCount` 的 server JSON、shared type 和 client 使用一致。
- [ ] bridge burst 有明确阈值，测试不再把 1,001 个定向请求当作成功标准。
- [ ] manifest scan 有并发上限。
- [ ] SSE parser 覆盖 CRLF 和 UTF-8 跨 chunk。
- [ ] 没有重新引入通用 M4 index、M6 SQLite event store 或私有 Codex DB。
- [ ] path projection 变更已独立审核或从本轮依赖中移除。
- [ ] 每个生产文件都能归属到客户端缓存、history/catalog 或 bridge 三条能力之一。
- [ ] CHANGELOG 只描述最终保留的用户可见行为，不记录已删除的实验方案。
- [ ] 未经用户确认不部署、不重启现有服务。

## 10. 完成定义

只有在 P0 三项全部关闭、验收矩阵中的深分页与 burst 场景通过，并完成按能力拆分的最终 diff
审核后，这轮 session switching 性能改动才适合进入正式合并流程。

轻量版的目标不是覆盖 Codex 的所有历史形态，而是保证常用路径快、异常路径不丢历史、session
数量增长时资源成本有上限，同时不把 Yep Anywhere 扩成第二个 Codex history store。
