# 部署模式说明

本分支使用 `pnpm yep` 统一管理 Windows 和 macOS 的开发、生产及登录自启动服务。

## 模式对比

| 项目 | 开发模式 | 生产模式 |
|------|----------|----------|
| 推荐启动 | `pnpm yep start-dev` | `pnpm yep start-prod` |
| 默认端口 | 3400 | 8022 |
| 运行内容 | 源码与 Vite 开发服务器 | `dist/npm-package/` 独立 Bundle |
| 默认 Profile | `dev` | 未命名默认 Profile |
| 终端行为 | 默认后台，`--fg` 前台 | 由平台服务管理器后台运行 |
| 自动更新 | 源码变更自动重载 | 运行 `pnpm yep rebuild` 后生效 |

## 常用命令

```bash
# 打开中文交互菜单
pnpm yep

# 开发服务
pnpm yep start-dev
pnpm yep start-dev --fg
pnpm yep stop-dev
pnpm yep restart-dev

# 生产服务
pnpm yep start-prod
pnpm yep stop-prod
pnpm yep restart-prod
pnpm yep rebuild

# 状态与自启动
pnpm yep status
pnpm yep enable-autostart
pnpm yep disable-autostart
```

Windows 由当前用户的 `YepAnywhereServer` 计划任务管理生产服务；任务动作是常驻的 `watch-yepanywhere.ps1`，它启动内层 `run-yepanywhere.ps1` supervisor。macOS 由 LaunchAgent 管理生产服务。

## 开发模式

`pnpm yep start-dev` 默认使用 `dev` Profile、端口 3400，并在后台运行以便关闭启动终端后继续服务。

`pnpm yep start-dev --fg` 在当前终端前台运行，适合实时查看开发输出。

开发服务的主端口、维护端口和 Vite 端口默认分别为 3400、3401 和 3402，可通过 `YEP_DEV_PORT`、`YEP_DEV_MAINT_PORT` 和 `YEP_DEV_VITE_PORT` 覆盖。

## 生产模式

`pnpm yep start-prod` 运行已构建的独立 Bundle，默认端口为 8022，并由计划任务或 LaunchAgent 与启动终端隔离。

Windows 纳管生产实例同时使用 8022 主端口和 `ServerPort+1` 维护端口（当前为 8023）。维护端口只监听 `127.0.0.1`，绝不能通过 FRP 发布。

可用 `YEP_DEPLOY_PORT`、`YEP_ANYWHERE_PROFILE` 或 `YEP_ANYWHERE_DATA_DIR` 在安装或启动生产服务时指定端口和数据目录。

`pnpm yep stop-prod` 只停止当前生产实例而保留登录自启动，`pnpm yep disable-autostart` 只关闭后续登录自启动而不停止当前实例。

Windows 下直接结束内层 supervisor 属于意外失败，常驻 watchdog 会在短暂延迟后重新启动 supervisor，并接管仍健康的已验证子进程。`pnpm yep stop-prod` 会先通过 `Stop-ScheduledTask` 停止 watchdog；登录触发器没有周期重复，因此任务不会自行复活，随后只清理身份验证通过的内层 supervisor 和子进程。PID 本身从来不是终止进程的授权，停止前必须核验进程身份。

## 重构建与更新

`pnpm yep rebuild` 依次执行代码检查、在暂存目录构建 Bundle、使用 `npm ci --omit=dev` 安装运行时依赖、校验运行时包、确认当前没有执行中的 AI 回合或排队消息、交换 Bundle、重启生产服务并完成运行验证。Windows 检测到 `unknown-conflict`、活动回合或排队消息时会在停机和目录移动前拒绝部署，且没有强制绕过参数。

暂存构建、依赖安装或校验失败时，当前生产 Bundle 和运行中的生产服务保持不变。

Windows 完整重构建会把旧 Bundle 保留为 `npm-package-rollback-*`，直到计划任务为 `Running`、v2 进程清单与端口/bridge 身份完全匹配、`buildId`、worker readiness 和维护 `/health` 全部通过。新版本启动或验证失败时，新 Bundle 会保存在 `npm-package-failed-*`，旧 Bundle 按固定顺序恢复并重新验证；回滚本身失败时不会继续清理生产目录、失败目录、回滚证据、进程清单或日志。

`--server-build-only` 仍只在生产服务已停止时交换并校验 Bundle，不启动服务；运行时自动回滚只适用于会重启服务的 `rebuild` / `--server-only`。

设置页的“更新到本地最新版本”复用本地工作树执行同一构建流程，“更新到 GitHub 最新版本”会先拉取远程代码再执行构建流程。

## 日志与状态

所有运行状态可通过 `pnpm yep status` 查看，其中包括服务定义、运行状态、自启动、PID、Profile、端口、日志路径和配置异常。Windows 生产状态明确报告 `healthy`、`degraded-adoptable`、`verified-stale`、`unknown-conflict` 或 `stopped`，并显示 Task Scheduler 状态与最近结果。

日志默认位于 `~/.yep-anywhere/logs/`，macOS 开发日志为 `dev-console.log`、生产日志为 `server-launchd.out.log` 和 `server-launchd.err.log`。

Windows 开发日志为 `dev-console.out.log` 和 `dev-console.err.log`，生产日志为 `server.out.log` 和 `server.err.log`。

## 不建议的入口

`pnpm start` 运行的是 workspace 编译产物，不是独立 Bundle 的标准生产入口。

生产部署请使用 `pnpm yep rebuild` 和 `pnpm yep start-prod`，而不是直接对 `dist/npm-package/` 执行 `pnpm install`。

独立 Bundle 的运行时依赖必须使用 `npm ci --omit=dev` 安装。
