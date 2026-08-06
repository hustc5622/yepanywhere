# Yep Anywhere Agent 说明

本文件是本仓库中 Codex CLI 会话的项目级指令来源。内容应聚焦大多数任务都会用到的上下文和行为约束；较长的专题说明放到 `docs/project/`。

## 语言要求

- 本项目默认使用中文与用户沟通，包括过程说明、最终回复、计划、风险提示和变更总结。
- 项目级说明文档优先使用中文编写。代码、API 名称、命令、日志字段、错误信息和第三方术语保留原文。
- 如果用户明确要求英文，或需要与上游英文接口/文档保持一致，可以改用英文。
- 客户端界面只维护英文（`en`）和简体中文（`zh-CN`）两套语言。新增或修改界面文案时同步更新这两个语言包；除非用户明确要求扩大产品语言范围，否则不要新增或维护其他 locale。

## Codex CLI 行为

- 除非用户明确要求 UI/browser/vibe test，或明确说要使用 Chrome/Browser 工具，否则不要主动使用浏览器自动化、Chrome DevTools、Browser Use、Playwright、截图检查或 in-app browser 工具。
- 除非用户明确授权，否则不要重启、停止、kill、替换或接管已经运行的服务，包括 dev server、launchd 服务、端口监听进程和本地守护进程。
- 如果验证必须依赖浏览器自动化或重启/停止服务，先说明原因并等待确认。优先采用不干扰现有状态的检查方式。
- 使用 `imagegen` 生成图片时，最终交付文件默认放到 `~/Downloads/`。如果项目代码需要引用该资产，可以额外复制一份到仓库内。
- 工作树经常是 dirty 状态。只编辑当前任务需要的文件，不要回滚无关改动。

## 项目上下文

Yep Anywhere 是一个面向移动端优先的 coding agent 监督器。核心工作流是：agent 在开发机上运行，服务端进程在客户端断开后继续保活，React 客户端展示多项目/多会话状态，并支持移动端审批和通知。

架构：
- Hono 服务端管理 provider 进程，并暴露 REST/WebSocket API。
- React 客户端通过 WebSocket 流式展示 session 状态。
- session 数据以 provider JSONL/session 文件持久化，并在展示前做 normalize。
- 支持多个 provider：Claude Code、Codex、Gemini、opencode 以及相关 bridge 模式。

从过去的 Codex session 看，本仓库高频工作主要集中在：
- Codex bridge / remote app-server 行为（`4510`、`cf`、MCP profiles）。
- session 编辑、rollback、分支和 transcript 展示。
- 工具结果 renderer，包括 search/fetch/detail 展示。
- 本地 `8022` web/API 服务的部署检查和 build metadata 校验。
- 日志、诊断、schema normalization 和 provider 兼容性。

涉及 opencode 的行为、协议、事件流、工具调用或展示改动时，先查看仓库内已有的 opencode 参考源码，不要凭印象实现。参考源码位于 `references/opencode/`；本项目自身的实现入口通常在 `packages/server/src/opencode-bridge/` 和 `packages/shared/src/opencode-schema/`。

涉及 Codex CLI、Codex app-server、remote bridge、session rollback/branch、Codex JSONL/session 解析或 Codex 工具展示改动时，先查看仓库内已有的 Codex CLI 参考源码，不要凭印象实现。参考源码位于 `references/codex/`；其中 app-server 相关实现重点看 `references/codex/codex-rs/app-server*`，CLI/TUI 相关实现重点看 `references/codex/codex-rs/cli` 和 `references/codex/codex-rs/tui`。本项目自身的 Codex 实现入口通常在 `packages/server/src/codex-bridge/`、`packages/server/src/sdk/providers/codex*`、`packages/server/src/sessions/codex-*`、`packages/client/src/lib/codex*` 和 `packages/shared/src/codex-schema/`。

Android 模拟器/真机和 ChromeOS streaming 是产品功能，但不是默认验证路径。只有在用户要求，或任务直接涉及 device-bridge/mobile-shell 行为时，才使用 adb、emulator、APK 安装、ChromeOS testbed 或设备 streaming 流程。

## 端口与 Profile

默认端口都从 `PORT` 派生：

| 端口 | 用途 |
| ---- | ---- |
| `PORT + 0` | 主 web/API 服务，默认 `3400` |
| `PORT + 1` | 维护服务，默认 `3401` |
| `PORT + 2` | Vite dev server，默认 `3402` |

示例：

```bash
PORT=4000 pnpm dev
PORT=4000 YEP_ANYWHERE_PROFILE=dev pnpm dev
```

重要环境变量：
- `YEP_ANYWHERE_PROFILE`：创建 `~/.yep-anywhere-{profile}/`。
- `YEP_ANYWHERE_DATA_DIR`：显式覆盖数据目录。
- `CLAUDE_CONFIG_DIR`：Claude Code 配置/session 根目录，默认 `~/.claude`。
- `ENABLED_PROVIDERS`：逗号分隔的 provider allowlist。有效值包括 `claude`、`claude-ollama`、`codex`、`codex-oss`、`gemini`、`gemini-acp`、`opencode`、`kimi`。
- `VOICE_INPUT=false`：在服务端禁用语音输入按钮。

## 验证

编辑 TypeScript 或其他源码后，根据改动范围运行对应的聚焦检查：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
```

只有改动需要 E2E 覆盖时才运行 `pnpm test:e2e`。浏览器/UI 自动化遵循上面的 Codex CLI 行为约束；除非用户明确要求，否则先询问。

营销站点变更：

```bash
pnpm site:build
```

schema/data 辅助脚本：

```bash
npx tsx scripts/validate-jsonl.ts
npx tsx scripts/validate-tool-results.ts --summary
```

## 部署与日志

本地类生产服务通常运行在 `http://127.0.0.1:8022/yep`。Codex bridge 通常运行在 `4510`。

没有用户明确授权时，不要重启这些服务。用户确认可以部署/重启时，优先使用统一入口：

```bash
scripts/deploy.sh
scripts/deploy.sh --server-only
scripts/deploy.sh --apk-only
pnpm deploy -- --server-only
```

常用日志：
- `~/.yep-anywhere/logs/server.log`：启用文件日志时的 app log。
- `/private/tmp/yep-server.log`：本地 `8022` launchd 风格实例的 stdout/stderr。
- `~/.yep-anywhere/logs/client-logs/*.jsonl`：Developer Mode remote logging 打开后的客户端 console 日志。

部署/build 校验常比较：
- `/api/version`
- `/build-info.json`
- `dist/npm-package/build-info.json`

排查 Codex 编辑/session branch 问题时，检查日志中的：
- `session_resume_requested`
- `session_rewind_existing_process_restart`
- `provider_session_start_requested`
- `codex_thread_rollback_requested`
- `codex_thread_rollback_completed`

如果这些日志缺失，通常说明 client/server 路径没有提交 rollback。如果这些日志存在，但 Codex JSONL 没有 `thread_rolled_back` marker，需要继续检查 Codex app-server 响应路径。

## 维护服务

维护服务默认运行在 `PORT + 1`，除非显式禁用：

```bash
curl http://localhost:3401/status
curl -X PUT http://localhost:3401/proxy/debug -d '{"enabled": true}'
curl -X PUT http://localhost:3401/log/level -d '{"console": "debug"}'
```

除非用户明确同意重启，否则避免调用 `POST /reload`。

## 类型系统

类型定义在 `packages/shared/src/claude-sdk-schema/`，以 Zod schema 作为事实来源。

关键约定：
- message identity 使用 `getMessageId(m)`，返回 `uuid ?? id`。
- 优先使用 `message.content`，不要优先读顶层 `content`。
- 使用 `type` 字段（`user`、`assistant`、`system`、`summary`）做类型判别。

## 发布

本仓库源自 `kzahel/yepanywhere`，但已二开到视为**独立项目**的程度，按独立发行线管理。主产品 tag 使用 `ya-v*`；裸 `v*` 命名空间属于 upstream，本仓库不创建，也不再被任何 workflow 响应。

版本号是 **CalVer `YYYY.M.N`**（年.月.当月序号），不是 SemVer——不需要判断 patch/minor/major。

凡会进入正式部署产物的功能、修复或兼容性变更，开发时必须更新 `CHANGELOG.md` 的 `[Unreleased]`；正式部署或发布前必须提升根 `package.json` 版本，并确保版本号、CHANGELOG、release tag 与构建产物一致。开发和临时验证不需要提升版本，靠 `buildId` 区分。

- `pnpm version:status` 查看版本 / CHANGELOG / tag / 运行时的当前状态
- `pnpm version:bump` 提升到下一个日历版本并把 `[Unreleased]` 定版（无参数；不自动 commit、不自动打 tag）
- `pnpm version:check` 发布前校验，退出码非 0 即不可发布

详见 `docs/project/versioning.md`。

本仓库不发 npm。`ya-v*` tag 触发 `.github/workflows/release.yml`：跑校验与构建，把 bundle 附到本仓库的 GitHub Release。构建产物包名是 `@hustc5622/yepanywhere`，与 upstream 的 `yepanywhere` 无关。

不要新增指向 upstream（`kzahel/yepanywhere`、`updates.yepanywhere.com`）的运行时依赖——已切断的耦合点见 `docs/project/versioning.md` §14。

网站部署和 package 发布分开。推送 `main` 不会部署网站；网站部署使用 `site-v*` tag 或手动 workflow。见 `site/RELEASING.md`。

## 会话完成

会话结束时，如果有助于用户把握整体计划，简短提示下一个合理步骤。
