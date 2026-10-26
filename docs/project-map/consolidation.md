# 架构整理进度

[返回总览](README.md)。这里只记录已经落地、并且用测试核对过的重复收口。能力流程仍以 [flows.md](flows.md) 为准；还不能合并的边界留在 [findings.md](findings.md)。

地图调查基线仍是 `635bf0a88`。下表是调查之后的工作区改动，不改变 F1–F5 的用户可见行为。

## 已收口

| 日期 | 重复点 | 现在的唯一入口 | 核对 |
| --- | --- | --- | --- |
| 2026-10-20 | Codex 与 ZCode 各写一份 `AsyncQueue`（ZCode 已移除，现仅 Codex 使用） | [packages/server/src/utils/async-queue.ts](../../packages/server/src/utils/async-queue.ts) `AsyncQueue`。关闭时拒绝等待者并丢弃缓冲，之后的 `push` 被忽略；`drain()` 仍只被 Codex 使用 | `packages/server/test/utils/async-queue.test.ts` |
| 2026-10-20 | `tool-approval` 以外的 pending input 都折叠成 `user-question`，同一表达式写在 Supervisor、项目列表、会话详情、外置 runtime 快照和 PushNotifier | [packages/server/src/sessions/session-runtime.ts](../../packages/server/src/sessions/session-runtime.ts) `pendingInputTypeFromRequest`。`pendingInputTypeFromProcess` 改为调用它 | `packages/server/test/sessions/session-runtime.test.ts` |
| 2026-10-20 | 三个通知开关各写一套 `settings-item`、开关和测试发送条 | [packages/client/src/components/ui/SettingsItem.tsx](../../packages/client/src/components/ui/SettingsItem.tsx) `SettingsItem`、`SettingsToggle`、`NotificationTestActions`。`BrowserNotificationToggle`、`PushNotificationToggle`、`NativePushNotificationToggle` 保留各自的权限和订阅分支 | `packages/client/src/components/ui/__tests__/SettingsItem.test.tsx` |
| 2026-10-20 | 非空消息身份在客户端合并、调试摘要、display 投影和搜索索引里各写一遍 | [packages/shared/src/message-id.ts](../../packages/shared/src/message-id.ts) `nonEmptyMessageId`、`stringMessageId`。客户端 `getMessageId` 仍负责对象局部 fallback。分页、inspector、文件活动、标题上下文和 `SessionInspector` 继续用 `uuid ?? id` | `packages/shared/src/message-id.test.ts`，客户端 `mergeMessages` 的既有身份测试 |
| 2026-10-20 | Codex 与客户端工具别名有 7 项相同；文件活动、inspector、display 又各写一遍去标点的小写工具名 | [packages/shared/src/tool-name-aliases.ts](../../packages/shared/src/tool-name-aliases.ts) `SHARED_RENDERER_TOOL_ALIASES`、`lookupToolAlias`。去标点仍只用 [session-files.ts](../../packages/shared/src/session-files.ts) `normalizeToolName`。Pi 的 `ls`/`find` 和 Codex 的 `exec` 不进共享表 | `packages/shared/src/tool-name-aliases.test.ts` |

展示用的 `approval` / `question`、飞书入站分支，以及 PushNotifier 里按工具批准决定是否附带 request id，都不是这套 `PendingInputType` 映射，没有并进来。

2026-10-20 核对：队列、pending input 和设置行测试通过；`PushNotifier` 与 ZCode protocol 相关测试通过；字体检查通过。消息身份这轮另通过 `message-id`、`mergeMessages`、display 投影和搜索索引测试。工具别名这轮通过 `tool-name-aliases` 测试，并在重建 shared 后通过 client 与 server 的 `tsc --noEmit`。

## 8022 运行核对

用户于 2026-10-20 手动重启后，只读核对了本机 `8022`，没有读取会话内容、密钥或日志，也没有打开页面。`4510` 仍未查看。

| 项 | 观察到的值 |
| --- | --- |
| 版本接口 | `http://127.0.0.1:8022/yep/api/version`，与 `/yep/build-info.json` 一致 |
| `buildId` | `2026.9.0-635bf0a88e10-20261020034916` |
| 版本 / commit | `2026.9.0`，`635bf0a88e10c90c7554a11cbae700c563b913c7`，`gitDirty: true` |
| 构建时间 | `2026-10-20T03:49:16.297Z`（北京时间 11:49） |
| 形态 | `basePath` 为 `/yep`，`source` 为 `bundle`。`/yep/api/status/workers` 的 `runtimeMode` 为 `external`；核对时 `activeWorkers` 为 2，`queueLength` 为 0，`hasActiveWork` 为 true |
| 进程 | 11:50 启动。Web 为 `dist/cli.js --port 8022`；runtime 为同一包的 `dist/cli.js --runtime-only --port 8022 --runtime-port 8025` |
| 产物 | `~/.yep-anywhere/runtime/npm-package` 在 11:49 写成。其中已有 `utils/async-queue.js`、`pendingInputTypeFromRequest`、`nonEmptyMessageId`、`normalizeToolName`、`SHARED_RENDERER_TOOL_ALIASES` |

这次重启把上述收口带进了正在运行的 web 和 external runtime。它不代替浏览器里的设置页或会话页验收。

## 下一刀，仍不要直接删

按 2026-10-20 复核，这些还在，但契约不同：

1. 会话正文两套渲染：默认 `RenderItemComponent`，`history=legacy` 和嵌套 transcript 仍走 `ContentBlockRenderer`。工具组在 `DisplayToolGroupRow` 内再分投影行和旧消息行。
2. 思考块：`ThinkingBlock` 按 detail ref 拉取，`ThinkingRenderer` 直接渲染整段文本。
3. 文件预览已收敛（2026-10-21）：会话内所有入口经 `useFilePreview`／`FileOpenButton`（`components/FilePreviewPanel.tsx`）打开唯一的 `FileViewer`，走 `/api/fs/*`；`LocalFileModal`、`LocalMediaModal`、`FilePathLink` 已删除。仍独立的只有上传附件 `AttachmentPreviewModal`（uploads 范围）和会话快照/diff 面板。
4. 审批两套界面：`ToolApprovalPanel`、`QuestionAnswerPanel`（`ZCodeBridgeApprovals` 已随 ZCode 移除）。
5. 工具名其余别名仍分开：客户端还有 `bash`、`Agent`、`webrun` 等；Codex 在有 namespace 时直接拼接，且把 `exec` 映成 `CodexExec`；Pi 把 `ls`/`find` 映成 `Glob`。消息身份里仍用 `uuid ?? id` 的几处见上表，不能改成跳过空白。思考块重新看过：`ThinkingBlock` 是 `<details>` 加按需加载，`ThinkingRenderer` 是另一套按钮。
6. Inbox / GlobalSession 的同名类型还不能放进 `shared`。服务端 Inbox 多 `pendingRequestId`、`originChannel`，标题是 `string`；客户端标题是 `string | null`，多 `runtime`，且没有读取那两个服务端字段。GlobalSession 的服务端 `ownership` 是 `SessionOwnership` 并多 `originChannel`；客户端 `ownership` 用 `SessionStatus`，没有声明 `originChannel`。运行时 JSON 仍带着这些字段，缺的是类型声明，不是另一套接口。
7. Codex、Pi 的 stdout 分帧和 stderr 截断策略不同，协议客户端继续分开。

做完一条就补到「已收口」，并写上测试或检查命令。没有测量数据时，不要把性能候选写成本表的已完成项。
