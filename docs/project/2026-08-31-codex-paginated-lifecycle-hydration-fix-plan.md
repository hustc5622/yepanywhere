# Codex Paginated Lifecycle Hydration 警告修复计划

> 日期：2026-08-31
> 状态：已实施（长 session 多轮性能采样仍独立保留）
> 优先级：P0 协议兼容 / 长会话恢复性能
> 适用范围：Codex / Codex OSS provider 的 `thread/resume`、`thread/fork`、`turn/steer` fallback
> 独立性：本文档是针对当前警告的专项修复计划，不并入 Session Outline 大计划
> 上游事实来源：`references/codex` 已于 2026-08-31 从 `c30a3e49c` fast-forward 到官方
> `openai/codex` `a9519cbcd`

## 0. 结论

截图中的提示：

```text
Full-history hydration is deprecated for paginated threads; use
`excludeTurns: true`, then page with `thread/turns/list` and
`thread/items/list`.
```

不是 agent turn 失败，而是 Codex app-server 对旧 lifecycle 调用方式发出的
`deprecationNotice`。

上游在提交 `d132b692199c53c085c7b2cbec3c44e2dc5cf277`（2026-08-25，
`Deprecate full-history hydration for paginated threads (#40676)`）中明确做了三件事：

1. paginated `thread/resume` 未传 `excludeTurns: true` 时发弃用通知；
2. paginated `thread/fork` 未传 `excludeTurns: true` 时发弃用通知；
3. paginated `thread/read(includeTurns: true)` 时发弃用通知。

Yep 当前正好仍有上述三类调用：

| 路径 | 当前行为 | 结果 |
| --- | --- | --- |
| 普通恢复 | `thread/resume` 不传 `excludeTurns` | paginated thread 全历史 hydration + 截图警告 |
| 编辑/fork | 依赖 resume 返回的完整 `thread.turns`，fork 也不传 `excludeTurns` | 两次 lifecycle 都可能 hydration |
| steer fallback | `thread/read(includeTurns: true)` | paginated thread 再次 hydration + read 专用警告 |

修复原则：

> **消除产生警告的旧请求，而不是只在 UI 隐藏警告。正常 resume 不加载历史；edit/fork 只分页读取计算
> boundary 所需的 turns；steer fallback 只读取最新 turn。完整历史继续由既有 history reader 分页读取。**

完成后，用户在长 session 中继续提问时不再触发 full-history hydration，也不再看到这条开发者协议警告。

### 0.1 实际实施结果

实施时对照当前 Yep 与 `references/codex` 源码后，对原计划做了三处有意调整：

1. bridge active-turn rejoin 不再采用“resume 后单独 `thread/turns/list`”。paginated list 只读 durable
   store，可能漏掉尚未持久化的 live turn；实际改为在同一个 `thread/resume` 中请求
   `initialTurnsPage(limit=1, desc, notLoaded)`，由 app-server 原子合并内存 active turn。
2. edit/fork 同样用 resume 的 `initialTurnsPage` 启动 boundary window；只有窗口不足时才沿
   `nextCursor` 调 `thread/turns/list`，因此常见的排除 1/N turns 只需一次 lifecycle round trip。
3. steer 的 completed-before-steer fallback 不再读取 latest turn page。当前上游会精确返回
   `no active turn to steer`；Yep 只在该错误下执行 `thread/read(includeTurns=false)`，并且只有 runtime
   status 为 `idle` 才启动新 turn，其他状态全部 fail closed。

`initialTurnsPage` 与 turns paging 受 `experimentalApi` capability 保护。Yep 只在 bridge rejoin 或
edit/fork 的 app-server 连接上声明 `{ experimentalApi: true }`；普通新会话和普通 stdio resume 继续使用
`capabilities: null`，对外实验控制能力保持关闭。

新增 disposable 真实 CLI smoke 使用隔离 `CODEX_HOME`，先通过无模型的 `thread/shellCommand("pwd")`
materialize paginated fixture，再用第二个 0.151 app-server 进程执行 cold metadata-only resume/fork。结果为：

```text
historyMode=paginated
resumeTurns=0
initialPageTurns=1
forkTurns=0
deprecationNotices=0
```

后续按用户决定将 checked baseline 同步到 `0.151.0`，并新增 CLI 版本变化后的自动 sync；只读 drift check
现已通过。尚未执行同一长 session 的 5 次 cold/warm RSS、response bytes 与首事件性能采样，该项不影响
本次协议正确性修复，但仍保留为后续性能验收工作。

---

## 1. 上游源码证据

### 1.1 弃用提交

更新后的 `references/codex` 中，`d132b6921` 的提交说明是：

```text
Why

Paginated thread history should be loaded incrementally through
thread/turns/list and thread/items/list instead of being fully reconstructed
in thread.turns.

What changed

- Emit deprecationNotice when thread/read, thread/resume, or thread/fork
  requests full history for a paginated thread.
- Direct clients to omit includeTurns for reads or use excludeTurns: true for
  resumes and forks, then page history through the list APIs.
```

直接源码位置：

- `references/codex/codex-rs/app-server/src/request_processors/thread_processor.rs`
  - `PAGINATED_FULL_HISTORY_DEPRECATION_SUMMARY`
  - `PAGINATED_THREAD_READ_DEPRECATION_SUMMARY`
  - cold/loaded resume、fork、read 的通知触发条件
- `references/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs`
  - `ThreadResumeParams.exclude_turns`
  - `ThreadForkParams.exclude_turns`
  - `ThreadReadParams.include_turns`
- `references/codex/codex-rs/app-server/README.md`
  - Resume threads
  - Fork threads
  - Read thread

### 1.2 新协议的关键语义

`excludeTurns: true` 只控制 response hydration：

- `thread.turns` 不再携带重建后的完整历史；
- model context、继承前缀和 provider 内部 session 状态不被删除；
- resume response 会为 paginated durable history 返回
  `turnsBackwardsCursor/itemsBackwardsCursor`；
- 客户端按需请求 `thread/turns/list` 和 `thread/items/list`；
- live 新事件仍通过通知到达。

上游 fork 测试明确断言：`excludeTurns` 只控制 response hydration，不改变 fork 继承的历史前缀。

### 1.3 Codex TUI 的参考实现

新版 Codex TUI 已采用下面的策略：

1. 对支持 paginated history 的 resume 设置 `excludeTurns=true`；
2. 使用 response 的 backwards cursor 请求最近 turns/items；
3. 只 hydrate 一个有界初始窗口；
4. 对 legacy history 才允许 `thread/read(includeTurns=true)`；
5. 对不支持 paging/excludeTurns 的旧 app-server 执行一次兼容 fallback；
6. fork 对 paginated source 同样设置 `excludeTurns=true`，之后做 bounded hydration。

参考实现：

- `references/codex/codex-rs/tui/src/app_server_session/rollout_history.rs`
- `references/codex/codex-rs/tui/src/app_server_session/history.rs`
- `references/codex/codex-rs/tui/src/app_server_session.rs`

Yep 不需要复制 TUI 的完整 UI hydration；只复用它的协议选择与兼容思路。

---

## 2. Yep 当前根因

### 2.1 普通 resume 默认请求完整历史

当前 `packages/server/src/sdk/providers/codex.ts` 构造：

```ts
const threadResumeParams: ThreadResumeParams = {
  threadId,
  model,
  modelProvider,
  cwd,
  approvalPolicy,
  sandbox,
  config,
};
```

没有 `excludeTurns`。协议默认值为 false，因此 app-server 必须保留旧客户端语义并 materialize
`thread.turns`。当 source `historyMode=paginated` 时，上游同时发出截图中的 deprecation notice。

这条路径在“历史 session 已经没有 Yep-owned process，用户再次发消息”时最常见：Yep 启动/连接
app-server、resume thread，然后启动新 turn。

### 2.2 edit/fork 依赖完整 `thread.turns`

当前历史编辑逻辑：

1. 先 `thread/resume`；
2. 从 `threadResult.thread.turns` 读取完整 source turns；
3. 用 `rollbackNumTurns` 计算 `retainedTurnCount`；
4. 取 `lastTurnId`；
5. 调 `thread/fork`。

所以不能只机械地给 resume 加 `excludeTurns=true`：那会让 `thread.turns=[]`，随后 fork boundary 计算
失败。

正确改法是用 `thread/turns/list` 只读取 boundary 所需的尾部 turns。

### 2.3 bridge active turn rejoin 依赖完整 turns

当前 bridge WebSocket rejoin 会从：

```ts
findLastInProgressCodexTurnId(threadResult.thread.turns)
```

恢复 active turn ID，随后通过 `turn/steer` 给现有 turn 追加输入。

使用 `excludeTurns=true` 后，这里也不能继续读取 `thread.turns`；必须只请求最新 turn 或从更直接的
bridge/runtime 状态获取 active turn ID。

首版建议请求 `thread/turns/list(limit=1, sortDirection=desc, itemsView=notLoaded)`，不扩展 bridge
公开协议。

### 2.4 steer fallback 再次读取完整历史

当 `turn/steer` 返回兼容性的 `-32602` 时，当前代码调用：

```ts
thread/read({ threadId, includeTurns: true })
```

只为判断最新 turn 是否仍然 `inProgress`，却要求 app-server 重建整个历史。对 paginated thread，这会
触发 read 专用 deprecation notice。

正确做法是优先 `thread/turns/list(limit=1, desc)`；只有 paging 不可用且 metadata 表明是 legacy
history 时，才允许 fallback 到 `thread/read(includeTurns=true)`。

### 2.5 deprecationNotice 被作为用户消息显示

当前 `warning`、`guardianWarning`、`deprecationNotice`、`configWarning` 共用一个 projection 分支，全部
转换为：

```ts
{
  type: "system",
  subtype: "warning",
  content: summary,
}
```

客户端会把 system warning 渲染进 transcript，所以协议迁移提示泄漏到产品界面。

请求修复是主修复；同时应做防御性分流：非用户可处理的 `deprecationNotice` 写入本地 diagnostics/log，
不进入 session transcript。`warning` 和 `guardianWarning` 保持现有用户可见语义；`configWarning` 不在
本次扩大处理范围。

---

## 3. 版本与协议边界

### 3.1 当前版本事实

- 本机实际 Codex：`codex-cli 0.151.0`。
- Yep checked-in protocol baseline：`0.151.0`。
- `package.json.yepAnywhere.codexCli.expectedVersion`：`0.151.0`。
- 更新后的 `references/codex`：官方 main `a9519cbcd`。
- 弃用通知引入提交：`d132b6921`，晚于旧 reference commit。

### 3.2 协议基线升级与自动同步

修复初始实现没有强绑 `0.147.0 -> 0.151.0`，因为 lifecycle 字段已存在于旧 experimental superset，
而完整升级需要独立 coverage 审计。后续用户明确决定让 baseline 随本机 CLI 升级自动同步，因此最终实现为：

- baseline 已同步到 `0.151.0`；
- `codex:protocol:sync` 在版本未变化时快速退出，变化时重生成 artifacts 并自动更新 `expectedVersion`；
- `pnpm dev`、`dev:8022`、`dev:8022:replace`、`dev:auto`、`staging` 启动前自动 sync；
- 新增未分类 server-facing capability 时，sync 在写文件前 fail closed，保留人工语义审计；
- `codex:protocol:check` 与 CI 始终只读。

0.151 新增的 9 个 notification 和 `functionCallOutput` ThreadItem 已按真实 generator stable profile 完成
coverage 分类；runtime version/schema hash 与 native controls 从生成的 `baseline.ts` 派生，不再保留手写版本常量。

### 3.3 兼容策略

采用 capability-first、精确 fallback，而不是只按 semver 猜测：

1. 优先发送 metadata-only lifecycle 请求（`excludeTurns=true`）。
2. 若 app-server 明确返回“experimental capability/unknown field/paging unsupported”兼容错误：
   - 将当前 client 标记为 `legacy-only`；
   - 对同一个 lifecycle 操作只重试一次旧参数；
   - 后续不再重复探测。
3. 其他错误（no rollout、config mismatch、auth、ownership、transport）不得误判成兼容错误。
4. turns/items list 若 method not found，才允许 legacy fallback。
5. 一旦 metadata 表明 `historyMode=paginated`，绝不调用 `includeTurns=true`。

建议内部状态：

```ts
type CodexLifecycleHistorySupport =
  | "unknown"
  | "paginated"
  | "legacy-only";
```

该状态只在单个 app-server client 生命周期内有效，不持久化，不跨 profile/remote bridge 复用。

---

## 4. 目标调用流程

### 4.1 普通历史 session 继续提问

目标流程：

```text
initialize
config/read
thread/resume { excludeTurns: true }
  └─ 返回 metadata/live state，thread.turns=[]
turn/start
  └─ agent 使用 provider 内部完整上下文继续工作
```

普通 stdio resume 不需要为了发送新问题主动请求历史 turns/items。Session 页面展示历史仍由现有
`CodexAppServerHistoryReader` 独立分页读取。

验收重点：

- resume request 明确包含 `excludeTurns:true`；
- 不出现 `thread/turns/list` 的无意义额外请求；
- 不出现 deprecation notice；
- 模型上下文、model/provider、permission、MCP config 保持；
- turn/start 正常。

### 4.2 bridge-owned active turn rejoin

目标流程：

```text
thread/resume { excludeTurns: true }
thread/turns/list {
  threadId,
  cursor: turnsBackwardsCursor,
  limit: 1,
  sortDirection: "desc",
  itemsView: "notLoaded"
}
  ├─ 最新 turn inProgress -> turn/steer(expectedTurnId)
  └─ 无 active turn -> turn/start
```

注意：

- 只有 bridge WebSocket rejoin 且确实需要 active turn ID 时才请求 latest turn；
- cursor 存在时按上游文档原样传递；没有 cursor 时允许从最新页读取；
- 不通过完整历史推断 active turn；
- active turn lookup 失败要 fail closed，不能在不确定 ownership 时同时启动竞争 turn。

### 4.3 edit/fork

目标流程：

```text
thread/resume { excludeTurns: true }
thread/turns/list(desc, itemsView=notLoaded)
  └─ 只翻到 excludedTurnCount + 1 个 source turns
计算 retained boundary
  ├─ 无 retained turn -> 保持现有 empty child fallback
  └─ 有 boundary -> thread/fork {
         lastTurnId,
         excludeTurns: true,
         ...current config
     }
turn/start(new child)
```

boundary 算法：

1. `forkExcludedTurnCount` 继续沿用现有 UI/服务端定义，不改变产品语义。
2. `thread/turns/list` 使用 descending 顺序。
3. 至少需要读取 `forkExcludedTurnCount + 1` 个 turns；超过单页上限时继续使用 `nextCursor`。
4. 第 `forkExcludedTurnCount` 个 descending turn 是 retained boundary。
5. 如果历史耗尽且没有 boundary，走现有“编辑第一条 prompt，创建空 child”流程。
6. boundary 若 `inProgress` 或 identity 缺失，继续 fail closed。
7. `thread/fork` response 不需要完整 turns；lineage、new thread ID 和 config 才是必要数据。

不能因为分页改造而改变：

- `lastTurnId` 的 inclusive 语义；
- MCP profile/config 继承；
- forkParentSessionId sidecar；
- history_fork_complete marker；
- first-prompt empty child fallback；
- source session 不被修改。

### 4.4 steer compatibility fallback

目标流程：

```text
turn/steer
  └─ -32602
     -> thread/turns/list(limit=1, desc, notLoaded)
        ├─ newest inProgress -> 明确拒绝直接输入
        └─ newest terminal/none -> turn/start
```

兼容旧 app-server：

1. 若 `thread/turns/list` method not found：先执行 metadata-only `thread/read(includeTurns=false)`。
2. 只有返回 `historyMode=legacy` 时，才执行一次 `thread/read(includeTurns=true)`。
3. paginated/unknown 状态绝不 full hydrate；无法确认时 fail closed 并给出可诊断错误。

### 4.5 warning projection

`deprecationNotice` 的目标策略：

- `log.warn` 或结构化 diagnostics，记录 `warningKind` 和稳定 summary；
- 同一 app-server client + summary 只记录一次，避免日志刷屏；
- 不生成 SDK `system/warning` message；
- 不写入 provider transcript；
- 不隐藏普通 `warning`、`guardianWarning`；
- `configWarning` 保持现状，另行评估。

即使未来上游新增其他 deprecation notice，也不应由终端用户承担协议迁移提示。

---

## 5. 实施阶段

### 阶段 A：锁定协议事实与兼容错误分类

#### 实施任务

1. 在计划/测试注释中记录：
   - reference before/after commit；
   - 上游弃用 commit `d132b6921`；
   - 本机 Codex `0.151.0`；
   - checked protocol baseline `0.151.0`（初始调查时为 `0.147.0`）。
2. 从更新后的上游 TUI 提取“paging unsupported”错误分类规则，但不要字符串泛匹配所有 `-32602`。
3. 新增纯函数：
   - `isCodexHistoryPaginationUnsupported(error)`；
   - `isCodexLifecycleExcludeTurnsUnsupported(error)`。
4. 扩展 fake app-server：
   - 可声明 historyMode；
   - 可拒绝 excludeTurns；
   - 可实现 turns/items list cursor；
   - 可在旧调用时发送 deprecationNotice。

#### 建议修改文件

- `packages/server/src/sdk/providers/codex.ts`
- `packages/server/test/sdk/providers/codex.test.ts`
- 可选新增 `packages/server/src/sdk/providers/codex-history-compat.ts`

#### 验收

- no rollout/config/auth/transport 错误不会触发 legacy retry。
- excludeTurns/paging unsupported 只重试一次。
- capability state 不跨 app-server client 泄漏。
- fake server 能复现截图 warning。

#### 退出条件

兼容错误分类有聚焦单测，后续阶段不再散落字符串判断。

---

### 阶段 B：修复普通 resume

#### 实施任务

1. `threadResumeParams` 默认加入 `excludeTurns:true`。
2. 若精确兼容错误，执行一次不带 `excludeTurns` 的旧请求。
3. retry 后更新 lifecycle history support 状态。
4. normal stdio resume 不读取 turns/items。
5. 保留 no-rollout replacement、startup retry、event ingress exchange 和 session ID repair。

#### 测试

- paginated cold resume：exclude true，无 notice。
- paginated loaded resume：exclude true，无 notice。
- legacy modern server：exclude true 可成功，normal resume 不依赖 turns。
- old server reject exclude：只 fallback 一次，原流程可继续。
- no rollout：仍进入现有 replacement，不能被 compatibility fallback 吃掉。
- retry/overload：请求参数保持 exclude true。
- stdio 与 bridge transport 都捕获准确 request params。

#### 验收

- 截图对应的普通 resume 不再请求 full history。
- init、turn/start、streaming、context usage 和 pending input 无回归。
- provider 日志没有重复 compatibility warning。

#### 退出条件

普通 session 继续提问路径完成修复，可独立合并。

---

### 阶段 C：修复 bridge active turn rejoin

#### 实施任务

1. 移除从 `threadResult.thread.turns` 获取 `resumedActiveTurnId`。
2. bridge rejoin 时调用 latest-turn helper：
   - cursor 优先；
   - limit=1；
   - descending；
   - `itemsView=notLoaded`。
3. 结果为 inProgress 才执行 steer。
4. lookup 不确定时 fail closed，不启动竞争 turn。
5. 不扩展 4510 HTTP status 协议，除非实测 list API 无法看到 live in-progress turn。

#### 测试

- bridge-owned in-progress turn -> steer exact ID。
- bridge-owned completed turn -> start new turn。
- empty history -> start new turn。
- cursor inclusive 行为不会选错前一 turn。
- lookup timeout/error -> 不发 turn/start。
- stdio resume 不额外 list latest turn。

#### 验收

- bridge rejoin 不依赖 hydrated `thread.turns`。
- 不出现双 turn、错误 steer 或 competing app-server。

#### 退出条件

WebSocket bridge reconnect/steer 语义与现状一致，并且 resume 保持 metadata-only。

---

### 阶段 D：修复 edit/fork boundary

#### 实施任务

1. 抽取 `loadCodexForkBoundary()`：
   - 输入 source thread、excluded count、cursor/support；
   - 输出 retained boundary / empty-child / typed error。
2. paginated source 使用 turns/list；legacy fallback 使用完整 turns。
3. `thread/fork` 加 `excludeTurns:true`，旧 server 精确 fallback。
4. 不再要求 resume/fork response 携带完整 turns。
5. 保留 current-main MCP enablement 和 source-preserving lineage。
6. 对极大 excluded count 使用多页 cursor，设置总 turns/请求次数安全上限；达到上限 fail closed。

#### 测试

- 排除最后 1/N turns。
- exclusion 跨两页。
- 排除全部 turns -> empty child。
- exclusion 大于总 turns -> 现有错误语义。
- retained boundary inProgress -> fail closed。
- cursor 重复/无前进 -> fail closed，避免死循环。
- fork params 同时包含 lastTurnId、excludeTurns、MCP config。
- 不发送 thread/rollback/beforeTurnId。
- fork response turns 为空仍可完成 history_fork_complete。
- source session 不变。

#### 验收

- edit/fork 不再产生 resume/fork full-history deprecation notice。
- 现有 branch UI、forkParentSessionId、消息编辑定位保持。
- 100+ turns source 的 boundary 只读取必要页面。

#### 退出条件

所有现有 Codex edit/fork fixture 通过，并新增 paginated cursor fixture。

---

### 阶段 E：修复 steer fallback

#### 实施任务

1. 用 latest-turn helper 替换 paginated `thread/read(includeTurns:true)`。
2. method-not-found 时做 metadata-only read 判别 legacy。
3. legacy-only 才允许旧 full read。
4. 把 fallback source/reason 记入结构化 debug log，不记录 turn 内容。

#### 测试

- paginated + steer -32602：只 list latest turn。
- latest active：拒绝新 turn。
- latest terminal：启动新 turn。
- legacy list unsupported：允许 includeTurns=true。
- paginated list temporary failure：fail closed，不 full hydrate。

#### 验收

- 全部 paginated provider 路径不存在 `includeTurns:true`。
- legacy compatibility 不回归。

#### 退出条件

代码检索和请求捕获测试共同证明 paginated full read 已清零。

---

### 阶段 F：deprecationNotice 诊断分流

#### 实施任务

1. `deprecationNotice` 从 SDK message projection 中独立出来。
2. 每 client/summary 去重记录本地 warning。
3. 添加内容安全测试，确保 details 不被无界记录。
4. 保留 `warning`、`guardianWarning` 当前 UI。
5. 增加 regression test：即使 fake server 发截图 notice，也不会进入 yielded messages。

#### 验收

- 用户 transcript 中不再出现 Codex API deprecation notice。
- diagnostics 中仍可定位上游 notice。
- 真正用户可操作的 guardian warning 未被隐藏。

#### 退出条件

协议诊断和产品警告的展示边界明确。

---

### 阶段 G：真实 0.151 smoke、性能与发布

#### 实施任务

1. 使用临时 Codex home/fixture 或现有只读 session 做 app-server smoke；不得发模型请求。
2. 捕获 JSON-RPC 方法和 params，验证：
   - normal resume exclude true；
   - paginated edit 使用 turns/list；
   - fork exclude true；
   - 无 includeTurns=true；
   - 无 deprecationNotice。
3. 对长 paginated session 比较修复前后：
   - resume response bytes；
   - resume wall time；
   - Node/app-server RSS 峰值；
   - turn/start 首事件时间。
4. 运行聚焦测试、typecheck、lint。
5. 更新 `CHANGELOG.md` `[Unreleased]`。
6. checked protocol baseline 已同步到 0.151，并完成新增 capability coverage 审计；未来由自动 sync 重复该门禁。

#### 验收

- 真实 Codex 0.151 不再发截图 warning。
- normal resume response 大小不随完整历史线性增长。
- 100+ turns edit/fork 结果正确。
- bridge rejoin 不出现 competing turn。
- 旧 server compatibility fixture 通过。
- 没有模型请求、真实 session 写入或服务重启副作用。

#### 退出条件

专项修复与 0.151 protocol baseline 均达到发布条件；长 session 性能采样仍可独立进行。

---

## 6. 测试矩阵

| History | Lifecycle | Transport | 预期请求 | 允许 full hydration |
| --- | --- | --- | --- | --- |
| paginated | normal resume | stdio | resume exclude=true -> turn/start | 否 |
| paginated | active rejoin | bridge WS | resume exclude=true -> turns/list(1) -> steer | 否 |
| paginated | edit fork | stdio/bridge | resume exclude=true -> turns/list(N) -> fork exclude=true | 否 |
| paginated | steer fallback | stdio/bridge | turns/list(1) | 否 |
| legacy | normal resume | stdio | metadata-only 优先；必要时 compatibility retry | 非必要 |
| legacy | edit fork | stdio/bridge | metadata read -> includeTurns=true 或现有 turns | 是 |
| legacy | steer fallback | stdio/bridge | list unsupported -> read metadata -> read full | 是 |
| old server | exclude unsupported | 任意 | 精确失败后单次旧参数 retry | 是 |
| missing rollout | resume | stdio | replacement start | 不适用 |

额外边界：

- cold vs already-loaded resume；
- source turn count 0/1/100/101/多页；
- cursor inclusive、cursor 重复、cursor stale；
- latest turn terminal/inProgress/failed/interrupted；
- first-prompt edit；
- MCP clear/light/full；
- provisional session replacement；
- app-server overload/retry；
- bridge external ownership；
- source thread rollback/fork lineage。

---

## 7. 验证命令

实施后先运行聚焦测试：

```bash
corepack pnpm --filter @yep-anywhere/server test -- test/sdk/providers/codex.test.ts
corepack pnpm --filter @yep-anywhere/server test -- test/codex-history/CodexAppServerHistoryReader.test.ts
corepack pnpm codex:protocol:test
```

随后运行：

```bash
pnpm typecheck
pnpm lint
pnpm test
git diff --check
```

协议漂移检查始终只读：

```bash
pnpm codex:protocol:check
```

CLI 升级后可显式运行 sync；常用开发入口也会自动运行：

```bash
pnpm codex:protocol:sync
```

sync 只有在 schema 生成与 coverage 审计全部通过后才写入 baseline 和 `expectedVersion`；`update` 可用于
强制重生成当前版本。

真实 smoke 必须：

- 使用 read-only/disposable fixture；
- 不调用 `turn/start` 发模型请求；
- 不修改真实 `~/.codex` session；
- 不安装插件；
- 不重启 8022/4510，除非用户另行明确授权。

浏览器/Playwright 验证也需要另行明确授权；首轮可通过 fake app-server message capture 和组件测试验证
warning 不再进入 transcript。

---

## 8. 性能验收

必须记录修复前后同一 paginated session 的：

| 指标 | 目标 |
| --- | --- |
| `thread/resume` response 中 turns 数 | 0 |
| normal resume 的 turns/items page 请求数 | 0 |
| bridge active lookup page | 最多 1 个 turn page |
| edit boundary page | 只读取 excluded count + boundary 所需页面 |
| paginated `includeTurns:true` 请求数 | 0 |
| 截图 deprecationNotice | 0 |
| resume response bytes | 不随完整历史线性增长 |
| turn/start 首事件时间 | 不劣于基线，长 session 应改善 |

不设脱离基线的绝对毫秒承诺；先使用现有真实长 session 记录至少 5 次 cold/warm 样本，再确定 p95 门槛。

---

## 9. 日志与隐私

允许记录：

- method；
- provider/history mode；
- support state；
- cursor 是否存在；
- page count；
- turn count；
- fallback reason code；
- duration/bytes bucket；
- warning kind。

禁止记录：

- prompt/answer；
- tool input/output；
- turn item 正文；
- absolute cwd/path；
- opaque cursor 原值；
- credential/config；
- deprecation details 的无界原文。

结构化日志建议事件：

```text
codex_lifecycle_resume_history_mode_selected
codex_lifecycle_compatibility_fallback
codex_fork_boundary_page_loaded
codex_active_turn_lookup_completed
codex_deprecation_notice_suppressed
```

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 只加 excludeTurns，没改 fork | edit/fork 立即失败 | boundary 独立分页，专项 fixture |
| bridge active ID 丢失 | 错误 start 新 turn | latest-turn lookup，失败时 fail closed |
| turns cursor inclusive 处理错 | fork 多保留/少保留一 turn | 真实 schema + 边界测试 |
| 旧 server 不支持 excludeTurns | resume 失败 | 精确单次 fallback + client support state |
| 把所有 -32602 当兼容错误 | 掩盖真实参数 bug | typed/message exact classifier |
| paginated list 临时失败时 full read | 警告和 O(N) 回归 | paginated fail closed，禁止 full read |
| exclude resume 影响 usage replay | context 指标短暂缺失 | 覆盖 cold/loaded usage 测试、现有 metadata retry |
| deprecation notice 全隐藏 | 丢失开发诊断 | 本地去重 diagnostics，不进用户 transcript |
| protocol baseline 大升级混入 | diff 过大、审计失焦 | baseline 升级单独提交 |

---

## 11. 回滚方案

建议将新 lifecycle 行为放在一个集中式 capability policy 下，而不是多个散落开关。

发生回归时：

1. 先关闭 metadata-only lifecycle policy，恢复旧 resume/fork response；
2. 保留 `deprecationNotice` diagnostics 分流，避免用户界面继续被协议提示污染；
3. 不回滚现有 `CodexAppServerHistoryReader`，它已经正确使用 metadata read + page API；
4. 不修改/删除 provider session；
5. 不清理 cursor/index 数据；这些都是临时请求状态；
6. 根据 transport/history mode 定位是 normal resume、bridge rejoin、fork 还是 steer fallback。

回滚后警告可能重新产生，但 agent session 数据不能损坏，legacy 路径应继续可用。

---

## 12. 推荐提交拆分

1. `test(codex): reproduce paginated hydration deprecation notice`
2. `fix(codex): resume threads without hydrating paginated history`
3. `fix(codex): resolve active bridge turns through bounded history`
4. `fix(codex): page fork boundaries before metadata-only forks`
5. `fix(codex): remove paginated full-read steer fallback`
6. `fix(codex): keep protocol deprecations out of user transcripts`
7. `docs(codex): record hydration migration validation and benchmarks`

每个提交都应有对应 message-capture 测试，可单独审查和回滚。进入正式部署产物的修复需更新
`CHANGELOG.md` `[Unreleased]`；开发阶段不提升 CalVer。

---

## 13. 最终验收清单

- [x] `references/codex` 已更新并记录 before/after commit。
- [x] 上游 `d132b6921` 的 trigger 已有本地 regression fixture。
- [x] normal paginated resume 发送 `excludeTurns:true`。
- [x] normal resume 不加载 turns/items。
- [x] bridge active rejoin 通过原生 `initialTurnsPage` 只读取最新 live turn。
- [x] paginated edit/fork 使用 initial page + turns/list 计算 boundary。
- [x] paginated fork 发送 `excludeTurns:true`。
- [x] paginated steer fallback 不使用 `includeTurns:true`。
- [x] legacy history 仍有受控 full hydration fallback。
- [x] compatibility retry 只发生一次且只匹配明确错误。
- [x] deprecationNotice 不进入用户 transcript。
- [x] guardian/user-actionable warning 未被隐藏。
- [x] no-rollout replacement、MCP config、lineage、branch/edit 无回归。
- [x] 真实 Codex 0.151 smoke 无截图警告。
- [ ] 长 session resume response 不随历史长度线性增长。
- [x] 聚焦测试、typecheck、lint、完整 test 和 diff check 通过。
- [x] `CHANGELOG.md` `[Unreleased]` 已更新。
