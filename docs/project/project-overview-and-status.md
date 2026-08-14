# Yep Anywhere：项目总览与状态

> 最近更新：2026-08-14

Yep Anywhere 是一个移动端优先的 coding agent 监督器。agent 运行在开发机或远端执行环境中，服务端在客户端断开后继续托管进程，React 客户端负责多项目/多会话展示、实时交互、审批和通知。

> 原始愿景文档和更详细的设计背景见 `docs/archive/`。

## 它是什么

可以把它理解为一个独立于具体 coding agent 的监督面板，重点是：

- **多提供商**：统一监督 Claude、Codex、Gemini、OpenCode、Kimi、ZCode 等不同 runtime
- **移动优先**：触控友好的 UI、推送通知，适合在手机上使用
- **多会话**：从一个面板查看所有项目，不需要来回切换窗口
- **服务端托管**：断开后可以重新连接，不丢失状态

## 当前状态

### 已可用功能

**核心循环**

- Hono 服务端通过 provider adapter 管理 SDK、CLI、app-server 和 bridge runtime
- 通过 WebSocket 向客户端实时流式推送消息、process 状态和输入请求
- resident provider 在客户端断开后继续运行，重新连接后恢复监督
- provider 运行期间支持 queue、defer 或 steer；具体能力由 provider/runtime 决定
- 工具审批 UI 支持批准/拒绝，并可从移动端处理
- permission/session mode 通过 provider-specific mapping 应用，不能假设所有 provider 使用同一原生枚举

**会话管理**

- 多项目仪表盘展示全部会话
- 从 provider JSONL、SQLite 或 session store 读取并 normalize 会话
- Codex app-server 事件另有 canonical event journal，用于恢复细粒度 item、plan、goal 和生命周期状态
- provider 进程仍存活时可实时重连；进程退出后可按 provider 能力 resume
- 检测外部 CLI/desktop/bridge 会话；能否交互取决于 ownership 和 command bridge
- 支持自定义会话标题和归档状态
- 支持 transcript 编辑、rollback、fork/branch；不同 provider 的原生语义与降级路径不同

**移动端体验**

- PWA 支持安装为 Web 应用
- 审批请求支持推送通知（VAPID，无 Firebase）
- 可在锁屏界面批准/拒绝
- WebSocket 自动重连并恢复会话

**智能体功能**

- 跟踪 subagent（Task 工具）并展示状态
- 支持模型选择和 extended thinking
- 通过 WebSocket 上传文件
- Plan mode 支持审批工作流
- 通过浏览器语音 API 输入语音
- 支持会话搜索和筛选

**多提供商支持**

- Claude Code / Claude Ollama
- Codex / Codex OSS，包括 stdio app-server、remote bridge、canonical event projection 和原生 ThreadItem 展示
- Gemini / Gemini ACP
- OpenCode，包括托管 server、事件流和插件/bridge 路径
- Kimi
- ZCode，包括 app-server、SQLite 历史读取和 hook bridge

各 provider 的协议、session store、审批和 branch 能力并不相同。涉及具体兼容性时，以 `docs/project/` 中对应的日期文档和仓库内 reference/probe 为准，不用本总览替代协议事实。

Codex Goal 当前属于“部分支持”：已有原生状态控制和 canonical goal 卡片，但还没有新会话 Goal-first、自动 continuation 的完整实时监督和 fork/resume 全语义。详见 [Codex Goal 模式适配现状与完整开发计划](./2026-08-14-codex-goal-support-plan.md)。

### 架构

```text
┌─────────────────────────────────────────────────────────────┐
│  Client (React PWA)                                         │
│  - SessionPage: 实时消息展示 + 工具审批                     │
│  - Dashboard: 多项目会话列表                                │
│  - Push notification service worker                         │
└─────────────────────────┬───────────────────────────────────┘
                          │ WebSocket（流式消息 + 操作）
┌─────────────────────────▼───────────────────────────────────┐
│  Server (Hono)                                              │
│  - Supervisor / Process: 管理 provider runtime 和输入队列   │
│  - Provider adapters: SDK / CLI / app-server / bridge       │
│  - Session readers: JSONL / SQLite / canonical event        │
│  - PushNotifier: VAPID Web Push                             │
└─────────────────────────┬───────────────────────────────────┘
                          │ provider-native protocol
┌─────────────────────────▼───────────────────────────────────┐
│  Coding agent runtimes                                      │
│  - Claude / Codex / Gemini / OpenCode / Kimi / ZCode        │
│  - 本地、remote executor 或 bridge                           │
│  - 各自的 session store 与事件协议                           │
└─────────────────────────────────────────────────────────────┘
```

### 已知缺口

| 领域 | 状态 | 说明 |
| --- | --- | --- |
| Codex Goal mode | 部分支持 | 已有 RPC 控制和刷新展示；Goal-first、automatic continuation runtime、resume/fork 完整语义待开发 |
| provider 协议兼容 | 持续维护 | app-server/CLI schema 会演进，关键行为必须用仓库 reference、固定版本 schema 或本机只读 probe 验证 |
| 外部会话控制 | provider-specific | 只读展示通常可用；交互需要 owner process、remote bridge 或 provider command channel |
| 进程恢复 | 符合当前设计 | 服务端进程退出后不恢复原 OS 进程；下一次交互按 provider 能力 resume session |

## 技术栈

- **服务端**：Node.js、Hono、provider SDK/CLI/app-server adapters
- **客户端**：React、Vite、React Router
- **推送**：web-push（VAPID 协议）
- **Lint**：Biome
- **测试**：Vitest

## 项目结构

```text
packages/
├── server/     # Hono 后端
│   ├── supervisor/   # 进程生命周期（Supervisor、Process、WorkerQueue）
│   ├── routes/       # API 端点
│   ├── sessions/     # 会话文件读取
│   └── push/         # Web Push 通知
├── client/     # React 前端
│   ├── pages/        # SessionPage、NewSessionPage 等
│   ├── components/   # MessageInput、MessageList、ToolApprovalPanel
│   └── hooks/        # useSession、useConnection、usePushNotifications
└── shared/     # 共享类型
```

## 竞争位置

| 工具 | 多会话 | 桌面端 | 移动端 | 推送通知 | 无外部依赖 |
|------|--------|--------|--------|----------|------------|
| Claude Code CLI | 否 | 是 | 否 | 否 | 是 |
| VS Code Extension | 否 | 是 | 部分支持* | 否 | 是 |
| **yep-anywhere** | 是 | 是 | 是 | 是 | 是 |

*VS Code Remote 能用，但 webview 状态较脆弱。

## 后续方向

计划功能见本目录下带日期的文档。当前 Codex Goal 专题从 [2026-08-14-codex-goal-support-plan.md](./2026-08-14-codex-goal-support-plan.md) 开始；文档中的“已完成/未开始”状态和执行记录应与实际实现同步更新。
