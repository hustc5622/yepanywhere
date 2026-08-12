# Yep Anywhere 跨平台服务进程与前端密码管理实施计划

> **历史计划说明（2026-08-12）：** 第一阶段服务进程管理已实施。本文件第 340 行起的旧第二阶段方案已被 [2026-08-12-simplified-password-management.md](./2026-08-12-simplified-password-management.md) 完整取代，包含独立密码页、三状态模型、多个维护命令、文件锁和远程安全传输矩阵的内容不得再执行。第二阶段只以新计划和已批准设计为准。

> **面向执行代理：** 实施时必须逐任务使用 `superpowers:test-driven-development`；按阶段执行可使用 `superpowers:executing-plans`，在声称完成前必须使用 `superpowers:verification-before-completion`。本文件当前仅供评审，未获用户批准前不得编码。

**目标：** 在不扩大已批准设计范围的前提下，完成 Windows/macOS 服务进程管理，以及由独立管理员密码保护的前端登录密码管理。

**架构：** 根目录 `yep.mjs` 仅按 `process.platform` 把参数、标准流和退出码转交给 Windows PowerShell 或 macOS shell；两个平台继续分别复用 Task Scheduler 与 launchd 管理生产生命周期。认证继续集中在现有 `AuthService` 与 `/api/auth`，将 `auth.json` 迁移到 v2，引入独立管理员哈希、原子私有存储、安全传输判断和本机交互 CLI；React 端复用现有设置导航、表单样式、API 客户端和 `AuthContext`，新增独立“密码管理”分类。

**技术栈：** Node.js 20+、TypeScript、Hono、bcrypt、Vitest、React 19、Testing Library、PowerShell 5.1、Task Scheduler、bash、launchd、pnpm 9.15.1，以及生产 Bundle 内的 npm。

## 实施边界与成功标准

- 行为语义唯一来源是 `docs/superpowers/specs/2026-08-10-service-process-and-password-management-design.md`；本计划只把已批准设计映射到当前代码，不重新设计。
- 只支持 Windows 和 macOS 的统一服务入口；不扩展 Linux 服务管理，现有脚本被直接调用时的无关行为不改。
- Windows 只依赖系统自带 Windows PowerShell 5.1，不引入 `pwsh`、Windows Service、NSSM 或管理员权限要求。
- 开发和生产默认后台静默常驻；只有 `start-dev --fg` 显式以前台启动。只有生产模式支持登录自启动。
- 保持现有端口和 Profile：开发 `3400/3401/3402`、生产 `8022`、桥接 `4510/4520`，开发默认 Profile 为 `dev`；显式 `YEP_ANYWHERE_DATA_DIR`/`YEP_ANYWHERE_PROFILE` 仍优先。
- 生产 Bundle 最终路径保持 `dist/npm-package`，运行依赖必须使用 `npm ci --omit=dev`，不替换为 pnpm 或 `npm install`。
- 管理员密码至少 12 个字符；登录密码继续使用现有后端至少 6 个字符的规则；两者分别使用 bcrypt 成本参数 12。
- 管理员密码不通过前端配置，不进入 URL、日志、命令行参数、环境变量、项目配置或浏览器持久化存储。
- 所有登录密码状态变更都临时验证管理员密码并清除全部登录会话；不新增失败次数限制、延迟、锁定或验证码。
- 不引入多用户/角色、网络恢复管理员密码、生产版本快照、自动回滚、通用服务框架或无关重构。
- 自动验证只运行聚焦的非侵入检查。启动服务、浏览器验证、重启电脑、登录/注销、真实本机部署和双平台人工验收都必须在执行时另获用户明确许可。

## 现有实现复用策略

- 保留根 `package.json` 中 `pnpm yep -> node yep.mjs` 的映射；除非实现时发现接口确有缺口，否则不修改该文件。
- 扩展 `yep.sh` 现有中文输出、`nohup` 开发启动、launchd 生产启动、Bundle 构建和 `buildId` 验证，不另写一套 macOS 管理器。
- 扩展 `scripts/yep.ps1`、`scripts/install-task-scheduler.ps1`、`scripts/uninstall-task-scheduler.ps1` 与 `scripts/run-yepanywhere.ps1` 的现有 Task Scheduler、隐藏窗口、日志和端口探测逻辑，不引入新守护框架。
- 扩展 `scripts/build-bundle.ts` 和现有 `scripts/verify-runtime-bundle.ts`，让构建可输出到暂存目录；构建、依赖安装、完整性检查通过后才触碰生产目录和进程。
- 在现有 `packages/server/src/auth/AuthService.ts` 内完成 v2 迁移和状态转换；复用 `packages/server/src/utils/filePermissions.ts`、`packages/server/src/utils/fileLock.ts` 与已经安装的 `proper-lockfile`。
- 复用 `packages/client/src/api/client.ts` 的 `ApiError.code`、`AuthContext` 的认证跳转，以及设置分类路由、现有表单/警告/危险按钮样式；不增加新的样式系统或顶层路由。

---

## 第一阶段：服务进程管理

本阶段只处理统一入口、生产构建安全性、Windows/macOS 后台生命周期和相应运维文档。三个任务按顺序执行，每个任务结束时均可独立验证。

### 任务 1：统一跨平台入口并建立安全的暂存构建流程

**涉及文件**

- 修改：`yep.mjs`
- 修改：`scripts/build-bundle.ts`
- 复用：`scripts/verify-runtime-bundle.ts`
- 新增：`packages/server/test/service/yep-entry.test.ts`
- 核对但预计不改：`package.json`

**输出接口**

`yep.mjs` 应提供可测试的薄分发边界，名称可按当前模块风格微调，但职责固定：

```js
export function backendForPlatform(platform) {
  // win32 -> scripts/yep.ps1
  // darwin -> yep.sh
  // otherwise -> null
}

export async function dispatch({
  platform,
  args,
  spawnImpl,
}) {
  // 原样继承 stdio，返回子进程退出码
}
```

`scripts/build-bundle.ts` 增加一个仅供构建管线使用的输出目录入口：

```ts
const outputDir =
  process.env.YEP_BUNDLE_OUTPUT_DIR ??
  path.join(repoRoot, "dist", "npm-package");
```

不增加通用发布配置，也不改变未设置环境变量时的现有产物位置。

**实施步骤**

- [ ] 1.1 先在 `packages/server/test/service/yep-entry.test.ts` 写失败测试，覆盖：
  - `win32` 选择 `powershell.exe`，参数为 `-NoProfile -ExecutionPolicy Bypass -File <绝对路径>/scripts/yep.ps1 ...args`。
  - `darwin` 选择 `bash <绝对路径>/yep.sh ...args`。
  - 无参数和带参数都不改变顺序或内容。
  - 子进程使用 `stdio: "inherit"`，退出码和信号失败被准确转换为入口退出结果。
  - 不出现系统选择菜单；不支持的平台输出中文错误并返回非零退出码。

  运行：

  ```powershell
  pnpm --filter @yep-anywhere/server test -- test/service/yep-entry.test.ts
  ```

  预期：新增测试因当前 `yep.mjs` 仍包含菜单和平台映射而失败，失败点与上述契约一致。

- [ ] 1.2 将 `yep.mjs` 缩减为平台分发器：
  - 保留 `node yep.mjs` 和 `pnpm yep` 入口。
  - 无参数时把控制权交给平台脚本，由后端脚本显示中文菜单。
  - 有参数时原样转交，不在 Node 层维护命令表、端口、认证或服务状态。
  - 使用当前文件绝对路径定位脚本，不依赖调用者工作目录。
  - 继承 stdin/stdout/stderr，并把子进程退出码原样交还调用者。
  - 仅 `win32` 和 `darwin` 受支持；其他平台显示中文错误并非零退出。
  - 仅在直接执行模块时调用主入口，使测试可以导入分发函数而不启动真实脚本。

- [ ] 1.3 再运行入口测试：

  ```powershell
  pnpm --filter @yep-anywhere/server test -- test/service/yep-entry.test.ts
  ```

  预期：所有平台选择、参数、标准流和退出码测试通过；测试过程中不启动真实服务。

- [ ] 1.4 修改 `scripts/build-bundle.ts`，让所有输出路径、复制、运行锁文件和清单生成都以 `YEP_BUNDLE_OUTPUT_DIR` 或默认目录为同一根目录。不要在构建脚本中停止服务、切换生产目录或实现回滚。

- [ ] 1.5 把两个平台后续使用的重构建算法固定为：
  1. 运行 `pnpm lint`、`pnpm typecheck` 和现有客户端/Bundle 构建。
  2. 在同一文件系统的临时目录生成完整 Bundle。
  3. 在暂存 Bundle 内运行 `npm ci --omit=dev`。
  4. 使用现有完整性校验器验证暂存 Bundle。
  5. 以上任一步失败：保留当前生产进程和 `dist/npm-package` 不变，报告失败阶段、退出码和日志。
  6. 全部通过后才停止当前生产实例、交换暂存目录到 `dist/npm-package`、通过平台管理器启动生产。
  7. 比较运行服务、前端和 Bundle 的 `buildId`。
  8. 不增加版本快照或自动回滚；只允许一个用于目录移动失败恢复的临时旧目录，交换成功后清理。

- [ ] 1.6 做非侵入验证：

  ```powershell
  pnpm --filter @yep-anywhere/server test -- test/service/yep-entry.test.ts
  pnpm typecheck
  ```

  预期：入口聚焦测试和类型检查通过；未启动或停止任何 Yep Anywhere 服务。

**任务完成条件**

- `yep.mjs` 只负责系统识别和转发。
- 默认 Bundle 路径与现有命令保持兼容，暂存目录可由构建管线显式指定。
- 在暂存构建失败路径中没有停止生产服务或替换生产目录的代码。

### 任务 2：完成 Windows 后台进程、计划任务和重构建管理

**涉及文件**

- 修改：`scripts/yep.ps1`
- 修改：`scripts/install-task-scheduler.ps1`
- 修改：`scripts/uninstall-task-scheduler.ps1`
- 修改：`scripts/run-yepanywhere.ps1`
- 修改：`scripts/deploy.ps1`
- 复用：`scripts/build-bundle.ts`
- 复用：`scripts/verify-runtime-bundle.ts`

**命令契约**

`scripts/yep.ps1` 必须支持并用中文解释：

```text
start-dev [--fg]
stop-dev
restart-dev [--fg]
start-prod
stop-prod
restart-prod
stop
status
rebuild
enable-autostart
disable-autostart
help
```

**实施步骤**

- [ ] 2.1 先整理 `scripts/yep.ps1` 内现有函数边界，只在必要处抽取以下单一职责函数：解析模式和参数、读取/验证 PID 元数据、核实进程身份、查询计划任务、启动/停止目标模式、等待健康检查、格式化中文状态。不要借机改写无关 PowerShell 风格。

- [ ] 2.2 让开发模式满足：
  - 默认 `start-dev` 通过 `Start-Process -WindowStyle Hidden` 启动独立隐藏 PowerShell 启动器。
  - 启动器使用仓库绝对路径、默认 `dev` Profile、现有 `pnpm dev`，stdin 不依赖原终端，stdout/stderr 写入开发日志。
  - 保存包含模式、Profile、仓库路径、启动器/父 PID 和日志路径的可验证元数据。
  - `start-dev --fg` 是唯一前台开发路径。
  - 重复启动不产生第二个实例；`stop-dev` 只清理经身份验证的开发进程树。

- [ ] 2.3 调整计划任务定义，使 `YepAnywhereServer` 同时服务人工生产启动和登录自启动：
  - 动作始终是隐藏运行 `scripts/run-yepanywhere.ps1`，所有路径为绝对路径。
  - 任务动作与当前用户 `AtLogOn` 触发器分离。
  - 首次 `start-prod` 可按需安装没有登录触发器、但可人工启动的任务定义。
  - `enable-autostart` 幂等安装/修复 `AtLogOn`，不启动当前实例。
  - `disable-autostart` 只移除/禁用登录触发器并保留任务动作，不停止当前实例。
  - `stop-prod` 先停止任务实例，再清理经身份验证的生产进程，不改变自启动设置。
  - 任务以当前用户运行、不保存密码、不要求管理员权限；`MultipleInstances=IgnoreNew`、`ExecutionTimeLimit=0`、重启间隔 1 分钟、`RestartCount=999`。

- [ ] 2.4 强化 `scripts/run-yepanywhere.ps1`：
  - 启动前验证生产 Bundle 和运行依赖，设置现有生产 Profile、端口和数据目录。
  - 隐藏启动主服务器及必要桥接进程，并沿用现有生产日志位置。
  - 记录能够确认同一生产实例的 PID/命令路径元数据。
  - 同时等待并监控服务器和所有关键桥接进程；任一关键进程异常退出时，清理其余经身份确认的同实例进程并以非零状态退出，让 Task Scheduler 重新拉起完整实例。
  - 正常停止路径不被误判为异常重启。

- [ ] 2.5 在 `scripts/yep.ps1` 中统一幂等语义和进程保护：
  - 开发和生产可以同时运行；停止或重启一个模式不影响另一个。
  - `stop` 停止两种运行模式但不改变自启动。
  - 进程身份至少综合任务状态、PID 文件、命令行仓库/Bundle 路径、Profile 和模式；端口只作辅助证据。
  - 未能确认身份的端口占用者绝不结束，中文输出端口、PID、进程名和处理建议并返回非零。
  - 启动后等待健康检查；超时报告模式、端口和日志，不能虚报成功。
  - 停止后复查进程树和端口；残留时返回非零并给出诊断。

- [ ] 2.6 让 `status` 以中文完整显示：
  - Windows 与 Task Scheduler。
  - 开发运行状态、端口、PID、Profile、日志路径。
  - 生产任务的安装、运行、最近结果，以及端口、PID/Profile、日志。
  - 自启动为“已启用 / 已关闭 / 配置异常”。
  - 端口占用、残留 PID、任务动作路径或触发器不一致时给出明确诊断。

- [ ] 2.7 修改 `scripts/deploy.ps1` 和 `rebuild`，复用任务 1 的暂存 Bundle 流程：
  - 构建和验证期间不停止现有生产任务。
  - 暂存 Bundle 验证成功后才调用统一的 `stop-prod`/目录交换/`start-prod`。
  - 启动仍只通过 `YepAnywhereServer` 任务，不直接创建另一套生产进程。
  - 最终验证 `buildId`，失败阶段、退出码和日志使用中文报告。

- [ ] 2.8 运行 PowerShell 5.1 静态解析，不执行脚本业务：

  ```powershell
  $files = @(
    "scripts/yep.ps1",
    "scripts/install-task-scheduler.ps1",
    "scripts/uninstall-task-scheduler.ps1",
    "scripts/run-yepanywhere.ps1",
    "scripts/deploy.ps1"
  )
  foreach ($file in $files) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
      (Resolve-Path $file),
      [ref]$tokens,
      [ref]$errors
    )
    if ($errors.Count -gt 0) {
      $errors | Format-List
      throw "$file PowerShell 语法解析失败"
    }
  }
  ```

  预期：命令无输出、退出码 0；所有脚本可由 Windows PowerShell 5.1 解析。

- [ ] 2.9 在获得用户允许后再做 Windows 只读/生命周期验收：
  - 先运行 `pnpm yep -- help` 和 `pnpm yep -- status`；预期中文列出全部命令和三类独立状态。
  - 再依次验证后台开发、前台开发、生产任务、并行运行、幂等启动/停止、启用/关闭自启动、未知端口占用保护、关键进程异常守护与重构建成功/失败。
  - 重启电脑和登录后自启动检查必须再次单独取得许可。

**任务完成条件**

- Windows 开发进程关闭原终端后仍运行；生产生命周期只有一个 Task Scheduler 入口。
- 开发运行、生产运行和登录自启动互相独立。
- 所有脚本自有菜单、帮助、状态、成功、警告和错误为中文，命令参数保持英文。

### 任务 3：完成 macOS launchd 管理、服务文档和跨平台验收

**涉及文件**

- 修改：`yep.sh`
- 修改：`scripts/install-launchagents.sh`
- 修改：`scripts/uninstall-launchagents.sh`
- 修改：`README.md`（仅服务进程部分）
- 修改：`CLAUDE.md`（仅服务进程与生产部署部分）
- 复用：`scripts/build-bundle.ts`
- 复用：`scripts/verify-runtime-bundle.ts`

**实施步骤**

- [ ] 3.1 在 `yep.sh` 中补齐与 Windows 相同的命令表、中文菜单和中文结果；保留现有 `enable-launchd` 等兼容别名，但帮助和文档只推荐 `enable-autostart`/`disable-autostart`。

- [ ] 3.2 保留并强化现有开发 `nohup` 路径：
  - `start-dev` 默认后台启动，stdin 连接 `/dev/null`，stdout/stderr 写入开发日志。
  - 使用现有开发端口和默认 `dev` Profile，保存可核实 PID。
  - 关闭原终端后进程继续运行；仅 `--fg` 前台运行。
  - 重复启动、重复停止和未知端口占用遵循与 Windows 相同的幂等与拒绝误杀语义。

- [ ] 3.3 在现有 LaunchAgent 生成逻辑内区分“当前会话生产运行”和“下次登录自启动”：
  - 持久配置位于 `~/Library/LaunchAgents`，表示自启动已启用。
  - 自启动关闭但需要人工运行生产时，在现有数据目录使用同一内容的会话级 plist，不安装到 `~/Library/LaunchAgents`。
  - `start-prod` 优先加载持久 plist；没有持久配置时加载会话级 plist。
  - `enable-autostart` 幂等安装/修复持久 plist，但不启动当前服务。
  - `disable-autostart` 删除持久配置但不停止当前实例；必要时保持当前已加载定义到本次会话结束。
  - `stop-prod` 卸载当前实例但保留持久自启动配置。
  - plist 继续使用 `RunAtLoad` 和 `KeepAlive`，人工启动和登录启动不产生两套生产定义。

- [ ] 3.4 让 macOS `status` 分别报告 plist 是否安装、当前是否加载、生产是否运行、自启动是否启用，并显示端口、PID、Profile 和日志；配置路径/动作失效时显示“配置异常”。

- [ ] 3.5 让 macOS `rebuild` 复用任务 1 的暂存构建：
  - 暂存 Bundle 完整构建、`npm ci --omit=dev` 和校验失败时不停止当前生产服务。
  - 成功后通过 launchd 的同一生产定义停止、交换、启动并核对 `buildId`。
  - 不影响开发进程和持久自启动开关。

- [ ] 3.6 更新 `README.md` 和 `CLAUDE.md` 的服务章节：
  - `pnpm yep` 自动识别 Windows/macOS，不再让用户选择系统。
  - 列出统一命令及中文语义、默认后台和 `start-dev --fg`。
  - 解释开发运行、生产运行、自启动三者独立，特别注明 `stop-prod`、`disable-autostart` 和 `stop` 不互相偷改状态。
  - 记录 Task Scheduler `YepAnywhereServer`、LaunchAgent、日志、Profile、端口和 `status` 诊断。
  - 记录 `rebuild` 先暂存构建/验证，成功后才重启；生产依赖固定为 `npm ci --omit=dev`。
  - 删除与新语义冲突的旧系统选择、前台默认或直接生产启动说明，不扩写其他文档。

- [ ] 3.7 在真实 macOS 环境运行 shell 静态检查：

  ```bash
  bash -n yep.sh
  bash -n scripts/install-launchagents.sh
  bash -n scripts/uninstall-launchagents.sh
  ```

  预期：三条命令均无输出并返回 0。当前 Windows 工作区的 `bash.exe` 指向未配置 WSL，因此不能把本机 WSL 失败误报为脚本失败；此项必须在 macOS 或可用 bash 环境完成。

- [ ] 3.8 运行阶段自动回归：

  ```powershell
  pnpm --filter @yep-anywhere/server test -- test/service/yep-entry.test.ts
  pnpm lint
  pnpm typecheck
  ```

  预期：入口测试、代码规范和类型检查全部通过。

- [ ] 3.9 获得用户允许后，分别执行 Windows 和 macOS 人工矩阵：
  - 后台开发/生产在关闭启动终端后继续运行。
  - 开发和生产同时运行，分别停止互不影响。
  - 启用自启动不启动当前服务；关闭自启动不停止当前服务；停止生产不改变自启动。
  - 登录后启动、关键进程异常后的守护重启、重复命令幂等、未知端口拒绝误杀。
  - 重构建成功更新 `buildId`；人为制造构建失败时旧生产服务和旧 Bundle 保持可用。
  - 菜单、帮助、状态和错误均为中文，统一入口无需选择操作系统。

**任务完成条件**

- macOS 使用同一 LaunchAgent 定义实现人工生产运行、登录自启动与 KeepAlive。
- 两个平台对外提供相同命令和状态语义。
- 服务文档与实现一致，自动检查和经批准的双平台人工矩阵通过。

---

## 第二阶段：密码管理

本阶段处理后端认证状态/存储、本机恢复命令、安全网络 API、前端密码管理入口和密码相关文档。管理员密码始终只在后端本机创建或恢复。

### 任务 1：升级认证状态与私有存储，并收口本机密码命令

**涉及文件**

- 修改：`packages/server/src/auth/AuthService.ts`
- 修改：`packages/server/src/auth/index.ts`
- 修改：`packages/server/src/utils/filePermissions.ts`
- 修改：`packages/server/src/cli-setup.ts`
- 修改：`packages/server/src/cli.ts`
- 修改：`packages/server/src/config.ts`
- 修改：`packages/server/src/app.ts`
- 修改：`packages/server/src/index.ts`
- 修改：`packages/server/src/middleware/auth.ts`
- 修改：`packages/server/src/sdk/providers/env-filter.ts`
- 修改：`packages/server/package.json`
- 修改：`packages/client/e2e/global-setup.ts`
- 修改：`scripts/smoke-terminal.mjs`
- 新增：`packages/server/src/auth/AuthStateLock.ts`
- 新增：`packages/server/src/cli-password-prompt.ts`
- 修改：`packages/server/test/auth/AuthService.test.ts`
- 新增：`packages/server/test/auth/AuthStateLock.test.ts`
- 新增：`packages/server/test/auth/CliAuthCommands.test.ts`

**认证模型与稳定错误码**

```ts
export interface AuthState {
  version: 2;
  enabled: boolean;
  localhostOpen?: boolean;
  admin?: {
    passwordHash: string;
    createdAt: string;
    updatedAt: string;
  };
  account?: {
    passwordHash: string;
    createdAt: string;
    updatedAt: string;
  };
  sessions: Record<string, AuthSession>;
}

export const AUTH_ERROR_CODES = {
  adminNotConfigured: "AUTH_ADMIN_NOT_CONFIGURED",
  adminInvalid: "AUTH_ADMIN_INVALID",
  loginInvalid: "AUTH_LOGIN_INVALID",
  loginNotConfigured: "AUTH_LOGIN_NOT_CONFIGURED",
  insecureTransport: "AUTH_ADMIN_TRANSPORT_REQUIRED",
  passwordInvalid: "AUTH_PASSWORD_INVALID",
  configInvalid: "AUTH_CONFIG_INVALID",
  writeFailed: "AUTH_WRITE_FAILED",
} as const;
```

`admin.passwordHash` 与 `account.passwordHash` 必须独立加盐哈希；任何状态/API/日志都不能返回哈希或管理员是否已配置。

**实施步骤**

- [ ] 1.1 先扩展 `AuthService.test.ts`，写出以下失败测试：
  - 新 v2 文件只存 bcrypt 哈希，管理员与登录哈希不同，成本参数均为 12。
  - 读取旧版 `auth.json` 时保留 `enabled`、原登录密码哈希、`localhostOpen` 和 sessions，迁移后管理员为空。
  - 旧用户仍可登录；管理员未配置时所有登录密码变更返回 `AUTH_ADMIN_NOT_CONFIGURED`。
  - 首次设置登录密码、启用、关闭、启用状态下修改、关闭状态下修改均符合已批准状态表。
  - 关闭认证保留 `account.passwordHash`。
  - 每次登录密码状态变化清除全部 sessions。
  - 第一次设置管理员密码保留原登录密码、启用状态和 sessions；替换/恢复已有管理员密码保留登录密码与启用状态但清除 sessions。
  - 损坏 JSON、缺字段或不支持版本返回 `AUTH_CONFIG_INVALID`，不得自动生成空配置或关闭认证。
  - 错误密码可以连续验证失败但不产生本范围外的限流或锁定状态。

  运行：

  ```powershell
  pnpm --filter @yep-anywhere/server test -- test/auth/AuthService.test.ts
  ```

  预期：新用例先因 v2 模型和转换方法尚不存在而失败。

- [ ] 1.2 在 `AuthService.ts` 和 `auth/index.ts` 中实现最小状态接口：

  ```ts
  getLoginPasswordStatus(): {
    configured: boolean;
    enabled: boolean;
  };
  hasAdminPassword(): boolean;
  verifyAdminPassword(password: string): Promise<boolean>;
  verifyLoginPassword(password: string): Promise<boolean>;
  setupAdminPassword(newPassword: string): Promise<void>;
  setupLoginPassword(adminPassword: string, newPassword: string): Promise<void>;
  enableLoginPassword(adminPassword: string): Promise<void>;
  disableLoginPassword(adminPassword: string): Promise<void>;
  changeLoginPassword(
    adminPassword: string,
    newPassword: string,
  ): Promise<void>;
  ```

  所有公共转换都先验证输入和管理员密码，再一次性持久化目标状态；不要让路由或 CLI 各自复制状态机。

- [ ] 1.3 在读取路径实现 v1→v2 迁移和安全失败：
  - 仅识别当前合法旧结构和 v2。
  - 迁移保留登录哈希、启用状态、`localhostOpen` 和 sessions，不凭空生成管理员密码。
  - 成功迁移后使用同一原子私有写入路径保存。
  - 解析/校验失败时保持原文件不变，抛稳定错误；不得回退成“认证关闭”的新文件。

- [ ] 1.4 先在 `AuthStateLock.test.ts` 写失败测试，覆盖同一 `auth.json` 的运行锁独占、释放、异常退出清理边界，以及 CLI 遇到服务持锁时拒绝写入。

- [ ] 1.5 新增 `AuthStateLock.ts` 并复用 `proper-lockfile`：
  - 服务器启动认证服务时持有运行期锁，并通过 `app.ts`/`index.ts` 的现有关闭路径在正常退出时释放。
  - 本机维护命令只在目标服务未持锁时取得独占锁，写完立即释放。
  - 锁绑定解析后的目标 `auth.json` 绝对路径，开发、生产和自定义数据目录互不串扰。
  - 锁失败显示目标 Profile/路径和“先停止对应服务”的中文建议，不等待或强行抢锁。

- [ ] 1.6 先补充原子写入和权限失败测试，再扩展 `filePermissions.ts`：
  - 在目标目录创建同文件系统临时文件，只写序列化状态，绝不落盘明文密码。
  - POSIX 数据目录限制为当前用户访问、文件 `0600`；写入、flush、权限校验后原子替换。
  - Windows 使用当前用户 SID，保留 SYSTEM/Administrators 等操作系统所需受信任主体，移除 `Everyone`、`Users`、`Authenticated Users` 的宽泛继承权限，并在替换后验证 ACL。
  - 创建、迁移、修改和恢复都走同一写入函数；任何阶段失败抛 `AUTH_WRITE_FAILED`，保留原文件。

- [ ] 1.7 再运行认证服务和锁测试：

  ```powershell
  pnpm --filter @yep-anywhere/server test -- test/auth/AuthService.test.ts test/auth/AuthStateLock.test.ts
  ```

  预期：v1 迁移、v2 状态表、会话失效、原子写入、权限与互斥测试全部通过。

- [ ] 1.8 先在 `CliAuthCommands.test.ts` 写失败测试：
  - `--setup-admin-password` 只接受隐藏输入的新密码与确认；不接受明文参数；最少 12 字符。
  - 第一次设置管理员密码保留 sessions；已有管理员密码的恢复/替换清除 sessions。
  - `--setup-auth` 隐藏输入管理员密码、新登录密码和确认，成功后设置并启用登录密码、清除 sessions。
  - `--auth-disable` 隐藏输入并验证管理员密码，关闭认证但保留登录哈希、清除 sessions。
  - 三个命令都显示目标 Profile 和 `auth.json` 绝对路径，不显示密码或哈希。
  - 非 TTY、确认不匹配、服务持锁、错误管理员密码和损坏配置均安全失败且非零退出。

- [ ] 1.9 新增 `cli-password-prompt.ts`，提供 Windows/macOS TTY 隐藏输入和恢复终端状态的最小实现；通过依赖注入让测试使用假输入，任何成功/错误路径都不能回显密码。

- [ ] 1.10 修改 `cli-setup.ts` 与 `cli.ts`，使三个命令成为真正的一次性维护命令：完成或失败后退出，绝不继续启动 HTTP 服务。专用管理员命令是唯一无需旧管理员密码的本机恢复路径，并在成功时只显示一次“保存到可信密码管理器”的中文提醒。

- [ ] 1.11 删除 `AUTH_DISABLED` 绕过的定义和传播：
  - 从 `config.ts`、`app.ts`、`index.ts`、`middleware/auth.ts` 和 `env-filter.ts` 移除运行时认证绕过。
  - `packages/server/package.json` 保留 `dev:mock` 脚本名以免破坏外部调用，只移除其 `AUTH_DISABLED=true` 前缀；它不再具有认证绕过语义。
  - `packages/client/e2e/global-setup.ts` 删除该环境变量，继续使用现有隔离 `YEP_ANYWHERE_DATA_DIR`，让全新数据目录通过正常 `AuthService` 初始状态进入认证关闭模式；在 E2E 启动检查中断言公开认证状态符合该前提。
  - 更新 `scripts/smoke-terminal.mjs` 的旧绕过说明；脚本只连接调用者明确准备好的测试服务，不自行或暗示设置认证后门。
  - 全仓搜索 `AUTH_DISABLED`；预期除明确记录历史迁移的文档外为零。

  验证：

  ```powershell
  rg -n "AUTH_DISABLED" packages scripts package.json
  pnpm --filter @yep-anywhere/server test -- test/auth/AuthService.test.ts test/auth/AuthStateLock.test.ts test/auth/CliAuthCommands.test.ts
  ```

  预期：搜索无匹配（`rg` 返回 1 属于“未找到”）；三个聚焦测试文件全部通过。

**任务完成条件**

- v1 用户可无损迁移并继续登录，管理员未配置时只拒绝密码管理操作。
- v2 所有转换、会话语义和错误码由 `AuthService` 单点实现。
- `auth.json` 写入原子、权限私有、服务与本机 CLI 互斥，且不存在运行时认证绕过。

### 任务 2：实现管理员验证、安全传输和稳定的认证 API

**涉及文件**

- 修改：`packages/server/src/auth/routes.ts`
- 修改：`packages/server/src/auth/index.ts`
- 修改：`packages/server/src/app.ts`
- 修改：`packages/server/src/middleware/auth.ts`
- 新增：`packages/server/src/auth/transportSecurity.ts`
- 修改：`packages/server/test/auth/AuthRoutes.test.ts`
- 新增：`packages/server/test/auth/transportSecurity.test.ts`

**API 契约**

```text
GET    /api/auth/status
POST   /api/auth/setup
POST   /api/auth/enable
POST   /api/auth/disable
POST   /api/auth/change-password
POST   /api/auth/login
POST   /api/auth/logout
```

`GET /api/auth/status` 只返回：

```ts
{
  configured: boolean;      // 登录密码是否存在
  enabled: boolean;
  authenticated: boolean;
  hasDesktopToken: boolean;
  localhostOpen: boolean;
}
```

禁止返回管理员配置状态、任何哈希、文件路径或恢复细节。

**实施步骤**

- [ ] 2.1 先在 `transportSecurity.test.ts` 写传输判定失败测试：
  - 直接回环请求允许管理员密码。
  - 直接 HTTPS 允许。
  - 只有直接对端是回环地址时，已有可信代理机制确认的 `https` 转发才允许。
  - 来自非回环对端的伪造 `X-Forwarded-Proto: https` 被拒绝。
  - 受信任桌面内部通道允许。
  - 普通局域网 HTTP 可读取状态，但所有含管理员密码的变更被拒绝。

- [ ] 2.2 新增 `transportSecurity.ts`，把回环、直接 TLS、可信本机代理和桌面内部令牌规则集中成一个纯判定函数；复用项目现有代理/桌面鉴权来源，不新增客户端可自行声明的信任头。Cookie 的 `Secure` 判断也复用同一可信连接规则。

- [ ] 2.3 先扩展 `AuthRoutes.test.ts`，写以下失败测试：
  - 状态接口严格匹配公开字段，不泄漏管理员状态、哈希或路径。
  - `setup` 接收 `adminPassword + newPassword`，`enable/disable` 接收 `adminPassword`，`change-password` 接收 `adminPassword + newPassword`。
  - 现有旧字段/旧路由若保留兼容层，最终仍进入同一管理员验证和状态转换。
  - 缺失、错误和正确管理员密码；未设置登录密码；密码格式错误；损坏配置/写入失败。
  - 每次成功修改都删除当前 Cookie，并因 `AuthService` 清除全部 sessions。
  - 启用或已启用修改后客户端必须重新登录；关闭或关闭状态修改后保持可进入应用。
  - 登录密码错误稳定返回 `AUTH_LOGIN_INVALID`；连续错误不锁定、不延迟。
  - 管理员密码及登录密码不出现在测试日志、错误体或响应快照。

- [ ] 2.4 在路由中建立单一错误映射：

  | 错误码 | HTTP 状态 | 前端含义 |
  | --- | ---: | --- |
  | `AUTH_ADMIN_NOT_CONFIGURED` | 409 | 管理员密码尚未在后端配置 |
  | `AUTH_ADMIN_INVALID` | 401 | 管理员密码错误 |
  | `AUTH_LOGIN_INVALID` | 401 | 登录密码错误 |
  | `AUTH_LOGIN_NOT_CONFIGURED` | 409 | 登录密码尚未设置 |
  | `AUTH_ADMIN_TRANSPORT_REQUIRED` | 403 | 当前连接不允许提交管理员密码 |
  | `AUTH_PASSWORD_INVALID` | 400 | 密码格式不合法 |
  | `AUTH_CONFIG_INVALID` | 500 | 认证配置损坏 |
  | `AUTH_WRITE_FAILED` | 500 | 认证配置写入失败 |

  错误体只包含稳定 code 和安全的本地化映射依据；日志可记录时间、来源和错误类型，但不能记录请求体、密码或哈希。

- [ ] 2.5 修改 `routes.ts`：
  - 状态接口在所有连接上可读，管理员未配置也可读。
  - 四个变更接口先验证安全传输，再由 `AuthService` 验证管理员密码和执行状态转换。
  - 登录/注销继续使用现有会话与 Cookie 机制。
  - 所有成功密码变更都明确删除 Cookie；Cookie `Secure` 使用任务 2.2 的可信连接判断。
  - 不允许已有登录 Cookie 替代管理员密码。

- [ ] 2.6 运行聚焦测试：

  ```powershell
  pnpm --filter @yep-anywhere/server test -- test/auth/transportSecurity.test.ts test/auth/AuthRoutes.test.ts
  ```

  预期：传输矩阵、公开状态形状、请求体、错误码/HTTP 状态和 Cookie 失效全部通过。

- [ ] 2.7 运行后端认证回归：

  ```powershell
  pnpm --filter @yep-anywhere/server test -- test/auth/AuthService.test.ts test/auth/AuthStateLock.test.ts test/auth/CliAuthCommands.test.ts test/auth/transportSecurity.test.ts test/auth/AuthRoutes.test.ts
  ```

  预期：所有认证服务、存储、CLI、传输和路由测试通过，现有登录行为无回归。

**任务完成条件**

- 普通局域网 HTTP 只能查看状态，不能提交管理员密码。
- 所有网络密码变更都经过相同的管理员验证和状态机。
- 状态、错误体、日志和 Cookie 行为不泄漏敏感信息，并与稳定错误码契约一致。

### 任务 3：完成前端密码管理、国际化、文档和整体验收

**涉及文件**

- 修改：`packages/client/src/api/client.ts`
- 修改：`packages/client/src/api/client.test.ts`
- 修改：`packages/client/src/contexts/AuthContext.tsx`
- 修改：`packages/client/src/pages/LoginPage.tsx`
- 修改：`packages/client/src/pages/settings/LocalAccessSettings.tsx`
- 修改：`packages/client/src/pages/settings/SettingsLayout.tsx`
- 修改：`packages/client/src/i18n-settings.ts`
- 新增：`packages/client/src/pages/settings/PasswordSettings.tsx`
- 新增：`packages/client/src/pages/settings/__tests__/PasswordSettings.test.tsx`
- 新增：`packages/client/src/pages/settings/__tests__/SettingsAuthNavigation.test.tsx`
- 新增：`packages/client/src/contexts/__tests__/AuthContext.test.tsx`
- 修改：`packages/client/src/i18n/en.json`
- 修改：`packages/client/src/i18n/zh-CN.json`
- 修改：`packages/client/src/i18n/es.json`
- 修改：`packages/client/src/i18n/fr.json`
- 修改：`packages/client/src/i18n/de.json`
- 修改：`packages/client/src/i18n/ja.json`
- 修改：`README.md`（仅认证/密码管理部分）
- 修改：`CLAUDE.md`（仅认证、本机恢复和测试说明）

**实施步骤**

- [ ] 3.1 先扩展现有 `packages/client/src/api/client.test.ts`，并在 `AuthContext.test.tsx` 写失败测试：
  - API 客户端把 setup/enable/disable/change 发送到正确端点，只把 `adminPassword`/`newPassword` 放入 JSON 请求体，并继续把服务端稳定错误码保存在 `ApiError.code`。
  - 客户端状态区分 `passwordConfigured`、`authEnabled`、`authenticated`、`localhostOpen` 和 `hasDesktopToken`。
  - setup/enable/disable/change 调用正确端点与字段，管理员密码不进入 URL 或持久化存储。
  - 成功启用、首次设置或启用状态下修改后清除本地会话并进入登录页。
  - 成功关闭或关闭状态下修改后刷新状态并留在应用。
  - 收到会话失效/401 时沿用现有认证事件与跳转，不建立第二套全局状态机。

- [ ] 3.2 修改 `api/client.ts` 和 `AuthContext.tsx`：

  ```ts
  setupLoginPassword(
    adminPassword: string,
    newPassword: string,
  ): Promise<void>;
  enableLoginPassword(adminPassword: string): Promise<void>;
  disableLoginPassword(adminPassword: string): Promise<void>;
  changeLoginPassword(
    adminPassword: string,
    newPassword: string,
  ): Promise<void>;
  ```

  复用 `ApiError.code` 做本地化映射；函数参数仅存在于请求生命周期，不写入 context 持久状态、日志或任何 Web Storage。

- [ ] 3.3 简化 `LoginPage.tsx`：
  - 页面只保留登录，不再显示首次设置模式或“创建密码”占位。
  - 认证关闭时按现有流程进入应用，再从设置页配置。
  - `AUTH_LOGIN_INVALID` 显示明确“登录密码错误”；其他稳定错误按 code 映射，不用模糊“登录失败”吞掉原因。

- [ ] 3.4 先在 `PasswordSettings.test.tsx` 和 `SettingsAuthNavigation.test.tsx` 写失败测试，覆盖：
  - 设置分类 `password` 可通过现有 `/settings/:category` 路由访问，无需新增顶层路由。
  - “本地访问”不再包含密码表单，但保留网络访问、`localhostOpen` 和暴露风险提示。
  - 密码页正确显示“未设置 / 已设置但未启用 / 已启用”。
  - 未设置显示首次设置表单；已关闭显示启用与修改；已启用显示关闭与修改。
  - 四类表单只收集规定字段，确认不一致在客户端阻止提交，后端仍是规则权威。
  - 请求期间禁止重复提交；成功、管理员错误、登录规则错误、不安全连接和配置错误提示明确。
  - 管理员字段使用 `type="password"`、`autoComplete="off"` 或更严格等效值，并在请求完成、操作切换、路由离开和卸载时清空。
  - 页面不读取/写入 localStorage、sessionStorage、IndexedDB 或 URL。
  - 注销入口从“本地访问”迁移到密码页并继续调用现有 logout。

- [ ] 3.5 新增 `PasswordSettings.tsx` 并接入现有设置导航：
  - 在 `i18n-settings.ts` 添加 `id: "password"` 分类。
  - 在 `SettingsLayout.tsx` 的现有分类组件映射中注册页面，不增加新的路由层。
  - 复用现有 `settings-*`、`form-error`、`form-success`、`form-warning` 和危险按钮样式；除非布局确有缺口，不修改 `styles/index.css`。
  - 管理员密码只放在当前表单组件的短生命周期 state；请求结束无论成功失败都清空。
  - 固定显示：“管理员密码仅在服务器后端配置。若忘记密码，请登录服务器本机并运行管理员密码恢复命令。”

- [ ] 3.6 更新六种语言文件的同一组 key：
  - 设置分类名、三种状态、首次设置/启用/关闭/修改、字段名、确认与进行中状态。
  - `AUTH_ADMIN_NOT_CONFIGURED`、`AUTH_ADMIN_INVALID`、`AUTH_LOGIN_INVALID`、`AUTH_LOGIN_NOT_CONFIGURED`、`AUTH_ADMIN_TRANSPORT_REQUIRED`、`AUTH_PASSWORD_INVALID`、`AUTH_CONFIG_INVALID`、`AUTH_WRITE_FAILED` 的用户提示。
  - 后端配置/恢复说明和关闭认证确认。
  - `zh-CN.json` 必须使用已批准的完整恢复文案；其他语言语义一致，不留英文占位。

- [ ] 3.7 运行前端聚焦测试：

  ```powershell
  pnpm --filter @yep-anywhere/client test -- src/api/client.test.ts src/contexts/__tests__/AuthContext.test.tsx src/pages/settings/__tests__/PasswordSettings.test.tsx src/pages/settings/__tests__/SettingsAuthNavigation.test.tsx
  ```

  预期：认证状态、四类操作、敏感字段清理、错误映射、路由和本地访问迁移测试全部通过。

- [ ] 3.8 更新 `README.md` 与 `CLAUDE.md` 的认证章节：
  - 解释登录密码与管理员密码职责、管理员密码不在前端配置。
  - 记录源代码和生产 Bundle 下 `--setup-admin-password`、`--setup-auth`、`--auth-disable` 的隐藏输入用法，不出现明文密码示例。
  - 记录生产、开发、自定义数据目录和“先停止使用同一 auth.json 的服务”锁要求。
  - 记录旧 v1 用户升级后仍可登录，只需在首次管理登录密码前本机配置管理员密码。
  - 记录安全传输白名单、局域网 HTTP 只读限制、会话失效和恢复行为。
  - 删除 `AUTH_DISABLED` 和登录页首次设置的旧说明。

- [ ] 3.9 运行完整自动验证：

  ```powershell
  pnpm lint
  pnpm typecheck
  pnpm --filter @yep-anywhere/server test -- test/auth/AuthService.test.ts test/auth/AuthStateLock.test.ts test/auth/CliAuthCommands.test.ts test/auth/transportSecurity.test.ts test/auth/AuthRoutes.test.ts test/service/yep-entry.test.ts
  pnpm --filter @yep-anywhere/client test -- src/api/client.test.ts src/contexts/__tests__/AuthContext.test.tsx src/pages/settings/__tests__/PasswordSettings.test.tsx src/pages/settings/__tests__/SettingsAuthNavigation.test.tsx
  pnpm --filter @yep-anywhere/client build
  pnpm test
  ```

  预期：lint、类型检查、聚焦测试、客户端生产构建和全仓测试全部返回 0。若全仓已有无关失败，必须保存完整命令/失败输出并先确认与本变更的关系，不能把聚焦测试通过等同于全部完成。

- [ ] 3.10 在获得用户允许后做密码管理人工验收：
  - 无管理员密码时可查看状态、可继续用旧登录密码登录，但所有变更被拒绝并显示本机配置说明。
  - 本机首次设置管理员密码不改变旧登录密码或会话；本机恢复已有管理员密码保留登录密码但清除旧会话。
  - 首次设置、关闭、重新启用、已启用/已关闭状态下修改分别符合状态表。
  - 错误登录密码和错误管理员密码提示明确，连续失败不锁定或限流。
  - 局域网 HTTP 可读状态但不能变更；回环、直接 HTTPS、可信本机代理和桌面通道可按契约变更。
  - 检查 `auth.json`、服务/访问日志、浏览器存储、URL、shell 历史和进程列表均无明文密码；POSIX 权限/Windows ACL 符合要求。

**任务完成条件**

- 前端只有一个“密码管理”入口，登录页只负责登录，“本地访问”不再承载密码表单。
- 三种状态和四类操作与后端状态机完全一致，管理员密码不持久化。
- 六种语言、运维文档、自动测试和经批准的人工验收都完成。

---

## 需求覆盖与执行关卡

| 已批准能力 | 实施位置 |
| --- | --- |
| 薄统一入口、参数/标准流/退出码转发 | 第一阶段任务 1 |
| 暂存 Bundle、失败不影响生产、`buildId` | 第一阶段任务 1、2、3 |
| Windows 隐藏开发进程、Task Scheduler、守护与自启动独立 | 第一阶段任务 2 |
| macOS `nohup`、launchd/KeepAlive、自启动独立 | 第一阶段任务 3 |
| 中文命令交互、服务文档、双平台验收 | 第一阶段任务 2、3 |
| v2 迁移、状态转换、会话失效、私有原子存储与锁 | 第二阶段任务 1 |
| 隐藏输入本机配置/恢复、移除 `AUTH_DISABLED` | 第二阶段任务 1 |
| 管理员验证、传输白名单、稳定错误码和 Cookie 失效 | 第二阶段任务 2 |
| 独立密码设置页、登录页简化、本地访问迁移与国际化 | 第二阶段任务 3 |
| 全仓自动验证与密码人工验收 | 第二阶段任务 3 |

当前关卡：**等待用户评审本计划。** 在用户明确批准前，不创建工作树、不修改实现代码、不启动服务，也不执行部署或人工验收。
