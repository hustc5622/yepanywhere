# Push 通知重启重放与去重状态丢失修复方案

> 状态：方案待评审（2026-08-13）。审查结论来自静态代码分析，运行时行为待按「验证」节实测。
>
> 日期：2026-08-13
>
> 关联文档：docs/push-notifications.md、docs/project/2026-08-13-unread-state-consistency-fixes-plan.md

## 1. 结论

2026-08-13 对 Push 通知层做了一轮静态代码审查（未做运行时验证），确认 6 个问题，根因只有两类：

1. **PushNotifier 的去重状态全部在内存**（`sessionsWithNotification`、`sessionInputState`、`sessionsWithHaltedNotification`，PushNotifier.ts:106-127），web/API 进程重启即清零。而 external 模式（8022 生产部署的常态，`scripts/dev-8022.js:814` 设 `YEP_RUNTIME_MODE: "external"`）启动时会对 runtime 侧所有驻留进程**无差别重放** `process-state-changed`（`packages/server/src/index.ts:946-982`），PushNotifier 把这些快照当成本进程内发生的真实状态转移，于是重发推送、重写 badge。
2. **`idle` 语义过载**：自然完成、用户手动 abort、embedded shutdown 三条路径最终都汇到 `unregisterProcess` 末尾的 `emitAgentActivityChange(..., "idle")`（`packages/server/src/supervisor/Supervisor.ts:1500`），PushNotifier 一律翻译成 `session-halted / completed`（PushNotifier.ts:218-219），web 端展示为 "Task completed"（`packages/client/public/sw.js:367`）。「用户主动停止」被误报为「任务完成」。

另有 1 个与重启无关的确认 bug：web service worker 的 dismiss 只按 `session-<id>` 取通知，清不掉 tag 为 `session-halted-<id>` 的 halted 通知（sw.js:263-265 vs sw.js:375）；Android 端两个 tag 都会 cancel，不受影响。

推荐组合拳：**B（启动快照打标记，快照不产生用户可见副作用）作为 P0 主修**，覆盖问题 1、2、3 的重启/停止向量；**A（去重状态持久化进 notifications.json）作为 P1 纵深**，覆盖问题 2 的"已清除通知复活"与问题 5。问题 4 是一个一行修复的独立 P0。问题 6 建议保持现状、以文档说明。

## 2. 背景与现状

### 2.1 通知触发链路

`packages/server/src/push/PushNotifier.ts` 订阅 EventBus（PushNotifier.ts:142-178）。监听 6 类事件，其中 3 类驱动通知收发，另 3 类（`session-created`、`session-updated`、`session-metadata-changed`）仅做标题缓存。驱动通知的行为：

| 事件 | 行为 | 代码位置 |
| --- | --- | --- |
| `process-state-changed` + `waiting-input` | 发送审批/问题推送（带 requestId 去重） | PushNotifier.ts:241-351 |
| `process-state-changed` + `idle` | `sendSessionHalted(event, "completed")` | PushNotifier.ts:218-219 |
| `process-state-changed` + 其他态 | 离开 waiting-input → 条件 dismiss；`in-turn` → 清 halted 去重并 `clearSessionNeedsReview` | PushNotifier.ts:193-217 |
| `process-terminated` | `sendSessionHalted(event, "error")` | PushNotifier.ts:417-421 |
| `session-seen` | 清全部内存去重状态 + dismiss | PushNotifier.ts:423-433 |

发送双通道：`PushService.sendToAll`（web-push）+ `NativePushService.sendToAll`（FCM），并排除当前有 WS 连接的 browserProfileId（PushNotifier.ts:307-310、365-371）。

### 2.2 前台抑制与设备端去重

- 前台两层抑制：服务端连接排除（同上）+ service worker 的 focused window 抑制（sw.js:290-313）。
- 通知 tag：审批 `session-<id>`（sw.js:343），halted `session-halted-<id>`（sw.js:375）。FCM `collapse_key` 对所有带 sessionId 的 payload 一律为 `session-<id>`（NativePushService.ts:485-491），TTL：pending-input 3600s、session-halted 600s（NativePushService.ts:478-480）。
- Android 端：pending-input 通知 `ongoing = true` 且 `setOnlyAlertOnce(ongoing)`（YepNativeNotifier.kt:97、331），同 tag 重贴**不会**二次发声；session-halted 通知 `ongoing = false`（YepNativeNotifier.kt:182），重贴会再次发声/复活。Android 另有 15s 轮询 + `cancelMissing` 兜底清理服务端已不可见的通知（YepSessionWatcher.kt:301、179-187）；web 端无此兜底。
- dismiss 出口只有两个：(a) 本进程 `sessionsWithNotification` 中有记录时离开 waiting-input（PushNotifier.ts:197-206）；(b) `session-seen`（PushNotifier.ts:423-433）。

### 2.3 已读与 badge 持久化

已读（`lastSeen`）与 badge（`needsReview`）持久化在 `~/.yep-anywhere/notifications.json`（NotificationService.ts:56-62），schema `version: 2`（NotificationService.ts:29-38），重启不丢；写入为合并式 `writeFile`（非 tmp+rename，NotificationService.ts:341-349）。`markSessionNeedsReview` 有 timestamp 单调去重（NotificationService.ts:186-189），但对启动重放无效——重放事件带的是重启时刻的新 timestamp（index.ts:980）。`hasUnread` 对 never-seen session 返回 `true`（NotificationService.ts:237-244）；未读进入 inbox 的 `unread8h`/`unread24h` 层（packages/server/src/routes/inbox.ts:461-483）。正常清读路径：`useEngagementTracking` 页面可见即 markSeen（packages/client/src/hooks/useEngagementTracking.ts:78-106）与 `/api/recents/visit` 顺带 markSeen（packages/server/src/routes/recents.ts:149-150）。

### 2.4 启动重放与 shutdown 路径

- external 模式启动时，`createApp` 对 runtime 驻留进程逐一 emit `session-status-changed` 与 `process-state-changed`（`activity` 取进程当前状态快照，index.ts:957-982）。
- shutdown：`index.ts:182-185` 以 `abortActive = (mode === "embedded")` 调 `runtimeController.shutdown({ abortActive })`；embedded 侧 `EmbeddedRuntimeController.shutdown` 在 `abortActive` 时调 `supervisor.shutdown()`（EmbeddedRuntimeController.ts:97-103），后者 abort 全部进程（Supervisor.ts:2013-2026）。
- abort 路径：`abortProcess` 先 emit `session-aborted`（Supervisor.ts:1182-1184、1224-1234），再 `process.abort()` + `unregisterProcess`（Supervisor.ts:1186-1187）；`unregisterProcess` 末尾固定 emit `idle`（Supervisor.ts:1500）。`process.terminationReason` 已被记录进 terminatedInfo（Supervisor.ts:1476-1479），但未随 state 事件外发。
- 空闲超时默认 5 分钟（config.ts:448，`IDLE_TIMEOUT`）。

## 3. 问题清单

### 3.1 【中】external 重启重放 idle → 假 "Task completed"

- **触发场景**：8022 每次部署/cutover 都会重启 web/API 进程。若某 session 在重启窗口内处于 `idle`（自然完成后、进程被回收前，最长约 5 分钟），重放使：(a) `sessionsWithHaltedNotification`（PushNotifier.ts:127）为空 → 去重失效 → 重发 "Task completed" 推送；(b) `markSessionNeedsReview`（PushNotifier.ts:470）以新 timestamp 重写 badge，即使用户已看过该 session（markSeen 已清），badge 复活。
- **证据**：重放循环 index.ts:957-982；idle→completed 翻译 PushNotifier.ts:218-219；去重检查 PushNotifier.ts:442-444；timestamp 去重被新时间戳绕过（NotificationService.ts:186-189 vs index.ts:980）。
- **确信度**：高（静态证据链完整）。补充：Android 端 halted 通知 `onlyAlertOnce=false`（YepNativeNotifier.kt:182），重发会再次发声，比 web 端更显眼。

### 3.2 【中低】重启重放 waiting-input → 审批推送重发

- **触发场景**：session 停在审批上时 web/API 重启，重放 `waiting-input`。`sessionInputState`（PushNotifier.ts:122-126）纯内存 → requestId 去重失效 → 重新 `sendToAll`。
- **缓释**：web SW 同 tag 静默替换（sw.js:343）；Android pending-input `onlyAlertOnce=true`，不二次发声。**残留影响**：用户已手动清除的通知会复活；无害但烦人。
- **证据**：重放 index.ts:957-982；requestId 去重 PushNotifier.ts:272-275。
- **确信度**：高。

### 3.3 【中】embedded shutdown / 手动 abort → 假 "Task completed"

- **触发场景**：(a) embedded 模式进程收到 SIGTERM → `abortActive: true`（index.ts:183）→ `supervisor.shutdown()` abort 全部进程（Supervisor.ts:2013-2026）→ 每个进程走 `unregisterProcess` 尾部 `idle`（Supervisor.ts:1500）→ 全部按 completed 推送。(b) 用户在 UI 手动 abort 一个进行中的 session → 同一 `abortProcess` → `unregisterProcess` 路径（Supervisor.ts:1186-1187）→ "Task completed" 误报。
- **证据**：`emitAgentActivityChange` 产出 `process-state-changed`（Supervisor.ts:1660-1672）；idle 事件本身不区分自然完成与 abort。
- **确信度**：高。注意 aborted 事件先于 idle 发出（Supervisor.ts:1184 vs 1500），这为修复提供了抓手。

### 3.4 【低】web SW dismiss 清不掉 halted 通知（确认 bug）

- **触发场景**：web 端收到 "Task completed" 后，任何 dismiss（session-seen 或离开 waiting-input）都无法关闭它，只能在系统通知中心手动滑掉；Android 不受影响。
- **证据**：dismiss 只按 `session-<id>` 取通知（sw.js:263-265），halted tag 是 `session-halted-<id>`（sw.js:375）；Android `cancelSession` 两个 tag 都 cancel（YepNativeNotifier.kt:246-249）。
- **确信度**：确认（键名直接对照）。

### 3.5 【低】embedded 重启 / 异常退出后审批通知残留无 dismiss

- **触发场景**：进程 A 发过审批推送后进程被杀或重启；审批在新进程内被处理（web UI/TUI），状态离开 waiting-input。新进程 `sessionsWithNotification` 为空 → PushNotifier.ts:197-206 的条件不成立 → 不发 dismiss。用户也没打开过该 session 时无 `session-seen` → 通知永久残留。
- **缓释**：Android 15s 轮询 `cancelMissing` 兜底（YepSessionWatcher.kt:179-187）；web 端无兜底。
- **证据**：dismiss 的两个出口见 §2.2。
- **确信度**：高（逻辑推导，未实测复现）。

### 3.6 【低】新 session 创建后未打开页面会长期挂未读

- **触发场景**：创建路径（POST `/projects/:projectId/sessions`，sessions.ts:1708；`/sessions/create`，sessions.ts:1725）无服务端 markSeen；`api.startSession` 成功后、`SessionPage` 的 `useEngagementTracking` 生效前用户离开（关 tab/断网）→ 该 session 因 never-seen 永远 `hasUnread=true`，在 inbox unread8h/24h 层最长挂 24h（inbox.ts:461-483）。
- **证据**：`hasUnread` never-seen → true（NotificationService.ts:237-244）；markSeen 只有独立路由（sessions.ts:1907-1921）、recents visit（recents.ts:149-150）与 engagement hook 三个入口。
- **确信度**：高（行为属实）；但这是产品语义取舍（"新建没看过"本来就是未读），不一定是 bug。

## 4. 目标与非目标

### 目标

- 任何形式的 web/API 重启/部署都不产生**无对应真实状态转移**的用户可见副作用（推送、badge、needsReview）。
- 保持审批推送的可达性：宁可因设备端 tag 替换静默重贴，不可漏发审批。
- 修复问题 4 的确认 bug；问题 3 消除 "Task completed" 误报。
- 改动最小、分级可独立回滚；单测可覆盖的部分全部进单测。

### 非目标

- 不重构通知层、不调整 inbox 分层与已读模型；不改 `NotificationService` 跨设备单 scope 语义。
- 不改 Android 端任何代码；不加新的界面 locale 文案（复用现有 "Task stopped" 等英文串）。
- 不做 web 端残留通知的周期兜底（问题 5 的非优雅 kill 变体，记为已知边界）。
- 不处理 notifications.json 写入的 crash-atomicity（现状即非原子，维持一致）。
- 不支持多 web/API 实例并发写 notifications.json。

## 5. 方案设计

### 5.1 P0-1：sw.js dismiss 双 tag（问题 4）

`packages/client/public/sw.js` 的 dismiss 分支（sw.js:262-270）同时取 `session-${sessionId}` 与 `session-halted-${sessionId}` 两个 tag 再逐个 `close()`。一行级改动，与 Android `cancelSession` 行为对齐。无服务端依赖。

### 5.2 P0-2：启动快照打标记，快照不产生用户可见副作用（问题 1 主修，问题 2 部分）

机制：给 `ProcessStateEvent` 增加可选字段 `replay?: boolean`（`packages/server/src/watcher/EventBus.ts`），`index.ts:970-981` 的启动快照 emit 时带 `replay: true`；运行时产生的真实转移不带该字段（undefined=falsy，向后兼容所有现有消费者）。

`PushNotifier.handleProcessStateChange`（PushNotifier.ts:186-222）在 `event.replay === true` 时进入快照分支，语义为「对齐内存状态，不产生外部副作用」：

- 快照 `waiting-input`：**照常走现有发送流程**。理由：审批可达性优先——若原推送在首次发送时失败或进程当时已死，重放是唯一的补发机会；设备端靠同 tag 静默替换 + Android `onlyAlertOnce` 消化重贴（问题 2 的"已清除通知复活"由 5.4 持久化解决，P0 阶段维持现状）。
- 快照 `idle`：只做 `sessionsWithHaltedNotification.add(sessionId)` 登记，**不发送推送、不写 `markSessionNeedsReview`**（跳过 PushNotifier.ts:218-219 的效果）。若该 session 之后真实进入新 turn，`in-turn` 转移（PushNotifier.ts:209）会清掉登记，下一次真实完成照常通知。
- 快照 `in-turn` 等其他态：对齐内存（删除 `sessionInputState`、清 halted 登记），但**跳过 `clearSessionNeedsReview`**——快照不是"用户开始新一轮工作"的证据，不应抹掉尚未查看的 badge；也跳过 dismiss（本进程未发过通知，与现有 `sessionsWithNotification` 条件语义一致）。

改动文件：`packages/server/src/watcher/EventBus.ts`（类型）、`packages/server/src/index.ts:970-981`（打标）、`packages/server/src/push/PushNotifier.ts`（快照分支）。

### 5.3 P0-3：以 `session-aborted` 事件抑制假 completed（问题 3）

利用现有时序：`abortProcess` 先 emit `session-aborted`（Supervisor.ts:1184），`unregisterProcess` 的尾部 `idle` 必在其后（Supervisor.ts:1500）。PushNotifier 订阅 `session-aborted`（订阅点在 PushNotifier.ts:142-178 的 switch 中新增分支），处理为 `sessionsWithHaltedNotification.add(sessionId)`——随后的 idle 转入 `sendSessionHalted` 时撞上去重检查（PushNotifier.ts:442）被跳过。

效果：embedded shutdown（每个进程都走 `abortProcess`）与手动 abort 都不再产生 "Task completed"；同时不写 needsReview（dismiss 语义：abort 是用户在场行为，不需要事后 review）。该登记在下一次 `in-turn`/`waiting-input`/`session-seen` 时被正常清除，无状态泄漏。

不改 EventBus schema、不改 Supervisor，只动 PushNotifier。备选（不推荐）：给 `ProcessStateEvent` 加 `terminationReason`，侵入面更大，见 §6。

### 5.4 P1：去重状态持久化进 notifications.json（问题 1 纵深、问题 2、问题 5）

路线 A。`NotificationState` 增加 `pushState` 节，schema v2 → v3（沿用 initialize 的版本分支与默认填充模式，NotificationService.ts:84-99）：

```ts
pushState: {
  // sessionId -> 已送达的 pending-input requestId（对齐 sessionInputState 的 delivered 态）
  inputDelivered: Record<string, string>;
  // 已发过 session-halted 推送的 sessionId（对齐 sessionsWithHaltedNotification）
  haltedNotified: string[];
}
```

- **写入点**（与内存状态同步）：delivered 晋升（PushNotifier.ts:333-337）、halted 登记（PushNotifier.ts:477）。
- **清除点**（与内存删除一一对应）：离开 waiting-input（PushNotifier.ts:196）、send 失败回滚（PushNotifier.ts:348）、`in-turn`/`waiting-input` 清 halted（PushNotifier.ts:209、224）、`session-seen`（PushNotifier.ts:428-430）。复用现有合并式 `save()`，不新增写盘路径。
- **启动 hydrate**：PushNotifier 初始化时（或首次事件前）从 NotificationService 读入：`inputDelivered` → `sessionInputState` 置 `delivered` 态 + `sessionsWithNotification` 置 `true`；`haltedNotified` → 灌入 `sessionsWithHaltedNotification`。
- **有界性**：正常流转在上述清除点收敛；为防异常残留导致文件单调增长，hydrate 时丢弃不存在于当前项目/session 索引的条目（或按写入时间修剪 7 天前条目，实现时二选一，倾向后者：无跨服务依赖）。

修复效果：问题 2——重启后重放 waiting-input 撞 `delivered` requestId 直接跳过（PushNotifier.ts:272-275 现有逻辑），已清除的通知不再复活；问题 5——hydrate 后 `sessionsWithNotification` 有记录，审批在新进程内被处理时 dismiss 正常发出；问题 1——即使 5.2 的标记缺失（如未来新增事件源），halted 去重跨重启依然命中，纵深防御。

### 5.5 P2：问题 6 保持现状 + 文档说明

不建议服务端在创建路径 markSeen：`NotificationService` 是跨设备单 scope，创建即 markSeen 会让**所有设备**都看不到新 session 的未读，破坏"其他设备应看到新内容"的语义。客户端侧补 markSeen 有同样问题。结论：维持 `hasUnread(never-seen)=true`，在 `docs/push-notifications.md` 增补一段说明该语义与 24h 自然消退窗口；若未来有用户反馈困扰，再在 unread 一致性工作中统一处理（见 §10）。

## 6. 不推荐的方案

- **只靠客户端同 tag 替换/onlyAlertOnce 掩盖重放**：解决不了 `needsReview` badge 复活，根因在服务端。
- **重放一律不发送（含 waiting-input）**：若原推送首次发送失败或服务端正巧不在线，审批将永久失去推送入口，可达性损失大于"通知复活"的烦恼。与 5.2 的取舍配套评审。
- **为去重启用独立存储或复用 RuntimeEventStore journal**：notifications.json 已有版本迁移、合并写、测试基建；新存储引入额外一致性面，embedded 模式还要另找落点。
- **时间窗启发式（如重启后 N 秒内的事件不通知）**：时钟与事件延迟不可控，会误杀窗口内的真实转移；打标/schema 是显式语义，优于猜测。
- **`ProcessStateEvent` 加 `terminationReason` 字段区分 idle 来源**（问题 3 的备选）：要改 EventBus 类型、`emitAgentActivityChange` 签名（Supervisor.ts:1660-1665）与所有 emit 点，还要处理 external 模式事件的跨进程传播；`session-aborted` 时序方案零 schema 改动即可覆盖。
- **问题 6 创建即 markSeen**：见 5.5，跨设备副作用错误。

## 7. 实施顺序

每阶段独立可落地、独立可回滚：

1. **阶段 A：P0-1**（sw.js 双 tag）。无依赖，先行；随下次客户端构建生效。
2. **阶段 B：P0-2 + P0-3**（replay 标记与 `session-aborted` 抑制）。同源改动（都在 PushNotifier 事件处理层），一并进一次部署，立刻消除问题 1/3 的用户可见症状。
3. **阶段 C：P1 持久化**（notifications.json v3 + hydrate）。依赖阶段 B 的快照语义稳定后叠加，避免两层逻辑同时排障。
4. **阶段 D：文档**（docs/push-notifications.md 增补问题 6 说明与本方案行为变更），同步 CHANGELOG `[Unreleased]`。

## 8. 测试与验证

### 8.1 单测方向

- `packages/server/test/push/PushNotifier.test.ts`（已有，增补用例）：
  - replay idle：不发推送、不写 needsReview、`sessionsWithHaltedNotification` 已登记；随后真实 in-turn→idle 正常发。
  - replay waiting-input：走发送流程并登记 dedupe。
  - `session-aborted` 后 idle：不发 "Task completed"；下一轮 in-turn 后恢复正常。
  - hydrate 后：重放 waiting-input 撞 delivered requestId 被跳过；离开 waiting-input 时 dismiss 发出。
- `packages/server/test/notifications/service.test.ts`（已有，增补用例）：v3 迁移默认填充、`pushState` 读写与清除点、v3 文件被 v2 代码读取时不丢 `lastSeen`/`needsReview`。

### 8.2 8022 实测（需用户配合执行）

未经用户授权不得重启 8022 服务；以下步骤均需用户在方便时执行 `scripts/deploy.sh --server-only` 或授权部署：

1. **部署空转检查（验问题 1）**：部署含阶段 B 的构建前，确保无 session 处于 idle 窗口外的活动态；部署后 10 分钟内检查 `/private/tmp/yep-server.log` 无 `[PushNotifier] Sent session-halted notification`；`cat ~/.yep-anywhere/notifications.json | jq .needsReview` 无已读 session 复活。
2. **审批驻留重启（验问题 2/5）**：让一个 session 停在工具审批上 → 部署 cutover → 期望：Android/web 不重复响铃（阶段 C 后）；在 web 上处理审批 → 各端通知被 dismiss。
3. **手动 abort（验问题 3）**：对一个 in-turn session 点 abort → 无 "Task completed" 推送、设备无 halted 通知。
4. **halted dismiss（验问题 4）**：制造一条 "Task completed" 通知 → 打开该 session → web 端通知被关闭（可用 DevTools → Application → Service Workers 观察或直接在系统通知中心确认）。
5. **回归**：`pnpm lint && pnpm typecheck && pnpm test`。

## 9. 回滚

- 各阶段独立：`replay` 字段为纯增量可选字段，回滚即删除 PushNotifier 快照分支与 index.ts 打标；现有消费者不受影响。
- notifications.json v3 回滚：旧代码读取时按已知键重建 state（NotificationService.ts:85-99），`pushState` 被静默丢弃、`lastSeen`/`needsReview` 保留，行为退化为本方案前现状，无崩溃风险。版本号保持 v3 不回退，防再次升级时误判。
- sw.js 改动经标准 service worker 更新流程生效，旧缓存客户端延迟更新无害（只是暂不享受问题 4 修复）。
- 若阶段 B/C 上线后出现审批漏发投诉：临时恢复手段为回退 PushNotifier 快照分支（waiting-input 快照即恢复重发），可达性立即回到现状水平。

## 10. 待确认问题

1. 5.2 中快照 `waiting-input` 选择"重发保可达"是否符合产品预期？备选是不发（靠 15s Android 轮询补崩），web 端在「首次发送失败 + 重启」交集下漏审批。
2. 问题 3 修复后，手动 abort 要完全静默（本文推荐），还是发 `reason: "idle"` 的 "Task stopped"（sw.js:369 已有文案）？
3. external 模式下 `session-aborted` 是否经 runtime 侧事件通道传播到 web/API 的 EventBus？embedded 路径已静态确认（Supervisor.ts:1224-1234），external 传播实现时需探测；若不传播，问题 3 的 external 变体需另行处理。
4. 问题 5 的非优雅 kill 变体：web 端残留通知接受现状，还是值得加一个轻量兜底（如 pushsubscriptionchange 时机清理）？
5. 问题 6 是否确认保持现状？该语义与 docs/project/2026-08-13-unread-state-consistency-fixes-plan.md 的未读口径需对齐，避免两份文档给出相反结论。
