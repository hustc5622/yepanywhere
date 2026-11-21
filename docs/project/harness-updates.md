# 从 Yep 更新 Harness CLI

入口：**设置 → 提供商 → CLI 更新**。先检查更新，存在更高的目标版本时点击「更新 CLI」。页面提供当前版本、检查时间、安装路径、更新日志和失败重试。

目前支持当前 Yep 服务器上的：

| Harness | 安装方式 |
| --- | --- |
| Codex CLI（含 Codex OSS 共用的 CLI） | `@openai/codex` 的 npm 全局安装、Homebrew cask |
| Pi Agent | `@earendil-works/pi-coding-agent` 的 npm 全局安装 |
| DeepSeek Harness | `@deepseek-ai/dsh` 的 npm 全局安装；更新前须停止使用该安装的 dsh Web |

支持 macOS 和 Linux。远程 SSH 主机、桌面应用内置二进制、自定义包装脚本、其他包管理器以及其他 harness 暂不通过此入口更新。

## 执行与生效

- 使用与 provider 相同的路径发现规则；npm 更新从真实安装目录定位 npm、Node.js 和 prefix，避免 NVM 与系统 npm 交叉安装。配置路径应指向受支持的全局安装；Homebrew 必须使用稳定的 `bin/codex` 入口。
- Codex、Pi 查询稳定发行版本；dsh 跟随官方 npm `latest` 标签，该标签可能指向 RC。不降级到比本机更旧的版本。npm 安装固定为本次查询得到的版本，不提供任意包或命令入口。Pi 安装禁用依赖生命周期脚本。
- 检查更新才访问包管理器，打开页面只读取本机版本；本机探测缓存 30 秒。更新前再次检测安装位置和版本，结束后复查原路径，避免将包管理器退出成功误报成 CLI 已更新。
- 更新命令使用 Yep 服务账号执行，不提权。目录权限不足、网络错误等会在页面显示，用户可以重试。Codex、Pi 安装最多运行 10 分钟，dsh 最多 30 分钟；日志保留末尾 16,000 个字符。
- 同一个 Yep 服务进程内一次只运行一个更新任务。任务与 HTTP 请求生命周期分离，手机断开、页面刷新或离开设置页不会取消更新；重新进入页面会读取当前任务。状态保存在服务进程内存中，**不跨 Yep 服务重启保存**。
- Yep runtime 报告同一 harness 存在本机执行中、等待输入、保留或已排队的任务时，更新会被拒绝。此检查不管理独立终端或其他宿主上的 CLI 进程。
- 更新不终止已有 CLI、bridge 或 Yep 进程；它们保留已加载版本。后续启动的 CLI 进程使用新版本。已有常驻 bridge 需要在合适的维护窗口重新启动才会加载新版，更新入口不会自动重启它。

## API

接口沿用 `/api/*` 的身份验证和请求安全中间件，并遵守 `ENABLED_PROVIDERS`：

- `GET /api/harness-updates`：当前安装、检查结果及任务状态。
- `POST /api/harness-updates/:id/check`：检查稳定版本；并发检查合并。
- `POST /api/harness-updates/:id/update`：创建后台任务并返回 `202`；已有更新任务时返回 `409`。

`:id` 只接受 `codex`、`pi`、`dsh`。客户端不能指定命令、安装路径、包名或版本。

## 通过终端维护六种 CLI

Cursor、MiniMax Code 和 Antigravity CLI 尚未接入上面的更新 API。自定义包装脚本也需要维护其背后的真实安装，不要覆盖代理、登录或模型路由配置。CLI 更新与桌面 App 更新是独立操作。

| Harness | 原安装渠道的更新命令 |
| --- | --- |
| Codex | npm 安装用 `npm install -g @openai/codex@latest`；Homebrew cask 用 `brew upgrade --cask codex` |
| Pi | `npm install -g @earendil-works/pi-coding-agent@latest --ignore-scripts` |
| Cursor CLI | `agent update`（旧命令名也可用 `cursor-agent update`） |
| Antigravity CLI | 自带后台自更新；手动更新用 `agy update`，或重新运行官方安装脚本 `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |
| MiniMax Code | `mcode update`；npm 手动安装必须使用 `--registry=https://npmmirror.xaminim.com/`，并允许包所需的原生依赖安装脚本 |
| dsh | `npm install -g @deepseek-ai/dsh@latest`；先核对目标版本的 `engines.node`，以及实际启动 dsh 的 Node |

维护顺序：

1. 用 `command -v`、符号链接的真实目标和 `--version` 确认 Yep 使用的安装。系统 npm 与 NVM npm 的全局目录不同，不能只升级终端里碰巧排在最前面的 npm prefix。
2. 查询原 registry 的 `latest` 与 `engines`，记录当前版本；实际安装可固定为检查得到的确切版本。不要仅凭 npm 退出成功判断启动环境兼容。
3. 等使用该安装的任务结束；dsh Web 还需明确停止后才能替换安装。更新 CLI 不等于授权重启 Yep、runtime、bridge 或已有 agent 进程。
4. 更新后复查原入口的 `--version`，再检查 RPC/ACP 初始化或独立 dsh Web 启动。初始化通过不等于完成真实模型对话验收。
5. 如使用 `references/` 排查协议，同步到实际安装版本对应的 tag 或发行包；不要把旧参考源码当成新版本实现。

## 本机维护记录（2026-11-06）

- Codex 的真实 npm 安装位于 `~/.nvm/versions/node/v22.22.2/`；`~/.local/bin/yep-codex-proxy` 仍负责模型代理。升级真实 CLI 后，后续启动会使用新版，已有进程仍使用已加载的版本。
- Pi 使用 `/opt/homebrew/` 的 npm prefix；mcode 使用上述 NVM prefix 和 MiniMax registry。Cursor 由 `agent update` 管理版本目录与入口链接。
- mcode 的原生 SQLite 扩展与安装时的 Node ABI 绑定。`~/.local/bin/mcode` 固定调用 NVM 的 Node 22 和原 npm 入口，避免终端默认 Node 25 导致启动失败；以后通过这个入口执行 `mcode update`，不要跨 Node 主版本重用原生依赖。
- dsh `0.2.2-rc.1` 要求 Node `>=24.9.0`。新版安装在 `/opt/homebrew/`，`~/.local/bin/dsh` 显式调用 `/opt/homebrew/bin/node`（本次为 `25.9.0`）。原 NVM `bin/dsh` 链接到该启动脚本，让 Yep 的 Node 22 服务继续使用原入口而无需重启。
- 此 dsh 包装入口按设计不支持页面内自动更新。后续使用 `/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js --prefix /opt/homebrew install -g @deepseek-ai/dsh@latest`，并保证安装子进程的 `PATH` 以 `/opt/homebrew/bin` 开头；更新后复查包装入口。旧 dsh 包保留用于回退，启动脚本与旧链接目标备份在 `~/.local/share/yep-harness-updates/2026-11-06/`。
- 已运行的 dsh Web 仍使用旧安装，须在允许中断其任务的维护窗口停止并重新启动，才会加载新版。仅更新磁盘 CLI 或重启 Yep Web 都不会替换这个独立进程。

官方说明：[Codex CLI](https://developers.openai.com/codex/cli)、[Cursor CLI 更新](https://cursor.com/docs/cli/installation)、[MiniMax 接入及安装源](mcode.md)、[dsh 生命周期与更新](dsh-web.md)。
