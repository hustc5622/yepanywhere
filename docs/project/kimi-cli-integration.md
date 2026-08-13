# Kimi CLI 接入开发计划

## 1. 目标与范围

在 Yep Anywhere 中接入 Kimi Code CLI 作为一个新 provider（`kimi`），功能对齐 Codex CLI 的核心体验：实时会话、历史展示、模型/思考档位选择、权限审批接管。

**核心决策（结论先行）**：

| 维度 | 决策 | 理由 |
| --- | --- | --- |
| 传输机制 | **走 ACP over stdio（`kimi acp`）**，复用现有 `ACPClient` + gemini-acp 那套 | Kimi 原生 ACP 比 Gemini 更完整（支持 `session/load`+`session/resume`+`configOptions`+`terminal-auth`）；无需新增进程 |
| 权限审批 | **进程内 ACP `session/request_permission` 回调**，复用 `onToolApproval` 审批流 | Kimi 审批是 ACP 协议内建 request/response，**不需要 4510/4520 那种常驻 bridge** |
| fork / branch / rollback | **一期不做**，`supportsDag=false / supportsCloning=false`（对齐 gemini-acp） | Kimi 的 fork/undo 只在 node-sdk / kap-server REST 暴露，**ACP 层完全不暴露**；二期再评估 |
| 历史展示 | reader 解析 `wire.jsonl` + scanner 读 `session_index.jsonl`（对齐 codex/gemini） | ACP 会话与 TUI 共用 `~/.kimi-code/sessions/` 存储，可直接读文件 |

**不在本计划范围**：fork/branch/rollback（见 §9 未来工作）、Kimi 子 agent（swarm）展示、MCP profile 管理。

---

## 2. 调研结论（事实依据）

### 2.1 Kimi ACP 能力（`references/kimi-code/packages/acp-adapter/`）

`kimi acp` 是完整的 ACP server（`protocolVersion=1`，SDK `0.23.0`，spec `v0.10.x`），支持的方法：

- `session/new`、`session/load`（回放历史）、`session/resume`（不回放，轻量续接）
- `prompt`、`cancel`、`session/set_mode`、`authenticate`
- `configOptions`：模型选择 + 按模型声明的 thinking 档位（如 low/high/max）+ 4 种 mode
- `terminal-auth`：`kimi acp --login` 设备码登录

**未暴露**：fork、undo、turnIndex、rewind、rollback（已 grep 确认 `acp-adapter/src` 无此能力）。

握手兼容性：Yep 的 `ACPClient.initialize` 发 `protocolVersion: 1`，与 Kimi 的 `MIN_PROTOCOL_VERSION=1` 兼容（`version.ts`）。

### 2.2 Kimi 会话存储（`~/.kimi-code/`）

```
~/.kimi-code/
├── config.toml                         # default_model / [providers.*] / [models.*] / [thinking]
├── session_index.jsonl                 # {sessionId, sessionDir, workDir} 全量索引
├── workspaces.json                     # workspace 目录 → 项目根路径映射
└── sessions/
    └── wd_<slug>_<hash>/
        └── session_<uuid>/
            ├── state.json              # title/agents；v1 为 workDir+ISO 时间，v2 为 cwd+毫秒时间戳
            └── agents/main/wire.jsonl  # 事件流
```

- session id 形如 `session_<uuid>`
- **ACP 模式与 TUI 共用 `harness.createSession`**，即 ACP 跑的会话同样落到此存储 → reader 方案成立
- **相比 Gemini 更简单**：`session_index.jsonl` + `workspaces.json` 直接给出 sessionId↔workDir↔project 映射，无需像 Gemini 那样猜 SHA-256 hash

`wire.jsonl` 事件类型：

| 事件 | 用途 |
| --- | --- |
| `metadata` / `config.update` / `tools.set_active_tools` / `permission.set_mode` | 会话元信息、系统提示、工具集、权限模式 |
| `turn.prompt` | 用户输入（原始） |
| `context.append_message` | 规范化后的 user/assistant 消息（含 content blocks）→ **reader 主数据源** |
| `context.append_loop_event` | 内含 `tool.call` / `tool.result` / `step.begin` / `content.part` / `step.end` → **工具渲染源** |
| `usage.record` | token 用量 → context usage |
| `llm.request` / `llm.tools_snapshot` / `plan_mode.enter` | 诊断/辅助 |

### 2.3 权限审批机制（`acp-adapter/src/approval.ts`）

Kimi 内部 `ApprovalRequest` → 标准 ACP `RequestPermissionRequest`：

- options：`approve_once` / `approve_always` / `reject`
- plan mode 下扩展为：`plan_opt_<i>`（多方案 A/B/C）+ `plan_revise` + `plan_reject_and_exit`
- `toolCall.content` 携带 diff / plan markdown（可渲染审批卡片）

客户端回 `RequestPermissionResponse{outcome:{selected, optionId}}` → Kimi 转回 `approved` / `approved+scope:session` / `rejected` / `cancelled`。

**这与 Yep 现有 gemini-acp 审批链路完全同构**：

```
kimi acp ──session/request_permission──▶ ACPClient.requestPermission (client.ts)
                                              → handlePermissionRequest (provider)
                                              → onToolApproval(toolName,input,opts)
                                              → Supervisor.ts:441 → process.handleToolApproval
                                              → Yep pending-input / 移动端审批 / 推送通知
```

**4510/4520 的本质**：codex bridge(4510) 是给 `codex --remote ws://` app-server 协议做的常驻 `http+WebSocketServer` 进程；opencode bridge(4520) 是给 opencode HTTP server 做的。审批只是搭车在它们的 JSON-RPC 上。Kimi 走 ACP stdio，审批是协议内建 request/response，**无需任何常驻端口进程**。

### 2.4 Fork 机制（说明为何一期不做）

Kimi 对"修改 session 内容"用 **fork（copy-on-write 分支）**：

- `harness.forkSession({id, turnIndex})`（node-sdk）→ store `fork()`（`session-store.ts:140`）
- 整目录复制 → 写 `forkedFrom` marker → `truncateForkedSessionAtTurn` 按 user-visible turn 截断 `wire.jsonl` → 注册新 `session_<uuid>`
- 原 session 完全不动；这是切新 session，非原地 rollback

另有 `POST /v1/sessions/{id}:undo`（原地砍尾 N turn）。**两者都不经 ACP 暴露**，故一期不做。

---

## 3. 分层改动清单

以 codex/gemini 现有实现为模板。⭐ = 新增文件。

### Layer A — shared 类型 / schema

| 文件 | 改动 |
| --- | --- |
| `packages/shared/src/types.ts` | `ProviderName` 加 `"kimi"`；`ALL_PROVIDERS` 追加 `"kimi"` |
| `packages/shared/src/app-types.ts:474` | context-window 分支加 kimi（k3 上下文 1,048,576） |
| `packages/shared/src/session/UnifiedSession.ts:23` | 加 `{ provider: "kimi"; session: KimiSessionContent }` |
| `packages/shared/src/kimi-schema/` ⭐ | 仿 `gemini-schema/`：用 zod 定义 `wire.jsonl` 事件 + `state.json` 解析（`content.ts`/`events.ts`/`session.ts`/`types.ts`/`index.ts`） |

### Layer B — server 实时 provider

| 文件 | 改动 |
| --- | --- |
| `packages/server/src/sdk/providers/kimi.ts` ⭐ | 以 `gemini-acp.ts` 为骨架。`args=["acp"]`；复用 `ACPClient`；`session/resume` 续接；审批映射（§4）；mode 映射（§4.1）；auth 读 `~/.kimi-code/config.toml`；模型及可选思考档位读 `config.toml [models.*]`，创建/恢复后通过 ACP `thinking` config option 应用并校验 |
| `packages/server/src/sdk/providers/types.ts:16` | `ProviderName` 加 `"kimi"` |
| `packages/server/src/sdk/providers/index.ts` | 导出 `kimiProvider`；`getProvider` case `"kimi"`；`getAllProviders` 追加 |

### Layer C — server 历史展示

| 文件 | 改动 |
| --- | --- |
| `packages/server/src/sessions/kimi-reader.ts` ⭐ | 仿 `gemini-reader.ts`：解析 `wire.jsonl` → `Message[]`。`context.append_message`→消息；`context.append_loop_event` 的 `tool.call`/`tool.result`→工具；`usage.record`→context usage；`state.json`→标题/时间 |
| `packages/server/src/projects/kimi-scanner.ts` ⭐ | 比 gemini 简单：读 `session_index.jsonl` + `workspaces.json` 枚举项目/会话，带 5s 缓存（对齐 `SCAN_CACHE_TTL`） |
| `packages/server/src/sessions/provider-resolution.ts` | 加 `kimiPaths`/`kimiSessionsDir`/`kimiReaderFactory`；`SessionSource.kind` 加 `"kimi"` |
| `packages/server/src/projects/scanner.ts` | 接入 `kimiScanner`（对齐 gemini：`registerKnownPaths`/`listProjects`/`getSessionsForProject`/`invalidateCache`） |

### Layer D — 配置

| 文件 | 改动 |
| --- | --- |
| `packages/server/src/config.ts` | 加 `kimiSessionsDir`（默认 `~/.kimi-code/sessions`，env `KIMI_SESSIONS_DIR` 可覆盖）+ `kimiHomeDir`；`enabledProviders` allowlist 支持 `kimi`（`ENABLED_PROVIDERS`，`config.ts:491`） |
| `packages/server/src/app.ts` | 对齐 gemini 多处接线：scanner 实例化（≈`:381`）、reader factory（≈`:449` switch case 加 `"kimi"`）、`provider-resolution` deps（≈`:537`）、后续 rescan/catalog 路径 |
| `packages/server/src/routes/providers.ts` | 无需改（`getAllProviders` + allowlist 自动生效） |

### Layer E — client UI

| 文件 | 改动 |
| --- | --- |
| `packages/client/src/providers/implementations/KimiProvider.ts` ⭐ | 仿 `GeminiACPProvider.ts`：`id="kimi"`、displayName、capabilities（`supportsDag/supportsCloning=false`）、metadata |
| `packages/client/src/providers/registry.ts` | 注册 `kimi: new KimiProvider()` |
| `packages/client/src/components/ProviderBadge.tsx` | 加 kimi 图标/配色 |
| `packages/client/src/components/NewSessionForm.tsx` | provider 选项加 kimi；模型/mode/thinking 下拉；thinking 选项随当前模型的 `support_efforts` 切换 |
| `packages/client/src/components/tools/summaries.ts` 等 | 视工具渲染需要补 kimi 分支 |

### Layer F — 校验 / 测试

| 文件 | 改动 |
| --- | --- |
| `scripts/validate-jsonl.ts` / `scripts/validate-tool-results.ts` | 加 kimi wire.jsonl fixtures |
| provider / reader / scanner 单测 | 仿现有 `__mocks__` 与 reader 测试 |

---

## 4. 权限审批详细设计

在 `kimi.ts` 内实现（**零新增进程**），照抄 gemini-acp 的三个方法：

1. `client.setPermissionRequestCallback(req => handlePermissionRequest(req, options, signal))`
2. `handlePermissionRequest`：ACP `RequestPermissionRequest` → `onToolApproval(toolName, input, opts)` → 结果经 `convertApprovalResultToACPResponse` 转回
3. option 映射：

| Yep `ToolApprovalResult` | 选择的 ACP optionId |
| --- | --- |
| `allow`（一次） | `approve_once` |
| `allow` + 记住选择 | `approve_always` |
| `deny` | `reject` |
| 中止/无 handler | `outcome: "cancelled"` |

### 4.1 权限模式映射（关键）

ACP 下工具由 Kimi 自己执行，**只有敏感操作才发审批，且受 Kimi mode 支配**：

| Yep `PermissionMode` | Kimi ACP mode | 行为 |
| --- | --- | --- |
| `default` | `default`（manual） | Kimi 自动允许安全读取，其余原生审批请求交给 Yep |
| `plan` | `plan` | Kimi 进入只读计划模式，`plan_review` 交给 Yep |
| `auto` | `auto` | 完全自主运行，不向用户提问 |
| `bypassPermissions` | `yolo` | 自动允许常规工具；Kimi 仍会把敏感操作、问题和计划审核交给 Yep |
| `acceptEdits`（旧数据兼容） | `default`（manual） | 不再对新 Kimi 会话展示；旧保存值仍由 Yep 按编辑自动允许、其他操作询问的规则处理 |

启动和恢复会话后通过 ACP `session/set_mode` 应用上述原生模式；活动会话切换模式时也调用同一接口。`bypassPermissions` 继续作为 Yep 的共享 wire value，对 Kimi 界面显示为 **YOLO**，从而不需要扩大跨 provider 的公共类型。

### 4.2 plan_review 多选审批

Kimi plan mode 会发多 option 审批（`plan_opt_<i>` 方案 A/B/C + Revise + Reject and Exit），比 Codex 更丰富。

- **一期**：塌缩为 allow/deny（选第一个 `plan_opt_0` 或 `plan_approve` = allow；`reject`/`cancelled` = deny）
- **二期**：把多 option 透传到 Yep 审批 UI 做多选（需扩展 `onToolApproval` 的 input 携带 options，及 client 审批卡片支持多按钮）

---

## 5. 历史展示设计要点（kimi-reader）

- **消息**：以 `context.append_message` 为主，`role: user/assistant`，content 为 block 数组（text / tool_use / tool_result / thinking）
- **工具**：`context.append_loop_event` → `tool.call`（id/name/args）配对 `tool.result`（id/output/error）
- **思考**：Kimi thinking 内容映射到 assistant 的 `thinking` block
- **思考档位**：`config.update.thinkingEffort` 写入 session summary，供历史会话恢复和新会话默认值复用
- **context usage**：`usage.record` 累计
- **标题/时间/项目**：兼容 `state.json` v1 的 `workDir` + ISO 时间，以及 Kimi CLI 0.34 v2 的 `cwd` + 毫秒时间戳；reader 内统一规范化后再按项目过滤
- **多 agent**：一期仅读 `agents/main/wire.jsonl`，忽略子 agent（swarm）
- **线性结构**：Kimi 会话为线性（无 DAG），对齐 Gemini reader 的处理

---

## 6. 阶段划分与里程碑

| 阶段 | 内容 | 交付标准 |
| --- | --- | --- |
| **P0 PoC** | Layer A 最小（ProviderName）+ Layer B（`kimi.ts` 连接/session/prompt/审批） | 能在 Yep 新建 kimi 会话、多轮对话、敏感操作弹审批并接管 |
| **P1 历史** | Layer C（reader + scanner）+ Layer A schema | 项目列表出现 kimi 会话、历史 transcript 正确渲染、resume 续接 |
| **P2 配置+UI** | Layer D + Layer E | `ENABLED_PROVIDERS=kimi` 可控、client 完整展示、模型/mode 选择 |
| **P3 打磨** | thinking/effort（low/high/max，已接入）、plan_review 多选审批、工具渲染细节 | 功能对齐 Codex（除 fork） |
| **未来** | fork/branch（见 §9） | — |

---

## 7. 命令与配置速查

```bash
# ACP 模式（Yep spawn 的命令）
kimi acp

# 登录（审批/首次）
kimi acp --login        # 或 kimi login

# 模型：-m；思考档位：ACP session/set_config_option；auth：~/.kimi-code/config.toml 有 provider/api_key 即已配置

# 启用 provider
ENABLED_PROVIDERS=claude,codex,kimi pnpm dev

# 会话目录覆盖（测试用）
KIMI_SESSIONS_DIR=/tmp/kimi-sessions
```

---

## 8. 风险与未决项

| 项 | 说明 | 缓解 |
| --- | --- | --- |
| `@agentclientprotocol/sdk` 版本 | Yep 现有版本需与 Kimi 的 `0.23.0` 兼容 | 实现时先跑握手，必要时对齐 SDK 版本 |
| wire.jsonl 格式演进 | Kimi 升级可能改事件结构 | schema 用 zod 宽松解析 + 未知事件忽略；`protocol_version` 打点 |
| 旧 `acceptEdits` 数据 | Kimi 无精确对应 mode | 映射到 Kimi `default`，由 Yep 保留旧的局部自动批准语义；新会话不再展示 |
| 模型目录与活动会话的 thinking 选项可能漂移 | picker 从 `config.toml` 的 `capabilities` / `support_efforts` / `default_effort`（含 model `overrides`）构建 | 创建或恢复后用 ACP `thinking` config option 应用，并校验返回的 `currentValue`；不一致时显式报错 |
| resume 可靠性 | ACP `session/resume` 失败需回退 | 对齐 gemini-acp：resume 失败则 `session/new` |

---

## 9. 未来工作：Fork / Branch（二期评估）

一期 `supportsDag/supportsCloning=false`。二期若要"编辑 session → 建分支"，两条路：

- **方案 A（推荐）**：绕过 ACP 调官方 `harness.forkSession({turnIndex})`（node-sdk），或起 kap-server 走 REST。语义正确、随 Kimi 升级不易碎；代价是引入 node-sdk 依赖或额外进程。
- **方案 B（兜底）**：Yep 在文件层复刻 `truncateForkedSessionAtTurn`（复制 session 目录 + 按 user-visible turn 截断 `wire.jsonl` + 写 `forkedFrom` marker + append `session_index.jsonl`），再用 ACP `session/resume` 续接新 id。代价：需吃透 turn 边界规则（`isUserVisibleTurnRecord`）与子 agent 截断，格式演进要跟随。

Kimi 的 fork（切新 session）语义其实比 Codex 的同 thread rollback 更贴合 Yep 现有 `fork.ts`/branch 概念，二期落地时可复用该基础设施。

---

## 10. 参考源码索引

- Kimi ACP：`references/kimi-code/packages/acp-adapter/src/{server,session,approval,modes,model-catalog,auth-methods,version}.ts`
- Kimi fork：`references/kimi-code/packages/agent-core/src/session/store/session-store.ts:140`（`fork` / `truncateForkedSessionAtTurn`）
- Yep ACP 基建：`packages/server/src/sdk/providers/{acp/client.ts,gemini-acp.ts}`
- Yep 审批入口：`packages/server/src/supervisor/Supervisor.ts:441`
- Yep reader/scanner 模板：`packages/server/src/sessions/gemini-reader.ts`、`packages/server/src/projects/gemini-scanner.ts`
- Yep 接线模板：`packages/server/src/app.ts`（搜索 `gemini`）、`packages/server/src/sessions/provider-resolution.ts`
</content>
</invoke>
