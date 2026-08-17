# Remote Session Reliability P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P0 已通过真实手机验收的前提下，加固 Windows 生产进程监管和部署事务，使孤儿服务可以安全识别与接管、未知端口占用绝不被误杀、8023 维护服务可用于本机 readiness，并在新版本启动或验证失败时自动恢复上一生产包。

**Architecture:** 新增一个仅供 Windows 脚本 dot-source 的 `production-runtime.ps1`，集中定义进程清单 v2、进程身份验证、五态运行状态和已验证进程组清理；`run-yepanywhere.ps1`、`yep.ps1` 与 `deploy.ps1` 只编排各自生命周期，不再各自判断 PID 身份。部署继续使用同一 `dist` 文件系统中的目录 rename，但把备份保留到任务、进程、端口、维护服务、build ID 和冒烟检查全部成功之后；失败路径先隔离失败包，再恢复并验证旧包。

**Tech Stack:** Windows PowerShell 5.1、Task Scheduler、Node.js 20+、pnpm 9、Vitest、Hono maintenance server、现有 `verify-deploy.mjs`。

## Global Constraints

- P0 的自动化测试、真实问题 Session、手机续发、旧 chunk 恢复和公网 WebSocket 两分钟观察必须全部通过后，才能开始本计划；P1 不回改 Session API、React 页面、静态资源恢复或 WebSocket 心跳。
- 只覆盖 Windows 生产服务；不改变 macOS LaunchAgent/bash 实现，不修改 FRP 地址、端口映射、认证或公网暴露范围。
- 保持 Windows PowerShell 5.1 兼容；不得依赖 PowerShell 7 专有语法、类或 .NET 新增重载。
- PID 从不单独证明进程身份；至少同时核对启动时间、可执行文件、完整命令行、role 参数、端口归属和健康信息。
- `unknown-conflict` 状态只报告证据并失败；任何 start、stop、deploy 或 rollback 路径都不得终止未验证进程。
- 现有 `prod-process.json` v1 只允许作为一次性安全升级输入：严格验证成功时归类为 `verified-stale` 并重启写入 v2，绝不直接归类为 `healthy` 或 `degraded-adoptable`；验证失败时归类为 `unknown-conflict`。
- 生产维护端口固定从主端口派生为 `ServerPort + 1`，当前为 `8023`，只绑定 `127.0.0.1`；不得加入 FRP 或其他公网入口。
- 现有“桥接端口已由外部实例提供”行为保持兼容：外部桥接只检查 loopback `/status`，记录为 `external`，不纳入可终止的受管进程组。
- 部署前必须请求 `/api/status/workers`；`hasActiveWork=true` 或 `queueLength>0` 时拒绝停机切换。空闲但仍驻留的 worker 不阻塞部署。
- rollback、状态检查和进程清理不得修改 `~/.claude/projects`、Session JSONL、附件、uploads 或 Yep Anywhere 数据目录中的用户数据。
- 自动 rollback 失败时保留 production、failed 和 rollback 目录以及 `prod-process.json` 证据，停止进一步目录删除或进程清理，并输出明确人工介入路径。
- 所有故障先写能在当前实现失败的测试，再写最小实现；每个任务独立提交，不顺手重构开发模式或不相关脚本。
- 真实 `pnpm yep rebuild`、计划任务故障注入和生产进程停止会改变当前运行状态；执行 Task 5 前必须按 `CLAUDE.md` 再取得用户部署授权。

---

## File and Contract Map

### Planned files

- Create: `scripts/production-runtime.ps1` — Windows 生产清单 v2、原子 JSON、build/config 身份、进程探测、五态检查和已验证进程组停止的唯一实现。
- Create: `packages/server/test/service/windows-production-reliability.test.ts` — PowerShell 5.1 隔离 harness，覆盖 v1 升级、PID 复用、五态状态、接管、未知占用、维护端口和进程组恢复。
- Create: `packages/server/test/service/verify-deploy.test.ts` — 跨平台 mock HTTP 验证 `verify-deploy.mjs` 的 main/client/worker/maintenance 冒烟契约。
- Modify: `scripts/run-yepanywhere.ps1` — 使用共享 inspection，接管健康残留，写原子 v2 清单，显式启用维护端口并监控受管子进程。
- Modify: `scripts/yep.ps1` — 生产 start/stop/status/readiness 改用五态模型；开发模式继续使用现有 v1 逻辑，不扩大范围。
- Modify: `scripts/deploy.ps1` — 增加空闲预检、延迟提交备份、失败包隔离、自动 rollback 和 rollback 后验证。
- Modify: `scripts/verify-deploy.mjs` — 在原 build ID 检查上增加 worker API 与可选 maintenance URL 冒烟检查。
- Modify: `packages/server/test/service/windows-service-scripts.test.ts` — 仅更新受 v2 合同影响的既有 fixture，并保留所有现有安全回归。
- Modify: `docs/DEPLOYMENT_MODES.md` — 记录五态 status、受控停止与异常退出差异、8023 loopback 和 rollback 目录语义。
- Modify: `CLAUDE.md` — 将 Windows 管理式生产的 8023 readiness 与自动 rollback 写入维护/重构建说明。
- Verify only: `scripts/install-task-scheduler.ps1` — 现有 `RestartCount=999`、`RestartInterval=1 minute`、`MultipleInstances=IgnoreNew` 和 `ExecutionTimeLimit=0` 已满足设计，不为 P1 重写任务模型。
- Verify only: `packages/server/src/config.ts`, `packages/server/src/index.ts`, `packages/server/src/maintenance/server.ts` — 维护服务已经强制绑定 `127.0.0.1`；P1 通过生产环境变量启用，不改 TypeScript 服务实现。

### Process manifest v2

`prod-process.json` 使用以下精确字段。`Processes` 只含 supervisor 实际启动或已验证接管的关键子进程；外部 bridge 不写入 `Processes`，只写入 `Bridges`：

```json
{
  "Version": 2,
  "Mode": "prod",
  "SupervisorInstanceId": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "Supervisor": {
    "Role": "supervisor",
    "Pid": 1200,
    "StartTimeUtc": "2026-08-17T08:00:00.0000000Z",
    "ExecutablePath": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "CommandLine": "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"D:\\PythonProjects\\Python_projects_anaconda_zpb\\Yepanywhere\\scripts\\run-yepanywhere.ps1\" -ConfigPath \"C:\\Users\\ZhuanZ\\.yep-anywhere\\service-config.json\""
  },
  "BuildId": "0.4.29-abcdef12-20260817T080000Z",
  "ConfigFingerprint": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "RepoRoot": "D:\\PythonProjects\\Python_projects_anaconda_zpb\\Yepanywhere",
  "BundlePath": "D:\\PythonProjects\\Python_projects_anaconda_zpb\\Yepanywhere\\dist\\npm-package",
  "Profile": "default",
  "DataDir": null,
  "BasePath": "",
  "Ports": {
    "Server": 8022,
    "Maintenance": 8023,
    "Codex": 4510,
    "Claude": 4520
  },
  "Bridges": {
    "Codex": "managed",
    "Claude": "managed"
  },
  "Processes": [
    {
      "Role": "server",
      "Pid": 1201,
      "StartTimeUtc": "2026-08-17T08:00:01.0000000Z",
      "ExecutablePath": "C:\\Program Files\\nodejs\\node.exe",
      "CommandLine": "node.exe \"D:\\PythonProjects\\Python_projects_anaconda_zpb\\Yepanywhere\\dist\\npm-package\\dist\\cli.js\" --port 8022"
    },
    {
      "Role": "codex-bridge",
      "Pid": 1202,
      "StartTimeUtc": "2026-08-17T08:00:01.1000000Z",
      "ExecutablePath": "C:\\Program Files\\nodejs\\node.exe",
      "CommandLine": "node.exe \"D:\\PythonProjects\\Python_projects_anaconda_zpb\\Yepanywhere\\dist\\npm-package\\dist\\cli.js\" --codex-bridge-only"
    },
    {
      "Role": "claude-bridge",
      "Pid": 1203,
      "StartTimeUtc": "2026-08-17T08:00:01.2000000Z",
      "ExecutablePath": "C:\\Program Files\\nodejs\\node.exe",
      "CommandLine": "node.exe \"D:\\PythonProjects\\Python_projects_anaconda_zpb\\Yepanywhere\\dist\\npm-package\\dist\\cli.js\" --claude-bridge-only"
    }
  ]
}
```

`Bridges.Codex` 和 `Bridges.Claude` 的唯一合法值是 `managed`、`external`、`disabled`。`server` role 必须恰好出现一次；managed bridge 必须恰好有一个同名 process entry；external/disabled bridge 不得有 process entry。

### Shared PowerShell interfaces

`scripts/production-runtime.ps1` 必须导出下列函数名和返回字段，后续任务不得另起同义接口：

```powershell
Write-YepJsonAtomic -Path <string> -Value <object>
Get-YepBundleBuildId -BundlePath <string>                         # -> string
Get-YepConfigFingerprint -ConfigIdentity <ordered dictionary>    # -> lowercase SHA-256
New-YepProcessIdentity -Role <string> -ProcessId <int>            # -> process entry or $null
Read-YepProcessManifest -Path <string>                            # -> { Status; Manifest; Error }
New-YepProductionExpectation -RepoRoot <string> -BundlePath <string> -BuildId <string> -BasePath <string> -Profile <string-or-null> -DataDir <string-or-null> -AllowedImagePaths <string-or-null> -ServerPort <int> -MaintenancePort <int> -CodexPort <int> -ClaudePort <int> -CodexControlUrl <string> -ClaudeControlUrl <string> -StartBridges <bool> -RunScriptPath <string>
Get-YepProductionInspection -ManifestPath <string> -Expectation <object>
Stop-YepVerifiedProcessGroup -Inspection <object> [-ExcludeProcessId <int>] # -> bool
```

`Get-YepProductionInspection` 返回：

```powershell
[pscustomobject]@{
  State = 'healthy' # or degraded-adoptable|verified-stale|unknown-conflict|stopped
  Manifest = $manifest
  VerifiedSupervisor = $supervisorIdentityOrNull
  VerifiedProcesses = @($verifiedChildEntries)
  UnknownPortOwners = @([pscustomobject]@{ Port = 8022; Pid = 9999 })
  MainHealthy = $true
  MaintenanceHealthy = $true
  RunningBuildId = '0.4.29-abcdef12-20260817T080000Z'
  Reasons = @('supervisor-missing')
}
```

`Reasons` 只使用这些固定 token：`manifest-missing`、`manifest-invalid`、`legacy-v1`、`supervisor-missing`、`process-identity-mismatch`、`build-mismatch`、`config-mismatch`、`role-missing`、`main-unhealthy`、`maintenance-unhealthy`、`bridge-unhealthy`、`unknown-port-owner`。CLI 可以把 token 映射为中文，但共享 inspection 不产生自由文本原因。

状态判定顺序固定如下，避免调用者各自解释：

1. 主端口或维护端口存在不属于已验证 server entry/其子进程的 listener，立即 `unknown-conflict`。
2. v2 清单无效且存在 listener，或 v1 entry 无法通过 legacy role/start/command 验证，`unknown-conflict`。
3. 没有任何已验证 production entry，且主/维护端口均未监听，`stopped`；损坏但无运行证据的旧清单只加入 `Reasons`。
4. 存在已验证 production entry，但 schema 为 v1、build/config 不匹配、关键 role 缺失、端口/健康不完整，`verified-stale`。
5. v2 的 build/config、server、managed bridges、端口和健康均匹配，但 supervisor 不存在或身份不匹配，`degraded-adoptable`。
6. 上述全部匹配且 supervisor 身份有效，`healthy`。

---

### Task 1: Add the atomic v2 manifest and shared production identity engine

**Files:**
- Create: `scripts/production-runtime.ps1`
- Create: `packages/server/test/service/windows-production-reliability.test.ts`

**Interfaces:**
- Consumes: existing `Get-CimInstance Win32_Process`, `Get-Process`, `Get-NetTCPConnection`, `/api/version`, maintenance `/health`, bridge `/status`, and `dist/npm-package/build-info.json`.
- Produces: all functions and inspection fields listed in “Shared PowerShell interfaces”; Tasks 2–4 consume these names exactly.

- [ ] **Step 1: Add a Windows PowerShell test harness and failing atomic/schema tests**

Create the test file with the same process wrapper style as `windows-service-scripts.test.ts`, but keep it independent so the existing 1,600-line suite does not grow further:

```ts
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const runtimeScript = path.join(repoRoot, "scripts", "production-runtime.ps1");
const tempDirs: string[] = [];

function psLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(command: string, environment: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`,
    ], { cwd: repoRoot, env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "win32")("Windows production runtime identity", () => {
  it("atomically writes a BOM-free v2 manifest and leaves no temp file", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-runtime-atomic-"));
    tempDirs.push(stateDir);
    const manifestPath = path.join(stateDir, "prod-process.json");
    const result = await runPowerShell(`
. ${psLiteral(runtimeScript)}
$first = [ordered]@{ Version = 2; Mode = 'prod'; BuildId = 'first' }
$second = [ordered]@{ Version = 2; Mode = 'prod'; BuildId = 'second' }
Write-YepJsonAtomic -Path $env:YEP_TEST_MANIFEST -Value $first
Write-YepJsonAtomic -Path $env:YEP_TEST_MANIFEST -Value $second
$tempCount = @(Get-ChildItem -Path ($env:YEP_TEST_MANIFEST + '.tmp.*') -ErrorAction SilentlyContinue).Count
Write-Output "__TEMP_COUNT__$tempCount"
`, { YEP_TEST_MANIFEST: manifestPath });

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
      Version: 2,
      Mode: "prod",
      BuildId: "second",
    });
    expect(result.stdout).toContain("__TEMP_COUNT__0");
    expect((await readFile(manifestPath))[0]).not.toBe(0xef);
  });

  it("rejects a v2 process entry without ExecutablePath", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "yep-runtime-schema-"));
    tempDirs.push(stateDir);
    const manifestPath = path.join(stateDir, "prod-process.json");
    await writeFile(manifestPath, JSON.stringify({
      Version: 2,
      Mode: "prod",
      Processes: [{ Role: "server", Pid: 42, StartTimeUtc: "2026-08-17T00:00:00Z", CommandLine: "node cli.js --port 8022" }],
    }), "utf8");
    const result = await runPowerShell(`
. ${psLiteral(runtimeScript)}
$read = Read-YepProcessManifest -Path $env:YEP_TEST_MANIFEST
Write-Output ('__READ__' + $read.Status)
`, { YEP_TEST_MANIFEST: manifestPath });

    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("__READ__invalid");
  });
});
```

- [ ] **Step 2: Run the new tests to prove the module is missing**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/service/windows-production-reliability.test.ts
```

Expected: FAIL because `scripts/production-runtime.ps1` does not exist.

- [ ] **Step 3: Implement atomic JSON, build ID, config fingerprint and strict v2 schema**

Create `scripts/production-runtime.ps1`. Use same-directory temp files and the .NET APIs available to Windows PowerShell 5.1:

```powershell
$script:YepProductionManifestVersion = 2
$script:YepProductionStates = @('healthy', 'degraded-adoptable', 'verified-stale', 'unknown-conflict', 'stopped')

function Write-YepJsonAtomic {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $tempPath = "$Path.tmp.$([guid]::NewGuid().ToString('N'))"
  try {
    $json = $Value | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText($tempPath, $json, (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Path) {
      [IO.File]::Replace($tempPath, $Path, $null, $true)
    } else {
      [IO.File]::Move($tempPath, $Path)
    }
  } finally {
    if (Test-Path -LiteralPath $tempPath) {
      Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Get-YepBundleBuildId {
  param([Parameter(Mandatory = $true)][string]$BundlePath)
  $buildInfoPath = Join-Path $BundlePath 'build-info.json'
  $buildInfo = Get-Content -LiteralPath $buildInfoPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$buildInfo.buildId)) { throw "Bundle build-info.json 缺少 buildId：$buildInfoPath" }
  return [string]$buildInfo.buildId
}

function Get-YepConfigFingerprint {
  param([Parameter(Mandatory = $true)]$ConfigIdentity)
  $bytes = [Text.Encoding]::UTF8.GetBytes(($ConfigIdentity | ConvertTo-Json -Compress -Depth 8))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
```

Implement `Test-YepProcessEntrySchema`, `Test-YepManifestV2Schema` and `Read-YepProcessManifest` with exact `Status` values `missing|valid-v1|valid-v2|invalid`. Require all manifest fields shown in the contract, unique roles, one server, valid bridge modes, ports 1–65535, and a 64-character lowercase fingerprint. v1 validity requires `Version=1`, `Mode=prod`, and process entries containing `Role`, integer `Pid>0` and parseable `StartTimeUtc`; it is never upgraded in place by the reader.

- [ ] **Step 4: Add failing identity-reuse and five-state decision tests**

Add table-driven PowerShell harness cases that mock `Get-Process`, `Get-CimInstance`, `Get-NetTCPConnection` and `Invoke-WebRequest`. Assert these exact results:

```ts
expect(states).toEqual({
  allMatched: "healthy",
  supervisorMissing: "degraded-adoptable",
  buildMismatch: "verified-stale",
  unknownServerPortOwner: "unknown-conflict",
  nothingRunning: "stopped",
  verifiedLegacyV1: "verified-stale",
});
```

Add three PID-reuse cases where only one field differs—`StartTimeUtc`, `ExecutablePath`, or `CommandLine`—and assert the entry is absent from `VerifiedProcesses`. For a mismatched listener PID, also assert `UnknownPortOwners` contains its port/PID and the test records no call to `Stop-Process` or `taskkill.exe`.

- [ ] **Step 5: Run the focused test and verify the new cases fail**

Run the same Vitest command. Expected: atomic/schema cases PASS; identity and state cases FAIL because the probe/inspection functions are not yet defined.

- [ ] **Step 6: Implement process identity, expectation and deterministic inspection**

Use exact live values from `Get-Process` plus `Win32_Process`; never reconstruct a command line from expected arguments:

```powershell
function New-YepProcessIdentity {
  param([Parameter(Mandatory = $true)][string]$Role, [Parameter(Mandatory = $true)][int]$ProcessId)
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  try { $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop } catch { return $null }
  if (-not $cim -or [string]::IsNullOrWhiteSpace([string]$cim.ExecutablePath) -or
      [string]::IsNullOrWhiteSpace([string]$cim.CommandLine)) { return $null }
  return [ordered]@{
    Role = $Role
    Pid = $ProcessId
    StartTimeUtc = $process.StartTime.ToUniversalTime().ToString('o')
    ExecutablePath = [IO.Path]::GetFullPath([string]$cim.ExecutablePath)
    CommandLine = [string]$cim.CommandLine
  }
}
```

`Test-YepProcessIdentity` must compare PID, parsed UTC start time within one second, normalized executable path with `OrdinalIgnoreCase`, and exact stored/current command line with `Ordinal`. Then apply role checks:

- `supervisor`: command contains the normalized `run-yepanywhere.ps1` path and `-ConfigPath`.
- `server`: command contains the normalized bundle `dist/cli.js`, `--port`, and the exact server port token.
- `codex-bridge`: command contains the same CLI and `--codex-bridge-only`.
- `claude-bridge`: command contains the same CLI and `--claude-bridge-only`.

Implement `New-YepProductionExpectation` with the exact parameters in the shared interface. Inside it, create one ordered config identity containing normalized repo/bundle paths, BasePath, Profile, DataDir, AllowedImagePaths, four ports, both effective bridge control URLs and StartBridges; call `Get-YepConfigFingerprint` there so all three callers use identical ordering. Derive `ServerBaseUrl` from server port plus normalized BasePath. Implement `Get-YepProductionInspection` according to the six ordered rules in the contract map. Parse `/api/version` and require `build.buildId`; check maintenance at `http://127.0.0.1:<MaintenancePort>/health`; check managed/external bridge `/status` only when its mode requires it.

For legacy v1, use role/start-time and current role-command checks against the expected script/CLI, but mark the result stale even when every process verifies. Never synthesize the missing executable/command fields into a v2 manifest without restarting.

- [ ] **Step 7: Implement identity-safe group cleanup and its failing/success tests**

Port the existing snapshot-before-kill safety into `Stop-YepVerifiedProcessGroup`. The function consumes only `Inspection.VerifiedSupervisor` and `Inspection.VerifiedProcesses`, omits `ExcludeProcessId` when supplied, snapshots PID/start-time plus descendants before any termination, kills only verified root trees, rechecks PID/start-time after each kill, and returns `$false` if enumeration is incomplete, a verified PID remains, or an unknown main/maintenance port owner exists.

Add tests that assert:

```ts
expect(verifiedCleanup.stdout).toContain("__KILL__supervisor");
expect(verifiedCleanup.stdout).not.toContain("__KILL__server-child-twice");
expect(unknownCleanup.stdout).not.toContain("__KILL__");
expect(unknownCleanup.code).not.toBe(0);
```

Use the same root-only and reparented-child fixtures already proven in `windows-service-scripts.test.ts`; do not delete those existing tests.

- [ ] **Step 8: Run focused tests and parse the PowerShell module**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/service/windows-production-reliability.test.ts
$errors = $null
[Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'scripts/production-runtime.ps1'), [ref]$null, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { $errors | Format-List; exit 1 }
```

Expected: all tests PASS; parser exits 0; unknown-owner tests record no kill marker.

- [ ] **Step 9: Commit Task 1**

```powershell
git add scripts/production-runtime.ps1 packages/server/test/service/windows-production-reliability.test.ts
git commit -m "feat: add verified production process manifests"
```

---

### Task 2: Use the five-state model in Windows start, stop, status and readiness

**Files:**
- Modify: `scripts/yep.ps1:5-21,51-80,110-218,571-595,726-819,856-912,937`
- Modify: `packages/server/test/service/windows-production-reliability.test.ts`
- Modify only for v2 fixture compatibility: `packages/server/test/service/windows-service-scripts.test.ts:354-536,619-1238`

**Interfaces:**
- Consumes: `New-YepProductionExpectation`, `Get-YepProductionInspection`, `Stop-YepVerifiedProcessGroup` from Task 1.
- Produces: `Get-ProductionRuntimeInspection`, five exact status tokens in CLI output, and safe start/stop behavior consumed by supervisor/deploy acceptance.

- [ ] **Step 1: Write failing CLI state tests for the incident and every transition**

Add fixtures invoking the real `scripts/yep.ps1` with mocked process/task/HTTP providers. Required assertions:

```ts
expect(degraded.stdout).toContain("degraded-adoptable");
expect(degraded.stdout).toContain("监督器缺失");
expect(degraded.stdout).not.toContain("生产模式：已停止");
expect(stale.stdout).toContain("verified-stale");
expect(conflict.stdout).toContain("unknown-conflict");
expect(stopped.stdout).toContain("生产模式：已停止");
expect(healthy.stdout).toContain("healthy");
```

The degraded fixture must reproduce the observed incident: Task Scheduler `State='Ready'`, `LastTaskResult=0xC000013A`, missing supervisor PID, verified server/bridges, healthy 8022/8023 and matching build/config. Assert `status` exits 0 and reports the task state/result without claiming why the supervisor stopped.

- [ ] **Step 2: Run the focused CLI tests and prove current status misclassifies degraded as stopped**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/service/windows-production-reliability.test.ts
```

Expected: the degraded assertion FAILS because current `Cmd-Status` prints `生产模式：已停止` when the task is not Running.

- [ ] **Step 3: Dot-source the shared runtime and derive one production expectation**

Near the existing `service-config.ps1` import, dot-source the runtime module. After `$ServerPort` and `$CliJs` have been assigned, derive the maintenance port and build ID without changing `service-config.json` schema:

```powershell
. (Join-Path $ScriptDir 'production-runtime.ps1')
$MaintenancePort = ([int]$ServerPort) + 1
$ProductionBuildId = if (Test-Path $CliJs) { Get-YepBundleBuildId (Join-Path $RepoRoot 'dist/npm-package') } else { $null }
```

Construct `$ProductionExpectation` once through `New-YepProductionExpectation`, passing the effective profile, data directory, allowed image paths, ports and bridge control URLs already resolved by `yep.ps1`. Add:

```powershell
function Get-ProductionRuntimeInspection {
  return Get-YepProductionInspection -ManifestPath $ProdStateFile -Expectation $ProductionExpectation
}
```

Do not replace the dev `dev-process.json` writer or dev cleanup functions in this task.

- [ ] **Step 4: Replace production readiness and status with the exact five-state mapping**

`Test-ProductionInstanceReady` must return true only when the task definition is valid, task state is `Running`, and inspection state is `healthy`. `Cmd-Status` must always print both the exact machine token and Chinese meaning:

```powershell
switch ($inspection.State) {
  'healthy' { Write-Info '生产模式：healthy（运行中）' }
  'degraded-adoptable' { Write-WarningMessage '生产模式：degraded-adoptable（监督器缺失，服务健康且可接管）' }
  'verified-stale' { Write-ErrorMessage '生产模式：verified-stale（已验证残留与当前 build、配置或健康不一致）' }
  'unknown-conflict' { Write-ErrorMessage '生产模式：unknown-conflict（端口占用身份未知，拒绝启动或清理）' }
  'stopped' { Write-WarningMessage '生产模式：已停止（stopped）' }
}
```

Print server/maintenance/bridge ports, verified PIDs, Task Scheduler state, `LastTaskResult`, build ID, config fingerprint prefix and `Reasons`; do not print full command lines.

- [ ] **Step 5: Write failing start/stop transition tests**

Cover this exact table:

| Initial state | `start-prod` | `stop-prod` |
|---|---|---|
| `healthy` | no-op success | controlled task stop, then verified group cleanup |
| `degraded-adoptable` | call `Start-ScheduledTask`; do not kill children | cleanup verified group even when task is Ready |
| `verified-stale` | cleanup verified group, then start task | cleanup verified group |
| `unknown-conflict` | fail, no start/kill | fail, no task stop/kill |
| `stopped` | ensure task then start | no-op success |

For degraded start, capture server PID before/after and assert no taskkill marker. For legacy v1 stale start, assert only verified v1 roots are killed and a task start is requested. For unknown conflict, assert both `__TASK_STARTED__` and `__KILL__` are absent.

- [ ] **Step 6: Implement minimal production start/stop orchestration**

Refactor only `Cmd-StartProd` and `Cmd-StopProd` around the table. `Cmd-StopProd` still calls `Stop-ScheduledTask` first when a valid task is Running, waits for it to leave Running, then obtains a fresh inspection and calls `Stop-YepVerifiedProcessGroup`. If task stop fails, retain the current safety behavior and do not kill the process group.

When `Cmd-StartProd` sees `verified-stale`, call shared cleanup and recompute inspection; proceed only if the new state is `stopped`. When it sees `degraded-adoptable`, start the task so the new supervisor performs adoption; never kill the healthy children from the CLI.

- [ ] **Step 7: Run new and existing Windows service tests**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/service/windows-production-reliability.test.ts test/service/windows-service-scripts.test.ts test/service/yep-entry.test.ts
```

Expected: all tests PASS. Existing dev lifecycle, task-definition safety, root-only cleanup, reparented child and build-staging tests remain green; only fixture fields needed by v2 are changed.

- [ ] **Step 8: Commit Task 2**

```powershell
git add scripts/yep.ps1 packages/server/test/service/windows-production-reliability.test.ts packages/server/test/service/windows-service-scripts.test.ts
git commit -m "fix: classify degraded production service states"
```

---

### Task 3: Adopt verified orphan processes and enable loopback maintenance readiness

**Files:**
- Modify: `scripts/run-yepanywhere.ps1:14-18,40-76,80-97,114-185,188-237`
- Verify only: `scripts/install-task-scheduler.ps1:97-126`
- Modify: `packages/server/test/service/windows-production-reliability.test.ts`
- Modify only for supervisor fixture compatibility: `packages/server/test/service/windows-service-scripts.test.ts:1515-1562`
- Modify: `docs/DEPLOYMENT_MODES.md:52-68`
- Modify: `CLAUDE.md:79-103,264-276,386-419`

**Interfaces:**
- Consumes: shared manifest/inspection/cleanup functions and Task 2 expectation contract.
- Produces: atomic v2 manifests, zero-interruption `degraded-adoptable` adoption, 8023 readiness, critical-child failure exit code 1, and documented controlled-stop semantics.

- [ ] **Step 1: Add failing supervisor adoption, stale cleanup and unknown-conflict tests**

Use real `run-yepanywhere.ps1` with mocked `Start-Process`, process probes, port ownership and HTTP. Assert:

```ts
expect(adoption.stdout).toContain("已接管现有生产进程组");
expect(adoption.stdout).not.toContain("__START_CHILD__");
expect(adoption.stdout).not.toContain("__KILL__");
expect(adoptedManifest.SupervisorInstanceId).not.toBe(oldInstanceId);
expect(adoptedManifest.Processes.find((p) => p.Role === "server")?.Pid).toBe(oldServerPid);

expect(stale.stdout).toContain("verified-stale");
expect(stale.stdout).toContain("__KILL_VERIFIED__");
expect(stale.stdout).toContain("__START_CHILD__server");

expect(conflict.code).not.toBe(0);
expect(conflict.stdout).toContain("unknown-conflict");
expect(conflict.stdout).not.toContain("__KILL__");
expect(conflict.stdout).not.toContain("__START_CHILD__");
```

The adoption test must mock one monitoring iteration and then an orderly harness exit; it must not hang in the infinite supervisor loop.

- [ ] **Step 2: Add a failing production maintenance-port test**

Capture the environment passed to the server child. Assert `MAINTENANCE_PORT` equals server port + 1 and that readiness queries both endpoints:

```ts
expect(capturedEnvironment.MAINTENANCE_PORT).toBe("8023");
expect(result.stdout).toContain("__HEALTH__http://127.0.0.1:8022/api/version");
expect(result.stdout).toContain("__HEALTH__http://127.0.0.1:8023/health");
```

Also assert the v2 manifest records `Ports.Maintenance=8023`. Keep a static assertion that `packages/server/src/index.ts` passes `host: "127.0.0.1"` to `startMaintenanceServer`; do not change it.

- [ ] **Step 3: Run supervisor tests and prove current script refuses adoption/does not enable 8023**

Run the production reliability test. Expected: adoption and maintenance tests FAIL; current script rejects occupied 8022 and does not set `MAINTENANCE_PORT`.

- [ ] **Step 4: Build the supervisor expectation and inspect before starting children**

Dot-source `production-runtime.ps1`, set:

```powershell
$MaintenancePort = ([int]$ServerPort) + 1
$env:MAINTENANCE_PORT = [string]$MaintenancePort
```

Add `MAINTENANCE_PORT` inside `Set-ProductionEnvironment`, create the expectation through `New-YepProductionExpectation` with the same effective values as `yep.ps1`, and call `Get-YepProductionInspection` before any `Start-Process`.

Handle initial states exactly:

- `healthy`: refuse a second supervisor with a diagnostic; Task Scheduler `IgnoreNew` should normally prevent this.
- `degraded-adoptable`: convert every `VerifiedProcesses` entry to a monitored `$Managed` item using `Get-Process`, preserve child PIDs, set bridge modes from the old manifest and write a new supervisor instance ID.
- `verified-stale`: call `Stop-YepVerifiedProcessGroup`; continue only after a fresh inspection is `stopped`.
- `unknown-conflict`: fail without starting or killing anything.
- `stopped`: start the normal child group.

- [ ] **Step 5: Write the v2 manifest atomically before and after readiness**

Replace `Write-ProcessMetadata` with `Write-ProductionManifest`. For a newly started group, write the manifest immediately after child identities have been captured so a supervisor failure during readiness still leaves verifiable evidence; after main, maintenance and managed bridge health checks pass, rewrite the same manifest atomically with no schema change.

For bridge selection:

```powershell
# port free + YEP_START_BRIDGES != false  -> managed and Start-Process
# port occupied + GET /status succeeds   -> external, never add to $Managed
# YEP_START_BRIDGES == false              -> disabled
# port occupied + GET /status fails      -> unknown-conflict and exit without kill
```

The server process owns both 8022 and 8023. Require `/api/version` build ID to equal the manifest `BuildId`, not just HTTP 200.

- [ ] **Step 6: Preserve critical-child group recovery semantics**

Monitor only `$Managed` entries. If any managed child exits, recompute identity, call `Stop-YepVerifiedProcessGroup -Inspection $inspection -ExcludeProcessId $PID` so the supervisor does not kill itself before cleaning siblings, and then exit 1 so the existing Task Scheduler failure policy can relaunch the supervisor. Remove `prod-process.json` only when every verified managed PID is gone and server/maintenance ports are released; otherwise preserve it for the next inspection.

Extend the existing critical-process test to assert:

```ts
expect(result.code).toBe(1);
expect(result.stdout).toContain("关键进程");
expect(result.stdout).toContain("__STOPPED__server");
expect(result.stdout).toContain("__STOPPED__remaining-bridge");
```

- [ ] **Step 7: Verify Task Scheduler configuration without changing its restart model**

Run the existing task-definition tests and assert:

```ts
expect(manualDefinition.RestartCount).toBe(999);
expect(manualDefinition.MultipleInstances).toBe("IgnoreNew");
expect(manualDefinition.ExecutionTimeLimit).toEqual({ Minutes: 0, Hours: 0, Seconds: 0 });
```

Add `RestartInterval` to `captureTaskDefinition` and assert one minute. Do not add a periodic trigger: unexpected supervisor exit is handled by restart-on-failure; explicit `Stop-ScheduledTask` remains a controlled stop and may remain Ready.

- [ ] **Step 8: Document operational semantics and the loopback boundary**

Update `docs/DEPLOYMENT_MODES.md` and `CLAUDE.md` with these exact facts:

- Windows managed production uses 8022 main and `ServerPort+1` maintenance (currently 8023).
- 8023 listens only on `127.0.0.1` and must never be published through FRP.
- `status` reports `healthy`, `degraded-adoptable`, `verified-stale`, `unknown-conflict`, or `stopped` plus Task Scheduler state/result.
- killing the supervisor process is an unexpected failure and should trigger Task Scheduler restart/adoption; `pnpm yep stop-prod` uses `Stop-ScheduledTask` as an intentional stop and should not self-relaunch.
- PID alone is never permission to kill a process.

- [ ] **Step 9: Run focused and existing service suites, then commit**

```powershell
pnpm --filter @yep-anywhere/server test -- test/service/windows-production-reliability.test.ts test/service/windows-service-scripts.test.ts test/service/yep-entry.test.ts
git add scripts/run-yepanywhere.ps1 packages/server/test/service/windows-production-reliability.test.ts packages/server/test/service/windows-service-scripts.test.ts docs/DEPLOYMENT_MODES.md CLAUDE.md
git commit -m "fix: adopt verified production process groups"
```

Expected: all tests PASS; `git diff --cached --name-only` contains no TypeScript application/runtime source and no FRP configuration.

---

### Task 4: Make Windows deployment transactional with idle guard and automatic rollback

**Files:**
- Modify: `scripts/deploy.ps1:5-37,50-90,107-125,191-226,228-268`
- Modify: `scripts/verify-deploy.mjs:5-127`
- Create: `packages/server/test/service/verify-deploy.test.ts`
- Modify: `packages/server/test/service/windows-production-reliability.test.ts`
- Modify only for compatibility: `packages/server/test/service/windows-service-scripts.test.ts:1564-1604`
- Modify: `docs/DEPLOYMENT_MODES.md:60-68`
- Modify: `CLAUDE.md:268-276`

**Interfaces:**
- Consumes: `pnpm yep stop-prod/start-prod`, shared five-state status, `/api/status/workers`, maintenance `/health`, current `build-info.json`, and `verify-deploy.mjs` build checks.
- Produces: `Assert-ProductionIdle`, `Start-BundleTransaction`, `Complete-BundleTransaction`, `Restore-BundleTransaction`, and a verification command whose nonzero exit triggers rollback.

- [ ] **Step 1: Add failing cross-platform deployment smoke tests**

Create `verify-deploy.test.ts` with a temporary HTTP server exposing:

```ts
// main base URL
GET /api/version       -> { build: { buildId: "build-new", gitCommit: "abc123" } }
GET /build-info.json   -> { buildId: "build-new", gitCommit: "abc123" }
GET /api/status/workers -> { activeWorkers: 0, queueLength: 0, hasActiveWork: false }

// maintenance base URL
GET /health            -> { status: "ok" }
```

Spawn `node scripts/verify-deploy.mjs --base-url <main> --maintenance-url <maintenance> --build-info <file>` and assert exit 0. Add separate cases for missing worker fields and maintenance 500; both must exit nonzero and include the failing endpoint in stderr.

- [ ] **Step 2: Run the smoke test and prove the new option is unsupported**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/service/verify-deploy.test.ts
```

Expected: FAIL with `Unknown argument: --maintenance-url`.

- [ ] **Step 3: Extend verify-deploy without changing existing callers**

Add optional `--maintenance-url`; when omitted, retain current main/client build behavior for macOS callers. Always validate `/api/status/workers` when main build checks pass:

```js
const workers = await fetchJson(`${args.baseUrl}/api/status/workers?${cacheBust}`);
if (
  typeof workers?.activeWorkers !== "number" ||
  typeof workers?.queueLength !== "number" ||
  typeof workers?.hasActiveWork !== "boolean"
) {
  throw new Error("Server /api/status/workers returned an invalid readiness payload.");
}

if (args.maintenanceUrl) {
  const health = await fetchJson(`${args.maintenanceUrl}/health?${cacheBust}`);
  if (health?.status !== "ok") throw new Error("Maintenance /health did not return status=ok.");
}
```

Print build ID, worker counts and maintenance URL in the success output. Do not require zero workers here; idle gating belongs before stopping the old server.

- [ ] **Step 4: Add failing idle-guard and transaction rollback tests**

In the Windows reliability suite, use mocked filesystem/process commands and cover:

1. `hasActiveWork=true` — deployment exits before `stop-prod`, Move-Item or Remove-Item.
2. `queueLength=1` — same refusal.
3. staging/build failure — existing production and service stay untouched.
4. new `start-prod` failure — new production moves to `npm-package-failed-*`, old backup returns to `npm-package`, old `start-prod` and old build verification run.
5. new build ID failure — same rollback.
6. maintenance/smoke failure — same rollback.
7. rollback restart/verification failure — production, failed and rollback evidence all remain; no backup deletion occurs after failure.
8. full success — backup is deleted only after all checks pass.
9. first install with no previous production — new failure is preserved as `npm-package-failed-*`, service remains stopped, and output clearly says no rollback bundle existed.

Assert operation order with a marker list:

```ts
expect(operations).toEqual([
  "idle-check",
  "stop-old",
  "move-old-to-rollback",
  "move-staging-to-production",
  "start-new",
  "verify-new",
  "remove-rollback",
]);
```

For failure, assert:

```ts
expect(operations).toEqual([
  "idle-check",
  "stop-old",
  "move-old-to-rollback",
  "move-staging-to-production",
  "start-new",
  "verify-new-failed",
  "stop-new",
  "move-new-to-failed",
  "move-rollback-to-production",
  "start-old",
  "verify-old",
]);
expect(operations).not.toContain("remove-rollback");
```

- [ ] **Step 5: Run rollback tests and verify current deploy deletes backup too early**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/service/windows-production-reliability.test.ts test/service/windows-service-scripts.test.ts
```

Expected: rollback cases FAIL because current `Publish-StagedBundle` removes the backup before start/verification.

- [ ] **Step 6: Add a strict pre-stop idle check**

Implement:

```powershell
function Assert-ProductionIdle {
  $workersUrl = "$ServerBaseUrl/api/status/workers"
  try {
    $workers = Invoke-RestMethod -Uri $workersUrl -Method Get -TimeoutSec 5 -ErrorAction Stop
  } catch {
    throw "无法确认当前生产服务是否有执行中的 AI 回合；拒绝停机：$workersUrl：$_"
  }
  if ($workers.hasActiveWork -eq $true -or [int]$workers.queueLength -gt 0) {
    throw "当前仍有 AI 回合或排队消息（hasActiveWork=$($workers.hasActiveWork), queueLength=$($workers.queueLength)）；拒绝部署。"
  }
}
```

At the top of `deploy.ps1`, dot-source `production-runtime.ps1`, derive `$MaintenancePort`, and add `Get-DeploymentInspection($bundlePath)`; this helper reads that bundle's build ID and calls `New-YepProductionExpectation` with the same effective service values used by the supervisor. If no production `build-info.json`, manifest, main listener or maintenance listener exists, return `stopped` for a first install; if a listener exists without readable build identity, return `unknown-conflict`. Call the helper before any stop or directory move. Call `Assert-ProductionIdle` immediately before `stop-prod` for full build/restart deployments. If the inspection is `stopped`, skip the HTTP call; if it is `unknown-conflict`, fail before any directory mutation. Do not add a force-bypass flag in P1.

- [ ] **Step 7: Keep the backup until commit and implement exact rollback ordering**

Replace `Publish-StagedBundle` with `Start-BundleTransaction`; it returns a transaction object and does not delete the backup:

```powershell
[pscustomobject]@{
  ProductionDir = $safeProduction
  RollbackDir = $rollbackDir
  PreviousProductionExisted = $movedOld
  NewBuildInfo = Join-Path $safeProduction 'build-info.json'
}
```

Use only validated paths under `$DistRoot` with prefixes `npm-package`, `npm-package-staging-`, `npm-package-rollback-`, and `npm-package-failed-`. `Complete-BundleTransaction` removes `RollbackDir` only after `start-prod` and `Verify-RunningBuild` succeed.

`Restore-BundleTransaction` must perform this exact sequence:

```powershell
# 1. pnpm yep stop-prod: it will kill only identities verified by the new manifest.
# 2. Move current npm-package to a unique npm-package-failed-* directory.
# 3. Move npm-package-rollback-* back to npm-package.
# 4. pnpm yep start-prod.
# 5. Verify-RunningBuild against the restored npm-package/build-info.json.
# 6. Report the original deployment error and rollback success/failure.
```

If stopping the failed new group returns nonzero, do not move any directory: preserve production, rollback, manifests and logs and report manual intervention. If any later rollback step fails, catch only to add diagnostics; do not remove production, failed, rollback, manifests or logs afterward. Preserve the original deployment exception separately so the final output contains both errors. When `PreviousProductionExisted=$false`, stop the verified new group, move it to `npm-package-failed-*`, leave production stopped and report that no rollback bundle existed.

`--server-build-only` retains its non-running semantics: bundle integrity is the commit point because runtime start was explicitly disabled; document that automatic runtime rollback applies to `rebuild`/`--server-only`, not build-only.

- [ ] **Step 8: Make all post-start checks rollback-triggering**

Pass both URLs to the verifier:

```powershell
& node $VerifyDeployScript `
  --base-url $ServerBaseUrl `
  --maintenance-url "http://127.0.0.1:$MaintenancePort" `
  --build-info $buildInfo
Assert-LastExitCode '生产 buildId/readiness 冒烟验证'
```

Before committing the transaction, call `Get-DeploymentInspection($ProductionDir)` and require `State='healthy'`, require Task Scheduler to be `Running`, and require every managed bridge mode/process/port to match the v2 manifest. `pnpm yep status` may still be printed for the operator, but its human text is not parsed as the deployment decision. Any failure enters the same rollback path.

- [ ] **Step 9: Run all deploy/service tests and update operational docs**

```powershell
pnpm --filter @yep-anywhere/server test -- test/service/verify-deploy.test.ts test/service/windows-production-reliability.test.ts test/service/windows-service-scripts.test.ts test/service/bundle-output.test.ts test/service/yep-entry.test.ts
```

Expected: all tests PASS. Update docs to state that full Windows rebuild refuses active/queued work, keeps the previous bundle until verification, stores failed new bundles as `npm-package-failed-*`, and preserves all evidence if rollback verification fails.

- [ ] **Step 10: Commit Task 4**

```powershell
git add scripts/deploy.ps1 scripts/verify-deploy.mjs packages/server/test/service/verify-deploy.test.ts packages/server/test/service/windows-production-reliability.test.ts packages/server/test/service/windows-service-scripts.test.ts docs/DEPLOYMENT_MODES.md CLAUDE.md
git commit -m "fix: roll back failed production deployments"
```

---

### Task 5: Verify P1, deploy once, and perform Windows recovery acceptance

**Files:**
- No planned source changes.
- Read: `docs/superpowers/specs/2026-08-17-remote-session-reliability-design.md:243-324,360-369,384-403`.
- Runtime state only after explicit authorization: Task Scheduler `YepAnywhereServer`, `dist/npm-package*`, and `~/.yep-anywhere/logs/prod-process.json`.

**Interfaces:**
- Consumes: four reviewed P1 commits, the completed P0 release, five-state status, v2 manifest, Task Scheduler restart-on-failure and transactional deploy.
- Produces: fresh automated evidence, production build identity, zero-interruption adoption evidence, controlled-stop evidence, loopback-only maintenance evidence and isolated rollback-failure evidence.

- [ ] **Step 1: Run P1-focused and existing service tests**

```powershell
pnpm --filter @yep-anywhere/server test -- test/service/windows-production-reliability.test.ts test/service/windows-service-scripts.test.ts test/service/verify-deploy.test.ts test/service/yep-entry.test.ts test/service/bundle-output.test.ts test/maintenance/server.test.ts
pnpm --filter @yep-anywhere/server test
```

Expected: both commands exit 0; Windows tests actually run on this Windows host rather than being skipped.

- [ ] **Step 2: Re-run the P0 critical regressions before P1 deployment**

Use the exact P0 test files rather than assuming P1 PowerShell changes cannot affect packaging:

```powershell
pnpm --filter @yep-anywhere/server test -- test/sessions/browser-session-projection.test.ts test/api/sessions.test.ts test/frontend/static.test.ts test/routes/ws.test.ts test/e2e/ws-transport.e2e.test.ts
pnpm --filter @yep-anywhere/client test -- src/api/client.test.ts src/hooks/__tests__/useSessionMessages.reliability.test.tsx src/pages/__tests__/SessionPage.reliability.test.tsx src/lib/__tests__/buildRecovery.test.ts src/components/__tests__/ErrorBoundary.test.tsx
pnpm lint
pnpm --filter shared build
pnpm typecheck
```

Expected: every command exits 0. If a named P0 file does not yet exist, P0 is not complete: stop P1 and return to the P0 plan rather than deleting the command.

- [ ] **Step 3: Parse all changed PowerShell and inspect scope**

```powershell
$parseErrors = @()
foreach ($scriptPath in @('scripts/production-runtime.ps1', 'scripts/run-yepanywhere.ps1', 'scripts/yep.ps1', 'scripts/deploy.ps1')) {
  $errors = $null
  [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $scriptPath), [ref]$null, [ref]$errors) | Out-Null
  $parseErrors += @($errors)
}
if ($parseErrors.Count -gt 0) { $parseErrors | Format-List; exit 1 }
git status --short
git diff HEAD~4 --stat
git diff HEAD~4 --name-only
```

Expected: parser exits 0; the four commits touch only files listed in this plan; no Session/UI/FRP source changed.

- [ ] **Step 4: Obtain explicit deployment authorization and capture the baseline**

Before any runtime mutation, ask the user to authorize production rebuild and supervisor fault acceptance. After approval:

```powershell
pnpm yep status
Get-ScheduledTask -TaskName YepAnywhereServer | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName YepAnywhereServer | Select-Object LastRunTime, LastTaskResult
Get-Content -LiteralPath "$env:USERPROFILE\.yep-anywhere\logs\prod-process.json" -Raw -ErrorAction SilentlyContinue
Invoke-RestMethod http://127.0.0.1:8022/api/status/workers
```

Record current commit, build ID, task/autostart state, PIDs, active work and all relevant `dist/npm-package*` directories. Before starting the rebuild, leave one phone tab open on the incident Session so the subsequent P1 deployment exercises P0's stale-build recovery. If active work or queue is present, wait for it to finish; do not bypass the guard.

- [ ] **Step 5: Deploy through the supported transactional path**

```powershell
pnpm yep rebuild
pnpm yep status
$version = Invoke-RestMethod http://127.0.0.1:8022/api/version
$maintenance = Invoke-RestMethod http://127.0.0.1:8023/health
$manifest = Get-Content -LiteralPath "$env:USERPROFILE\.yep-anywhere\logs\prod-process.json" -Raw | ConvertFrom-Json
[pscustomobject]@{
  RuntimeBuildId = $version.build.buildId
  ManifestVersion = $manifest.Version
  ManifestBuildId = $manifest.BuildId
  SupervisorInstanceId = $manifest.SupervisorInstanceId
  MaintenanceStatus = $maintenance.status
}
```

Expected: rebuild exits 0; status is `healthy`; task is Running; manifest version is 2; runtime and manifest build IDs match the just-built bundle; 8022 and 8023 are owned by the manifest server process.

- [ ] **Step 6: Re-smoke the original phone/session path after the P1 deployment**

Using the existing 4G/public URL and the tab left open before rebuild:

1. Return to the incident Session and confirm the stale build performs at most one automatic refresh while preserving pathname, query and hash.
2. Confirm the Session loads without the long skeleton stall, React #300 or module-script failure.
3. Wait until no AI turn is active, send `P1 deployment regression acceptance`, and confirm server logs contain the corresponding `session_resume_requested` or `session_queue_requested`, an accepted event and a completed provider turn.
4. Keep the page connected for at least two minutes. If it disconnects, record P0's `connectionId`, `durationMs`, `closeCode` and `closeReason`; do not alter heartbeat or FRP as part of P1.

Expected: all four checks pass. A failure here blocks P1 release even when the PowerShell lifecycle tests pass, because the P1 bundle switch must not regress P0.

- [ ] **Step 7: Prove 8023 is loopback-only and not in FRP**

```powershell
Get-NetTCPConnection -LocalPort 8023 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess
```

Expected: `LocalAddress=127.0.0.1`. From the existing phone/public URL, requesting port 8023 must fail; do not add or alter an FRP mapping to make the test pass.

- [ ] **Step 8: Prove Task Scheduler relaunches and adopts after an unexpected supervisor exit**

First confirm `/api/status/workers` reports no active work or queue. Capture the v2 manifest, then kill only the verified supervisor PID—not the task and not any child:

```powershell
$before = Get-Content -LiteralPath "$env:USERPROFILE\.yep-anywhere\logs\prod-process.json" -Raw | ConvertFrom-Json
$samples = [Collections.Generic.List[object]]::new()
Stop-Process -Id ([int]$before.Supervisor.Pid) -Force
for ($second = 0; $second -lt 90; $second++) {
  try {
    $sample = Invoke-RestMethod http://127.0.0.1:8022/api/version -TimeoutSec 1
    $samples.Add([pscustomobject]@{ Second = $second; Ok = $true; BuildId = $sample.build.buildId })
  } catch {
    $samples.Add([pscustomobject]@{ Second = $second; Ok = $false; BuildId = $null })
  }
  Start-Sleep -Seconds 1
}
$after = Get-Content -LiteralPath "$env:USERPROFILE\.yep-anywhere\logs\prod-process.json" -Raw | ConvertFrom-Json
[pscustomobject]@{
  FailedSamples = @($samples | Where-Object { -not $_.Ok }).Count
  OldSupervisor = $before.Supervisor.Pid
  NewSupervisor = $after.Supervisor.Pid
  InstanceChanged = $before.SupervisorInstanceId -ne $after.SupervisorInstanceId
  ServerPidPreserved = (@($before.Processes | Where-Object Role -eq 'server')[0].Pid -eq @($after.Processes | Where-Object Role -eq 'server')[0].Pid)
}
```

Expected within the configured one-minute interval: new supervisor PID/instance ID, identical server PID, `FailedSamples=0`, and final `pnpm yep status` is `healthy`. This proves Task Scheduler relaunch plus adoption, not merely manual supervisor startup.

- [ ] **Step 9: Prove controlled stop does not self-relaunch, then restore production**

```powershell
pnpm yep stop-prod
Start-Sleep -Seconds 70
pnpm yep status
Get-ScheduledTask -TaskName YepAnywhereServer | Select-Object State
Get-NetTCPConnection -LocalPort 8022,8023 -State Listen -ErrorAction SilentlyContinue
pnpm yep start-prod
pnpm yep status
```

Expected after 70 seconds: state `stopped`, task Ready, no 8022/8023 listener, and no surprise restart. Final start returns to `healthy`. Do not describe `0xC000013A` alone as proof of a spontaneous crash; report it only as the Task Scheduler result.

- [ ] **Step 10: Run isolated end-to-end rollback failure injection**

Run the PowerShell transaction harness from `windows-production-reliability.test.ts` with real temporary directories and mock start/verify commands, not the live `dist/npm-package`. Force each of the three rollback triggers independently: new start failure, build ID mismatch and maintenance smoke failure.

```powershell
pnpm --filter @yep-anywhere/server test -- test/service/windows-production-reliability.test.ts -t "restores the previous bundle"
```

Expected: each case restores the old build, verifies it, preserves the failed new directory and never touches the real production directory or user data. A live production rollback failure injection is intentionally excluded because it would add risk without increasing coverage beyond the same real PowerShell transaction functions.

- [ ] **Step 11: Final production and evidence check**

```powershell
pnpm yep status
Invoke-RestMethod http://127.0.0.1:8022/api/version
Invoke-RestMethod http://127.0.0.1:8023/health
git status --short
```

Expected: production `healthy`, matching build IDs, maintenance `status=ok`, expected bridge modes/PIDs, no active rollback directory from the successful deploy, and clean working tree.

- [ ] **Step 12: Report P1 separately from P0**

Report exact commands and outcomes for:

- focused/full test counts and PowerShell parser result;
- production commit and build ID;
- old/new supervisor instance IDs and preserved server PID;
- 90-second availability sample count;
- controlled stop after 70 seconds;
- phone stale-build refresh, resume/queue event and two-minute connection result;
- 8023 loopback address and failed public access;
- rollback failure-injection cases and preserved-directory assertions;
- any blocked acceptance item with its exact evidence.

P1 is complete only when Steps 1–11 pass and Step 12 records the evidence. Do not use P1 completion to retroactively claim the original mobile problem fixed; that conclusion remains owned by the P0 phone/session acceptance.
