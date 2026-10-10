# Codex / Pi 旁路聊天调研与 Yep 接入方案

日期：2026-10-09；实现更新：2026-10-10。状态：首版已实现并完成聚焦验证，未部署。

已确认的产品选择：**旁路默认读取创建时的主任务上下文快照；随后独立对话，不自动向主任务回传。**

## 1. 结论

Codex CLI 原生支持 `/side`，`/btw` 是别名。Pi 当前核心没有同名内置功能，但社区 `pi-btw` 扩展实现了并行子会话。两者都可以为 Yep 提供基础能力。

建议 Yep 将其作为统一的「旁路聊天 / Side chat」功能：Codex 使用原生临时 fork；Pi 在 Yep 随包扩展中创建独立 SDK session；前端使用独立聊天面板。旁路拥有自己的输入、事件、状态和停止操作，不能复用主任务的普通发送入口。

首版定位为问答与只读探索，每个主会话同时保留一个旁路，可连续追问。需要执行修改时，通过「带回主任务」交接。

## 2. 已核对的源码与版本

| 对象 | 调研基线 | 本次操作 |
| --- | --- | --- |
| Codex reference | `2351d9e1b608e6f9d9a3699b71d7eb39ee41cfa4`，2026-10-09 | 从 `82e70121f` 快进更新 |
| Pi reference | `f1b2e77f5b13b2a199b1052cb79c235451afe7d7`，2026-10-09 | 从 `b1efcf7d7` 快进更新 |
| pi-btw reference | `d0d1ba5404b66058c501ed3e286733660df56aa9`，0.7.1 | 新增 `references/pi-btw/` 供阅读，未安装插件 |
| 本机 CLI | Codex `0.161.0`；Pi `1.1.0` | 仅运行版本查询 |
| Yep Codex 协议基线 | `0.151.0` | 未更新生成代码；已有所需基础协议类型 |

另外用本机 Codex 导出了**不包含 experimental 字段**的 JSON Schema，确认 `thread/fork` 的 `ephemeral`、`excludeTurns`、`developerInstructions`、`sandbox` 等字段和 `ThreadInjectItemsParams` 都存在。导出位置为 `/tmp/yep-side-chat-schema.uV0Udj/`。这证明本机二进制的协议形状，不代表已经完成运行中主任务上的端到端验证，也不代表 4510 的现有进程必然使用同一版本。

来源：

- [OpenAI 官方旁路聊天说明](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)介绍 `/side [question]` 与选中文字后打开旁路的使用方式。
- [Codex side.rs](../../references/codex/codex-rs/tui/src/app/side.rs)：隔离提示、临时线程生命周期、主任务状态提示、界面历史边界。
- [Codex app_server_session.rs](../../references/codex/codex-rs/tui/src/app_server_session.rs)：`fork_side_thread` 与 fork 参数构造。
- [Codex thread.rs](../../references/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)：`ThreadForkParams`、`ThreadInjectItemsParams`。
- [Codex thread_processor.rs](../../references/codex/codex-rs/app-server/src/request_processors/thread_processor.rs)：临时分页 fork 的约束与快照处理。
- [Pi rpc-mode.ts](../../references/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts)、[agent-session.ts](../../references/pi/packages/coding-agent/src/core/agent-session.ts)：RPC 和扩展命令执行顺序。
- [pi-btw 上游说明](https://github.com/dbachelder/pi-btw/tree/d0d1ba5404b66058c501ed3e286733660df56aa9)、[本地扩展源码](../../references/pi-btw/extensions/btw.ts)：子会话、工具范围、模型隔离和 RPC 降级行为。

## 3. 上游具体做了什么

### Codex：临时 fork 加明确的对话边界

`/side` 与 `/btw` 由 TUI 解释，不是把命令文本发送给模型后自动生效。

其主要流程为：

1. 从父线程建立 `ephemeral: true` 的独立线程，继承主模型与 reasoning 设置。
2. 追加 developer instructions，强调继承历史仅供参考，不能继续父任务、执行旧请求或操作旧子代理。
3. 调用 `thread/inject_items`，在子线程添加隐藏的历史边界。
4. 子线程使用自己的 `turn/start`；父线程继续工作。界面只展示边界之后的对话，不重复展开继承历史。
5. 在旁路中显示父线程的完成、失败、待输入和待审批状态。
6. 丢弃旁路时只中断子线程并 unsubscribe，不中断父线程。

实现时必须保留的细节：

- 分页历史的临时 fork 要使用 `excludeTurns: true`。该参数省略的是响应里的历史内容，不是模型的继承上下文。
- 从运行中的任务取当前快照时不填写 `lastTurnId`；指向运行中 turn 的 `lastTurnId` 会被拒绝。上游会在**子线程副本**中冻结未完成 turn，不代表停止父任务。
- `ephemeral` 线程不支持 goal；不要设置 `deferGoalContinuation`，上游明确拒绝它与 `ephemeral` 同时使用。
- 临时线程不保留 worktree attachments，也不应伪装成普通持久会话。
- 原生旁路主要依靠边界指令约束行为，并沿用权限配置；“旁路”本身不等于强制只读沙箱。Yep 若承诺只读，要另做工具和权限限制。

### Pi：核心提供机制，扩展实现功能

更新后的 Pi 核心没有发现内置 `/btw` 或 `/side` 命令。`pi-btw` 0.7.1 已提供：

- `/btw`、`/side`：继承主上下文的连续旁路；默认提供 `read/bash/edit/write`。
- `/btw:tangent`：不继承主对话的连续旁路。
- `/btw:ask`：继承上下文，只提供 `read/grep/find/ls`。
- 独立模型和 thinking 配置；主动 inject 或 summarize 后带回主任务。

实现使用 `SessionManager.inMemory()` 和 `createAgentSession()`。创建子会话前以 `buildSessionContext(entries, leafId)` 构造当前分支上下文，再订阅子会话事件。这个过程不会切换父 session。

Pi 的 `prompt()` 在流式期间也会优先立即执行扩展命令；`steer()` / `followUp()` 不能等价替代，核心明确拒绝把扩展命令当排队消息使用。原生 `fork` 则涉及当前 AgentSession 替换，不适合作为运行中父任务的旁路入口。

**RPC 限制：**`ctx.ui.custom()` 在 RPC 模式不渲染自定义 TUI。`pi-btw` 因而要求 RPC/SDK 调用者把问题写在命令后面；完成后用可见的 `btw-note` 展示回答，父任务忙时该笔记延后展示。扩展通过 `context` hook 排除这些笔记，避免它们进入父模型上下文；隐藏状态用 `appendEntry` 保存。

因此，不能说这个插件完全不支持 RPC；准确结论是：**它现有 RPC 展示方式不是 Yep 所需的独立实时聊天面板。**

## 4. Yep 当前已有能力和缺口

| 位置 | 当前情况 | 接入要求 |
| --- | --- | --- |
| `packages/client/src/lib/agentCommands.ts` | Codex 静态菜单已经有 `side`、`btw` | 菜单按真实能力显示；不能把“列出命令”当成功能实现 |
| `codexInputCommands.ts` / `SessionPage.tsx` | 特殊发送分支只处理 `/compact`，其余走主消息流程 | 在 optimistic 主消息、主状态和附件处理之前分流旁路命令 |
| `sdk/providers/types.ts` | 有主消息 queue、steer、interrupt 和 Codex controls | 增加独立 side conversation 控制接口 |
| `sdk/providers/codex-protocol/` | 已有 fork/inject/unsubscribe 等类型 | 补能力约束和实际适配，不必为此全面升级协议基线 |
| `codex-bridge/` | 已识别 ephemeral、thread 路由与生命周期 | 复用原 owner/account 的连接路由，旁路不进入普通会话列表 |
| `sdk/providers/pi.ts` | 受管进程通过 `--no-extensions --extension <Yep扩展>` 启动 | 用户全局安装 `pi-btw` 不会自动启用；应由 Yep 显式随包加载适配 |
| `PiRpcClient` 与 `runSession` | 通知汇入单一事件队列；主 turn 循环等 `agent_settled` | 在入口分发 side 事件；主循环空闲时旁路仍须实时推送 |
| `handleExtensionUiRequest` | 普通 notify/status/widget 当前直接忽略 | 单独解析受控的 side event 封装，不能当普通通知丢弃 |
| `runtime/*` | 支持 embedded / external 两种形态 | 两种形态均增加控制、快照和重连事件；持有会话的逻辑放 runtime |
| `SessionInspector.tsx` | 现有右侧信息栏，问题/文件/检查/Git，默认 320px | 复用栏位与风格；聊天面板独立，不嵌进“问题”历史列表 |

服务端 `SessionCommandService` 也需要兜底识别保留命令，避免旧客户端或其他发送入口把 `/side` 文本投递给主模型。不支持时返回明确错误，不静默回退为普通消息。

## 5. 推荐的服务端设计

### 5.1 统一旁路对象和生命周期

新增 runtime 持有的 `SideConversationManager`，以独立 `sideConversationId` 管理旁路，记录：

- 父 `projectId/sessionId`、provider、account/executor、原生子线程标识。
- `contextMode: snapshot | empty`、创建时间、实际捕获时间及可取得的 provider 历史边界。
- 子模型、reasoning、工具策略、状态、当前 turn、消息序号和有界重放缓存。
- 父运行时 generation / connection epoch，避免进程替换后继续复用失效句柄。

界面隐藏与结束会话分开：关闭面板只隐藏；停止只中断旁路当前 turn；“结束旁路”释放子会话。主任务正常结束后，只要 runtime 和子会话仍在，就可以继续追问。

旁路运行期间需要独立 lease，避免父任务进入 idle 后被现有 idle timeout 回收，连带终止 Pi 子会话。旁路容量要有单独的并发限制与成本统计，不能排在父任务占满的 worker 队列之后，也不能无限创建。

首版恢复边界：前端刷新、断线、切换项目可以在同一存活 runtime 内恢复；真正的 runtime / provider 进程重启后临时子会话失效，展示“旁路已结束，可基于最新上下文新建”。不承诺跨进程重启原样恢复。长期旁路历史可以后续单独设计，不能靠扫描主 JSONL 找回 ephemeral 会话。

### 5.2 拟新增的 API 和事件

以下为建议接口，尚未存在：

| 操作 | 接口 |
| --- | --- |
| 创建 / 返回当前旁路 | `POST /api/sessions/:sessionId/side-conversations` |
| 查询状态与消息快照 | `GET /api/side-conversations/:id` |
| 发送旁路消息 | `POST /api/side-conversations/:id/messages` |
| 停止旁路当前 turn | `POST /api/side-conversations/:id/interrupt` |
| 结束旁路 | `DELETE /api/side-conversations/:id` |

创建和发送带 `clientRequestId`，支持幂等重试。服务端校验 side 与父 session/project/account 的归属；客户端不能自由传入一个 native thread ID 绕过归属检查。

事件建议使用独立订阅 scope，携带 `{sideConversationId, parentSessionId, generation, seq, type, payload}`。事件包括 ready、message delta、message completed、tool activity、turn completed、interrupted、error、expired。取消关联实际子 turn；过期 generation 的迟到事件不得写入新旁路。

沿用现有传输和重放基础设施，但使用独立消息 reducer、pending messages、draft key 和状态。不能把旁路结果塞进父 session 的 `SessionDisplayReducer` 或主完成通知。

### 5.3 Codex adapter

在现有 account、bridge owner 和文件环境路由上执行原生请求，保证父线程不发生 resume 接管、连接迁移或进程重启。

核心请求顺序：

```text
thread/fork(parentThreadId, ephemeral=true, excludeTurns=true,
            developerInstructions=原策略+旁路边界, 子权限/模型配置)
→ thread/inject_items(childThreadId, 隐藏边界)
→ turn/start(childThreadId, 旁路问题)
→ 按 childThreadId 分发事件
```

创建无上下文聊天时改用 `thread/start(ephemeral=true)`；“无上下文”仅指不带父对话，项目指令和运行环境是否仍加载需在说明中区分。

能力声明以实际运行端的兼容版本/协议为准；当前 shell 中的 `codex --version` 不能替代远端能力判断。无需依赖新加入的 experimental prediction mode。

只读模式使用独立的只读 sandbox、禁止权限升级，并收窄会产生外部副作用的 MCP/plugin/dynamic tools。仅设置 `sandbox=read-only` 并不能约束所有外部工具；只有验证完整工具范围后才能向 UI 宣告只读能力，失败时不可继承主任务的宽权限继续执行。

### 5.4 Pi adapter

推荐在 `pi-yep-extension.mjs` 随包资源中增加模块化的旁路实现，参考 `pi-btw` 的机制，不把其 TUI 代码和全局安装流程引入 Yep。

1. Yep 私有扩展注册独立控制命令（例如 `/yep:side <结构化参数>`）；对外 `/side`、`/btw` 由 Yep 统一处理。
2. 通过 `prompt` 立即调用该扩展控制命令，绕过主 queue / steer。handler 快速确认接收，异步驱动子 session；不要等待完整模型回答才返回 RPC ACK。
3. 创建时从当前分支的 `buildSessionContext` 复制快照，使用独立的 `SessionManager.inMemory()` 和 `createAgentSession()`。后续不再次读取父上下文。
4. 复制当前动态 provider 配置到独立 model runtime，并传递必要的运行时凭据。不得调用父 session 的 `set_model`，也不能只复制模型 ID 后假设子 session 能读到 Yep 的 gateway 配置。
5. 首版只暴露 `read/grep/find/ls`，不加载父 session 的任意扩展工具。所有继承消息标为参考，当前问题才是新任务。
6. 订阅子 session 事件，通过带版本和标识的受控消息封装传回 Yep。可以利用已有 `extension_ui_request/notify` 通道增加专用 JSON 前缀，但必须在 `PiRpcClient.acceptLine()` 附近先解包分发，避免依赖主 turn 消费循环。
7. 子 session 的 abort/dispose 只操作子对象，不能发送会中断父任务的顶层 RPC `abort`。

启动时做扩展能力握手；未注册、版本不匹配或 command disposition 异常时禁用入口。否则私有控制文本可能被错误当成主模型输入。父 session reload/fork/switch 时使旧 generation 失效并清理对应旁路，不能继续使用捕获的过期 extension context。

首版不向父 session 写 `sendMessage`、custom note 或 hidden transcript；旁路展示和存活期缓存由 Yep 管理。未来若复制第三方实现，保留 MIT 许可与归属。

## 6. UI 与配置

### 6.1 入口和布局

主会话输入区增加「旁路 / Side chat」入口，运行中仍可用。`/side`、`/btw` 打开旁路；带参数时打开并立即提问；空命令只打开面板。第二阶段可增加消息操作「在旁路中询问」。

桌面端使用右侧独立聊天面板，与现有 Inspector 共用右侧位置，通过「详情 / 旁路」切换，避免叠出两个侧栏。旁路建议约 400–480px；现有详情栏维持原宽度。空间不足时使用覆盖式面板，不压缩主消息到难以阅读。

```text
主会话                                      详情 | 旁路       收起
                                            主任务：运行中 / 等待审批
agent 正在继续工作…                         上下文快照 14:32 · 只读
                                            你：这个方案为何选 SQLite？
                                            AI：……
                                            [带回主任务]
主输入框 + 旁路入口                         旁路输入框       发送 / 停止
```

手机端用全屏旁路视图，顶部保留「返回主任务」和实时主任务状态条。不要在有限高度内同时放两个输入框。切回主任务只切换视图，保留旁路流式生成、草稿和滚动位置。

沿用现有 typography、Markdown/代码展示和深浅色 tokens。界面不暴露 native thread ID、RPC 方法、插件内部命令等实现细节。

### 6.2 用户能理解的状态

| 状态 | 展示与操作 |
| --- | --- |
| 未开始 | 简短说明“读取当前任务的上下文快照，聊天不会自动带回主任务” |
| 创建中 | 仅旁路显示 loading；失败保留问题文本 |
| 回复中 | 独立流式回复和「停止旁路回复」；主停止按钮行为不变 |
| 主任务等待审批 / 输入 | 面板顶部显示明确提醒，点击返回主任务，不把审批转交旁路 |
| 主任务完成 / 失败 | 更新状态条；不清空旁路、不抢输入焦点 |
| 断线 | 显示重连，按 seq 补事件；不能直接判定模型已停止 |
| runtime 失效 | 标记临时旁路已结束，允许基于最新主上下文新建 |
| 内容过长 / 上下文溢出 | 显示具体错误并提供新建入口，不静默丢失历史 |

旁路只呈现新对话，顶部显示「上下文快照 HH:mm」。需要主任务最新进展时，通过「新建旁路，使用最新上下文」创建新的快照，不在追问时悄悄更新旧上下文。

桌面键盘焦点只落在当前活动输入框；覆盖式面板有正确的 dialog 焦点管理与返回焦点。关闭按钮表示隐藏，不兼任取消生成。流式文本不要逐 token 触发屏幕阅读器公告，状态变化适量播报。

### 6.3 带回主任务

首版点击「带回主任务 / Bring to main task」时，将选中的旁路内容作为引用放入主输入框，让用户补充要主任务做什么；此操作本身不发送消息。

父任务忙时，用户可继续选择现有的排队或立即插话；默认建议排队。每次交接使用请求 ID 去重。摘要生成属于显式操作，不因收起旁路自动调用模型或发送内容。

### 6.4 建议的配置范围

| 配置 | 默认值 | 放置位置 |
| --- | --- | --- |
| 是否展示旁路入口 | 支持的 provider 默认展示 | 会话 UI；由服务端 capability 决定能否使用 |
| 上下文 | **当前任务快照，已获用户确认** | 新建旁路菜单可选“不带主对话上下文” |
| 模型 / reasoning | 创建时继承主任务 | 面板设置；覆盖值只作用于旁路 |
| 工具 | 只读探索 | 首版固定，不继承主任务宽权限 |
| 展示方式 | 桌面侧栏；手机全屏 | 响应式自动选择；本地记住收起/展开状态 |
| 带回方式 | 先放入主输入框 | 无需新增全局“自动注入”选项 |
| 历史保留 | 同一存活 runtime 内恢复 | 首版不提供会让用户误解的“永久保存”开关 |

不要新增一整页设置。模型偏好按服务器/provider 保存；草稿按服务器、父 session 和 side ID 隔离；服务端保存实际生效的 side 配置。`en` / `zh-CN` 同步增加文案。

## 7. 实施顺序与验收

### 第一阶段：可靠的端到端旁路

1. shared 数据契约、runtime manager、embedded/external 控制和重放；独立并发配额与 lease。
2. Codex native fork adapter；Pi 私有扩展与入口事件分发。
3. `/side` / `/btw` 客户端和服务端分流、能力门控。
4. 桌面/手机旁路面板，连续追问、停止、收起恢复、主任务状态条、带回主输入框。
5. 更新 `CHANGELOG.md [Unreleased]`，按 provider/runtime/client 范围运行聚焦检查。

### 第二阶段：增强便利性

选中文字后提问、独立模型选择、显式摘要交接、多个历史旁路与长期保存。后两项需要另外定义临时 native session 失效后的恢复语义，不能直接宣称 resume 原会话。

关键自动化检查应覆盖真实隔离行为：

- 父任务持续输出时创建和追问旁路；父 thread/session/turn、状态、queue 和消息计数不被旁路操作改写。
- 停止旁路仅向 child turn / SDK session 发取消；父任务仍持续输出。
- Pi 主循环 idle、busy、waiting approval 时旁路事件均可及时分发；私有命令 ACK 不等待答案，不进入普通主提示。
- 父上下文含未完成工具调用、压缩记录、历史分支时，快照仍为 provider 可接受的有效上下文；不能直接复制 UI 消息数组。
- Codex 临时分页 fork、旧版本能力失败、bridge account/owner 路由、无首条父消息的错误提示。
- 子模型、thinking、只读工具策略和 token 统计不覆盖父配置；动态 gateway 模型能在子 session 正确解析。
- 收起/返回、断线重放、重复发送、多客户端竞争、进程失效和迟到事件不串会话。
- 旁路存在时 idle timeout 不错误回收仍有工作的 provider；单 worker 配置不让旁路永远等待父任务结束。
- 中英文文案、独立草稿和“带回仅填入草稿”的行为。

浏览器验证与真实模型并发 smoke 留到实现后按用户授权执行。2026-10-09 调研阶段只完成源码、CLI 版本和静态协议检查，未调用模型、未安装插件、未重启服务，也未改产品代码；后续实现记录见第 8 节。


## 8. 2026-10-10 实现与验证记录

首版实现沿用上面的上下文选择与隔离边界，实际交付如下：

- 新增共享请求 schema、独立 `SideConversationSession`、Codex/Pi adapter；每个父会话一个旁路，进程内最多四个存活旁路，不占主任务 worker queue。
- 实际接口为 `POST /api/sessions/:sessionId/side-conversation`，以 `action=get/create/send/interrupt/close` 分发。embedded 与 external runtime 使用同一接口契约；旧 runtime 返回不支持，不触发主流程回退。
- 首版使用独立、按版本读取的内存快照，回复中约 650ms 轮询、空闲 3s；面板隐藏后停止持续轮询，浏览器不可见时暂停读取。只有版本变化才传输 transcript。这样不需要改动主会话 WebSocket/SSE、display reducer 和重连协议。返回体、草稿和错误状态相互独立。
- Codex 的请求/响应不进入父 provider journal；子线程通知与审批在 RPC 入口分流。结束后保留子线程识别信息，丢弃迟到事件。外部 bridge 会话用独立观察连接读取父信息后 fork，不 resume 或 steer 父线程；模型、reasoning 与 service tier 从 bridge 的会话视图读取。
- bridge 对 `ephemeral + read-only + never` 的临时线程使用 clear MCP 配置，原连接的 profile 不变。MCP 的空工具 allowlist 提供第二层限制。Codex 同时禁用 shell、agents、插件、hooks、浏览器与外部工具；Pi 只提供 read/grep/find/ls。
- 原生验证发现 `features.multi_agent=false` 并不足以关闭 Codex 0.161.0 的 agent 工具，已补 `agents.enabled=false`。本机实际模型请求工具清单已核对为 `request_user_input` / `view_image`；前者的 server request 被旁路通道拒绝，不转为主任务审批。Codex 首版主要用于快照问答，不开放 shell 文件探索。
- Pi 扩展只在受管进程中随包加载，SDK 懒加载；使用独立 in-memory settings/session/model runtime；复制网关模型配置和凭据，不修改父 model/settings。私有命令先通过 `get_commands` 验证，再携带进程令牌调用；其 ACK 和流式输出不依赖父 `agent_settled`。
- 主任务发送服务拒绝 `/side`、`/btw` 和内部控制命令，防止旧客户端把旁路请求当成普通消息。UI 在 optimistic 主消息创建之前分流。
- 会话页顶部提供旁路入口，桌面右栏与详情栏共用位置，手机全屏；支持连续追问、收起、单独停止、结束后新建、主任务状态、完成后 Markdown 和“带回主输入框”。带回动作读取实时草稿并追加，不直接发送。
- 单轮最长 10 分钟，无访问的空闲旁路 30 分钟释放；最多 100 条消息 / 512,000 字符，Pi 快照入口另有大小限制。真正 provider/runtime 退出、父会话替换或原有 idle preemption 会使子会话失效；没有为了旁路去修改主任务调度优先级。使用者须新建旁路，不能将临时线程当持久会话 resume。

验证证据：

1. 聚焦测试覆盖独立消息、创建/发送去重、取消范围、创建与关闭竞争、容量回收、超时、父发送入口保护、bridge profile、外置 runtime、草稿、IME 和关闭面板行为。
2. 本机 Pi 1.1.0 使用真实安装的 SDK 创建、销毁子会话；使用测试模型配置，阻断 fetch，记录网络请求为 0。
3. 本机 Codex 0.161.0 使用临时 CODEX_HOME 和本机模拟 Responses 服务：父请求保持未结束时创建快照 fork，子线程回答并关闭后父线程仍 active，随后父线程正常完成；共两个模拟请求，无真实模型用量。
4. 原生并发探测已保留为 `pnpm exec tsx --conditions source scripts/smoke-side-conversations.ts`，包含父任务持续运行、快照/边界继承和子工具清单断言。
5. TypeScript、改动文件 Biome、客户端临时目录构建和机械设计检查按实现范围执行；未进行浏览器自动化，未安装全局插件，未重启现有服务。

模型选择器、选中文字后提问、多旁路列表和跨运行时重启的永久保存仍属于第二阶段；首版固定继承模型/思考等级，仅允许切换新建旁路是否携带主对话快照。

旁路隔离的是任务指令、消息、权限和生命周期；它仍会产生额外模型用量，并与主任务共享对应账户的速率限制和机器资源。首版以独立并发上限约束这部分开销，不承诺资源层面的零竞争。
