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
- **语音输入**：通过浏览器语音 API 直接和智能体对话
- **移动端性能优化**：语法高亮和 Markdown 渲染在服务端完成

无数据库、无云服务、无账号。100% 开源，采用 MIT 许可证。

## 支持的提供商

| 提供商 | Diff | 审批 | 流式输出 | 说明 |
|--------|------|------|----------|------|
| Claude Code | 完整支持 | 支持 | 支持 | 主要提供商，功能支持最完整 |
| Codex | 完整支持 | 支持 | 支持 | 支持 diff 和审批 |

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

如果你已经能安装 Claude Code 或 Codex，就能安装 Yep Anywhere。依赖很少。

```bash
npm i -g yepanywhere
yepanywhere
```

也可以从源码运行：

```bash
git clone https://github.com/kzahel/yepanywhere.git
cd yepanywhere
pnpm install
pnpm build
pnpm start
```

在浏览器打开 http://localhost:3400。应用会自动检测已安装的 CLI 智能体。

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
```

`start-dev` 默认在后台以 `dev` Profile 运行，关闭原终端不会停止；只有 `start-dev --fg` 使用前台模式。生产服务默认沿用未命名 Profile 和端口 8022，也可通过环境变量显式指定 Profile 或数据目录：Windows 由当前用户的计划任务 `YepAnywhereServer` 管理，macOS 由一个带 `RunAtLoad`/`KeepAlive` 的 LaunchAgent 管理。macOS 也可直接运行 `bash yep.sh <命令>`。

开发运行、生产运行和登录自启动是三个独立状态。`stop-prod` 只停止当前生产实例并保留自启动配置；`disable-autostart` 只删除下次登录自启动并保留当前实例；`stop` 停止开发与生产实例，但不改变自启动开关。`status` 会分别显示安装、加载、运行、自启动、PID、Profile、端口、日志和配置异常。

`rebuild` 先在同一 `dist` 文件系统内创建唯一暂存目录，完成 Bundle 构建、`npm ci --omit=dev` 和运行时校验后，才停止并交换生产 Bundle、通过同一服务定义重启并核对 `buildId`。暂存阶段失败不会停止当前生产服务或触碰生产 Bundle。

默认日志位于 `~/.yep-anywhere/logs/`：开发后台控制台使用 `dev-console.log`（Windows 分为 `.out.log` / `.err.log`）；macOS 生产服务使用 `server-launchd.out.log` / `server-launchd.err.log`，Windows 生产监督器使用 `server.out.log` / `server.err.log`。Windows 需要系统自带的 Windows PowerShell 和 Node.js 20+。

完整部署使用 `pnpm run deploy -- --server-only`。`pnpm deploy` 是 pnpm 自带的 workspace 命令，不会调用本项目的部署脚本。

## 远程访问

服务器运行在你的机器上，客户端会直接连接服务器的 WebSocket。你可以从手机通过自己的网络访问它，例如 Tailscale、局域网 IP，或者带 SSL 终止的反向代理/隧道（如 Caddy）。

如需密码保护，先在服务器项目目录运行 `pnpm yep setup-admin-password`，为当前系统用户设置所有 Profile 共用的管理员密码；再从服务器本机的 loopback 页面，在现有“设置 → 本地访问”中启用或修改普通登录密码。远程用户只能使用普通登录密码，运行时没有认证绕过开关。更多细节见 [远程访问文档](docs/project/remote-access.md)。

## 为什么不用手机终端？

当然可以在手机上用终端，但小屏幕阅读等宽文本很吃力，也没有文件上传、推送通知，更难同时查看所有会话。Yep Anywhere 提供更合适的 UI，同时保持自托管，并让代码仍然在你的本地机器上运行。

## 与其他工具对比

这个方向已有不少项目，我们在这里持续跟踪：**[docs/competitive/all-projects.md](docs/competitive/all-projects.md)**

## 开发

构建说明、配置项和更多开发信息见 [DEVELOPMENT.md](DEVELOPMENT.md)。

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
