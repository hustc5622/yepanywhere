# Yep Anywhere

这是一个面向移动端优先的 Claude Code agent 监督器。它类似 VS Code 的 Claude 扩展，但专为手机和多会话工作流设计。

**核心思路：**
- **服务端持有进程**：Claude 在你的开发机上运行；客户端断开连接不会中断工作
- **多会话仪表盘**：一眼查看所有项目，不需要来回切换窗口
- **移动端监督**：审批通过推送通知到达，可从锁屏直接响应
- **零外部依赖**：不依赖 Firebase，不需要账号体系

**架构：** Hono 服务端管理 Claude SDK 进程。React 客户端通过 WebSocket 连接以接收实时流式输出。会话持久化为 jsonl 文件（由 SDK 处理）。

**远程访问：** 客户端直接连接服务端的 WebSocket。可以在你自己的网络中运行服务端，并通过 Tailscale、局域网 IP，或你控制的任意反向代理 / 隧道访问（例如带 TLS 的 Caddy）。可选的 Cookie 鉴权用于访问控制；见 `docs/project/remote-access.md`。

详细概览见 `docs/project/`。历史愿景文档在 `docs/archive/`。

## 验证流程的自主边界

除非用户明确要求，或当前任务无法在没有这些步骤的情况下完成，否则不要自动进入后续 UI 验证、本地部署或额外 dev server 启动。前端展示类工作尤其如此：完成代码改动，并只运行完成该编辑所需的聚焦、非侵入式检查。启动额外浏览器会话、部署/重新部署服务，或启用备用端口之前，需要先询问用户。

## 快速开始

### 首次运行

```bash
# 安装依赖
pnpm install

# 启动开发模式
pnpm dev

# 访问 http://localhost:3400
```

### 修改代码后

```bash
# 开发模式自动刷新，无需操作

# 如需更新生产模式：
bash yep.sh rebuild
```

### 部署到生产

```bash
# 重构建并重启生产模式
bash yep.sh rebuild
# 构建完成后会自动重启并验证生产模式
```

## 端口配置

项目有两种运行模式，使用不同的默认端口以避免冲突。**端口由 `NODE_ENV` 环境变量自动选择**。

### 开发模式（pnpm dev）

**默认端口：3400**（当 `NODE_ENV != production` 时）

所有端口都从单个 `PORT` 环境变量派生：

| 端口 | 用途 |
|------|------|
| PORT + 0 | 主服务端（默认：3400） |
| PORT + 1 | 维护服务端（默认：3401） |
| PORT + 2 | Vite dev server（默认：3402） |

使用不同端口运行：
```bash
PORT=4000 pnpm dev  # 使用 4000、4001、4002
```

单独覆盖（很少需要）：
- `MAINTENANCE_PORT`：覆盖维护端口（设为 0 可禁用）
- `VITE_PORT`：覆盖 Vite dev 端口

### 生产模式（Bundle 独立部署包）

**默认端口：8022**（当 `NODE_ENV=production` 时）

生产模式运行打包后的独立 Bundle：

```bash
# 启动生产模式（推荐：设置 NODE_ENV=production）
NODE_ENV=production node dist/npm-package/dist/cli.js

# 或使用 yep.sh（会自动使用正确端口）
bash yep.sh start-prod

# 手动指定端口（覆盖默认值）
NODE_ENV=production node dist/npm-package/dist/cli.js --port 9000

# 或使用 PORT 环境变量
NODE_ENV=production PORT=9000 node dist/npm-package/dist/cli.js

# 修改 LaunchAgent 部署端口
YEP_DEPLOY_PORT=9000 scripts/install-launchagents.sh
```

### 端口选择规则

**端口由 `NODE_ENV` 自动选择：**
- `NODE_ENV=production` → 默认 8022（生产模式）
- 其他情况（包括未设置） → 默认 3400（开发模式）

**覆盖优先级（从高到低）：**
1. `--port` CLI 参数
2. `PORT` 环境变量
3. `NODE_ENV` 自动选择的默认值

**说明**：
- 开发模式（3400）和生产模式（8022）使用不同的默认端口，两种模式可以同时运行互不冲突
- 这是 Node.js 生态的标准实践：根据 `NODE_ENV` 自动调整配置
- 如果直接运行 bundle 而不设置 `NODE_ENV=production`，会使用开发模式的默认端口（3400）

### 端口配置示例

```bash
# 开发模式（默认 3400）
pnpm dev

# 生产模式（默认 8022）
NODE_ENV=production node dist/npm-package/dist/cli.js

# 未设置 NODE_ENV（退回开发模式默认 3400）
node dist/npm-package/dist/cli.js

# 手动指定端口（覆盖默认值）
NODE_ENV=production PORT=9000 node dist/npm-package/dist/cli.js
```

## 开发模式 vs 生产模式

### 关键概念

**开发模式**：
- 直接运行源代码，修改后自动重新编译
- 命令：`pnpm dev` 或 `bash yep.sh start-dev`
- 代码位置：`packages/server/src/`, `packages/client/src/`
- 默认端口：3400
- 特点：Vite HMR 自动刷新，无需重构建

**生产模式**：
- 运行打包后的独立部署包
- 命令：`NODE_ENV=production node dist/npm-package/dist/cli.js` 或 `bash yep.sh start-prod`
- 代码位置：`dist/npm-package/`（完整打包产物）
- 默认端口：8022（需要 `NODE_ENV=production`）
- 特点：需要重构建才能看到代码修改

**重构建的含义**：
- 将当前源代码重新打包成生产模式的部署包（`dist/npm-package/`）
- 修改代码后，**只影响开发模式**（源码运行）
- 生产模式继续运行旧的打包代码，**必须重构建 + 重启**才能应用修改

### 模式详细说明

详细的模式对比和使用指南请参考：[docs/DEPLOYMENT_MODES.md](docs/DEPLOYMENT_MODES.md)

### 为什么不使用 `pnpm start`？

你可能会在 `package.json` 中看到 `pnpm start` 命令。**这不是真正的生产模式！**

`pnpm start` 运行的是 `NODE_ENV=production node packages/server/dist/index.js`，它：
- 依赖 pnpm workspace 符号链接
- 无法独立部署
- 不是完整的 Bundle

真正的生产模式应该使用：
```bash
NODE_ENV=production node dist/npm-package/dist/cli.js
```

这才是可以独立部署的完整 Bundle。详细区别见 [docs/DEPLOYMENT_MODES.md](docs/DEPLOYMENT_MODES.md)。

## 数据目录与 Profile

服务端状态存储在数据目录中（默认：`~/.yep-anywhere/`）。其中包括：
- `logs/`：服务端日志
- `indexes/`：会话索引缓存
- `uploads/`：上传文件
- `session-metadata.json`：自定义标题、归档/星标状态
- `notifications.json`：最后已读时间戳
- `push-subscriptions.json`：Web Push 订阅
- `vapid.json`：Push 使用的 VAPID key
- `auth.json`：鉴权状态（密码哈希、会话）

### 运行多个实例

使用 profile 同时运行开发和生产实例（类似 Chrome profile）：

```bash
# 生产环境（默认 profile，端口 8022）
NODE_ENV=production node dist/npm-package/dist/cli.js

# 开发环境（dev profile，端口 3400）
PORT=3400 YEP_ANYWHERE_PROFILE=dev pnpm dev
```

这会创建独立的数据目录：
- 生产环境：`~/.yep-anywhere/`
- 开发环境：`~/.yep-anywhere-dev/`

环境变量：
- `YEP_ANYWHERE_PROFILE`：profile 名称后缀（创建 `~/.yep-anywhere-{profile}/`）
- `YEP_ANYWHERE_DATA_DIR`：数据目录的完整路径覆盖
- `CLAUDE_CONFIG_DIR`：Claude Code 配置目录（默认：`~/.claude`）。用它指向某个 Claude Code profile（例如 `~/.claude-work`）。会话会从 `{CLAUDE_CONFIG_DIR}/projects/` 扫描。

注意：默认情况下，所有实例共享 `~/.claude/projects/`（SDK 管理的会话）。如需每个实例使用不同的 Claude Code profile，请设置 `CLAUDE_CONFIG_DIR`。

## Provider 与功能配置

限制可用的 agent provider 和功能：

```bash
# 只显示 Claude Code（隐藏 Codex、Gemini 等）
ENABLED_PROVIDERS=claude pnpm dev

# 禁用语音输入（麦克风按钮）
VOICE_INPUT=false pnpm dev

# 组合示例：仅 Claude、无语音、dev profile
ENABLED_PROVIDERS=claude VOICE_INPUT=false PORT=4000 YEP_ANYWHERE_PROFILE=dev pnpm dev
```

环境变量：
- `ENABLED_PROVIDERS`：要暴露的 provider 名称列表，逗号分隔（默认：全部）。有效名称：`claude`、`claude-ollama`、`codex`、`codex-oss`、`gemini`、`gemini-acp`、`opencode`
- `VOICE_INPUT`：设为 `false` 可在服务端禁用语音输入按钮（默认：`true`）

## 编辑代码后

编辑 TypeScript 或其他源码文件后，验证改动可以编译并通过检查：

```bash
pnpm lint       # Biome linter
pnpm typecheck  # TypeScript 类型检查（快，无 emit）
pnpm test       # 单元测试
pnpm test:e2e   # E2E 测试（如果涉及 UI 改动）
```

对于站点改动（`site/` 中的营销页面）：
```bash
cd site && npm run build   # Astro check + build（或从根目录运行：pnpm site:build）
```

在认为任务完成前，先修复所有错误。

## 本地部署与重构建

### 使用 yep.sh（推荐）

`yep.sh` 是主要的项目管理工具，提供交互式菜单和命令行接口：

```bash
# 交互式菜单
bash yep.sh

# 命令行模式
bash yep.sh start-dev      # 启动开发模式
bash yep.sh start-prod     # 启动生产模式
bash yep.sh stop           # 停止所有服务
bash yep.sh restart-dev    # 重启开发模式
bash yep.sh restart-prod   # 重启生产模式
bash yep.sh status         # 查看服务状态
bash yep.sh rebuild        # 重构建项目
```

**yep.sh rebuild 会自动执行**：
1. `pnpm lint` - Biome linter 检查
2. `pnpm typecheck` - TypeScript 类型检查
3. `pnpm --filter client build` - 构建客户端
4. `pnpm build:bundle` - 构建完整部署包
5. `cd dist/npm-package && npm ci --omit=dev` - 按运行时锁安装依赖
6. `chmod +x dist/npm-package/dist/cli.js` - 设置执行权限
7. 自动重启生产模式（LaunchAgent 守护）并执行部署验证

**关键**：重构建完成后，必须重启生产模式服务才能应用新代码。`bash yep.sh rebuild` 会自动重启并验证生产模式，不再提示选择开发/生产重启模式。

### ⚠️ 重要：依赖安装方法

在 `dist/npm-package/` 中安装依赖时，**必须使用 `npm ci`，不能使用 `pnpm install` 或 `npm install`**。

**原因**：
- `dist/npm-package/` 是独立的打包产物，不是 workspace 的一部分
- pnpm 在 monorepo 中会尝试链接 workspace，导致路径错误
- `npm ci` 严格按受版本控制的 `scripts/runtime-package-lock.json` 安装所有依赖
- 构建会把该锁复制为 `dist/npm-package/npm-shrinkwrap.json`

**错误方法**：
```bash
cd dist/npm-package
pnpm install  # ❌ 会失败！
```

**正确方法**：
```bash
cd dist/npm-package
npm ci --omit=dev  # ✅ 正确
```

### 使用 scripts/deploy.sh（完整部署）

`scripts/deploy.sh` 提供了更完整的部署流程，包括 APK 构建：

```bash
# 交互式部署向导
scripts/deploy.sh

# 仅重构建和重启服务端
scripts/deploy.sh --server-only

# 仅构建 APK
scripts/deploy.sh --apk-only
```

**说明**：`scripts/deploy.sh` 包含服务端 rebuild、restart、verify 和 APK 构建。如果只需要重构建服务端，使用 `bash yep.sh rebuild` 更快捷。

### 手动构建流程（了解原理）

```bash
# 1. 验证代码
pnpm typecheck
pnpm lint

# 2. 构建完整 bundle
pnpm build:bundle

# 3. 安装运行时依赖（关键：必须用 npm）
cd dist/npm-package
npm ci --omit=dev --no-audit --no-fund
cd ../..
pnpm bundle:verify dist/npm-package

# 4. 设置执行权限
chmod +x dist/npm-package/dist/cli.js

# 5. 重启生产模式
bash yep.sh restart-prod
```

### 部署验证

重构建后会执行部署验证，比较：
- 运行中服务端的 `/api/version` 中的 `build.buildId`
- 前端 `/build-info.json` 中的 `buildId`
- `dist/npm-package/build-info.json` 中的 `buildId`

如果验证失败，说明响应端口的进程或静态前端 bundle 不是刚构建的代码。

## 服务端日志

服务端应用日志路径会在启动时打印为 `[Config] Log file: ...`，默认位于 `{dataDir}/logs/`（默认：`~/.yep-anywhere/logs/`）：

- `server.log`：开发模式日志（`pnpm dev`）
- `e2e-server.log`：E2E 测试期间的服务端日志
- `server-launchd.out.log`：LaunchAgent 标准输出日志
- `server-launchd.err.log`：LaunchAgent 错误输出日志

**开发模式日志**：
```bash
tail -f ~/.yep-anywhere/logs/server.log
```

**生产模式日志**（LaunchAgent）：
```bash
tail -f ~/.yep-anywhere/logs/server-launchd.out.log
tail -f ~/.yep-anywhere/logs/server-launchd.err.log
```

**开发后台控制台日志**：
```bash
tail -f ~/.yep-anywhere/logs/dev-console.log
```

所有 `console.log/error/warn` 输出都会被捕获。应用日志文件通常是 JSON 格式；stdout/stderr 日志会 pretty-print。

**日志环境变量**：
- `LOG_DIR`：自定义日志目录
- `LOG_FILE`：自定义日志文件名（默认：server.log）
- `LOG_LEVEL`：最低级别：fatal、error、warn、info、debug、trace（默认：info）
- `LOG_FILE_LEVEL`：文件日志的独立级别（默认：与 LOG_LEVEL 相同）
- `LOG_TO_FILE`：设为 `"true"` 可启用文件日志（默认：关闭）
- `LOG_PRETTY`：设为 `"false"` 可禁用控制台 pretty logs（默认：开启）

## 维护服务端

一个单独的轻量 HTTP 服务运行在 PORT + 1（默认 3401），用于带外诊断。当主服务无响应时很有用。

```bash
# 检查服务状态
curl http://localhost:3401/status

# 运行时启用 proxy debug logging
curl -X PUT http://localhost:3401/proxy/debug -d '{"enabled": true}'

# 运行时修改日志级别
curl -X PUT http://localhost:3401/log/level -d '{"console": "debug"}'

# 启用 Chrome DevTools inspector
curl -X POST http://localhost:3401/inspector/open
# 然后在 Chrome 中打开 chrome://inspect

# 触发服务端重启
curl -X POST http://localhost:3401/reload
```

可用 endpoints：
- `GET /health`：健康检查
- `GET /status`：内存、uptime、连接
- `GET|PUT /log/level`：获取/设置日志级别
- `GET|PUT /proxy/debug`：获取/设置 proxy debug logging
- `GET /inspector`：Inspector 状态
- `POST /inspector/open`：启用 Chrome DevTools
- `POST /inspector/close`：禁用 Chrome DevTools
- `POST /reload`：重启服务端

环境变量：
- `MAINTENANCE_PORT`：维护服务端端口（默认：PORT + 1，设为 0 可禁用）
- `PROXY_DEBUG`：启动时启用 proxy debug logging（默认：false）

## 客户端控制台日志

远程收集移动客户端浏览器的 `console.log/warn/error`。这对调试无法打开 DevTools 的设备上的连接问题很有用。

**启用：** Developer Mode settings -> "Remote Log Collection" toggle。

**存储：** `{dataDir}/logs/client-logs/`（默认：`~/.yep-anywhere/logs/client-logs/`）。每天每个设备一个 JSONL 文件，命名为 `client-{YYYY-MM-DD}-{deviceId}.jsonl`。设备 UUID 会持久化到客户端的 `localStorage`。

每一行都是一个日志事件：
```json
{"timestamp":1770790157738,"level":"log","prefix":"[SecureConnection]","message":"[SecureConnection] Closed: 1006","_receivedAt":1770790161477}
```

每次会话启动时会写入一个 `[ClientInfo]` 条目，包含 user agent、屏幕尺寸、DPR 和语言。

```bash
# 列出设备日志文件
ls ~/.yep-anywhere/logs/client-logs/

# 查看某个设备今天的日志
cat ~/.yep-anywhere/logs/client-logs/client-$(date +%Y-%m-%d)-<deviceId>.jsonl

# 跟随新增日志
tail -f ~/.yep-anywhere/logs/client-logs/*.jsonl
```

**实现：** `packages/client/src/lib/diagnostics/ClientLogCollector.ts`（客户端），`packages/server/src/routes/client-logs.ts`（服务端 `POST /api/client-logs`）。

## 调试 Codex 会话分支问题

处理 Codex 编辑消息/session branch 问题时，先检查服务端日志中的关键事件：

- `session_resume_requested`：API 收到了 provider、`resumeSessionAt` 和 `rollbackNumTurns`
- `session_rewind_existing_process_restart`：Supervisor 终止了现有进程，使 rewind 参数能生效
- `provider_session_start_requested`：provider 启动选项包含 rewind 字段
- `codex_thread_rollback_requested` 和 `codex_thread_rollback_completed`：确实调用了 Codex app-server 的 `thread/rollback`

如果 Codex JSONL 中没有 `thread_rolled_back` 事件且这些日志缺失，说明 client/server 路径没有提交 rollback。如果这些日志存在但 JSONL 没有 marker，需要调查 Codex app-server 响应路径。

## 校验会话数据

用 Zod schema 校验 JSONL 会话文件：

```bash
# 校验 ~/.claude/projects 中的所有会话
npx tsx scripts/validate-jsonl.ts

# 校验指定文件或目录
npx tsx scripts/validate-jsonl.ts /path/to/session.jsonl
```

schema 变更后运行它，以验证与现有会话数据的兼容性。

## 校验工具结果

用 ToolResultSchemas 校验 SDK 原始日志中的 `tool_use_result` 字段：

```bash
# 校验 sdk-raw.jsonl（默认位置）
npx tsx scripts/validate-tool-results.ts

# 只输出摘要（无错误详情）
npx tsx scripts/validate-tool-results.ts --summary

# 按工具名过滤
npx tsx scripts/validate-tool-results.ts --tool=Edit
```

SDK 会在工具结果旁提供结构化 `tool_use_result` 对象。当设置 `LOG_SDK_MESSAGES=true` 时，这些对象会记录到 `~/.yep-anywhere/logs/sdk-raw.jsonl`。添加新工具 schema 后，或调试工具结果解析时，运行此脚本。

## 类型系统

类型定义在 `packages/shared/src/claude-sdk-schema/` 中（以 Zod schema 作为事实来源）。

关键模式：
- **消息识别**：使用 `getMessageId(m)` helper，它返回 `uuid ?? id`
- **内容访问**：优先使用 `message.content`，而不是顶层 `content`
- **类型判别**：使用 `type` 字段（user/assistant/system/summary）

## 依赖安全维护

定期运行 `pnpm audit --prod`，特别关注 `web-push -> asn1.js -> bn.js` 链路。在 `web-push` 发布上游修复前，保持 `bn.js` 已打补丁（当前通过 pnpm override）。

## Git 提交

提交信息中不要提及 Claude、AI 或任何 AI assistant。像人类开发者一样撰写提交信息。

## 发布到 npm

该包通过 GitHub Actions 和 OIDC trusted publishing 发布到 npm，包名为 `yepanywhere`（不在 secrets 中存储 npm token）。

**发布前：**

1. 在 `CHANGELOG.md` 中新增版本章节：
   ```markdown
   ## [0.1.11] - 2025-01-24

   ### Added
   - New feature description

   ### Fixed
   - Bug fix description
   ```

2. 提交 changelog 更新

3. 打 tag 并推送：
   ```bash
   git tag v0.1.11
   git push origin v0.1.11
   ```

CI workflow 会验证 changelog 包含待发布版本的条目。如果缺失，发布会失败并提示更新 changelog。

workflow 会运行 lint、typecheck 和 tests，然后通过 `pnpm build:bundle` 构建，并使用 `--provenance` 发布以提供供应链证明。它还会创建带自动生成说明的 GitHub Release。

## 发布网站

网站（营销落地页）与 npm 包分开部署到 GitHub Pages。**推送到 main 不会部署网站**，只会运行 CI（lint、typecheck、tests）。网站只会在推送 `site-v*` tag 时部署（或通过手动 workflow_dispatch）。

完整流程见 `site/RELEASING.md`。

快速参考：
```bash
# 先更新 site/CHANGELOG.md，然后：
scripts/release-website.sh 1.5.3
```

## Android 模拟器测试

当 Android 模拟器可用时，始终使用它测试。用 `source ~/.profile && adb devices` 检查，并在可能时部署/测试到模拟器。

## 浏览器控制（UI 测试）

使用 `~/code/claw-starter` 下的 claw-starter 浏览器技能自动化测试 Web UI。它基于 Playwright 和无头 Chromium。

**启动浏览器服务**（如果尚未运行）：

```bash
cd ~/code/claw-starter && npx tsx lib/browser/server.ts &
```

**CLI 命令**（从 `~/code/claw-starter` 运行）：

```bash
npx tsx lib/browser-cli.ts status              # 检查服务是否运行
npx tsx lib/browser-cli.ts open <url>           # 在新标签页打开 URL
npx tsx lib/browser-cli.ts navigate <url>       # 导航当前标签页
npx tsx lib/browser-cli.ts snapshot --efficient  # 读取页面（accessibility tree）
npx tsx lib/browser-cli.ts screenshot           # 截图（返回路径）
npx tsx lib/browser-cli.ts click e5             # 按 ref 点击元素
npx tsx lib/browser-cli.ts type e5 "text"       # 向元素输入文本
npx tsx lib/browser-cli.ts evaluate "JS expr"   # 执行 JS 并返回结果
npx tsx lib/browser-cli.ts tabs                 # 列出打开的标签页
npx tsx lib/browser-cli.ts close                # 关闭标签页
```

**工作流**：snapshot -> act（按元素 ref click/type）-> 再次 snapshot 验证。

完整 CLI 参考见 `~/code/claw-starter/README.md`。

## ChromeOS 调试

对于 Chromebook 测试和调试（截图、输入、诊断），使用 chromeos-testbed CLI，不要使用浏览器控制技能（后者用于本地无头 Chromium）。

```bash
~/code/chromeos-testbed/bin/chromeos screenshot              # 保存截图并打印路径
~/code/chromeos-testbed/bin/chromeos screenshot output.png   # 保存到 output.png
~/code/chromeos-testbed/bin/chromeos help                    # 完整命令列表
```

需要能 SSH 到 `chromeroot`。详情见 `~/code/chromeos-testbed/CLAUDE.md`。
