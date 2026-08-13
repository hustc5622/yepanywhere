# 未读状态一致性与缓存杂项小修方案

> 状态：方案待评审（2026-08-13）。除标注「存疑」的条目外，问题均已经静态代码确认。
>
> 日期：2026-08-13
>
> 关联文档：docs/project/2026-08-13-push-notifier-restart-dedup-plan.md、docs/project/2026-08-13-session-switching-performance-plan.md、docs/project/2026-08-13-codex-event-journal-memory-plan.md

## 1. 结论

2026-08-13 静态审查在未读/已读状态链路及相邻的元数据、缓存代码中发现 13 个缺陷。每一项都足够小，可独立实施、独立测试、独立回滚，互不阻塞。

| 条目 | 级别 | 改动面 | 风险 |
| ---- | ---- | ------ | ---- |
| 3.1 hasUnread 用 ISO 字符串字典序比较 | 中 | `NotificationService` 比较入口归一化 + 客户端同模式点 | 低：纯比较语义修正，单测直给 |
| 3.2 重启首轮用允许陈旧的索引算未读 | 中低 | `inbox.ts` / `global-sessions.ts` 首轮 fresh 策略 | 低：首屏延迟略增 |
| 3.3 无「变未读」推送，Sidebar 未读点不即时 | 中低 | 服务端事件附带 hasUnread（推荐）或客户端本地推导 | 中：多 tab 一致性需分析 |
| 3.4 「从未看过 = 未读」口径失真 | 中低 | stats 分层 / 导入回填 / 仅说明，三选一 | 低：口径取舍需产品确认 |
| 3.5 `needsReview` 只写不读死状态 | 低 | 接线进 badgeCount 或删除 | 需产品决策（见第 6 节） |
| 3.6 notifications.json 非原子写 + 孤儿 key | 低 | `doSave` tmp+rename；reconcile 清理 | 低：仓库内有原子写先例 |
| 3.7 跨机时钟偏移致 hasUnread 恒真 | 低 | 上限钳制或仅文档说明 | 低（可先只文档） |
| 3.8 SW 前台抑制与 engagement 判定口径不一 | 低 | sw.js 判定对齐或接受现状 + 注释 | 低（可先只注释） |
| 4.1 `charBudgetLruCache` 预算只计 key | 低 | 注释修正或按估值计入 value | 极低 |
| 4.2 `maxCacheSize` 注释失真 + FIFO 淘汰 | 低（文档级） | 注释修正；可选 LRU 化 | 极低 |
| 4.3 `journalSubscriptions` 疑似残留【存疑】 | 待确认 | crash/abort 路径补清理 | 先运行时确认再定 |
| 4.4 桌面端直播消息数组无界 | 中低 | 桌面端软上限 / 对齐移动端裁剪 | 中：与切换性能方案呼应 |
| 4.5 content 索引落盘副本随历史无界 | 低 | 容量水位 / 按 mtime 淘汰 | 低 |

## 2. 未读机制现状

简述现有链路，使后续每条小修自足：

- `NotificationService`（`packages/server/src/notifications/NotificationService.ts`）把 `lastSeen` 与 `needsReview` 两张表持久化到 `~/.yep-anywhere/notifications.json`（schema version 2）。
- `hasUnread(sessionId, updatedAt)`（:237-244）：无 `lastSeen` 记录即视为未读；否则比较 `updatedAt > lastSeen.timestamp`。
- 已读写入：客户端 `useEngagementTracking` 在会话页 `visibilityState === "visible"` 时 POST `/api/sessions/:sessionId/mark-seen`（`routes/sessions.ts:1907`），服务端 `markSeen` 取 `max(provided, now)` 记录并广播 `session-seen` SSE；DELETE 同路径（`sessions.ts:1931`）是手动「标为未读」。
- 启动时 `index.ts:637` 调 `importLastSeenFromRecents` 用 recents 访问记录回填 `lastSeen`，只覆盖访问过的 session。
- 读侧：`routes/inbox.ts` 与 `routes/global-sessions.ts` 遍历各项目 session 时用 `hasUnread` 注入 `hasUnread` / `unreadCount`；Sidebar 经 `useGlobalSessions`、Inbox 经 `InboxContext`，靠 SSE 增量 + 轮询刷新。
- `updatedAt` 来源不对称：多数 reader 经 `toISOString()` 归一化（含 mtime fallback），而 Gemini 与 Kimi 会透传外部 CLI 写入的原始时间字符串（见 3.1）。

## 3. 未读一致性小修

### 3.1 hasUnread 依赖 ISO 字符串字典序比较【中】

背景：`hasUnread` 的时间比较是字符串字典序，只有「同一格式、同一精度、同一时区后缀」时才与时间序等价。

证据：

- `NotificationService.ts:243` `return updatedAt > lastSeen.timestamp;`；`:290` `recordSeenInMemory` 的 `existing.timestamp < timestamp`、`:134` `markSeen` 的 `provided > now` 同模式。
- `updatedAt` 来源不对称：`sessions/gemini-reader.ts:162` 透传 Gemini CLI 的 `session.lastUpdated`；`sessions/kimi-reader.ts:171`（原始值来自 Kimi CLI `state.json`，:609）透传 `entry.updatedAt`。精度差异（有无毫秒）或时区后缀差异（`Z` vs `+08:00`）都会比错。
- 客户端 `useEngagementTracking.ts:73` 的 `activityAt > lastSeenAt` 是同一模式，应同批修。

修法：在 `NotificationService` 内设统一归一化入口（如 `toEpochMs(ts)`，内部 `Date.parse`），三处比较先转 number 再比；reader 侧不动，归一化集中在消费点。`Date.parse` 失败的脏数据定义兜底：`updatedAt` 解析失败时保守返回未读，`lastSeen` 写入解析失败时跳过更新。客户端 `hasNewContent` 同步改为 `Date.parse` 比较。

验证：`NotificationService` 单测补「同一时刻的不同精度/时区后缀表示」等价性用例；构造 `updatedAt` 带 `+08:00`、`lastSeen` 带 `Z` 的用例断言比较结果一致。

风险：低。行为变化仅限此前就比错的边界场景；兜底策略需写进代码注释。

### 3.2 重启后首轮用允许陈旧的索引算 hasUnread【中低】

背景：重启后未读「晚一拍」。

证据：`routes/inbox.ts:267` 与 `routes/global-sessions.ts:409` 调 `listSessionsAcrossProviders` 传 `allowStaleSessionCache: true`；对比 `app.ts:871-873` 启动恢复路径刻意用 `false` 且有注释「Recovery must observe files written while the server was down」。首轮 inbox/stats 可能拿停机前持久化的索引算 `hasUnread`，`updatedAt` 偏旧导致停机期间的新内容漏标未读，等索引校验追上后才出现。

修法：服务端持有「恢复完成」标志，首轮 inbox / global-sessions 请求（或恢复扫描完成前的所有请求）强制 `allowStaleSessionCache: false`。比逐点加临时标记简单，语义与 app.ts 恢复路径一致。

验证：停机期间向某 session 追加内容，重启后第一个 inbox 请求应立即 `hasUnread = true`。

风险：低；首轮响应延迟略增，但启动期本来已有一次全量恢复扫描。

### 3.3 没有「变未读」推送，Sidebar 未读点不即时【中低】

证据：

- `useGlobalSessions.ts:732-802` 的 `handleSessionUpdated` 更新 title/messageCount/updatedAt 等字段但不更新 `hasUnread`。
- `session-seen` 事件只把 `hasUnread` 置 false（`useGlobalSessions.ts:718-729`），唯一的置 true 路径是手动「标为未读」（`sessions.ts:1931-1950` 发空 timestamp）——方向不对称，新内容不会触发未读点。
- `InboxContext.tsx:317-330` 注释明确不再因 file-change refetch，未读变化只能等下次轮询或导航。

修法选项：

- a)（推荐）服务端在新内容事件（file-change / session-updated）中附带重算的 `hasUnread`，false→true 翻转时推送；单一事实源，多 tab 天然一致。需 eventBus 能访问 `NotificationService`，且推送要节流（file-change 高频）。
- b)（降级）客户端在 `handleSessionUpdated` 里按 `updatedAt > lastSeen` 本地推导；依赖 3.1 先修（否则继承同样的字符串比较坑），且各 tab 的 `lastSeen` 快照可能短暂不一致，靠 `session-seen` 广播收敛——不一致窗口可接受但要在代码注释中写明。

验证：两个 tab 打开 Sidebar，第三方向某 session 写入新消息，两个 tab 的未读点应及时出现且一致。

风险：中低；a 的节流策略与翻转判定需单测覆盖，避免事件风暴。

### 3.4 「从未看过 = 未读」使存量 session 全未读、stats 口径失真【中低】

证据：`NotificationService.ts:239-241` 无 `lastSeen` 即返回 true；`global-sessions.ts:250-251` 的 `unreadCount` 对全部非归档 session 统计。新数据目录下全部历史 session 计入未读；`index.ts:637` 的 recents 回填只覆盖访问过的，未访问的历史 session 永远未读。

修法选项与取舍：

- a)（推荐）保留语义、stats 分层：`unreadCount` 拆为「未读且近 N 天活跃」与「未读总量」，badge/概览用前者；
- b) 导入回填：首次 initialize 时对早于安装时间的 session 批量写 `lastSeen`——基准时间难定义、不可逆，且引入「没看过的老 session 不再提醒」的语义变化；
- c) 维持现状，仅 UI 文案/文档说明口径。

口径选择属产品决策，列入第 6 节待确认。

验证：stats 单测补「从未看过但 30 天前活跃」的分层断言。

风险：低；口径变化需在变更说明中写明。

### 3.5 needsReview 只写不读的死状态【低】

证据：

- 写入：`NotificationService.ts:181-197` `markSessionNeedsReview` + `:202-209` clear；调用方 `PushNotifier.ts:470`（session-halted 推送时标记）、`PushNotifier.ts:211`（activity 回到 `in-turn` 时清）。
- 读取：唯一读取方 `getSessionsNeedingReview()`（:214-216）生产代码零调用（仅 test 与 `inbox.test.ts` 的 mock）。
- `InboxContext.tsx:204` 注释宣称 `totalBadgeCount` 含「unread review」，但实际 `badgeCount` 只取 needsAttention 集合大小（`inbox.ts:495-502`），注释与实现不符。

修法（二选一，产品决策，列入第 6 节）：

- a) 接线：`inbox.ts` 把 `getSessionsNeedingReview()` 并入 `badgeSessionIds`，落地注释宣称的行为（halted 未查看前持续角标）；
- b) 删除：移除 `needsReview` 状态、PushNotifier 写入与 notifications.json 字段（schema version 2→3），同步修正 InboxContext 注释。

验证：a) inbox 集成测试断言 halted 未看 session 计入 badge；b) 全仓 grep 无残留引用。

风险：a 改变用户可见角标计数（该功能本意即如此）；b 为纯删减。

### 3.6 notifications.json 非原子写 + 孤儿 key 只增不删【低】

证据：

- `doSave`（:341-349）整文件 `writeFile` 覆盖；写入中途崩溃留下截断 JSON，`initialize`（:100-113）解析失败即整体重置为空 → 全部 session 回到「从未看过 = 未读」（叠加 3.4 效果放大）。
- 孤儿 key：`NotificationService.clearSession`（:250）仅被 DELETE mark-seen（`sessions.ts:1938`）调用；app 外删除 session 文件没有任何清理路径，`lastSeen` / `needsReview` key 只增不删。`SessionMetadataService.clearSession`（`SessionMetadataService.ts:567`）生产零调用，`session-metadata.json` 同样只增不删。

修法：

- a) 原子写：tmp + rename。仓库内 `SessionIndexService.ts:354-364`（tmp 文件 + 写锁 + rename）与 `SessionContentIndexService.ts:276-277` 均有先例，直接套用。
- b) reconcile：`SessionIndexService` 全量校验或启动恢复扫描时，比对索引把已不存在 session 的 key 从 notifications.json / session-metadata.json 摘掉；低频批量做，不上热路径。

验证：单测写入截断文件后 initialize 不丢状态；reconcile 后孤儿 key 消失且正常 key 不受影响。

风险：低；rename 语义与同仓库现有实现一致。

### 3.7 跨机时钟偏移：markSeen 地板与 provider 时间戳超前【低】

证据：`markSeen`（:127-134）取 `max(provided, now)` 地板——客户端 `updatedAt` 晚于服务器时按 provided 记。反过来，当 session 文件由远程 executor 产生、其机器时钟持续超前于服务器时，`updatedAt > lastSeen` 恒真，`hasUnread` 永远 true。

修法（可先只文档）：a) 比较前对 `updatedAt` 做上限钳制（`min(updatedAt, serverNow + 容忍窗)`）；b) 在远程 executor 文档中写明时钟同步（NTP）是未读正确性的前置条件。建议先 b)，出现真实案例再做 a)。

验证：构造 `updatedAt` 超前 `now` 5 分钟的用例，钳制后行为符合预期。

风险：低；钳制会掩盖真实时钟问题，容忍窗取值要保守并留日志。

### 3.8 SW 前台抑制与 engagement 判定口径不一致【低】

证据：`public/sw.js:258` 用 `client.focused`、:297-298 匹配 focused client 的 URL 决定是否抑制系统通知；`useEngagementTracking.ts:102,114` 用 `document.visibilityState` 判定「可见即已读」。双屏失焦场景：窗口可见但未 focused 时 engagement 已把内容标记已读，SW 仍按「无 focused client」弹通知——已读仍弹。

修法（二选一）：a) client 通过 postMessage 向 SW 上报可见性、对齐判定（改动中等）；b) 接受现状并在 sw.js 注释说明「focused 是保守近似，宁可多弹不漏弹」。移动端优先产品多弹比漏弹安全，推荐 b)。

验证：双屏手动验证（可见未 focused 窗口 + 新消息 → 现状会弹通知）。

风险：低（b 无代码风险）。

## 4. 元数据与缓存杂项小修

### 4.1 charBudgetLruCache 预算只计 key 长度【低】

证据：`set`（`utils/charBudgetLruCache.ts:42-59`）与 `evictToBudget`（:61-69）的预算只累计 `key.length`（:57、:67），value 完全不计。两处使用点注释宣称「~8M chars (≈16MB UTF-16) of distinct inputs retained」（`highlighting/index.ts:139`、`augments/markdown-augments.ts:209`），但驻留的还有 value：Shiki 的 `HighlightResult`（含 HTML 与 token 结构）和 Markdown 渲染后的 HTML 通常不小于输入，实际驻留约为注释宣称的数倍。

修法：a)（推荐）注释修正为「预算只约束 key（输入字符），value 驻留另计」；b) 按估值计入 value（string 取 length，否则按 key.length 系数折算）——预算变严会增加重算，需重测命中率。

验证：a 无需测试；b 调整现有 cache 容量断言并观察高亮命中率。

风险：极低。

### 4.2 SessionIndexService maxCacheSize 注释失真与 FIFO 淘汰【低，文档级】

证据：`SessionIndexService.ts:99` 注释写「default: 100」，实现 :156 是 `?? 10000`。另外 `evictIfNeeded`（:190-204）自述「Simple FIFO eviction since Map maintains insertion order」，命中不刷新位置——与 `charBudgetLruCache` 的真 LRU 不同，理论上热 scope 可按插入顺序被挤出（实际上 scope 数远小于 10000，几乎不发生）。

修法：a) 注释 100 → 10000（必修，一行）；b) 可选：命中 re-insert 转真 LRU，或在注释中明确 FIFO 是有意为之。

验证：grep 无其他引用旧默认值；b 若做则补淘汰顺序单测。

风险：极低。

### 4.3 EmbeddedRuntimeController.journalSubscriptions 疑似残留【存疑，需运行时确认】

证据（静态）：`ensureJournalSubscription`（`EmbeddedRuntimeController.ts:620-650`）在订阅回调 `append().finally` 中仅当 `normalized.type === "complete"` 时才 `cleanup()` 并 `journalSubscriptions.delete(process.id)`（:642-647，登记在 :649）。进程 crash / kill / abort 而不产生 complete 事件时，订阅清理不执行、map 条目残留，回调闭包持有 `process` 引用，疑似阻止 Process GC。supervisor 在 crash 路径是否另行释放 Process 及其 subscribers 静态审查未完全排除，标注存疑。

确认方法：a) 起内嵌 runtime 会话后 kill 子进程，heap snapshot 检查 Process 实例是否经 journalSubscriptions 链保持；b) 测试环境连续 crash N 个进程后断言 `journalSubscriptions.size` 回落。

修法（确认后）：supervisor 的 process exit/crash 回调里统一兜底清理，或订阅时同时挂 exit 监听，不依赖 complete 事件类型。

验证：上述 size 断言 + heap snapshot 复测。

风险：低；与《2026-08-13-codex-event-journal-memory-plan.md》的 journal 内存治理联动，避免重复改动。

### 4.4 桌面端直播 session 消息数组无界【中低】

证据：active-window 前缀裁剪（`useSessionMessages.ts:760-787`，`planActiveMessageWindowTrim`）只在移动端壳启用——`activeWindowTrimEnabledRef` 由 `isMobileShellDocument()` 门控（:448-450）；阈值 `ACTIVE_WINDOW_TRIGGER_MESSAGES = 100 + 50 = 150`（:161-163）。桌面 web 直播会话可小时级持续 append，`messages` 数组无界增长。

修法：a) 桌面端启用同一裁剪，阈值放宽（如 500）与移动端对齐；b) 或只设软上限（超阈值提示、不裁剪）。注意与《2026-08-13-session-switching-performance-plan.md》的客户端缓存设计呼应：若该方案引入跨会话消息缓存层，裁剪窗口应落在缓存层而非 hook 内，避免两处各剪一次——实施前先读该文档定稿。

验证：桌面 web 直播灌入 200+ 消息后内存与渲染行数稳定；向上翻页不受影响（裁剪仅在跟随底部时触发）。

风险：中；改变桌面端现有行为，阈值要保守并可关。

### 4.5 SessionContentIndex 落盘文本副本随历史无界【低】

证据：内容索引把每个 session 的 user/assistant 消息文本全文落盘（`CachedSessionContent.messages`，`SessionContentIndexService.ts:42-58`），默认存 `~/.yep-anywhere/indexes/content/`（:135）；仅在 session 文件消失时剔除（:553-559「Drop sessions whose files disappeared」），无容量上限——索引体积随全部历史会话文本增长。

修法：a)（推荐）容量水位：单 scope 或全局超阈值（默认如 200MB 可配）按 `updatedAt` 从旧到新淘汰整 session 条目，淘汰后该 session 搜索退化为实时解析；b) 或按年龄淘汰（如只索引近 90 天）。a 行为更可预测。

验证：构造超水位索引目录，淘汰后总大小回落；被淘汰 session 搜索仍可用（走 fallback）。

风险：低；老 session 搜索变慢属语义变化，需在变更说明中写明。

## 5. 实施顺序建议

每项独立成 PR，建议按风险与依赖分批：

1. 第一批（零风险注释/文档，当天可落）：4.2a、4.1a、3.8b、3.7b。
2. 第二批（纯服务端小修，单测直给）：3.1（先行，3.3b 依赖它）、3.6a 原子写、3.2。
3. 第三批（有行为变化，需手动验证）：3.3、3.6b reconcile、4.5。
4. 第四批（依赖决策或其他方案）：3.4 与 3.5（产品口径决策）、4.3（先运行时确认）、4.4（等切换性能方案定稿）、3.7a（视真实案例）。

回滚：每项单独 commit/PR 即可整体回退；3.3 与 4.4 建议带开关或保守默认值。

## 6. 待确认问题

1. 3.4 stats 口径：`unreadCount` 分层（近 N 天活跃）还是维持全量？N 取值？（产品决策）
2. 3.5 `needsReview`：接线进 badgeCount（落地 InboxContext 注释宣称的行为）还是删除死状态？（产品决策）
3. 4.3 `journalSubscriptions`：crash/abort 路径是否真有 Process 滞留——先按 4.3 的确认方法做 heap snapshot / size 断言，再定修法。
4. 4.4 与《session-switching-performance》方案：桌面端裁剪在 hook 层做还是由该方案的缓存层统一做？
5. 3.7 远程 executor 时钟偏移是否已在真实部署中出现（日志/用户反馈）？决定做钳制还是仅文档。
