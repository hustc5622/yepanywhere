# 一次性热叠加（hot-apply）与外置 agent runtime

面向的问题：8022 上常年挂着正在跑的 agent 会话，但工作树里有一波改动想立刻用上。整机重新部署会打断这些会话，于是改动一直压着不敢上。

本文说明两件事：

1. **hot-apply**：把当前工作树按“最小中断层级”叠加到正在运行的部署上，用完即弃，下次正常 deploy 自动回归。
2. **外置 agent runtime**：把持有 provider 子进程的 runtime 拆成独立进程，让 8022 重启不再中断会话。这是让 hot-apply 的 `shell` 档也变成零中断的前置条件。

## 1. 三层中断模型

任何一次改动，按"能打到运行中服务的最小代价"分为四档。档位由变更文件推导，不由参数决定。

| 档位 | 触发文件 | 动作 | 会话影响 |
| --- | --- | --- | --- |
| `none` | 只有 docs / scripts / 测试 | 无 | 无 |
| `client` | `packages/client/src` 等 | 重建浏览器包并原子替换 `client-dist` | **无**，不碰任何进程 |
| `shell` | `packages/server/src` 里非 runtime 的部分 | 重建 bundle 并重启 web/API 进程 | embedded 下中断；external runtime 下**无** |
| `runtime` | `supervisor/`、`runtime/`、`sdk/providers/`、`packages/shared/`、`packages/server/resources/` | 重启 runtime worker | **中断所有活跃 turn** |

分类实现在 `scripts/runtime-reload-classifier.js` 的 `classifyChangedFile()` / `getHotApplyPlan()`，单测在 `packages/server/test/runtime/reload-classifier.test.ts`。

为什么 `client` 档能做到零中断：

- 服务端静态文件缓存的 key 是 `路径 + mtime + size`（`packages/server/src/frontend/static.ts`），换文件即失效，不需要重启。
- `index.html` 是 `Cache-Control: no-cache`。
- 客户端的 `useBuildRefresh()` 轮询 `client-dist/build-info.json`，发现 `buildId` 与自身编译进去的 `__BUILD_ID__` 不同就自动刷新页面。hot-apply 会写入一个 `<原 buildId>+hot.<base36>` 的新 id，所以已经打开的页面会自己切过去。

`shared` 被判为 `runtime` 档是保守选择：`packages/shared` 同时编进浏览器包、web shell 和 runtime worker，只换其中一部分会让控制协议版本错配。

## 2. hot-apply 用法

```bash
pnpm hot-apply --check          # 只分类打印计划，不改任何东西
pnpm hot-apply                  # 执行 client 档（零中断）
pnpm hot-apply --allow-shell    # 允许重启 web/API 进程
pnpm hot-apply --allow-runtime  # 允许重启 runtime（会打断活跃 turn）
pnpm hot-apply --status         # 查看当前叠加状态
pnpm hot-apply --revert         # 回滚上一次 client 叠加
```

其它参数：

- `--base-url <url>`：运行中的部署地址，默认 `http://127.0.0.1:8022/yep`，也可用 `YEP_HOT_APPLY_BASE_URL`。

### 执行流程

1. 读 `/api/version`，拿到运行版本的 `build.gitCommit` 作为 baseline。
2. `git diff --name-only <baseline>` 加上未跟踪文件，得到变更集合。
3. 分类得到档位，并与命令行授权比对：档位超过授权就拒绝，退出码 `2`。
4. 从监听端口的进程 argv 反查 bundle 目录（不假设一定是 LaunchAgent 那份）。
5. `client` 档：构建 `shared` + `client`（`BASE_PATH` 取自部署的 build-info），写入带 `hotApply: true` 的 `build-info.json`，然后两次 `rename` 原子换掉 `client-dist`，旧目录存到备份区。
6. `shell` / `runtime` 档：委托 `scripts/redeploy-server.sh`，不自己造重启流程。

### 状态与回滚

状态文件 `<dataDir>/hot-apply/state.json`，备份目录 `<dataDir>/hot-apply/backups/`（保留最近 3 份）。

叠加是**临时的**：它只改运行目录下的产物，不改 plist、不改部署形态。下一次 `scripts/deploy.sh` 从提交树完整重建，叠加自然消失。想提前撤销就用 `--revert`。

注意 `--revert` 只还原 client 包。如果上一次叠加走的是 `shell` / `runtime` 档（已经完整重建过 bundle），要回到旧代码请 checkout 对应 commit 后重新 deploy。

### 常见场景

```bash
# 改了 tool result renderer / transcript 展示 / 界面文案
pnpm hot-apply                 # 秒级生效，会话不受影响

# 改了 session 读取、display normalize、某个 route
pnpm hot-apply --check         # 先确认没有误伤 runtime
pnpm hot-apply --allow-shell   # external runtime 下零中断

# 改了 provider / supervisor
# 不要 hot-apply，等 idle 再走正常 deploy
```

## 3. 外置 agent runtime

默认形态下，8022 进程既是 web/API shell，又持有所有 provider 子进程（`runtimeMode: "embedded"`），所以重启必然打断会话。外置形态把两者拆开：

```
8022  web/API shell      ← 可以随时重启
 |  HTTP control (loopback + bearer token)
8025  agent runtime      ← 持有 provider 子进程，重启才会打断会话
4510  codex bridge       ← 早已独立
```

runtime 端口默认是 `PORT + 3`，token 在 `<dataDir>/runtime/token`，事件 journal 在 `<dataDir>/runtime/events/`，shell 重连后可以补播断连期间的消息。

### 启用（一次性，需要一次重启）

外置 runtime 是 **opt-in**：普通部署不会自动切换形态，因为这是持久的运维变更（多一个常驻进程），且切换动作本身要同时替换 shell 并拉起 runtime。三种启用方式：

```bash
# 1. 命令行 flag（挑一个 idle 窗口执行）
scripts/deploy.sh --server-only --external-runtime

# 2. 交互式向导：选了重部 8022 后会出现 `Agent runtime placement` 问题
scripts/deploy.sh

# 3. 写进部署环境，一次决定长期生效
echo 'YEP_RUNTIME_EXTERNAL=true' >> .env.deploy.local
```

向导会先读 `/api/status/workers` 判断当前形态：已经是 `external` 就只问要不要顺便重启 runtime（默认 no）；还是 `embedded` 才问要不要拆分（默认 no）。向导里显式回答 no 会覆盖 `.env.deploy.local` 里的 `YEP_RUNTIME_EXTERNAL=true`。

启用时会：

1. 写入 `com.yueyuan.yepanywhere.runtime` LaunchAgent（`cli.js --runtime-only --port 8022 --runtime-port 8025`）。
2. 重写 8022 的 plist，加上 `YEP_RUNTIME_MODE=external` 等控制面变量。
3. 通过 `redeploy-server.sh --restart-runtime` 完成一次 runtime + shell 的切换。

切换前如果还有活跃 turn，redeploy 会先等 idle（不会强杀）。一个已知边界：plist 在等待之前就已写入，所以如果你在等待期间中断了部署，形态配置会停在“已写入但未生效”，下一次部署会把它带上。

也可以在 `.env.deploy.local` 写 `YEP_RUNTIME_EXTERNAL=true`，之后普通 deploy 都保持这个形态。

### 切换之后

- `scripts/deploy.sh --server-only`：只换 shell，runtime 与活跃会话原样保留。
- 交互向导里只选择 8022 即可；4510 和 runtime 的重启选项相互独立，不需要为续聊一起勾选。已有 external 配置在 LaunchAgent 环境同步和备用 `nohup` 启动时都会保留，部署结束会核对 `/api/status/workers` 的实际运行形态；不一致则报错，不把 HTTP 可访问当作部署成功。
- `scripts/redeploy-server.sh --restart-runtime`：显式重启 runtime，会打断活跃 turn。
- `curl -s http://127.0.0.1:8022/yep/api/status/workers` 里 `runtimeMode` 会变成 `external`。
- runtime 日志：`~/.yep-anywhere/logs/runtime-launchd.{out,err}.log`。
- `redeploy-server.sh` 的 idle 等待逻辑对 external 模式自动放行，因为 shell 重启不再影响活跃 turn。

### 回到 embedded

```bash
launchctl bootout gui/$(id -u)/com.yueyuan.yepanywhere.runtime
YEP_RUNTIME_EXTERNAL=false scripts/install-launchagents.sh --server-only
```

### 代价与注意事项

- 多一个常驻进程要运维；runtime 崩溃由 launchd 按 `SuccessfulExit=false` 拉起。
- runtime 与 shell 的 `packages/shared` 版本必须一致，这正是 `shared` 改动被判为 `runtime` 档的原因。
- provider 相关的环境变量（`YEP_CODEX_PATH`、LLM gateway 那组）现在同时写进 runtime 和 server 两个 plist，由 `install-launchagents.sh` 的 `build_provider_env_args()` 统一生成。
- `--runtime-only` 与 `--codex-bridge-only` 不能同时使用。

## 4. 相关文件

- `scripts/hot-apply.mjs`：叠加命令入口。
- `scripts/runtime-reload-classifier.js`：档位分类。
- `packages/server/src/cli.ts`：`--runtime-only` / `--runtime-port`。
- `packages/server/src/runtime/standalone.ts`：runtime worker 进程主体。
- `scripts/install-launchagents.sh`：runtime LaunchAgent 与 external 接线。
- `scripts/redeploy-server.sh`：`--restart-runtime`，以及默认保留 runtime 的重启流程。
- `docs/tasks/2026-07-10-runtime-hot-reload-refactor-plan.md`：runtime 分层的原始设计文档。
