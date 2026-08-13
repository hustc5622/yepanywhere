<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="site/public/branding/lockup-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="site/public/branding/lockup-light.svg">
    <img src="site/public/branding/lockup-light.svg" alt="Yep Anywhere" height="60">
  </picture>
</p>

<p align="center">
  <em>移动优先。端到端加密。开源。</em>
</p>

<p align="center">
  <a href="https://yepanywhere.com">yepanywhere.com</a>
</p>

Yep Anywhere 是 Claude Code 和 Codex 的远程操作界面。它自托管、无需云账号，让智能体继续在你的开发机上运行，你可以从手机上查看进度、处理审批并继续对话。

## 本分支新增与修复

> 本仓库基于原作者 [kzahel/yepanywhere](https://github.com/kzahel/yepanywhere) 继续开发；以下为当前分支的新增功能、改进与修复，不代表上游原项目的全部能力。

- **前端更新**：在“设置 → 关于”中可检查版本、重构建本地最新代码，或拉取 GitHub 最新代码后重构建并重启。
- **服务管理**：`pnpm yep` 提供开发与生产服务的中文交互式管理，并支持后台静默运行和登录自启动。
- **密码管理**：管理员密码用于本机恢复和管理普通登录密码，普通密码只允许在服务器本机修改。
- **仓库浏览**：会话检查器可浏览项目仓库、打开文件并在文件变动时刷新目录树。
- **会话参数**：会话检查器支持模型选择和按提供商原生档位设置思考程度，停止的会话也可预设下次启动模型。
- **文件工作区**：文件可在会话内以多个标签页同时打开、编辑、保存或在新浏览器标签页查看。
- **增强预览**：Markdown 支持目录、标题层级、表格和常见文本结构，DOCX、PDF、CSV/TSV 与 XLS/XLSX 可直接预览。
- **稳定性修复**：修复 Windows 更新假成功与文件锁失败、更新检测不准确、会话页空数据崩溃、Codex 默认提供商兼容和发送后长期停留在 Pondering 等问题。

完整的功能与修复清单见 [本分支新增与修复说明](docs/本分支新增与修复.md)。

## 功能

- **跨工具衔接**：查看并继续 CLI、VS Code 或其他工具里启动的会话。不引入新数据库，直接复用 CLI 的会话持久化
- **文件上传**：从手机相册直接发送截图、照片、PDF 和代码文件
- **推送通知**：需要审批时收到提醒，并可在锁屏界面直接响应
- **远程访问**：通过 Tailscale、局域网 IP 或自己的反向代理访问服务器。可选启用基于 cookie 的认证
- **对话分叉/克隆**：从任意消息节点分出新对话，用来探索替代方案
- **分层收件箱**：需要关注、进行中、最近活动、未读分层展示，少在终端标签页之间来回切换
- **全局活动流**：跨会话查看所有智能体当前在做什么
- **远程设备控制**：通过 WebRTC 把 Android 模拟器和设备串流到手机，支持触控、导航按钮和自适应画质
- **服务端托管进程**：客户端断开不会中断正在运行的任务
- **仓库文件工作区**：在会话侧栏浏览仓库文件，并以 VS Code 风格标签页预览或编辑多个文件
- **多格式文件预览**：直接渲染 Markdown、PDF、DOCX、CSV/TSV 和 XLS/XLSX，无法预览的二进制文件可下载
- **会话参数控制**：在新建会话和会话检查器中选择提供商模型，并使用提供商原生的思考程度档位
- **本地更新与服务管理**：从设置页更新本地或 GitHub 代码，并用统一命令管理开发、生产和自启动服务
- **语音输入**：通过浏览器语音 API 直接和智能体对话
- **移动端性能优化**：语法高亮和 Markdown 渲染在服务端完成

无数据库、无云服务、无账号。100% 开源，采用 MIT 许可证。

## 支持的提供商

| 提供商 | Diff | 审批 | 流式输出 | 说明 |
|--------|------|------|----------|------|
| Claude Code | 完整支持 | 支持 | 支持 | 主要提供商，功能支持最完整 |
| Codex | 完整支持 | 支持 | 支持 | 支持 diff 和审批 |
| Codex-OSS | 视模型能力而定 | 支持 | 支持 | 通过 Codex CLI 使用本地模型 |
| Gemini / Gemini ACP | 视提供商能力而定 | 支持 | 支持 | 通过 Gemini CLI 接入 |
| Claude + Ollama / OpenCode | 视提供商能力而定 | 视提供商能力而定 | 支持 | 可选的本地或多提供商接入 |

## 截图

<p align="center">
  <img src="site/public/screenshots/session-view.png" width="250" alt="会话视图">
  <img src="site/public/screenshots/conversation.png" width="250" alt="对话">
  <img src="site/public/screenshots/approval.png" width="250" alt="审批流程">
</p>
<p align="center">
  <img src="site/public/screenshots/navigation.png" width="250" alt="导航">
  <img src="site/public/screenshots/new-session.png" width="250" alt="新建会话">
  <img src="site/public/screenshots/mobile-diff.png" width="250" alt="移动端 diff 视图">
  <img src="site/public/screenshots/device-stream.png" width="250" alt="远程设备控制">
</p>

**桌面端也很好用。**

<p align="center">
  <img src="site/public/screenshots/desktop.png" width="400" alt="桌面视图">
  <img src="site/public/screenshots/desktop-diff.png" width="400" alt="桌面 diff 视图">
</p>

## 快速开始

本分支建议从源码运行；需要 Node.js 20+，并按需安装 Claude Code、Codex 或其他已支持的 CLI 提供商。

```bash
git clone https://github.com/Gumekn/yepanywhere_pb_fork.git
cd yepanywhere_pb_fork
pnpm install
pnpm dev
```

在浏览器打开 http://localhost:3400；`pnpm dev` 直接运行开发服务，修改源码后会自动重载。

如需构建并运行生产服务：

```bash
pnpm yep rebuild
pnpm yep start-prod
```

生产服务默认监听 http://localhost:8022；`pnpm start` 仅用于 workspace 编译产物调试，不是本分支推荐的生产部署入口。

## 本地服务管理

macOS 和 Windows 使用同一个入口管理开发与生产服务：

```bash
pnpm yep
```

入口会自动识别 Windows 或 macOS，并显示中文菜单。也可以直接执行统一命令：

```bash
pnpm yep start-dev
pnpm yep start-dev --fg
pnpm yep stop-dev
pnpm yep restart-dev
pnpm yep start-prod
pnpm yep stop-prod
pnpm yep restart-prod
pnpm yep stop
pnpm yep status
pnpm yep rebuild
pnpm yep enable-autostart
pnpm yep disable-autostart
pnpm yep setup-admin-password
```

`start-dev` 默认在后台以 `dev` Profile 运行，关闭原终端不会停止；只有 `start-dev --fg` 使用前台模式。生产服务默认沿用未命名 Profile 和端口 8022，也可通过环境变量显式指定 Profile 或数据目录：Windows 由当前用户的计划任务 `YepAnywhereServer` 管理，macOS 由一个带 `RunAtLoad`/`KeepAlive` 的 LaunchAgent 管理。macOS 也可直接运行 `bash yep.sh <命令>`。

开发运行、生产运行和登录自启动是三个独立状态。`stop-prod` 只停止当前生产实例并保留自启动配置；`disable-autostart` 只删除下次登录自启动并保留当前实例；`stop` 停止开发与生产实例，但不改变自启动开关。`status` 会分别显示安装、加载、运行、自启动、PID、Profile、端口、日志和配置异常。

`rebuild` 先在同一 `dist` 文件系统内创建唯一暂存目录，完成 Bundle 构建、`npm ci --omit=dev` 和运行时校验后，才停止并交换生产 Bundle、通过同一服务定义重启并核对 `buildId`。暂存阶段失败不会停止当前生产服务或触碰生产 Bundle。

默认日志位于 `~/.yep-anywhere/logs/`：开发后台控制台使用 `dev-console.log`（Windows 分为 `.out.log` / `.err.log`）；macOS 生产服务使用 `server-launchd.out.log` / `server-launchd.err.log`，Windows 生产监督器使用 `server.out.log` / `server.err.log`。Windows 需要系统自带的 Windows PowerShell 和 Node.js 20+。

完整部署可使用 `pnpm run deploy -- --server-only`；不要使用 `pnpm deploy`，它是 pnpm 的 workspace 内置命令，不会调用本项目脚本。

## 远程访问

服务器运行在你的机器上，客户端会直接连接服务器的 WebSocket。你可以从手机通过自己的网络访问它，例如 Tailscale、局域网 IP，或者带 SSL 终止的反向代理/隧道（如 Caddy）。

如需密码保护，先在服务器项目目录运行 `pnpm yep setup-admin-password`，为当前系统用户设置所有 Profile 共用的管理员密码；再从服务器本机的 loopback 页面，在现有“设置 → 本地访问”中启用或修改普通登录密码。远程用户只能使用普通登录密码，运行时没有认证绕过开关。更多细节见 [远程访问文档](docs/project/remote-access.md)。

## 为什么不用手机终端？

当然可以在手机上用终端，但小屏幕阅读等宽文本很吃力，也没有文件上传、推送通知，更难同时查看所有会话。Yep Anywhere 提供更合适的 UI，同时保持自托管，并让代码仍然在你的本地机器上运行。

## 与其他工具对比

这个方向已有不少项目，我们在这里持续跟踪：**[docs/competitive/all-projects.md](docs/competitive/all-projects.md)**

## 开发

构建、端口、Profile 和环境变量说明见 [部署模式说明](docs/DEPLOYMENT_MODES.md) 与 [项目开发说明](CLAUDE.md)。

## TOS 合规

Yep Anywhere 使用 Anthropic 发布的官方 [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)。我们不处理认证、不伪造请求头，也不操作 OAuth token。你通过自己的 Claude CLI 登录，Yep Anywhere 只是这些会话的远程界面。

更多说明：[我们如何使用 SDK](https://yepanywhere.com/tos-compliance.html) | [2026 年 2 月认证说明](https://yepanywhere.com/sdk-auth-clarification.html)

## Star History

<a href="https://www.star-history.com/#kzahel/yepanywhere&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=kzahel/yepanywhere&type=date&legend=top-left&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=kzahel/yepanywhere&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=kzahel/yepanywhere&type=date&legend=top-left" />
  </picture>
</a>

## 许可证

MIT
