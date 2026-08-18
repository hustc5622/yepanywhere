# OpenCode 编辑消息后创建分支开发计划

> 历史资料：OpenCode provider 与 4520/4521 bridge 已于 2026-08-18 退役；本文只保留原分支语义研究。

## 背景

当前 Codex CLI 已支持在 Yep 前端编辑历史用户消息后创建会话分支，并能在前端切换分支查看不同历史。目标是把这套体验扩展到 `opencode` provider：

- 用户在 Yep 前端编辑任意历史用户消息。
- OpenCode CLI 侧创建新的 fork session，并从编辑点继续。
- Yep 前端能在原消息和编辑后消息之间切换分支。
- 不破坏现有 Claude / Codex 分支行为。

本文只记录现状和开发计划，不包含代码改动。

## 现有 Codex 实现

### 前端编辑入口

`packages/client/src/pages/SessionPage.tsx` 中维护 `editRewind` 状态：

- `uuid`：被编辑用户消息自身 id。
- `parentUuid`：被编辑消息的父消息 id。
- `rollbackNumTurns`：Codex app-server 专用，表示需要回滚的 trailing user turns 数量。

编辑历史用户消息后，下一次发送消息会进入特殊分支：

- Codex provider：调用 `api.resumeSession(..., rollbackNumTurns)`。
- Claude provider：调用 `api.resumeSession(..., resumeSessionAt=parentUuid)`。
- 第一条 Claude 消息没有 parent，当前逻辑会退化为新建 session。

### Codex 服务端执行

`packages/server/src/sdk/providers/codex.ts` 使用 `codex app-server`：

- 先 `thread/resume` 或 `thread/start`。
- 如果存在 `rollbackNumTurns`，再调用 `thread/rollback`。
- 然后把编辑后的用户消息作为新 turn 发送。

这保持了 Codex CLI 自身的 Esc Esc backtrack 语义：同一个 thread 中追加 `thread_rolled_back` marker，而不是复制一个新 session。

### Codex 分支重建

`packages/server/src/sessions/codex-rollback.ts` 通过 append-only rollout 中的 `thread_rolled_back` marker 重建轻量 turn tree：

- 每个真实用户 turn 变成一个 `SessionBranchOption`。
- rollback marker 会把 active path 往前裁剪。
- 新 turn 成为同一个 parent 下的 sibling。
- `buildCodexBranchView(entries, sessionId, branchId)` 返回：
  - 当前选中 branch 的可见 entries。
  - provider-agnostic `SessionBranchState`。

`packages/server/src/sessions/codex-reader.ts` 把 `branchState` / `codexBranchState` 返回给 normalization。

### 前端分支切换

共享类型在 `packages/shared/src/app-types.ts`：

- `SessionBranchState`
- `SessionBranchOption`
- `SessionBranchMetadata`

`packages/server/src/sessions/normalization.ts` 用 `annotateBranchMessages()` 给用户消息加 `message.branch`。

`packages/client/src/components/blocks/UserPromptBlock.tsx` 看到 `branch.alternatives.length > 1` 时渲染分支切换控件。`SessionPage` 的 `handleSelectBranch()` 当前只更新 URL query：`?branch=<branchId>`，适合 Codex / Claude 这类同 session 投影。

## 当前 OpenCode 实现现状

### 已具备的能力

`packages/server/src/sdk/providers/opencode.ts` 已经支持 native fork：

- `prepareOpenCodeSession()` 在 `resumeSessionId + resumeSessionAt` 同时存在时调用 `forkOpenCodeSession()`。
- `forkOpenCodeSession()` 调用 OpenCode HTTP API：

```text
POST /session/:sessionId/fork
body: { "messageID": "<message-id>" }
```

- fork 返回的新 OpenCode session id 会作为 Yep runtime 的实际 session id。
- `packages/server/test/sdk/providers/opencode.test.ts` 已有 “resuming at a message boundary triggers fork” 测试。

### 关键缺口

1. OpenCode 消息转换没有给前端 `parentUuid`

`convertOpenCodeEntries()` 目前只把 OpenCode 的 `message.parentID` 映射为 `parentId`。但 `RenderItemComponent` 和 `SessionPage` 编辑逻辑读取的是 `parentUuid`。结果是非首条 OpenCode 用户消息也可能被当成没有 parent，走错新建 session 路径。

2. OpenCode fork 语义和 Claude 不同

Claude 的 `resumeSessionAt` 语义是“恢复到 parentUuid，包含 parent”。  
OpenCode 原生 fork 语义是“传入被编辑的用户消息 id，复制它之前的消息，并把该消息文本预填到新 session 输入框”。

上游参考实现位于 `references/opencode/packages/opencode/src/session/session.ts`：

- `Session.fork({ sessionID, messageID })` 遍历原 session 消息。
- 遇到 `msg.info.id >= messageID` 时停止复制。
- 因此应该传被编辑用户消息自身 id，而不是 parent id。

3. OpenCode reader 不返回 branchState

`packages/server/src/sessions/opencode-reader.ts` 的 SQLite reader 只返回当前 session 的 messages，没有处理 `_options.branchId`，也没有返回 `branchState`。

4. OpenCode fork 不可靠保留 lineage

当前参考实现的 `Session.fork()` 新建 session 时复制 metadata，但没有显式写 `parentID`。`session.parent_id` 在 OpenCode 中更多用于 child/subagent session，不应假设 fork 一定会写它。

因此 Yep 需要自己在 fork 后写入 lineage metadata，避免靠标题 `"(fork #1)"` 或消息前缀猜测。

5. 前端分支切换只支持同 session

现有 `handleSelectBranch(branchId)` 只改 `?branch=`。OpenCode fork 是新 session；选择 sibling branch 时需要能够跳转到 `branch.sessionId`。

## 设计结论

OpenCode 不能直接复用 Codex 的同 session rollback model。推荐把它建模为“跨 session 分支”：

- OpenCode 原 session 保持不变。
- 编辑历史用户消息时，调用 OpenCode native fork 创建新 session。
- 新 session 记录 Yep 自己的 fork metadata。
- Reader 通过 metadata 把同一 fork family 的多个 OpenCode session 重建为 provider-agnostic `SessionBranchState`。
- 前端分支控件复用现有 UI，但当目标 `SessionBranchOption.sessionId` 与当前 session 不同时执行导航。

## 计划一：修正 OpenCode 编辑触发

### 前端改动

文件：

- `packages/client/src/pages/SessionPage.tsx`
- `packages/client/src/api/client.ts`

计划：

1. 增加 `isOpenCodeProvider(provider)` helper。
2. 编辑发送逻辑拆成三类：
   - Codex：继续用 `rollbackNumTurns`。
   - OpenCode：调用 `api.resumeSession(..., resumeSessionAt=editRewind.uuid)`。
   - Claude/Claude Ollama：继续用 `resumeSessionAt=editRewind.parentUuid`。
3. OpenCode 编辑第一条用户消息时也走 fork，而不是 `startSession()`。
4. 更新 `resumeSessionAt` 的注释，避免继续写“传 parentUuid”这种 Claude-only 说明。

预期结果：

- OpenCode 编辑任意历史用户消息都会 fork 出新 session。
- fork boundary 是被编辑消息自身 id，匹配 OpenCode 原生行为。

### 服务端路由改动

文件：

- `packages/server/src/routes/sessions.ts`
- `packages/server/src/sdk/providers/types.ts`

计划：

1. 更新 `StartSessionBody.resumeSessionAt` 注释为 provider-native boundary。
2. 保留 `supportsResumeSessionAt("opencode")`。
3. 日志继续记录 `resumeSessionAt`，但语义标注为 provider-specific。

## 计划二：写入 Yep fork lineage metadata

文件：

- `packages/server/src/sdk/providers/opencode.ts`

计划：

1. 在 `prepareOpenCodeSession()` 中区分返回结果：
   - create
   - resume existing
   - forked
2. forked 时，在 `markOpenCodeSessionCreatedByYep()` 或新 helper 中 PATCH metadata：

```json
{
  "createdBy": "yep",
  "source": "yep-anywhere",
  "yepFork": {
    "kind": "edit-fork",
    "parentSessionId": "ses_parent",
    "forkMessageId": "msg_user_to_edit",
    "createdAt": "2026-07-10T..."
  }
}
```

3. 如果能从 OpenCode response 或后续 GET 拿到已有 metadata，先 merge 再 PATCH，避免覆盖用户或上游 metadata。
4. 保留当前新建 OpenCode session 的 `createdBy/source` 行为。
5. 增加结构化日志：
   - `opencode_session_fork_requested`
   - `opencode_session_fork_completed`
   - `opencode_session_fork_metadata_patched`

注意：

- OpenCode PATCH metadata 是替换语义，不是深 merge；实现时不能只 PATCH `yepFork`。
- 历史 session 没有 `yepFork` metadata 时，不做猜测式分支重建。

## 计划三：补 OpenCode 消息 normalization

文件：

- `packages/server/src/sessions/normalization.ts`

计划：

1. `convertOpenCodeEntries()` 中把 `message.parentID` 同时映射为：
   - `parentUuid`
   - `parentId`
2. OpenCode provider 的 `normalizeSession()` 分支改为：
   - 读取 `loaded.branchState`。
   - 转换 messages。
   - 若存在 branchState，调用 `annotateBranchMessages(messages, branchState)`。
3. 调整 `annotateBranchMessages()`：
   - 当前 `branchMetadata.sessionId` 使用 `branchState.sessionId`。
   - 改为使用匹配到的 `branch.sessionId`。
   - Claude/Codex 都是同 session，不受影响；OpenCode alternatives 可以跨 session。

## 计划四：新增 OpenCode branch builder

建议新增文件：

- `packages/server/src/sessions/opencode-branch.ts`

输入：

- 当前 session id。
- 当前 session messages。
- 同 directory 下的 OpenCode session rows。
- 每个 session 的 messages/parts。
- 可选 `selectedBranchId`。

输出：

- 当前 session 可显示的 messages。
- `SessionBranchState`。

核心逻辑：

1. 从 SQLite `session.metadata.yepFork` 找 fork 关系。
2. 以 `parentSessionId` / `forkMessageId` 建立 fork family。
3. 对每个 session 提取用户消息节点：
   - `id`：真实 OpenCode user message id。
   - `sessionId`：消息所在 session。
   - `prompt`：text parts 拼出的用户文本。
   - `createdAt`：message time。
4. 对 root session，按用户消息顺序建立主线。
5. 对 fork session：
   - 在 parent session 找到 `forkMessageId` 对应用户消息。
   - 该消息的 prompt parent 成为 fork sibling group parent。
   - child session 中 fork boundary 之后的第一个 user message 是编辑后的新 branch。
   - 后续 child user messages 按 child session 自身顺序继续挂接。
6. `activeBranchId` 是当前 session active path 的最后一个用户 prompt。
7. `selectedBranchId` 用于前端聚焦，不跨 session 替换当前 session 数据。
8. `branches` 中同一 fork point 的原始消息和编辑后消息互为 siblings。

边界处理：

- 如果 fork 后还没有新 user message，branchState 可以暂不暴露该 fork branch。
- 如果 parent session 或 forkMessageId 已缺失，忽略该 broken fork metadata，并记录 debug 日志。
- archived sessions 默认不参与 active branch choices，除非后续产品明确需要。
- 只对 Yep 写入 `yepFork.kind === "edit-fork"` 的 session 建分支，避免误判 OpenCode 普通 fork。

## 计划五：接入 OpenCode reader

文件：

- `packages/server/src/sessions/opencode-reader.ts`
- `packages/server/src/sessions/types.ts`

计划：

1. SQLite `getSession()` 中加载当前 session 后，调用 `buildOpenCodeBranchView()`。
2. 返回 `LoadedSession.branchState`。
3. `getSessionSummary()` 暂不强制返回 branchState，列表页不依赖分支控件。
4. legacy JSON storage 可先不支持分支；如果 JSON session 自带 `parentID` 或 metadata，可作为后续增强。
5. `getSessionSummaryIfChanged()` 不需要因为 sibling session 更新而立刻刷新当前 session summary；完整 session 页面刷新时读取 branchState 即可。

## 计划六：支持跨 session 分支切换

文件：

- `packages/client/src/pages/SessionPage.tsx`
- `packages/client/src/components/blocks/UserPromptBlock.tsx`

计划：

1. `handleSelectBranch(branchId)` 先从 `sessionBranchState.branches` 查目标 option。
2. 如果目标 option 存在且 `option.provider === "opencode"` 或当前 provider 是 OpenCode：
   - `option.sessionId !== sessionId`：导航到 `/projects/:projectId/sessions/:option.sessionId?branch=:branchId`。
   - `option.sessionId === sessionId`：保留当前 `?branch=` 行为，用于聚焦。
3. Claude/Codex 保持当前同 session query 切换逻辑。
4. `pendingBranchFocusId` 继续使用 branchId，导航后用于滚动到目标 user prompt。
5. `UserPromptBlock` 现有 `BranchControls` 可以先复用；CSS class 仍叫 `codex-branch-*` 是命名债，不阻塞功能。后续可单独重命名为 provider-neutral。

## 测试计划

### OpenCode provider

文件：

- `packages/server/test/sdk/providers/opencode.test.ts`

新增或调整：

- `resumeSessionAt` 对 OpenCode 发送的是被编辑 user message id。
- fork 后 PATCH metadata，包含 `createdBy/source/yepFork`。
- PATCH metadata 时不覆盖已有 metadata。

### OpenCode reader

文件：

- `packages/server/test/sessions/opencode-reader.test.ts`

新增 SQLite fixture：

1. parent session：
   - `u1 -> a1 -> u2 -> a2`
2. fork session：
   - metadata `yepFork.parentSessionId = parent`
   - metadata `yepFork.forkMessageId = u2`
   - copied prefix `u1' -> a1'`
   - edited prompt `u2_edit -> a2_edit`

断言：

- parent 和 fork session 都能读到 `branchState`。
- `u2` 和 `u2_edit` 是 siblings。
- sibling options 的 `sessionId` 分别指向 parent/fork session。
- active branch 在 parent 页面是 `u2`，在 fork 页面是 `u2_edit`。
- `selectedBranchId` 能保留为传入 branchId。

### Normalization

文件：

- `packages/server/test/sessions/normalization.test.ts`

新增断言：

- OpenCode `message.parentID` 被映射为 `parentUuid`。
- OpenCode user prompt 收到 `message.branch` metadata。
- `branch.sessionId` 使用具体 branch option 的 sessionId。

### 前端

可选增加轻量单测或组件测试：

- OpenCode branch option 指向不同 session 时，`handleSelectBranch` 导航到目标 session。
- Claude/Codex branch option 仍只更新 query。

不默认跑 Playwright / browser automation，除非明确要求。

### 推荐验证命令

```bash
pnpm test packages/server/test/sdk/providers/opencode.test.ts
pnpm test packages/server/test/sessions/opencode-reader.test.ts
pnpm test packages/server/test/sessions/normalization.test.ts
pnpm lint
pnpm typecheck
```

如果前端新增单测，再补对应 client test。只有涉及真实 UI 行为确认时才考虑浏览器自动化。

## 风险与取舍

- OpenCode fork 会复制历史消息并生成新 message ids，因此不能用 message id 直接判断共同前缀；必须依赖 Yep fork metadata 和消息顺序。
- 历史 OpenCode fork 没有 `yepFork` metadata，第一版不做自动追溯，避免误把普通 session 或 subagent session 当成编辑分支。
- OpenCode upstream 未来如果开始写 `parentID`，可以作为辅助信号，但不应替代 Yep metadata。
- `resumeSessionAt` 名称对 OpenCode 不够精确，但为了少改 API，可以先保留字段并更新注释；如果后续 provider 继续增加，建议引入更明确的 provider-native rewind/fork payload。
- 跨 session branch navigation 会让 URL sessionId 变化；这和 Codex 同 session query 切换不同，需要特别测试返回原 branch 的体验。

## 交付顺序

1. 修 OpenCode 编辑触发和 `parentUuid` 映射。
2. fork 后写 Yep lineage metadata。
3. 实现 OpenCode branch builder 和 reader 接入。
4. normalization 注入 `branch` metadata。
5. 前端跨 session branch navigation。
6. 补测试并跑聚焦验证。
