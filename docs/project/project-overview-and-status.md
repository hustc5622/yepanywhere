# Yep Anywhere：项目总览与状态

Yep Anywhere 是用于管理 Claude 和 Codex 智能体的 Web 界面，在手机和桌面端都能良好使用。

> 原始愿景文档和更详细的设计背景见 `docs/archive/`。
>
> 当前分支的二次开发内容见 [本分支新增与修复说明](../本分支新增与修复.md)。

## 它是什么

可以把它理解为类似 VS Code Claude 扩展的体验，但重点不同：

- **多提供商**：支持 Claude、Codex（包括本地模型）、Gemini
- **移动优先**：触控友好的 UI、推送通知，适合在手机上使用
- **多会话**：从一个面板查看所有项目，不需要来回切换窗口
- **服务端托管**：断开后可以重新连接，不丢失状态

## 当前状态

### 已可用功能

**核心循环**

- 服务端启动并管理 Claude Code SDK 进程
- 通过 WebSocket 向客户端实时流式推送智能体消息
- Claude 正在工作时支持消息排队
- 工具审批 UI 支持批准/拒绝操作
- 权限模式：`default`、`acceptEdits`、`plan`、`bypassPermissions`

**会话管理**

- 多项目仪表盘展示全部会话
- 通过 SDK 的 jsonl 文件持久化会话
- 进程重启后可继续会话
- 检测外部会话（CLI、VS Code）并以只读方式展示
- 支持自定义会话标题和归档状态
- 会话检查器可浏览仓库文件，并在文件变动时刷新目录树
- 会话内支持文件多标签页预览和文本编辑

**移动端体验**

- PWA 支持安装为 Web 应用
- 审批请求支持推送通知（VAPID，无 Firebase）
- 可在锁屏界面批准/拒绝
- WebSocket 自动重连并恢复会话

**智能体功能**

- 跟踪 subagent（Task 工具）并展示状态
- 支持模型选择和提供商原生思考程度档位
- 支持 Markdown、PDF、DOCX、CSV/TSV 与 XLS/XLSX 文件预览
- 通过 WebSocket 上传文件
- Plan mode 支持审批工作流
- 通过浏览器语音 API 输入语音
- 支持会话搜索和筛选

**多提供商支持**

- Claude Code：完整支持，是主要提供商，工具可见性最好
- Codex：功能可用，但透明度有限，编辑过程较黑盒，没有细粒度工具事件
- Codex-OSS：通过 shell 命令使用本地模型，比云端 Codex 更透明
- Gemini：只读模式，没有编辑工具，适合探索和规划

**本分支运维能力**

- 设置页可检查更新、重构建本地最新代码，或拉取 GitHub 最新代码后重构建
- `pnpm yep` 可交互管理 Windows 和 macOS 的开发、生产和登录自启动服务
- 管理员密码可在服务器本机管理普通登录密码，且跨当前系统用户的 Profile 生效

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
│  - Supervisor: 管理进程池和 worker 队列                     │
│  - Process: 封装 Claude SDK，处理审批和消息队列             │
│  - SessionReader: 通过 DAG 合并 jsonl 和实时事件            │
│  - PushNotifier: VAPID Web Push                             │
└─────────────────────────┬───────────────────────────────────┘
                          │ Claude Code SDK
┌─────────────────────────▼───────────────────────────────────┐
│  Claude Code CLI                                            │
│  - 运行在 ~/.claude/projects/{projectId}/                   │
│  - 持久化到 session jsonl 文件                              │
└─────────────────────────────────────────────────────────────┘
```

### 已知缺口

| 领域 | 状态 | 说明 |
|------|------|------|
| 多设备推送 | 基础可用 | 已能工作，可能还需要清理过期 subscription |
| 进程恢复 | 符合当前设计 | 服务端重启会停止进程；下一条消息可继续会话 |

## 技术栈

- **服务端**：Node.js、Hono、@anthropic-ai/claude-code SDK
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

计划功能见本目录下带日期的文档，例如 `2026-01-05-*.md`。
