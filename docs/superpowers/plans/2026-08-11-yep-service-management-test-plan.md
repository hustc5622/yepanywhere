# Yep Anywhere 服务管理全功能验证与缺陷修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:systematic-debugging` for failures, `superpowers:test-driven-development` for fixes, and `superpowers:verification-before-completion` before reporting completion.

**Goal:** 逐项验证 `pnpm yep`、Windows PowerShell 后端与 macOS Bash 后端的全部交互选择和等价命令，并修复 Windows 停止生产模式时已退出 PID 被误判为失败的问题。

**Architecture:** 自动测试分三层：Node 跨平台入口、菜单选择到后端函数的分发、平台生命周期逻辑的隔离模拟；当前 Windows 主机再执行真实服务生命周期验收。macOS 的 launchd 真实集成只能在 macOS 主机完成，本次 Windows 会执行 Bash 语法/模拟测试并明确保留真实 macOS 验收项。

**Tech Stack:** Node.js 20+、pnpm 9、Vitest、Windows PowerShell 5.1、Task Scheduler、Bash、launchd。

## Global Constraints

- 只触碰服务管理脚本及其聚焦测试；不重构无关代码。
- 先记录当前开发运行、生产运行和登录自启动状态，测试结束后恢复。
- 未核实身份的端口占用进程绝不终止。
- Windows 真实验收使用菜单入口，不以命令行等价命令代替菜单分发验证。
- macOS 真实 launchd 生命周期不能在 Windows 上伪装为已通过。
- 重构建必须验证暂存构建、Bundle 交换、生产重启和 `buildId`。

---

### Task 1: 建立完整菜单与竞态回归覆盖

**Files:**
- Modify: `packages/server/test/service/windows-service-scripts.test.ts`
- Modify: `packages/server/test/service/macos-service-scripts.test.ts`
- Modify only if the regression fails as expected: `scripts/yep.ps1`

**Interfaces:**
- Consumes: Windows `Show-Menu`、macOS `show_menu`、Windows `Stop-VerifiedMode`。
- Produces: 每个菜单选择的调用映射断言，以及“taskkill 报 PID 不存在但进程已退出时停止成功”的回归测试。

- [ ] **Step 1: 添加 Windows 菜单分发测试**

  通过加载脚本后替换 `Cmd-*` 函数与 `Read-Host`，逐项断言 `1,2,3,4,5,6,7,8,9,a,d,h,q` 的映射；不得启动真实服务。

- [ ] **Step 2: 添加 macOS 菜单分发测试**

  source `yep.sh` 后替换生命周期函数，逐项断言 `1..11,0` 的映射，特别核对选项 2 传入 `--fg`。

- [ ] **Step 3: 添加 Windows PID 消失竞态失败测试**

  构造已核实 PID，在 `taskkill` 调用前后模拟进程消失；预期 `stop-prod` 返回 0、清理元数据，且不输出 PowerShell `NativeCommandError`。

- [ ] **Step 4: 运行聚焦测试确认新增竞态用例先失败**

  Run: `pnpm --filter @yep-anywhere/server test -- test/service/yep-entry.test.ts test/service/windows-service-scripts.test.ts test/service/macos-service-scripts.test.ts`

  Expected: 菜单分发测试通过；竞态测试在当前实现上失败，并复现用户看到的停止失败语义。

- [ ] **Step 5: 做最小 PowerShell 修复**

  仅调整 `Stop-VerifiedMode` 对 `taskkill` 非零退出的处理：若同一 PID/启动时间对应的进程已经不存在，则视为停止成功；若仍存活则保留失败。避免让 native stderr 作为未处理错误污染交互输出。

- [ ] **Step 6: 重跑聚焦测试**

  Expected: 三个服务管理测试文件全部通过。

### Task 2: 静态与隔离自动验证

**Files:**
- Verify: `yep.mjs`
- Verify: `scripts/yep.ps1`
- Verify: `scripts/run-yepanywhere.ps1`
- Verify: `scripts/install-task-scheduler.ps1`
- Verify: `scripts/uninstall-task-scheduler.ps1`
- Verify: `scripts/deploy.ps1`
- Verify: `yep.sh`
- Verify: `scripts/install-launchagents.sh`
- Verify: `scripts/uninstall-launchagents.sh`

- [ ] **Step 1: 验证 Node 跨平台入口**

  Run: `pnpm --filter @yep-anywhere/server test -- test/service/yep-entry.test.ts`

  Expected: Windows/macOS 参数、标准流、退出码和不支持平台处理全部通过。

- [ ] **Step 2: 用 Windows PowerShell 5.1 解析全部 Windows 后端脚本**

  Expected: 所有 Parser 错误集合为空。

- [ ] **Step 3: 用可用 Bash 执行 macOS 脚本语法检查**

  Run: `bash -n yep.sh scripts/install-launchagents.sh scripts/uninstall-launchagents.sh`

  Expected: 可用 Bash 环境返回 0；若当前主机只有未配置 WSL，记录为环境限制。

- [ ] **Step 4: 执行 Windows/macOS 生命周期隔离测试**

  Run: `pnpm --filter @yep-anywhere/server test -- test/service/windows-service-scripts.test.ts test/service/macos-service-scripts.test.ts`

  Expected: 端口身份保护、健康检查、计划任务/launchd 配置、自启动独立性、停止竞态与暂存构建失败保护全部通过。

### Task 3: Windows 菜单真实全功能验收

**Files:**
- Runtime state only: `~/.yep-anywhere/`、Task Scheduler `YepAnywhereServer`、`dist/npm-package`

- [ ] **Step 1: 捕获基线状态**

  记录开发/生产运行状态、自启动状态、任务定义、PID、端口和当前 Bundle `buildId`。

- [ ] **Step 2: 验证只读选项**

  通过交互菜单分别选择 `8`、`h`、`q`，断言状态字段完整、帮助列出全部命令、退出码为 0。

- [ ] **Step 3: 验证开发生命周期**

  通过菜单执行 `1 -> 8 -> 3 -> 8 -> 2 -> 8`；断言 3400/3401/3402、PID 元数据和健康端点与每一步一致。

- [ ] **Step 4: 验证生产生命周期**

  通过菜单执行 `4 -> 8 -> 6 -> 8 -> 5 -> 8`；断言 Task Scheduler、8022、生产 PID 元数据和健康端点与每一步一致。

- [ ] **Step 5: 验证开发/生产并行与停止全部**

  通过菜单启动 `1`、`4`，确认两模式同时健康，再执行 `7` 并确认两者都停止且自启动设置未变。

- [ ] **Step 6: 验证自启动独立性**

  通过菜单执行 `a`，确认只添加当前用户登录触发器且不启动生产；启动生产后执行 `d`，确认触发器被移除但生产仍运行。

- [ ] **Step 7: 验证重构建**

  通过菜单执行 `9`，确认 lint、typecheck、暂存 Bundle、`npm ci --omit=dev`、Bundle 校验、交换、生产重启和三处 `buildId` 一致。

- [ ] **Step 8: 重测用户复现路径**

  在生产运行时通过交互菜单选择 `5`，确认即使计划任务停止与 PID 自行退出发生竞态，也不会出现 `NativeCommandError` 或 `ELIFECYCLE`，最终状态为已停止。

- [ ] **Step 9: 恢复基线状态**

  将开发运行、生产运行和登录自启动恢复到 Step 1 记录值；不覆盖用户数据或日志。

### Task 4: 最终回归与结果报告

**Files:**
- Verify only: all changed files

- [ ] **Step 1: 运行聚焦服务测试与仓库规定检查**

  Run: `pnpm --filter @yep-anywhere/server test -- test/service/yep-entry.test.ts test/service/windows-service-scripts.test.ts test/service/macos-service-scripts.test.ts`

  Run: `pnpm lint`

  Run: `pnpm typecheck`

- [ ] **Step 2: 检查差异与工作区**

  确认所有改动都能追溯到菜单覆盖或 PID 竞态修复，保留用户原有未跟踪文件。

- [ ] **Step 3: 汇总平台结论**

  分别报告 Windows 真实集成、Windows/macOS 自动测试、macOS 真实集成的 PASS/FAIL/BLOCKED，并列出确切命令、退出码和未完成原因。
