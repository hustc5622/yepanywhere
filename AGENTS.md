# Yep Anywhere Agent 说明

本文件是本仓库中 Codex CLI 会话的项目级指令来源。内容应聚焦大多数任务都会用到的上下文和行为约束；较长的专题说明放到 `docs/project/`。

## 语言要求

- 本项目默认使用中文与用户沟通，包括过程说明、最终回复、计划、风险提示和变更总结。
- 项目级说明文档优先使用中文编写。代码、API 名称、命令、日志字段、错误信息和第三方术语保留原文。
- 如果用户明确要求英文，或需要与上游英文接口/文档保持一致，可以改用英文。
- 客户端界面只维护英文（`en`）和简体中文（`zh-CN`）两套语言。新增或修改界面文案时同步更新这两个语言包；除非用户明确要求扩大产品语言范围，否则不要新增或维护其他 locale。

## 本机 shell

这台 Mac 上的 agent 会话（Cursor 和 Codex CLI）都使用 zsh，没有 `~/.bash_profile`。直接在当前 zsh 会话里执行命令，不要 `source ~/.bash_profile`，也不要改用 bash。如果另一条规则要求第一次执行终端命令前 source 该文件，以本节为准。

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
- 支持多个 provider：Claude Code、Codex、Gemini、Pi、MiniMax Code、DeepSeek Harness（只读）以及相关 bridge 模式。ZCode 与 Kimi provider 已移除，旧数据中的 `zcode`、`kimi` 按 retired provider 处理。

从过去的 Codex session 看，本仓库高频工作主要集中在：
- Codex bridge / remote app-server 行为（`4510`、`cf`、MCP profiles）。
- session 编辑、rollback、分支和 transcript 展示。
- 工具结果 renderer，包括 search/fetch/detail 展示。
- 本地 `8022` web/API 服务的部署检查和 build metadata 校验。
- 日志、诊断、schema normalization 和 provider 兼容性。

涉及 Pi（`@earendil-works/pi-coding-agent`）的 RPC 协议、扩展、原生 session tree/fork、工具调用或展示改动时，先查看 `references/pi/`；RPC 重点看 `packages/coding-agent/src/modes/rpc/`，session/extension 重点看 `packages/coding-agent/src/core/`。本项目实现入口通常在 `packages/server/src/sdk/providers/pi.ts`、`packages/server/resources/pi-yep-extension.mjs`、`packages/server/src/sessions/pi-*` 和 `packages/shared/src/pi-schema/`。

涉及 Codex CLI、Codex app-server、remote bridge、session rollback/branch、Codex JSONL/session 解析或 Codex 工具展示改动时，先查看仓库内已有的 Codex CLI 参考源码，不要凭印象实现。参考源码位于 `references/codex/`；其中 app-server 相关实现重点看 `references/codex/codex-rs/app-server*`，CLI/TUI 相关实现重点看 `references/codex/codex-rs/cli` 和 `references/codex/codex-rs/tui`。本项目自身的 Codex 实现入口通常在 `packages/server/src/codex-bridge/`、`packages/server/src/sdk/providers/codex*`、`packages/server/src/sessions/codex-*`、`packages/client/src/lib/codex*` 和 `packages/shared/src/codex-schema/`。

涉及 MiniMax Code（`mcode` provider、`mcode acp`、`~/.minimax` 会话目录/transcript、App 会话接管）改动时，协议事实以本机真实 CLI（`mcode`，npm 包 `@minimax/code`）和 `references/minimax/` 为准；ACP 服务端行为看 `references/minimax/pretty/run-acp-command.js`，存储/权限看 `references/minimax/app/mavis/`。CLI 与桌面 App 共用 `~/.minimax`，Yep 只读其数据库与 transcript，不要写入。实现入口：`packages/server/src/sdk/providers/mcode*.ts`、`packages/server/src/sessions/mcode-*.ts`、`packages/server/src/projects/mcode-scanner.ts`。真实联调脚本 `scripts/smoke-mcode-provider.ts` 会发起模型请求，需用户授权。说明见 `docs/project/mcode.md`。

涉及 DeepSeek Harness（`dsh`）时：Yep 有两部分集成，一是内嵌 `dsh web` 页面（`packages/server/src/dsh/`、`packages/client/src/pages/DshPage.tsx`），二是只读 provider `dsh`，只解析 `~/.dsh/sessions` 下的 zstd 帧日志，不启动、不续接、不写入（`packages/server/src/sessions/dsh-*.ts`、`packages/server/src/projects/dsh-scanner.ts`）。存储格式、事件和 Web 行为以 `references/dsh/`（`deepseek-harness` 源码，按本机 dsh 版本对应的 tag 拉取）为准，不要凭印象实现。说明见 `docs/project/dsh-web.md`。

设备桥接与 Android／ChromeOS 远程串流功能已移除；手机客户端、浏览器设备管理和通知仍保留。只有用户要求，或任务直接涉及 mobile-shell 行为时，才使用 adb、emulator 或 APK 安装流程。

## 端口与 Profile

默认端口都从 `PORT` 派生：

| 端口 | 用途 |
| ---- | ---- |
| `PORT + 0` | 主 web/API 服务，默认 `3400` |
| `PORT + 1` | 维护服务，默认 `3401` |
| `PORT + 2` | Vite dev server，默认 `3402` |
| `PORT + 3` | 外置 agent runtime 控制端口，默认 `3403`（仅 external 形态）|

示例：

```bash
PORT=4000 pnpm dev
PORT=4000 YEP_ANYWHERE_PROFILE=dev pnpm dev
```

重要环境变量：
- `YEP_ANYWHERE_PROFILE`：创建 `~/.yep-anywhere-{profile}/`。
- `YEP_ANYWHERE_DATA_DIR`：显式覆盖数据目录。
- `CLAUDE_CONFIG_DIR`：Claude Code 配置/session 根目录，默认 `~/.claude`。
- `ENABLED_PROVIDERS`：逗号分隔的 provider allowlist。有效值包括 `claude`、`claude-ollama`、`codex`、`codex-oss`、`gemini`、`gemini-acp`、`pi`、`mcode`、`dsh`（只读）。
- `VOICE_INPUT=false`：在服务端禁用语音输入按钮。
- `YEP_RUNTIME_EXTERNAL=true`：部署时把 agent runtime 拆成独立进程（见下面的热叠加章节）。
- `YEP_RUNTIME_MODE`：`embedded`（默认）或 `external`，运行时形态。

## 一次性热叠加（hot-apply）

当 8022 上挂着不能打断的会话，但工作树里有一波改动想立刻用上时，用 `pnpm hot-apply` 把改动叠加到运行中的部署，而不是整机重新部署。它是**一次性**的：只改运行目录下的产物，不改部署形态，下一次正常 `scripts/deploy.sh` 会从提交树完整重建并自动回归。

档位由变更文件自动推导，不由参数决定：

| 档位 | 触发文件 | 会话影响 |
| ---- | ---- | ---- |
| `client` | `packages/client/src` 等 | 无，不重启任何进程 |
| `shell` | `packages/server/src` 中非 runtime 的部分 | embedded 下中断；external runtime 下无 |
| `runtime` | `supervisor/`、`runtime/`、`sdk/providers/`、`packages/shared/`、`packages/server/resources/` | 中断所有活跃 turn |

标准流程：

```bash
pnpm hot-apply --check          # 先看计划，永远从这一步开始
pnpm hot-apply                  # client 档，零中断
pnpm hot-apply --allow-shell    # 需要重启 web/API 时显式授权
pnpm hot-apply --allow-runtime  # 会打断活跃 turn，仅在确认可接受时使用
pnpm hot-apply --status         # 查看当前叠加状态
pnpm hot-apply --revert         # 回滚上一次 client 叠加
```

约束：

- 档位超出授权时命令以退出码 `2` 拒绝执行，不会偷偷重启任何东西。
- `--allow-runtime` 等同于中断线上会话，必须先取得用户明确同意，和重启服务的约束一致。
- `runtime` 档的改动不要强行叠加，等 idle 走正常部署。
- baseline 是运行中部署的 `build.gitCommit`，所以 diff 是“自部署以来的全部改动”，不只是最近一次编辑。

想让 `shell` 档也变成零中断，需要把 agent runtime 拆成独立进程（一次性切换，需要一次重启窗口）：

```bash
scripts/deploy.sh --server-only --external-runtime
```

切换后 `/api/status/workers` 的 `runtimeMode` 变为 `external`，此后 `scripts/deploy.sh --server-only` 只替换 web/API 进程，活跃会话不受影响；只有 `scripts/redeploy-server.sh --restart-runtime` 才会打断它们。

外置 runtime 是 **opt-in**：普通部署不会自动切换形态。三种启用方式：命令行 `--external-runtime`、交互式向导里的 `Agent runtime placement` 问题，或在 `.env.deploy.local` 写 `YEP_RUNTIME_EXTERNAL=true`（一次决定、长期生效；向导里显式回答 no 优先级更高）。

完整说明见 `docs/project/hot-apply-and-external-runtime.md`。

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
- `~/.yep-anywhere/logs/runtime-launchd.*.log`：外置 agent runtime 的 stdout/stderr（仅 external 形态）。
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

## 客户端字体与字号

- 字体栈和字号只在 `packages/client/src/styles/typography.css` 定义；普通 UI 使用 `--font-sans`，代码/路径使用 `--font-mono`，字号使用已定义的 `--font-size-*` 或继承。
- 新页面、侧栏、弹窗默认继承统一正文；不要自行写 px/rem/em 字号、拼接另一套字体栈、重定义字号变量或用局部倍数制造新字号。React 内联样式也遵守同样规则。
- 用户字号由 `useFontSize` 单独调整根比例，不再对各 token 重复写像素值。移动输入框使用 `--font-size-input`；终端、SVG 和启动画面的有限例外见 [字体约束](docs/project/typography.md)。
- 修改 UI 后运行 `pnpm lint:typography`；此检查也属于 `pnpm lint` 和客户端构建。新增字号角色应更新唯一入口和说明，不应绕开检查。

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
