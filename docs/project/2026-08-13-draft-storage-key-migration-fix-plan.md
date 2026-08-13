# 草稿存储 key 迁移失配修复方案

> 状态：方案待评审（2026-08-13）。问题已经静态代码确认（键名不匹配可直接核实），运行时复现步骤见「验证」。
>
> 日期：2026-08-13

## 1. 结论

`migrateLegacySettings` 把草稿类 localStorage key 改名成 installId scoped key，但全仓库没有任何代码按 scoped key 读草稿。迁移一旦触发，未发送的草稿从 UI 消失，scoped 副本成为永久孤儿。

推荐方案 B：把草稿/FAB 类 key 从迁移列表中撤掉（草稿保持未加前缀），并对 scoped 孤儿 key 做一次性清理。理由：scoped key 的本意是多服务器配置隔离，而草稿 key 自带 sessionId/projectId，天然按服务器隔离，不需要也不应该参与 installId 前缀体系。

修复必须在 `InstallIdProvider` 接入应用树之前完成——目前该 Provider 未挂载，迁移处于休眠状态；一旦挂载，每次页面加载都会触发迁移并把草稿改名成孤儿。

## 2. 背景与现状

### 2.1 草稿 key 体系

客户端输入草稿直接存 localStorage，key 均未带 installId 前缀：

- `draft-message-{sessionId}`：会话输入框草稿。写入点 `SessionPage.tsx:2293`（`draftKey` prop）→ `MessageInput.tsx:178`（`useDraftPersistence(draftKey)`）。
- `draft-new-session-{projectId}`：新会话表单草稿。`NewSessionForm.tsx:373-375`。
- `fab-draft`：FAB 快速输入草稿。`FloatingActionButton.tsx:20,54`。
- `draft-tool-prompt-{sessionId}-*`：审批反馈/提问 Other 草稿。`useDrafts.ts:131,144,203`。
- 草稿存在性指示：`useDrafts.ts:14-30`（`scanDrafts` 按 `draft-message-` 前缀扫描）和 `useDrafts.ts:101,122`（按 `draft-new-session-{projectId}` 检查）。
- `useDraftPersistence`（`useDraftPersistence.ts`）负责读写：初次读取 39-45 行，防抖写入 `saveToStorage` 17-27 行，确认发送后 `clearDraft` 删除 117-129 行。

### 2.2 installId 与 scoped key 机制

`storageKeys.ts` 头部注释（4-9 行）写明设计目的：通过 yepanywhere.com/remote 访问时用户可能连接不同服务器，scoped key 保证每台服务器的配置（model、通知、recentProject 等）相互独立。

- 服务端 `InstallService`（`packages/server/src/services/InstallService.ts`）在首次启动时生成 `crypto.randomUUID()` 作为 installId，持久化到数据目录的 `install.json`（34-40、101-111 行），经 `/api/server-info` 暴露（`routes/server-info.ts:43`）。install.json 丢失/损坏/非法或数据目录切换（`YEP_ANYWHERE_PROFILE` / `YEP_ANYWHERE_DATA_DIR`）时会重新生成。
- 客户端 `InstallIdContext.tsx:34-66` 挂载时请求 `/api/server-info`，拿到 installId 后调用 `setCurrentInstallId`（49 行）。
- `setCurrentInstallId`（`storageKeys.ts:20-33`）在 `prevInstallId !== installId` 时调用 `migrateLegacySettings`。`currentInstallId` 是模块级变量，每次页面加载时重置为 `undefined`，因此挂载后**每次页面加载都会完整跑一遍迁移**，remote 切换服务器、服务端 installId 重新生成时也会再跑。

### 2.3 迁移逻辑

`migrateLegacySettings`（`storageKeys.ts:230-323`）做三类迁移：SERVER_SCOPED 配置（247-259）、UI key 改名（262-271）、FAB 与草稿 key（273-320）。其中草稿段（294-320）把 `draft-message-*` / `draft-new-session-*` **移动**到 `KEY_BUILDERS.draftMessage/newSessionDraft` 生成的 `yep-anywhere-{installId}-draft-*` scoped key，并删除旧 key。

关键事实：`KEY_BUILDERS`（169-183 行）在全仓库仅被迁移器自身引用（285、301、312 行），没有任何读取方使用 scoped 草稿 key。

### 2.4 当前处于休眠状态

`InstallIdProvider` 定义后从未被挂载（`App.tsx:101-114` 的 provider 树中没有它，全仓库无引用）。因此 `setCurrentInstallId` 在生产路径从不执行，迁移不会触发，`getServerScoped` 一律走 legacy key 回退（`storageKeys.ts:100-104`）。本问题是潜伏 bug，但该 Provider 的存在说明接入 scoped key 是既定方向，接入前必须先修。

## 3. 问题

### 3.1 证据

迁移写 scoped key（`storageKeys.ts:294-320`），读取方全部仍用未加前缀的旧 key（§2.1 各引用点），两侧键名不匹配，直接对照即可核实。同类问题还有 FAB 段（273-292）：`fab-draft` 读取方是 `FloatingActionButton.tsx:20,54` 的旧 key；`fab-prefill` 更彻底——当前代码用 sessionStorage 读写（`FloatingActionButton.tsx:27-39`），迁移的 localStorage `fab-prefill` 没有任何读取方，属于死迁移。

### 3.2 影响面

迁移触发后（见 §2.2 触发条件）：

1. 草稿从 UI 消失。旧 key 被改名，读取方读不到，输入框显示为空。数据还在 scoped key 里，但用户感知是草稿丢了。
2. 重复触发时数据真正丢失。迁移用「scoped key 已存在则跳过 setItem、但仍 removeItem 旧 key」（302-306 行，配置段 252-257 行同构）。由于读取方继续往旧 key 写新草稿，下一次迁移会把孤儿 scoped key 之外的新草稿内容直接删除。
3. scoped 副本永久残留。没有任何代码读或删这些 key；草稿本来就只增不删（仅发送成功 `clearDraft` 或清空时 removeItem，`useDraftPersistence.ts:17-27,117-129`），迁移失配使残留翻倍。
4. localStorage 写满后 `setItem` 抛错被静默吞掉（`useDraftPersistence.ts:24-26` catch 为空，仅注释），草稿只留在内存 state，刷新即丢且无任何提示。孤儿 key 越多，越容易顶到配额。

附注：`draft-tool-prompt-` 系列（`useDrafts.ts:131,144,203`）不在迁移范围内，不受影响；这也说明仓库自身对「按 session 划分的草稿」的既有约定就是不加前缀。

## 4. 方案

### 选项 A：读取方统一改用 scoped key

改动点：`SessionPage.tsx:2293`、`MessageInput.tsx:178`、`NewSessionForm.tsx:373-375`、`FloatingActionButton.tsx:20,54`、`useDrafts.ts:14-30,101,122`，以及 `useDraftPersistence` 的 key 解析。

否决理由：

- installId 是异步获取的，草稿在组件挂载时同步读取。切换 scoped key 后，installId 到达前即已挂载的输入框读不到草稿，需要重构 `useDraftPersistence` 支持 key 后至或门控渲染，侵入面大。
- 收益近似为零。草稿 key 已含 sessionId/projectId，都是服务器侧 UUID，天然按服务器隔离；remote 多服务器共用同一 origin 时也不会互相误读。
- `useDrafts` 的草稿指示器要在 installId 缺失时给出错误答案（漏标），或同样引入异步依赖。

### 选项 B：撤掉草稿/FAB key 的迁移（推荐）

草稿保持未加前缀的旧 key；从 `migrateLegacySettings` 删除草稿段（294-320）与 FAB 段（273-292），并连带清理只被迁移器引用的 `KEY_BUILDERS` 和 `LEGACY_KEYS` 草稿条目；对 scoped 孤儿 key 做一次性清理。SERVER_SCOPED 配置迁移保留不动。

理由：与 scoped key 的设计目的对齐——配置需要按服务器隔离，草稿不需要；改动小、无读取方变动、无异步时序问题；同时消灭死迁移（`fab-prefill`）。

### 选项 C：顺带治理（可与 B 同行）

- `saveToStorage` 的 catch 至少 `console.warn`，写满不再静默（`useDraftPersistence.ts:24-26`）。
- 草稿数量/总量设上限或按最后修改时间淘汰。当前 value 是纯文本无时间戳，淘汰需扩展存储格式（如 `{text, updatedAt}`），属行为变更，建议独立任务评估，不阻塞 B。

推荐：B 必选；C 的第一条（警告日志）改动一行、风险为零，建议同做；C 的淘汰机制另行评估。

## 5. 实施步骤

按提交顺序：

1. `storageKeys.ts`：删除草稿迁移段（294-320）与 FAB 迁移段（273-292）；删除失去引用的 `KEY_BUILDERS`（169-183）及 `LEGACY_KEYS` 中 `draftMessagePrefix`/`newSessionDraftPrefix`/`fabDraft`/`fabPrefill` 条目（210-213）。先不删数据的阶段——此 commit 单独可发布，即刻止血。
2. `storageKeys.ts`：新增一次性孤儿清理（如 `cleanupOrphanedDraftKeys`），在 `migrateLegacySettings` 同处调用：遍历 localStorage，删除匹配 `yep-anywhere-{installId}-draft-*`、`yep-anywhere-{installId}-new-session-draft-*`、`yep-anywhere-{installId}-fab-draft`、`yep-anywhere-{installId}-fab-prefill` 的 key。installId 是 36 字符 UUID，用该格式约束匹配，严禁误删 `yep-anywhere-{installId}-model` 等 SERVER_SCOPED 配置。建议作为后续独立 commit/版本，先观察步骤 1 的线上表现。
3. `useDraftPersistence.ts:24-26`：catch 分支加 `console.warn`（保留静默容错语义，只加可观测性）。
4. 按 AGENTS.md 在 `CHANGELOG.md` 的 `[Unreleased]` 记录本次修复（实施时做）。

## 6. 测试与验证

单元测试（vitest，mock localStorage）：

- 迁移不再触碰草稿：预置 `draft-message-s1`、`draft-new-session-p1`、`fab-draft`，调用 `migrateLegacySettings("id-x")`，断言旧 key 原样保留、无 scoped 副本生成。
- 孤儿清理精确匹配：预置 `yep-anywhere-{uuid}-draft-s1`、`yep-anywhere-{uuid}-new-session-draft-p1`、`yep-anywhere-{uuid}-fab-draft`、`yep-anywhere-{uuid}-fab-prefill` 以及对照组 `yep-anywhere-{uuid}-model`、`draft-message-s2`，断言只删前四个。
- `useDrafts` 的 `scanDrafts`/`checkNewSessionDraft` 在迁移执行后仍能发现草稿（回归当前行为）。
- 注意 `useRecentProject.test.ts:29` 已在测试中调用 `setCurrentInstallId`，新测试可复用其 localStorage mock 方式。

静态确认（不依赖浏览器）：

- 修复后全仓库 grep `KEY_BUILDERS`、`draft-message-`、`draft-new-session-`，确认所有读写点键名一致。

运行时复现/回归（修复前后对照，仅本地验证环境，不动线上服务）：

- 复现：`pnpm vitest run` 下用 jsdom/happy-dom 写一段临时测试：`localStorage.setItem("draft-message-s1", "hello")` → `migrateLegacySettings("id-x")` → 断言 `useDraftPersistence("draft-message-s1")` 读到空串，即现状的「草稿消失」。
- 修复后人工验证：本地 dev server 打开会话输入草稿、刷新页面，草稿仍在；DevTools → Application → Local Storage 确认无 `yep-anywhere-*-draft-*` 孤儿新增。

## 7. 回滚

纯客户端 localStorage key 策略变更，无服务端状态、无数据格式迁移，回滚即 revert 对应 commit。注意两点：

- 步骤 2 的孤儿清理是删除操作，不可恢复；被删 key 本来就没有任何读取方，业务上无损。如对激进删除有顾虑，可只发步骤 1，观察后再发步骤 2，或给清理加保守开关。
- 回滚到旧代码会恢复失配的迁移逻辑。当前 `InstallIdProvider` 未挂载，回滚无即时危害，但问题仍在，不推荐长期停留在旧版本。
