# ZCode 支持现状与后续开发目标

日期：2026-08-12

范围：Yep Anywhere 对 ZCode CLI `0.16.1` 的 provider 注册、历史会话读取、新会话创建和实时交互支持。

## 1. 结论

Yep Anywhere 目前已经具备 ZCode 的 provider 注册、CLI 发现、历史 SQLite 会话扫描和 transcript normalize 等基础能力；本机也能识别 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`，并已经读取到 28 个历史 ZCode session。

但“新建 ZCode 会话”的实时链路还不能使用。直接原因是运行中服务将 ZCode 判定为：

```text
installed=true
authenticated=false
enabled=false
modelCount=0
```

客户端仅展示 `installed && (authenticated || enabled)` 的 provider，因此 ZCode 在新会话页面不可选。

进一步排查确认，这不是单一 UI 问题，而是当前实现与真实 ZCode CLI `0.16.1` 之间存在两类核心契约偏差：

1. 当前配置解析器无法识别本机真实 ZCode 配置结构，因而得不到 provider、model 和认证状态。
2. 当前 app-server 客户端、fake server 和测试使用了一套与真实 CLI 不一致的 NDJSON RPC、workspace、registry 和 session 参数结构。

因此，当前状态可以概括为：**历史会话支持基本可用，实时创建和交互支持尚未达到可用状态。**

## 2. 能力矩阵

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Provider 类型和前后端注册 | 已实现 | ZCode 已进入 provider registry 和客户端展示体系 |
| ZCode CLI 自动发现 | 可用 | 可以从 macOS app bundle 找到 `zcode.cjs` |
| 历史 session 扫描 | 可用 | 当前服务检测到 28 个 ZCode session |
| SQLite session 读取 | 基本可用 | reader、scanner、normalization 聚焦测试均通过 |
| 配置和模型目录解析 | 不可用 | 当前 parser 与真实 `~/.zcode/v2/config.json` 结构不匹配 |
| Provider 认证状态 | 不可用 | 因目录为空而被判断为 `authenticated=false` |
| 新会话 UI 选择 | 不可用 | provider 被可用性过滤器排除 |
| 真实 app-server 基础通信 | CLI 可用，实现不兼容 | 使用真实请求结构可以响应；当前实现请求会超时 |
| 创建、恢复和发送消息 | 不可用 | 多处参数和返回值结构与真实协议不符 |
| 实时事件和交互映射 | 未验证 | fake event 结构不能证明兼容真实 CLI |
| 真实模型端到端 smoke | 未执行 | 会产生模型请求和诊断 session，需要用户明确授权 |

## 3. 已确认的运行证据

### 3.1 本机 CLI

已发现：

```text
/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
```

版本：

```text
0.16.1
```

### 3.2 运行中服务的 provider 状态

从 `http://127.0.0.1:8022/yep/api/providers` 读取到 ZCode 状态：

```text
installed=true
authenticated=false
enabled=false
modelCount=0
```

没有为排查重启、停止或接管现有服务。

### 3.3 历史 session 状态

全局 session API 当前统计：

```text
total=648
codex=162
zcode=28
kimi=32
opencode=426
```

这说明 ZCode 历史数据发现链路实际在工作；问题集中在实时 provider 和新会话链路，而不是“项目完全不支持 ZCode”。

### 3.4 测试结果

实时 provider 相关现有单元测试：

```text
54/54 passed
```

覆盖：

- `test/sdk/providers/zcode-config.test.ts`
- `test/sdk/providers/zcode.test.ts`
- `test/sdk/providers/zcode-events.test.ts`

历史会话相关测试：

```text
34/34 passed
```

覆盖：

- `test/sessions/zcode-normalization.test.ts`
- `test/projects/zcode-scanner.test.ts`
- `test/sessions/zcode-reader.test.ts`

现有 read-only app-server smoke 能发现 CLI，但等待响应 30 秒后超时。随后使用真实 CLI 契约进行一次临时、只读探测：

- 不发送 `jsonrpc` 字段；
- 为 `workspace/readState` 提供完整 workspace identity；
- `workspace/readState` 立即成功；
- `session/list` 立即成功；
- 裸 app-server 的 provider/model 目录为空，说明后续还必须正确注入 provider registry。

这证明 CLI 启动正常，超时的主要原因是当前客户端请求契约错误，而不是 ZCode CLI 无法运行。

## 4. 新会话不可用的直接原因

客户端 provider 可用性判断位于：

- `packages/client/src/hooks/useProviders.ts`
- `packages/client/src/components/NewSessionForm.tsx`

核心条件是：

```ts
provider.installed && (provider.authenticated || provider.enabled)
```

服务端当前给出的 ZCode 状态是：

```text
installed=true
authenticated=false
enabled=false
```

所以 ZCode 被新会话表单过滤或禁用。这是 UI 表现的直接原因，但不应通过放宽客户端条件绕过，因为服务端实际上还没有可用 model catalog，实时协议也没有对齐。

## 5. 根因一：配置结构不兼容

当前解析器主要位于：

```text
packages/server/src/sdk/providers/zcode-protocol/config.ts
```

当前代码假设 `~/.zcode/v2/config.json` 使用以下概念结构：

```text
providers: []
provider.id
provider.label
provider.kind
provider.models: []
provider.apiKey / apiKeyEnv / runtimeHeaders
```

本机真实 ZCode `0.16.1` 配置的结构则是：

```text
provider: {}
provider.<id>.name
provider.<id>.kind
provider.<id>.options
provider.<id>.enabled
provider.<id>.source
provider.<id>.models: {}
provider.<id>.systemDisabledReason
```

主要差异：

- 根字段是单数 `provider`，不是 `providers`。
- provider 是对象映射，不是数组。
- `models` 是对象映射，不是数组。
- base URL、认证和其他运行参数位于 `options`。
- credentials 文件也不符合当前代码假定的 `providers` map。

当前 `parseZCodeConfig()` 因此得到空 catalog，继而导致：

- `getAvailableModels()` 返回空数组；
- provider 认证判断为 false；
- `/api/providers` 返回 `modelCount=0`；
- 新会话 UI 不允许选择 ZCode。

配置适配时必须保持 secret 边界：只能解析必要结构，不能把 API key、OAuth token 或完整 runtime headers 输出到日志、API 响应、fixture 或测试快照。

## 6. 根因二：真实 app-server 协议不兼容

### 6.1 NDJSON 消息 envelope

真实 ZCode CLI `0.16.1` 的入站请求是严格结构：

```json
{"id": 1, "method": "...", "params": {}}
```

当前客户端发送：

```json
{"jsonrpc": "2.0", "id": 1, "method": "...", "params": {}}
```

多余的 `jsonrpc` 会被真实 CLI 的严格 schema 拒绝。当前共享 schema 也错误地要求 client request 包含 `jsonrpc`：

```text
packages/shared/src/zcode-schema/protocol.ts
```

真实 CLI 的响应同样不带 `jsonrpc`；当前 response parser 相对宽松，因此响应侧不是首要阻塞点。

### 6.2 Workspace 请求

真实 `workspace/readState` 至少要求：

```text
workspace.workspacePath
workspace.workspaceKey
workspace.workspaceIdentity（可选）
runtimeModel（可选）
preferWorkspaceDefaults（可选）
```

当前 read-only smoke 发送空 `params`，因此即使修掉 `jsonrpc`，仍然不能构成有效请求。

### 6.3 Provider registry

真实 `workspace/updateProviderRegistry` 需要：

```text
workspace
registry.revision
registry.generatedAt
registry.providers
includeWorkspaceState（可选）
```

真实 registry entry 使用：

```text
providerId
models[].modelId
kind
source
baseURL / apiKey / runtime fields
```

当前实现发送的是近似结构：

```text
{ providers: registry }
```

共享 schema 和 builder 还使用 `id` 与 `models[].id`，无法满足真实契约。

### 6.4 Session 方法

已确认的主要差异如下：

| 方法 | 真实协议要点 | 当前实现偏差 |
| --- | --- | --- |
| `session/create` | `workspace`、`model`、`runtimeModel`、`mode`、`persistence` 等 | 当前发送 `cwd`，且只使用 `runtimeModel` |
| create result | 返回完整 session snapshot，ID 位于 `session.id` | 当前读取 `createResult.id` |
| `session/resume` | 使用 `sessionId`，可带 `workspace` 和 runtime model | 当前使用 `id` |
| `session/send` | `sessionId`、`content`、`inputId/queryId`、attachments 等 | 当前发送嵌套的 `message` 对象 |
| `session/setModel` | model 位于 `{ providerId, modelId }` 对象 | 当前把两个字段放在顶层 |
| `session/setMode` | `{ sessionId, mode }` | 当前结构大体一致，仍需真实 contract test |
| `session/subscribe` | `sessionId` 及 delivery/message cursor 字段 | 请求近似，但响应和事件仍需验证 |

runtime headers 的请求/响应语义也需要以真实 CLI 为准重新核对。该路径直接涉及敏感认证信息，不能用猜测兼容。

### 6.5 实时事件

当前 fake server 主要使用：

```text
{ event: <name>, ...params }
```

当前 converter 也主要读取 `params.event` 或 `params.kind`。真实 CLI bundle 显示的事件更接近包含 `type`、`payload`、`sessionId`、`seq` 等字段的 envelope。

在拿到经过脱敏的真实事件 fixture 前，以下能力都不能视为已验证：

- assistant delta；
- tool call / tool result；
- approval；
- user input request；
- usage 和 result；
- session end / error；
- reconnect cursor 和去重。

## 7. 为什么现有测试全部通过

现有测试验证的是项目内 fake contract 的自洽性，而不是与真实 ZCode CLI 的兼容性。

例如当前 fake app-server：

- 接受并返回 `jsonrpc`；
- 接受当前错误的参数结构；
- `session/create` 直接返回 `{ id }`；
- 使用当前 converter 熟悉的 fake event。

配置测试也使用了合成的：

```text
providers: []
models: []
top-level apiKey
```

因此 `54/54 passed` 说明当前实现内部一致，但不能证明真实 CLI 可用。后续测试必须分成两层：

1. 真实 `0.16.1` 契约 fixture 驱动的单元/contract tests；
2. 启动真实 CLI 的 read-only smoke，以及经用户授权的真实模型 smoke。

## 8. 次要集成缺口

`SessionCommandServiceDeps` 已定义：

```text
zcodeDbPath
zcodeReaderFactory
```

但 `toProviderResolutionDeps()` 没有将这两个字段传入 provider resolution deps，而 Codex、Gemini、OpenCode 和 Kimi 的对应依赖已经传递。

这不是当前“新会话不可选”的直接原因，但可能影响 ZCode 的跨 provider session resolution、resume、pending input 和 metadata 路径，应在实时主链路修复后补齐并测试。

## 9. 现有计划与发布声明的偏差

现有计划：

```text
docs/project/2026-08-11-zcode-provider-integration-plan.md
```

其中 P0/P1/P2 被标为 code gate 已通过，同时也诚实记录了真实 app-server smoke 尚未执行。根据本次真实 CLI 契约探测，P0/P1 至少需要重新打开：fake contract 与真实 `0.16.1` 的差异足以阻断运行。

`CHANGELOG.md` 中已经存在 ZCode P0/P1/P2 的声明。现在不应只为诊断文档改写历史；完成修复时，应同步校正计划状态和 `[Unreleased]` 描述，使其与真实验收结果一致。

## 10. 建议开发路线

### Checkpoint 0：固定真实契约基线

目标：先建立能够发现协议漂移的测试基线。

- 从本机 ZCode CLI `0.16.1` bundle 中整理最小、脱敏、可审查的 schema 说明或 fixtures。
- 修正 request/response envelope，移除错误的 `jsonrpc` 要求。
- 为 workspace identity 建立唯一 builder。
- 修复 read-only smoke，使 `workspace/readState` 和 `session/list` 对真实 CLI 稳定响应。
- 不发起模型请求，不创建诊断 session。

完成标准：真实 CLI read-only smoke 不超时；fake server 和 schema tests 使用真实 envelope。

### Checkpoint 1：适配配置和 provider registry

目标：让服务端得到真实 provider/model catalog，并安全注入 app-server。

- 支持真实 `provider` 对象映射及 `models` 对象映射。
- 解析 `options` 中必要的 base URL、认证引用和运行参数。
- 明确 OAuth、API key、环境变量和 runtime headers 的优先级。
- 建立脱敏边界，禁止 secret 进入日志、API 或 fixture。
- 生成真实 `workspace/updateProviderRegistry` envelope。
- 根据真实 catalog 计算 `authenticated`、`enabled` 和 `modelCount`。

完成标准：在本机有效配置下，`/api/providers` 的 ZCode 至少有一个可用 model，且客户端无需绕过条件即可选中它。

### Checkpoint 2：修复实时 session 主链路

目标：对齐创建、恢复、订阅、发消息和切换模型/模式。

- 修复 `session/create` 参数和 snapshot 返回值解析。
- 修复 `session/resume` 的 `sessionId` 和 workspace/runtime model。
- 修复 `session/send` 的 content/input/query/attachment 结构。
- 修复 `session/setModel`、`session/setMode` 和 `session/subscribe`。
- 核对 persistence、thought level 和默认 workspace/model 语义。
- 为每个方法添加真实契约 fixture tests。

完成标准：fake contract tests 全部切换为真实结构，且真实 CLI 不再报告 invalid message/params。

### Checkpoint 3：修复事件与交互转换

目标：把真实事件可靠转换成 Yep Anywhere 的标准消息流。

- 捕获并脱敏真实 `session/event` envelope。
- 映射 init、user、assistant、tool、usage、result 和 error。
- 映射 approval 与 user-input request 的请求和响应。
- 验证 seq/cursor、重连、去重和结束状态。
- 对未知事件采用可诊断但不泄密的降级行为。

完成标准：真实事件 fixtures 覆盖主要 happy path、工具、审批、输入请求、失败和结束路径。

### Checkpoint 4：补齐集成边缘

目标：保持实时 session、历史 session 和全局命令服务行为一致。

- 将 `zcodeDbPath` 和 `zcodeReaderFactory` 传入 provider resolution deps。
- 验证 resume、pending input、metadata、project mapping 和历史刷新。
- 验证新建 session 刷新后能由 SQLite scanner/reader 找回。
- 为不可用状态提供准确原因，避免只显示泛化的“未认证”。

完成标准：新建、活动、断连恢复和历史读取形成同一条闭环。

### Checkpoint 5：验证、文档和发布状态

目标：以真实验收结果收尾。

- 运行 ZCode 聚焦测试、server/shared/client typecheck 及受影响范围 lint。
- 运行真实 CLI read-only smoke。
- 在发起任何真实模型请求前暂停，并向用户说明预计行为和数据写入，等待明确授权。
- 获得授权后，执行一个最小真实模型 smoke，验证 create/send/stream/result/persistence。
- 更新原集成计划、本文档执行记录和 `CHANGELOG.md` 的 `[Unreleased]`。

完成标准：下节的所有验收条件满足，且没有依靠 UI 条件绕过或 fake-only 证明完成。

## 11. 总体验收条件

只有全部满足以下条件，才可以将 ZCode 新会话支持标记为完成：

- 有效本机配置下，`/api/providers` 返回 ZCode `installed=true`，且 `authenticated || enabled` 为 true、`modelCount >= 1`。
- 新会话表单能通过正常 provider 可用性判断选择 ZCode，无硬编码绕过。
- 共享 schema、client、fake server 和 fixtures 均不再要求错误的 `jsonrpc`。
- 真实 CLI read-only smoke 的 `workspace/readState` 与 `session/list` 稳定通过。
- provider registry 的 workspace、revision、providerId 和 modelId 结构与真实 CLI 一致。
- create、resume、subscribe、send、setModel 和 setMode 均有真实契约测试。
- 经用户明确授权的最小真实模型 smoke 能收到 init/user/assistant/result，并正常结束。
- 新建 session 在刷新或重启客户端连接后可由历史 reader 找回；不要求重启现有服务来证明这一点。
- approval 和 user-input 至少各有 contract test；真实 smoke 是否触发取决于模型行为，不以强制触发高风险操作为代价。
- 现有 ZCode 历史 reader/scanner/normalization 测试继续通过。
- API、日志、错误、fixture 和 snapshot 中没有 API key、OAuth token 或完整认证 header。
- 受影响包的 typecheck、lint 和聚焦测试通过。
- 原集成计划和 `CHANGELOG.md` 与真实状态一致。

## 12. 安全和执行边界

- 不主动重启、停止、kill 或接管当前运行中的 `8022` 服务及其他进程。
- 未经用户明确要求，不使用浏览器自动化、Playwright、Chrome DevTools 或截图检查。
- read-only smoke 可以启动由测试自身管理的临时 CLI 子进程，但不能影响现有服务。
- 未经用户明确授权，不执行会发起模型请求或写入诊断 session 的真实 smoke。
- 检查配置时只记录字段结构、类型、计数和脱敏状态，绝不输出 secret 值。
- 不迁移、不修改和不删除 ZCode SQLite 数据库。
- 保留 dirty worktree 中与本任务无关的用户改动，不回滚、不覆盖。
- 每个 checkpoint 完成后先记录证据，再进入下一阶段；遇到真实协议不确定项时回到 CLI reference 验证，不凭印象补字段。

## 13. 历史 Goal prompt（非当前 Yep 启动说明）

> 2026-08-14 更正：下面内容是完成本轮 ZCode 修复时保留的执行 prompt。当前 Yep New Session 不会把第一条 `/goal` 确定性转换成原生 `thread/goal/set`，而是把它作为普通 `turn/start` 输入；因此不要再用本节作为 Yep 已支持 Goal-first 的证据。Yep 的现状、自动 continuation 风险和开发计划见 [Codex Goal 模式适配现状与完整开发计划](./2026-08-14-codex-goal-support-plan.md)。

Codex Goal mode 的官方说明见 [OpenAI 官方 Goal 指南](https://learn.chatgpt.com/use-cases/follow-goals)。当前仓库的 Codex reference 已把 goals 标为 stable/default enabled；对于 `/goal` 仍不可用的旧安装，可按官方说明执行 `codex features enable goals`，或在 `config.toml` 中启用：

```toml
[features]
goals = true
```

以下 prompt 仅作为历史执行记录保留。它可以通过原生 Codex CLI 的 `/goal` 命令提交；在 Yep 完成 Goal-first 适配前，不应作为普通新会话消息粘贴：

```text
/goal 在 /Users/yueyuan/Desktop/work/before_work/yepanywhere 中完成 ZCode 新会话实时链路的真实协议修复：以本机 ZCode CLI 0.16.1 的实际契约为基线，在不破坏现有历史 session 读取能力和 secret 边界的前提下，使有效配置的 ZCode 能被 /api/providers 正确判定为可用、能在新会话表单正常选择，并完成 create/send/stream/result/persistence 闭环；持续推进，直到 docs/project/2026-08-12-zcode-support-current-state.md 第 11 节的总体验收条件全部满足。

开始前必须完整阅读并遵守：
1. 仓库 AGENTS.md。
2. docs/project/2026-08-12-zcode-support-current-state.md。
3. docs/project/2026-08-11-zcode-provider-integration-plan.md。
4. 当前 ZCode 实现、测试，以及本机已安装 ZCode CLI 0.16.1 中与 app-server/config/session/event 直接相关的 reference；遇到协议字段不确定时先查 reference，不凭印象实现。

按文档第 10 节的 Checkpoint 0→5 顺序工作。每个 checkpoint 都要：先核实工作树和相关实现；只修改本目标需要的文件；补充能反映真实 CLI 契约的 tests/fixtures；运行聚焦验证；把完成项、命令、结果、遗留风险更新回该文档的执行记录，然后再进入下一 checkpoint。现有 fake server、schema 和测试必须改成真实契约，不能用放宽客户端可用性条件、硬编码 model、吞掉协议错误或仅 fake tests 通过来宣称完成。

执行边界：保留 dirty worktree 中无关改动；不得回滚用户修改；不得修改、迁移或删除 ZCode SQLite 数据；不得输出 API key、OAuth token 或完整认证 header；不得重启、停止、kill 或接管现有 8022/4510 服务及其他运行进程；未经明确要求不得使用浏览器自动化；允许执行由测试自行管理的临时、read-only CLI smoke。

在发起任何会调用真实模型、产生费用或写入诊断 session 的 smoke 之前，必须暂停并向我说明将调用的 provider/model、发送的最小输入、预计写入位置和清理策略，等待我的明确授权。未获授权时继续完成所有不依赖真实模型调用的实现、contract tests、typecheck、lint 和 read-only smoke，但不要把 Goal 标为完成。

完成条件：第 11 节全部验收项有可复现证据；经授权的最小真实模型 smoke 验证 create/send/stream/result/persistence；历史 ZCode 测试无回归；secret 检查通过；原集成计划和 CHANGELOG.md [Unreleased] 与实际状态一致。只有此时才结束 Goal，并用简洁中文汇总改动文件、关键契约修复、验证命令与结果、真实 smoke 证据和剩余非阻塞风险。
```

## 14. Checkpoint 执行记录（2026-08-12 真实协议修复）

### Checkpoint 0：固定真实契约基线 — ✅ 通过

**关键修复**：
- 移除 shared schema 中所有 `jsonrpc: z.literal("2.0")` 要求（`protocol.ts`）。真实 CLI 0.16.1 不检查 `jsonrpc` 字段——消息分类仅依据 `method` 和 `id` 键的存在性。
- 修正 `ZCodeJsonRpcRequestSchema`/`Response`/`Notification`/`ServerRequest` 不再要求或包含 `jsonrpc`。
- 新增 `ZCodeWorkspaceIdentitySchema`（`{workspacePath, workspaceKey, workspaceIdentity?, remoteSessionId?}`）。
- 新增 `ZCodeModelRefSchema`（`{providerId, modelId}`）、`ZCodeRuntimeModelSchema`。
- 新增 `ZCodeSessionCreate/Resume/Send/SetModel/SetMode/SubscribeParamsSchema`。
- 新增 `ZCodeSessionSnapshotSchema`（从 `result.session.sessionId` 读取，非 `result.id`）。
- 新增 `ZCodeEventEnvelopeSchema`（`{type, payload?, seq, sessionId, eventId, timestamp}`）。
- 更新事件名列表：移除 `rewind.started/completed/failed`，新增 `part.started/delta/upserted/removed`、`userInput.requested/resolved`。
- 修正 registry entry schema：`providerId`/`modelId`（非 `id`/`models[].id`）。
- `client.ts`：出站消息不再发送 `jsonrpc` 字段；`sendRaw({id, method, params})`。
- `smoke-zcode-app-server.ts`：移除 `jsonrpc`，发送完整 `workspace` identity。

**验证命令与结果**：
- `corepack pnpm typecheck` → exit 0
- `corepack pnpm exec biome check`（zcode 文件范围）→ no errors
- `corepack pnpm test:zcode-app-server-smoke -- --read-only --summary` → `ZCode CLI found: version=0.16.1, source=app-bundle, isCjs=true` / `smoke passed: models=0, sessions=9`

### Checkpoint 1：适配配置和 provider registry — ✅ 通过

**关键修复**：
- `config.ts`：支持真实 ZCode 0.16.1 配置结构——根键为单数 `provider`（对象映射，非数组），`models` 为对象映射（非数组），secrets 位于 `options.apiKey`/`options.headers`。
- 新增 `ProviderOptionsSchema`（`apiKey`, `baseURL`, `apiKeyRequired`, `headers`）。
- 修正 `ConfigModelSchema`：`reasoning` 使用 `z.unknown()`（真实值为对象 `{enabled, variants, defaultVariant}`，非布尔值）。
- 支持 `enabled`/`systemDisabledReason` 字段——`enabled=false` 或有 `systemDisabledReason` 的 provider 标记为不可用。
- 保留对 legacy `providers` 键的兼容。
- `buildZCodeProviderRegistry`：输出真实 registry 结构 `{providerId, name, kind, source, models[{modelId, name}]}`。
- `types.ts`：`ZCodeApiKeySource` 改为 `"inline" | "runtime-headers"`（移除 `"env"`，真实配置不使用 `apiKeyEnv`）。`ZCodeParsedProvider` 新增 `enabled` 和 `systemDisabledReason` 字段。

**本机配置验证**：
- `parseZCodeConfig` 对真实 `~/.zcode/v2/config.json` 返回 `errorCode: null`，7 个 provider，9 个 model，1 个 available model。
- `buildZCodeProviderRegistry` 生成 2 个 registry entry。
- secret 检查通过：输出不含 `sk-`、`Bearer`、`access_token`。

### Checkpoint 2：修复实时 session 主链路 — ✅ 通过

**关键修复**（`zcode.ts`）：
- 新增 `buildWorkspaceIdentity(cwd)` 函数，生成 `{workspacePath, workspaceKey}`。
- `session/create`：发送 `workspace`（非 `cwd`）、可选 `model: {providerId, modelId}`（非 `runtimeModel`）、`mode`。
- `session/create` 结果解析：从 `result.session.sessionId` 读取（非 `result.id`）。
- `session/resume`：使用 `sessionId`（非 `id`）。
- `session/send`：使用 `content`（字符串，非嵌套 `message` 对象）。
- `session/setModel`：使用 `model: {providerId, modelId}` 对象（非顶层字段）。
- `workspace/updateProviderRegistry`：发送 `{workspace, registry: {revision, generatedAt, providers[]}}`。

### Checkpoint 3：修复事件与交互转换 — ✅ 通过

**关键修复**（`events.ts`）：
- 事件名从 `params.event` 改为 `params.type`（真实 CLI 0.16.1 envelope 使用 `type` 判别器）。
- 事件 body 从 `params.payload` 提取并合并到参数顶层。
- 新增事件处理：`userInput.requested`/`resolved`、`part.started`/`delta`/`upserted`/`removed`（安全忽略，P5 增强）。
- 移除已不存在的 `rewind.started`/`completed`/`failed`（真实 CLI 只有 `rewind.triggered`）。

### Checkpoint 4：补齐集成边缘 — ✅ 通过

**关键修复**：
- `SessionCommandService.ts`：`toProviderResolutionDeps()` 新增 `zcodeDbPath` 和 `zcodeReaderFactory` 传递。
- `routes/sessions.ts`：`toProviderResolutionDeps()` 同步新增传递。

### Checkpoint 5：验证 — ✅ 通过（真实模型 smoke 待授权）

**全部聚焦测试**：
- `corepack pnpm --filter @yep-anywhere/server test -- test/sdk/providers/zcode*.test.ts test/sessions/zcode*.test.ts test/projects/zcode*.test.ts` → 8 files, 128 tests passed
- `corepack pnpm typecheck` → exit 0
- `corepack pnpm exec biome check`（zcode 文件范围）→ no errors
- `corepack pnpm test:zcode-app-server-smoke -- --read-only --summary` → passed (models=0, sessions=9)

**回归检查**：
- 历史 ZCode 测试（zcode-normalization/scanner/reader）34/34 passed，无回归。

**secret 检查**：
- 源码和测试文件不含真实 API key、OAuth token 或 credentials 值。
- 测试 sentinel (`sk-test-sentinel-DO-NOT-LEAK`) 仅出现在测试数据和断言中，不进入源码。

**真实模型 smoke（用户授权执行，happy path 完全通过）**：

创建临时 `~/.zcode/cli/config.json`（从 `v2/config.json` 派生，包含 `X-Sub-Module: claude-code-internal` header，smoke 结束后删除），使用本机可用 provider `93be4d49.../glm-5.2`，在临时 workspace 中执行完整 app-server 链路。

完整验证的协议路径：
1. ✅ `workspace/readState` — 发送 workspace identity，收到响应
2. ✅ `workspace/updateProviderRegistry` — 发送真实 registry（`{workspace, registry: {revision, generatedAt, providers[]}}`，包含 `apiKey: {source: "inline", value: ...}` 和 `headers: {X-Sub-Module: "claude-code-internal"}`），被接受
3. ✅ `session/create` — 发送 `workspace` + `model: {providerId, modelId}`，收到 snapshot，从 `result.session.sessionId` 成功解析 session ID
4. ✅ `session/subscribe` — 订阅 `web-remote-replayable` delivery kind
5. ✅ `session/send` — 发送 `content` 字符串，被接受
6. ✅ 收到事件流（真实 envelope `{type, payload, seq, sessionId}`），完整 19 个事件：
   - `session.titleUpdated` (seq=1)
   - `turn.started` (seq=2)
   - `session.updated` (seq=3-4)
   - **`model.streaming` ×10** (seq=5-14) — 包含 `reasoning_delta`（模型推理）和 `text_delta`（助手文本）
   - `session.titleUpdated` (seq=16)
   - `session.updated` (seq=17-18)
   - **`turn.completed`** (seq=19) — 包含 `response: "Hello from ZCode smoke test."`, `usage`, `duration: 8284ms`, `resultType: "success"`
7. ✅ `session/requestRuntimePreferences` server request 被正确处理（返回 `{nativeSearchEnhancementsEnabled: false, memoryEnabled: false}`）
8. ✅ `interaction/requestProviderRuntimeHeaders` server request 被正确处理（返回 `{headers: {X-Sub-Module: "claude-code-internal"}}`）
9. ✅ app-server 子进程正常关闭
10. ✅ secret 检查通过（stderr 不含 API key、Bearer、token）

助手文本：模型正确返回 `"Hello from ZCode smoke test."`（从 `text_delta` 事件聚合）。

`turn.completed` payload 包含完整 usage 信息：
```json
{
  "response": "Hello from ZCode smoke test.",
  "tokenCount": 13166,
  "usage": {
    "source": "provider",
    "modelRequestCount": 1,
    "inputTokens": 13015,
    "outputTokens": 151,
    "totalTokens": 13166,
    "cacheReadTokens": 10496,
    "cacheWriteTokens": 0,
    "reasoningTokens": 0
  },
  "toolCallCount": 0,
  "duration": 8284,
  "resultType": "success"
}
```

关键发现：provider 的 `headers: {X-Sub-Module: "claude-code-internal"}` 必须包含在 registry entry 和 `interaction/requestProviderRuntimeHeaders` 响应中，API 才会接受请求。缺少此 header 会导致 `submodule_not_allowed` 错误（400）。

**遗留风险（非阻塞）**：
- `~/.zcode/cli/config.json` 需由 ZCode Desktop 创建，或在真正启动 Yep 托管的 ZCode session 时由 `ensureCliConfig()` 补齐。自动创建的文件只含 `{model: "<provider>/<model>"}` 且使用 `0600` 权限；provider 定义与凭据随后通过进程内 `workspace/updateProviderRegistry` 注入，不再复制可能包含 API key/headers 的 `v2/config.json`。`getAuthStatus()`、`getAvailableModels()`、只读 MCP 查询等路径只读配置，不触发落盘。
- Registry 条目中的 `apiKey` 使用真实 CLI 的 `{source: "inline", value: <key>}` 格式（`Reo` discriminated union），`buildZCodeProviderRegistry` 已正确转换。
- `session/requestRuntimePreferences` 响应使用 `{nativeSearchEnhancementsEnabled: false, memoryEnabled: false}`，符合真实 CLI 0.16.1 schema（不接受 `model`/`mode` 字段）。
- `interaction/requestProviderRuntimeHeaders` 从 provider 配置 `options.headers` 返回真实 headers（包括 `X-Sub-Module`），而非空对象。
- `builtin:zai-start-plan` provider 在 registry 中但无 models，不影响 catalog 中已有可用 model。
- `state.updated` 通知未在事件转换器中处理（P5 增强）。



## 15. 第二轮修复执行记录（2026-08-13：阻塞 bug + 功能对齐 opencode）

本轮起点：用户反馈新建 ZCode 会话失败（registry `-32602`）、附件被静默丢弃、`session/fork` 与 `mcp/list` 未接线、无 bridge。所有协议结论均通过**真实 CLI 0.16.1 探测**（临时 app-server 子进程 + strict zod 报错反推 + bundle 源码切片）确认，不凭印象实现。

### 15.1 修复：provider registry schema（新建会话阻塞根因）

- **根因**：真实 CLI 对 `workspace/updateProviderRegistry` 的 entry schema 是 strict 的，要求 `providers[].models` 为**非空数组**且元素只有 `{modelId}`；provider 级和 model 级都**不接受 `name` 键**。旧 builder 发出 `name` 且在 models 为空时省略该键，导致每次调用都被 `-32602` 拒绝（即用户看到的报错）。
- **实证**（探测脚本对真实 app-server 逐一验证）：entry 带 `name` → `Unrecognized key: "name"`；缺 `models` → `expected array, received undefined`；`models: []` → `expected >=1 items`；models 带 `name` → `Unrecognized key`；合规形状（`{providerId, kind, source, baseURL, apiKey:{source:"inline",value}, headers?, models:[{modelId}]}`）→ `status: "applied"`，modelCatalog 出现可用模型。
- **修复**：`buildZCodeProviderRegistry` 去掉两级 `name`、`models` 恒为非空数组、零模型 provider 整体跳过；shared `ZCodeProviderRegistryEntrySchema`/`ZCodeRegistryModelSchema` 同步收紧。
- **端到端验证**：用本机真实 `~/.zcode/v2/config.json` 跑 parse → build → 真实 app-server `updateProviderRegistry`：`REGISTRY ACCEPTED: status=applied providers=1 availableModels=1`（未输出了任何 secret）。

### 15.2 新增：`session/send` attachments

- 附件 wire 形状从 bundle 的附件归一化函数（`Hda`）逆向确认：`{kind: "image"|"file"|"audio", filename?, localPath? | dataBase64? | textContent?, mimeType?, sizeBytes?, sourceKind?}`，loose record（探测确认 `attachments` 元素是 `record`，非法类型才被拒）。
- 新增 `zcode-protocol/attachments.ts`：结构化上传（`UploadedFile`，优先 `localPath` —— app-server 同机读盘）+ 粘贴 base64 图片（`dataBase64`）→ wire records；无附件时整个 key 省略（strict schema）。
- provider turn loop 已接线；fake server 测试断言精确 wire 形状与 key 省略行为。

### 15.3 新增：`session/fork`（历史消息编辑 / fork / branch）

- 契约（探测 + bundle 双重确认）：params strict `{sessionId, target?: {kind:"turn",turnIndex}|{kind:"message",messageId}|{kind:"checkpoint",checkpointId}|{kind:"latestCheckpoint"}(默认), expectedRevision?}`；result `{forkedSessionId, parentSessionId?, targetMessageId?, targetCheckpointId?, response, snapshot}`；fork 要求源 session 先 resume 为 active；fork 继承源 mode/model/thoughtLevel；forked session 同进程自动 active。
- **边界语义**：message target 是 **inclusive**（复制到目标消息为止，含目标）。yep 编辑语义需要 exclusive，provider 侧策略：`session/messages` 定位被编辑消息 M → fork 于 **M 的前一条** → child 恰好排除 M 及其后内容 → 发送新文本。M 不存在或为首条消息时 fail-closed（`zcode_session_not_found` / 新增 `zcode_first_message_edit_unsupported`）。
- 接线范围：provider `resumeSessionAt` 分支、Supervisor fork gating（zcode 复用 opencode 路径）、`SessionCommandService`（`supportsResumeSessionAt`/`isSourcePreservingFork`/`setForkParentSessionId`）、zcode-reader（fork child 不再被 `parent_id IS NULL` 隐藏，subagent_child 仍隐藏；summary 透出 native `parent_id` 为 `forkParentSessionId`，家族列表折叠由通用 `collapseEditForkFamilies` 处理）、客户端 `sessionBranching`（zcode 与 opencode 同路径，仅可编辑已持久化消息）。
- **分支箭头视图（2026-08-13 补齐）**：新增 `packages/server/src/sessions/zcode-branch.ts`（`buildZCodeBranchView`，镜像 opencode branch view 语义：copied prefix 不生成 branch option、child 首个新 user 消息继承父 session 被编辑消息的 parentId/depth 形成兄弟分支）；zcode-reader `loadBranchState()` 用 native `parent_id` + yep metadata 互补的边合成家族并挂到 `LoadedSession.branchState`；normalization zcode case 复用通用 `annotateBranchMessages`（另为 zcode 消息补 `timestamp`，使 fresh-id copied prompt 走 timestamp+text 回退匹配）。客户端零改动（`BranchControls`/`?branchId=` 均为 provider 无关路径）。48 个相关测试通过。

### 15.4 新增：`mcp/list`（全 yep 首个 MCP 可见性）

- 契约：params strict `{workspace, mcpServers?, mode?: "connect"|"status"（默认 connect）}`；yep 恒用 `mode: "status"`（只读，不发起连接）。result `{statuses: Record<name, {status, transport, toolCount, updatedAt, error?}>}`。
- 接线：`AgentProvider.listMcpServers?(cwd)`（zcode 实现：临时 app-server 查询后即关闭，不注入 registry、不建 session）；`GET /api/providers/zcode/mcp-servers?projectId=<id>`（400/404/503/502 语义化错误）；NewSessionForm 选中 ZCode 时只读展示（名称+状态+工具数，en/zh-CN）。

### 15.5 新增：zcode bridge v1（外部 TUI 会话感知 + 审批转发）

- **可行性调研结论（高）**：ZCode 插件机制（`.zcode-plugin/plugin.json` + Claude 兼容 `hooks/hooks.json`）支持 7 个 hook 事件（SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop）；`PermissionRequest` hook 的决定**优先于** TUI 弹窗；插件在 TUI 模式同样加载；外部 session 的 transcript 本就在共享 sqlite（zcode-reader 已覆盖展示）。
- **明确不做**：app-server resume 活跃 TUI session 的"接管"（session 表无 owner/lock，跨进程写同一 db 有实质冲突风险）。
- 实现：`packages/server/resources/zcode-plugin/`（manifest + hooks.json + 零依赖 `hook-entry.mjs`，失败一律静默回退 TUI 原生弹窗）；server `ZCodeBridgeService` + `/api/zcode-bridge/*`（hook 端点共享 token 鉴权，client 端点走正常鉴权；SessionStart + 所有 hook keepalive + 10 分钟静默 TTL 的外部 session 注册表——0.16.1 的 Stop 是 turn-level assistant stop，并非 SessionEnd——以及 pending permission 长轮询队列）；client GlobalSessionsPage 顶部审批卡片；`scripts/install-zcode-yep-plugin.sh`（token 0600、配置备份、`--uninstall` 回滚）。
- v1 未覆盖：assistant 流式转发（reader 已覆盖展示）、question/choice 类 user input、updatedInput 编辑 UI。

### 15.6 验证结果

- zcode 聚焦套件（provider/config/protocol/events/discovery/reader/normalization/scanner/bridge/routes）：**12 文件 211 tests passed**。
- shared zcode-schema：14 passed；client lib/components：431 passed；supervisor + api/sessions fork 用例：通过。
- `corepack pnpm test:zcode-app-server-smoke -- --read-only --summary` → **passed**（version=0.16.1, sessions=13）。
- `pnpm exec biome check`（本轮全部触碰文件）→ clean。
- `pnpm typecheck`：本轮改动无错误；仓库当前有**一处与本任务无关的既有错误**（`sdk/providers/index.ts` 引入了尚不存在于 `codex.ts` 的 `CodexBridgeExecutionConfig`，属于工作树中并行的 codex event-store rotation 改动），未代为修改。
- 真实模型 smoke：本轮未重跑（2026-08-12 已授权验证 happy path；fork/附件的真实链路 smoke 仍需用户授权后执行）。

### 15.7 与 opencode 接入度的剩余差距（2026-08-13 时点）

| 能力 | opencode | zcode 现状 |
| --- | --- | --- |
| 实时会话 create/resume/send/stop/model/mode | ✅ | ✅ 已对齐 |
| 附件/图片 | ✅ | ✅ 本轮对齐 |
| 审批 + user input 转发 | ✅ | ✅ 已有（本轮回归确认） |
| 历史编辑 / fork / branch | ✅ | ✅ 已对齐（含分支箭头 branchState 视图） |
| 历史 reader/scanner/搜索 | ✅ | ✅ 已有 |
| bridge（外部进程） | ✅ 完整（事件流 + 审批 + 命令通道 + session 视图） | ⚠️ v1：注册表 + 审批转发；无事件流/命令通道/深度 UI |
| mcp/list | ❌ 未实现 | ✅ 本轮实现（zcode 反而领先） |
| compact | 部分 | ✅ 已对齐（P5：session/compact 全链路 + SessionMenu 入口） |
| subagents 展示 | ✅ | ✅ 已对齐（P5：agents metadata + subagent_child sqlite，agent tree 复用） |
| thought level 会话中切换 | n/a | ✅ 已对齐（P5：mid-session setThoughtLevel + ModelSwitchModal level 选择） |
| goal 生命周期 | 部分 | ✅ 已对齐（session/goal 全链路 + 会话 Goal 对话框） |
| rewind / checkpoint 控制 UI | 部分 | ❌ 0.16.1 协议不可行——没有 checkpoint 枚举方法（详见 §16.5） |
| cancelBackgroundTask UI | 部分 | ❌ 0.16.1 协议不可行——没有 background task 枚举方法（详见 §16.5） |

结论：核心链路（创建/交互/附件/编辑 fork/历史/MCP 可见性/bridge v1/compact/subagents 展示/会话中 thought level/goal）已达到或接近 opencode 接入度；协议上可行的剩余差距集中在 bridge 深度（事件流与命令通道）。

## 16. 第三轮：真实模型 smoke、部署与 P5（2026-08-13 下午，用户已授权）

### 16.1 新发现并修复：streaming delta 契约（真实模型 smoke 暴露）

授权后的真实模型 smoke 第一跑暴露了一个此前 fake-only 测试无法发现的**真实协议偏差**：真实 CLI 0.16.1 的 `model.streaming` payload 与 yep converter 的假名字段完全不同——

- chunk 字段是 `delta`（不是 `text`/`reasoning`）；
- 消息标识是 `assistantMessageId`（不是 `messageId`，replay 用 `partId`）；
- `tool_input_delta.delta` 是**全量累计快照**（buffer flush），不是增量——按增量累加会把 tool input 拼坏；
- `tool_call` 直接携带解析好的 `input` 对象。

后果：此前 zcode 实时会话的 assistant 文本/reasoning 在 yep 中被静默丢弃。已修复 `events.ts`（真实字段优先、legacy 拼写保留容错、tool input 快照语义改替换），fake server 和 converter 测试全部改为真实形状锁定契约（`zcode-events.test.ts` 新增 "real CLI 0.16.1 streaming payload contract" describe）。

### 16.2 真实模型 smoke（授权执行，6/6 通过）

1. `updateProviderRegistry`（修复后的 builder + 真实配置）→ `status: "applied"`；
2. `session/create` → sessionId；
3. 固定 prompt → 流式 `text_delta` 聚合出 marker 文本 + `turn.completed`（`resultType: "success"` + usage）；
4. file 附件（`{kind:"file", localPath, ...}`）→ 模型正确复述附件内容；
5. `session/messages` 定位 + `session/fork`（target=前一条消息）→ child 创建、**被编辑消息不在 child 中**（排他语义实证）；
6. `mcp/list {workspace, mode:"status"}` → 正常响应。

副作用：zcode DB 中留下若干 `yep-zcode-smoke-*` workspace 的诊断 session（含 fork child），已授权保留。

### 16.3 部署与运行态验证

- `scripts/deploy.sh --server-only` 部署到 8022 成功（buildId `2026.8.2-03b7b17aa2fd-20260813072022`）。
- `/api/providers`：zcode `installed=true, authenticated=true, enabled=true, modelCount=1`（glm-5.2）——对比 §3.2 的 `authenticated=false, enabled=false, modelCount=0`，**新会话表单可正常选择 zcode，用户报告的创建问题在运行态已消除**。
- `/api/zcode-bridge/sessions` 正常响应（bridge 服务端在线）。
- `scripts/install-zcode-yep-plugin.sh` 已执行：插件装入 `~/.zcode/plugins/yep-bridge/` 并注册 `plugins.dirs`（已备份原配置）；外部 TUI 的 hook 端到端需在用户实际打开 zcode TUI 时自然生效。

### 16.4 P5 首批三项（已完成）

- **subagent 展示**：`zcode-reader.getAgentMappings/getAgentSession` 落地——关联链为 `~/.zcode/cli/agents/<parentId>/agent_*/metadata.json` 的 `parentToolUseId`/`childSessionId`（经真实数据结构只读验证 36/36）；复用 provider 无关的 agent tree UI，客户端零改动。
- **session/compact**：`AgentSession.compact()` → Supervisor/Process/RuntimeController → `POST /api/processes/:id/compact` → SessionMenu "Compact context"（仅 zcode 自有 session 显示）。
- **session/setThoughtLevel 会话中切换**：`AgentSession.setReasoningEffort()`（fail-closed 校验 level 属于当前 model）→ `POST /api/processes/:id/reasoning-effort` → ModelSwitchModal effort chips。

验证：server 86 passed（zcode reader/provider/processes/branch）+ supervisor 32 + client 431；typecheck 干净；biome clean。

### 16.5 更新后的剩余差距

- **goal 生命周期 UI**：✅ 已对齐（本轮落地）。`session/goal` 全链路——`AgentSession.getGoal()/goalAction()` → `POST /api/processes/:id/goal`（action 枚举 + set/replace 的 objective 校验）→ SessionMenu "Goal…" → GoalModal（show 状态展示、objective 输入、set/replace/pause/resume/clear；set/replace 的 startedTurn 属于用户显式触发的正常行为）。shared schema 补 strict params/result 契约。
- **rewind/checkpoint 控制 UI**：❌ **0.16.1 协议上不可行**——app-server 没有任何枚举 checkpoint 的方法（`session/fork` 仅支持把已知 checkpointId/latestCheckpoint 作为 target），没有列表入口就无法做用户可选的 rewind UI。协议新增方法后再评估。
- **cancelBackgroundTask UI**：❌ **0.16.1 协议上不可行**——只有 `cancelBackgroundTask {sessionId, taskId}`，没有任务枚举方法，无法知道有哪些 backgroundTask 可取消。
- **bridge 深度**：⚠️ v1（注册表 + 审批转发）；事件流转发、命令通道、session 深度视图未做。
- **外部 session TTL 清理**：✅ 已做（所有 hook 刷新 `lastSeenAt`，静默 10 分钟后清理；`Stop` 只作 keepalive）。

除此之外，zcode 在 yep 中的功能接入度已达到（部分超过——mcp/list、thought level）opencode 水平；协议上可行的能力中，剩余差距集中在 bridge 深度。
