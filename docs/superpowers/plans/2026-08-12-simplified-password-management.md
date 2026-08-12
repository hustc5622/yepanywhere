# Yep Anywhere 轻量密码管理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为个人及少量朋友共享场景实现一套轻量密码管理：一条本机命令管理全局管理员密码，服务器本机页面管理各 Profile 的普通登录密码，远程设备只能使用普通密码登录。

**Architecture:** 当前系统用户的管理员哈希独立存放在 `~/.yep-anywhere/admin.json`，所有开发、生产和自定义 Profile 按需共用；各 Profile 的 `auth.json` v2 只保存普通密码、`localhostOpen` 和 sessions。后端用真实 socket 对端地址与请求 URL 主机共同限制管理员操作为回环访问，React 端复用现有“设置 → 本地访问”认证区域，不新增页面或导航。

**Tech Stack:** Node.js 20+、TypeScript、Hono 4、`@hono/node-server/conninfo`、bcrypt 6、Vitest 2、React 19、Testing Library、PowerShell 5.1、bash、pnpm 9.15.1。

## Global Constraints

- 行为唯一来源是 `docs/superpowers/specs/2026-08-10-service-process-and-password-management-design.md`，设计提交为 `fec5ccc9`。
- 开始实现前必须使用 `superpowers:using-git-worktrees` 创建或确认隔离 worktree；不得直接在 `main` 上修改第二阶段业务代码。
- 只执行本计划第二阶段任务 1～3；第一阶段已经完成，不重写服务生命周期、端口、Profile、自启动或暂存 Bundle 流程。
- 每项行为改动严格使用 `superpowers:test-driven-development`：先运行新增用例确认按预期失败，再写最小实现，再运行确认通过。
- 普通密码与管理员密码都至少 6 个字符，分别使用 bcrypt 成本参数 12；不增加强度计、字符组合规则、限流、锁定、验证码、多用户或角色。
- 管理员密码不得进入命令行参数、环境变量、URL、日志、响应、浏览器持久化状态或项目配置；前端每次请求结束后清空敏感 state。
- 管理员操作只接受真实回环连接和回环 URL 主机；不信任转发头，不为 HTTPS、Tailscale、反向代理或桌面通道增加例外。
- `admin.json` 固定为当前系统用户的 `~/.yep-anywhere/admin.json`，不受 `YEP_ANYWHERE_PROFILE` 或 `YEP_ANYWHERE_DATA_DIR` 影响。
- v2 `auth.json` 只有关闭/启用两态；关闭时删除 `account`，重新启用必须设置新普通密码。
- 缺失文件表示未配置；JSON 损坏、版本不支持、字段无效或写入失败统一安全失败，不得覆盖旧文件或静默关闭认证。
- 只修改本计划列出的认证、命令转发、现有认证 UI、相关测试和认证文档；不整理、格式化或重构相邻代码。
- 未经用户另行批准不得提交、推送或合并。每个任务结束时保留可审阅 diff，并记录测试结果。
- 用户已经批准在第二阶段代码评审和验证通过后执行一次 `pnpm yep rebuild` 更新生产模式；不得启动额外开发服务、修改自启动或执行重启/登录验收。

## File Structure

### 新增后端单元

- `packages/server/src/auth/authErrors.ts`：六个稳定错误码和 `AuthError`，不包含 HTTP 或 UI 逻辑。
- `packages/server/src/auth/privateJsonFile.ts`：仅供认证文件使用的同目录临时写入、`0600` 权限和原子替换。
- `packages/server/src/auth/AdminPasswordService.ts`：全局 `admin.json` 路径、解析、设置/重置和按需验证。
- `packages/server/src/auth/localManagement.ts`：回环地址、URL 主机及组合判定纯函数。
- `packages/server/src/cli-password-prompt.ts`：TTY 隐藏输入与确认；通过接口注入供测试使用。

### 修改现有单元

- `packages/server/src/auth/AuthService.ts`：v1→v2 迁移、两态普通密码和当前 Profile 会话失效。
- `packages/server/src/auth/routes.ts`：状态、登录、管理员验证、三种普通密码操作和 Cookie 语义。
- `packages/server/src/cli-setup.ts`、`packages/server/src/cli.ts`：唯一 `--setup-admin-password` 内部命令，删除旧旁路。
- `scripts/yep.ps1`、`yep.sh`：把公开的 `setup-admin-password` 子命令转发到同一个源码 Node CLI。
- `packages/client/src/api/client.ts`、`packages/client/src/contexts/AuthContext.tsx`：精简状态和新请求体。
- `packages/client/src/pages/LoginPage.tsx`：本机管理员登录恢复提示和安全错误文案。
- `packages/client/src/pages/settings/LocalAccessAuthCard.tsx`：独立密码卡片的敏感 state 与三种提交；由现有 `LocalAccessSettings.tsx` 渲染。

---

## 执行前关卡：隔离、审阅和基线

- [ ] **Step 1: Read the controlling artifacts and create the three-task todo**

Read in full:

```text
CLAUDE.md
docs/superpowers/specs/2026-08-10-service-process-and-password-management-design.md
docs/superpowers/plans/2026-08-12-simplified-password-management.md
the temporary handoff document supplied by the user
```

Invoke `superpowers:using-superpowers`, `superpowers:executing-plans`, `superpowers:using-git-worktrees` and `superpowers:test-driven-development`. Create a todo containing exactly second-stage tasks 1～3 plus final verification/review/rebuild. Do not carry the superseded second-stage checklist from the 2026-08-10 historical plan into the todo.

- [ ] **Step 2: Create or verify an isolated worktree**

Use `superpowers:using-git-worktrees`. Record these commands and outputs:

```powershell
git worktree list --porcelain
git status --short --branch
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
```

Expected: the implementation worktree is not the primary `main` worktree, its branch uses the repository's `codex/` prefix, and it starts from commit `fec5ccc9` or a later user-approved documentation commit containing this plan. If the tree contains unrelated changes, stop and report them rather than cleaning or absorbing them.

- [ ] **Step 3: Record a fresh non-invasive baseline before changing code**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/auth/AuthService.test.ts test/auth/AuthRoutes.test.ts
pnpm --filter @yep-anywhere/server test -- test/service/yep-entry.test.ts test/service/windows-service-scripts.test.ts test/service/macos-service-scripts.test.ts
pnpm --filter @yep-anywhere/client test -- src/api/client.test.ts
pnpm lint
pnpm typecheck
pnpm test
```

Record every exit code, passed/failed file count and failing test name. Do not fix baseline failures outside this plan. Do not start a server, browser or production rebuild during the baseline.

---

## 第二阶段任务 1：认证状态 v2、全局管理员存储和唯一管理命令

**Files:**

- Create: `packages/server/src/auth/authErrors.ts`
- Create: `packages/server/src/auth/privateJsonFile.ts`
- Create: `packages/server/src/auth/AdminPasswordService.ts`
- Create: `packages/server/src/cli-password-prompt.ts`
- Create: `packages/server/test/auth/privateJsonFile.test.ts`
- Create: `packages/server/test/auth/AdminPasswordService.test.ts`
- Create: `packages/server/test/auth/CliAdminPassword.test.ts`
- Modify: `packages/server/src/auth/AuthService.ts`
- Modify: `packages/server/src/auth/index.ts`
- Modify: `packages/server/src/auth/routes.ts` (only remove the runtime bypass in task 1; task 2 owns the API rewrite)
- Modify: `packages/server/src/cli-setup.ts`
- Modify: `packages/server/src/cli.ts`
- Modify: `packages/server/src/config.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/middleware/auth.ts`
- Modify: `packages/server/src/sdk/providers/env-filter.ts`
- Modify: `packages/server/package.json`
- Modify: `packages/server/test/auth/AuthService.test.ts`
- Modify: `packages/server/test/service/windows-service-scripts.test.ts`
- Modify: `packages/server/test/service/macos-service-scripts.test.ts`
- Modify: `packages/client/e2e/global-setup.ts`
- Modify: `scripts/smoke-terminal.mjs`
- Modify: `scripts/yep.ps1`
- Modify: `yep.sh`

**Interfaces:**

- Produces `AUTH_ERROR_CODES`, `AuthErrorCode` and `AuthError` for tasks 1～3.
- Produces `writePrivateJsonAtomic(filePath: string, value: unknown): Promise<void>` for both credential services.
- Produces `AdminPasswordService` for CLI and routes.
- Produces v2 `AuthService` transitions for task 2.
- Produces public command `pnpm yep setup-admin-password`.

- [ ] **Step 1: Write failing tests for the global administrator file**

In `privateJsonFile.test.ts`, write a real temporary target, replace it through `writePrivateJsonAtomic`, and assert valid JSON plus POSIX `0600` mode. Use Vitest's module mock for `node:fs/promises.rename` to force a rename error after an old target exists; assert the old bytes are unchanged and no task-owned temp file remains.

Add exact behavioral tests in `AdminPasswordService.test.ts` using a temporary injected path:

```ts
const service = new AdminPasswordService({ filePath });

await expect(service.isConfigured()).resolves.toBe(false);
await service.setPassword("admin-password");
await expect(service.isConfigured()).resolves.toBe(true);
await expect(service.verifyPassword("admin-password")).resolves.toBe(true);
await expect(service.verifyPassword("wrong-password")).resolves.toBe(false);

const stored = JSON.parse(await fs.readFile(filePath, "utf8"));
expect(stored).toEqual({ version: 1, passwordHash: expect.any(String) });
expect(stored.passwordHash).not.toContain("admin-password");
expect(await bcrypt.getRounds(stored.passwordHash)).toBe(12);
```

Also cover:

- `AdminPasswordService.getDefaultFilePath()` equals `path.join(os.homedir(), ".yep-anywhere", "admin.json")` regardless of Profile environment variables.
- `setPassword` rejects strings shorter than 6 characters with `AUTH_PASSWORD_INVALID`.
- a missing file means “not configured”, while malformed JSON, unsupported version and missing hash throw `AUTH_CONFIG_ERROR`.
- resetting replaces the hash and immediately invalidates the old administrator password without touching any Profile directory.
- a `writePrivateJsonAtomic` rejection is surfaced as `AUTH_CONFIG_ERROR` and never leaks the password.

- [ ] **Step 2: Run the new administrator tests and confirm RED**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/auth/privateJsonFile.test.ts test/auth/AdminPasswordService.test.ts
```

Expected: FAIL because `AdminPasswordService`, `AuthError` and atomic private JSON writing do not exist.

- [ ] **Step 3: Implement the minimal shared errors and private JSON writer**

Create `authErrors.ts` with this public contract:

```ts
export const AUTH_ERROR_CODES = {
  adminNotConfigured: "AUTH_ADMIN_NOT_CONFIGURED",
  adminInvalid: "AUTH_ADMIN_INVALID",
  loginInvalid: "AUTH_LOGIN_INVALID",
  localRequired: "AUTH_LOCAL_REQUIRED",
  passwordInvalid: "AUTH_PASSWORD_INVALID",
  configError: "AUTH_CONFIG_ERROR",
} as const;

export type AuthErrorCode =
  (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
```

Create `privateJsonFile.ts` with only the shared authentication write primitive:

```ts
export async function writePrivateJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void>;
```

The implementation must create a random temporary file in `path.dirname(filePath)`, open it with mode `0o600`, write `JSON.stringify(value, null, 2)`, sync and close it, enforce existing owner-only permissions, then rename it over the target. On every failure, close/unlink only its own temp file and leave the old target untouched. Do not change `filePermissions.ts` behavior for VAPID or sharing files.

- [ ] **Step 4: Implement `AdminPasswordService` and turn its tests GREEN**

Use this exact interface:

```ts
export interface AdminPasswordServiceOptions {
  filePath?: string;
}

export class AdminPasswordService {
  static getDefaultFilePath(): string;
  constructor(options?: AdminPasswordServiceOptions);
  getFilePath(): string;
  isConfigured(): Promise<boolean>;
  verifyPassword(password: string): Promise<boolean>;
  setPassword(newPassword: string): Promise<void>;
}
```

Every `isConfigured`/`verifyPassword` call must read and validate the file again; do not cache the hash. Missing file returns `false`. All other read/parse/schema failures become `AuthError(AUTH_CONFIG_ERROR)` without logging file contents.

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/auth/privateJsonFile.test.ts test/auth/AdminPasswordService.test.ts
```

Expected: PASS.

- [ ] **Step 5: Extend `AuthService.test.ts` with v2 migration and two-state RED tests**

Add fixtures and assertions for these exact transitions:

```ts
expect(service.isEnabled()).toBe(false);
await service.setLoginPassword("login-password");
expect(service.isEnabled()).toBe(true);
await service.disableAuth();
expect(service.isEnabled()).toBe(false);
await expect(service.verifyPassword("login-password")).resolves.toBe(false);
```

Cover all of the following:

- a missing file starts as `{ version: 2, sessions: {} }` in memory.
- v1 `{ enabled: true, account, localhostOpen, sessions }` preserves all four meaningful values and atomically writes v2 without `enabled`.
- v1 with `enabled` absent/false drops `account`, preserves `localhostOpen`, clears sessions and writes v2.
- valid v2 loads without rewriting; malformed JSON, unknown version, invalid account or invalid sessions throws `AUTH_CONFIG_ERROR` and preserves the source file.
- `setLoginPassword` creates/replaces `account` and clears every session.
- `disableAuth` deletes `account` and clears every session.
- wrong passwords can fail repeatedly without creating lock or rate-limit state.

- [ ] **Step 6: Run `AuthService` tests and confirm RED**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/auth/AuthService.test.ts
```

Expected: FAIL on v2 schema, migration safety and `setLoginPassword`.

- [ ] **Step 7: Implement the minimal v2 `AuthService`**

Use this state and public transition surface:

```ts
export interface AuthState {
  version: 2;
  localhostOpen?: boolean;
  account?: {
    passwordHash: string;
    createdAt: string;
  };
  sessions: Record<string, AuthSession>;
}

isEnabled(): boolean; // exactly equivalent to hasAccount()
setLoginPassword(newPassword: string): Promise<void>;
disableAuth(): Promise<void>;
verifyPassword(password: string): Promise<boolean>;
```

Remove `createAccount` and the independent `enabled` state. Both mutations validate the 6-character minimum in the service, construct the full target state without changing `this.state`, persist it once through `writePrivateJsonAtomic`, and only then assign it to `this.state`; a failed write must leave both disk and memory on the previous state. Preserve the existing in-process save serialization for session activity, but do not add a cross-process lock.

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/auth/AuthService.test.ts test/auth/privateJsonFile.test.ts test/auth/AdminPasswordService.test.ts
```

Expected: PASS.

- [ ] **Step 8: Write CLI and cross-platform dispatch RED tests**

In `CliAdminPassword.test.ts`, inject a fake prompt and temporary `AdminPasswordService`:

```ts
const prompt: PasswordPrompt = {
  readHidden: vi
    .fn()
    .mockResolvedValueOnce("admin-password")
    .mockResolvedValueOnce("admin-password"),
};

await setupAdminPassword({ prompt, adminPasswordService });
await expect(adminPasswordService.verifyPassword("admin-password"))
  .resolves.toBe(true);
```

Assert non-TTY, mismatch and short password exit nonzero; no captured output contains either input; `--setup-admin-password secret` is rejected as an unknown extra argument; successful setup does not import/start `index.ts`.

Extend both service script tests so `help` lists `setup-admin-password`, and a fake `pnpm` executable confirms that the public command invokes exactly:

```text
pnpm --filter @yep-anywhere/server exec tsx --conditions source src/cli.ts --setup-admin-password
```

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/auth/CliAdminPassword.test.ts test/service/windows-service-scripts.test.ts test/service/macos-service-scripts.test.ts
```

Expected: FAIL because the prompt, CLI flag and script branches do not exist.

- [ ] **Step 9: Implement the one-command flow and remove authentication bypasses**

Define the injectable prompt boundary:

```ts
export interface PasswordPrompt {
  readHidden(label: string): Promise<string>;
}

export interface SetupAdminPasswordOptions {
  prompt: PasswordPrompt;
  adminPasswordService?: AdminPasswordService;
}

export async function setupAdminPassword(
  options: SetupAdminPasswordOptions,
): Promise<void>;
```

The production prompt must require `process.stdin.isTTY && process.stdout.isTTY`, suppress echo on Windows and POSIX, restore terminal mode in `finally`, and never include entered text in thrown errors.

Make `cli.ts --setup-admin-password` the only setup option and exit immediately after it finishes. `scripts/yep.ps1` and `yep.sh` must resolve the repository root, forward the public subcommand to the exact `pnpm` invocation tested above, and return its exit code.

Delete the old paths completely:

- `--setup-auth` parsing/help and `setupAuth`.
- `--auth-disable`, `AUTH_DISABLED`, `Config.authDisabled`, `AppOptions.authDisabled` and route/middleware bypass branches.
- the `AUTH_DISABLED=true` prefix in `dev:mock` and client E2E setup.
- the stale env filter entry and smoke-test comment.

Do not alter desktop token or `localhostOpen` behavior.

- [ ] **Step 10: Run task 1 verification and inspect the diff**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/auth/AuthService.test.ts test/auth/privateJsonFile.test.ts test/auth/AdminPasswordService.test.ts test/auth/CliAdminPassword.test.ts test/auth/AuthRoutes.test.ts test/service/windows-service-scripts.test.ts test/service/macos-service-scripts.test.ts
rg -n -- '--setup-auth|--auth-disable|AUTH_DISABLED|authDisabled' packages/server packages/client/e2e scripts package.json yep.sh
git diff --check
git status --short
```

Expected: all focused tests pass; `rg` returns no matches (exit 1 means none); diff contains only task 1 files. Do not commit without user approval.

---

## 第二阶段任务 2：本机管理员验证和稳定认证 API

**Files:**

- Create: `packages/server/src/auth/localManagement.ts`
- Create: `packages/server/test/auth/localManagement.test.ts`
- Modify: `packages/server/src/auth/routes.ts`
- Modify: `packages/server/src/auth/index.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/middleware/auth.ts`
- Modify: `packages/server/test/auth/AuthRoutes.test.ts`
- Create: `packages/server/test/auth/AuthMiddleware.test.ts`

**Interfaces:**

- Consumes `AdminPasswordService`, `AuthService` and `AuthError` from task 1.
- Produces `isLocalManagementRequest(url: URL, remoteAddress?: string): boolean`.
- Produces status shape and route behavior consumed by task 3.

- [ ] **Step 1: Write pure local-management RED tests**

Create a table test in `localManagement.test.ts`:

```ts
it.each([
  ["http://localhost:8022/api/auth/status", "127.0.0.1", true],
  ["http://127.0.0.1:8022/api/auth/status", "::ffff:127.0.0.1", true],
  ["http://[::1]:8022/api/auth/status", "::1", true],
  ["https://example.test/api/auth/status", "127.0.0.1", false],
  ["http://192.168.1.10:8022/api/auth/status", "127.0.0.1", false],
  ["http://localhost:8022/api/auth/status", "192.168.1.20", false],
])("classifies %s from %s", (rawUrl, address, expected) => {
  expect(isLocalManagementRequest(new URL(rawUrl), address)).toBe(expected);
});
```

Also assert that `X-Forwarded-For`/`X-Forwarded-Proto` are not inputs to this function.

- [ ] **Step 2: Run local-management tests and confirm RED**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/auth/localManagement.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal pure classifier**

Export only:

```ts
export function isLoopbackAddress(address?: string): boolean;
export function isLoopbackHostname(hostname: string): boolean;
export function isLocalManagementRequest(
  url: URL,
  remoteAddress?: string,
): boolean;
```

Accepted addresses are exactly `127.0.0.1`, `::1` and `::ffff:127.0.0.1`; accepted normalized hostnames are exactly `localhost`, `127.0.0.1` and `[::1]`/`::1`. Do not broaden to the whole `127.0.0.0/8` range.

- [ ] **Step 4: Replace route tests with the approved API contract and confirm RED**

Construct routes with injected test address reading:

```ts
routes = createAuthRoutes({
  authService,
  adminPasswordService,
  getRemoteAddress: () => remoteAddress,
});
```

Cover:

- `GET /status` returns exactly `enabled`, `authenticated`, `hasDesktopToken`, `localhostOpen` and `localManagementAllowed`; no hash, admin-configured flag, file path, setup mode or env-bypass field.
- remote login verifies only the ordinary password.
- local login first verifies the ordinary password, then the administrator password; both success paths create sessions with the same stored shape.
- a missing global admin file does not change local login failure from `AUTH_LOGIN_INVALID`.
- `/enable`, `/change-password` and `/disable` reject remote requests with `AUTH_LOCAL_REQUIRED`, even over HTTPS or with forged forwarding headers.
- the three mutations reject missing admin config, wrong admin password and invalid new password with the approved codes.
- enable/change set the new ordinary password; disable removes it; all three clear every session and delete the current Cookie.
- existing Cookie authentication never replaces per-operation administrator verification.
- `POST /setup` returns 404.
- neither errors nor response snapshots contain supplied passwords or hashes.

In `AuthMiddleware.test.ts`, assert `/api/auth/status`, `/api/auth/login`, `/api/auth/enable`, `/api/auth/change-password`, `/api/auth/disable` and `/api/auth/logout` always reach their route handlers even when ordinary auth is off and a desktop token floor exists. Assert a representative non-auth route remains blocked without the desktop token/session unless `localhostOpen` is enabled.

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/auth/AuthRoutes.test.ts
```

Expected: FAIL against the old routes and response shape.

- [ ] **Step 5: Implement route dependencies, status and login behavior**

Use this dependency contract:

```ts
export interface AuthRoutesDeps {
  authService: AuthService;
  adminPasswordService: AdminPasswordService;
  desktopAuthToken?: string;
  getRemoteAddress?: (context: Context) => string | undefined;
}
```

The production default calls `getConnInfo(context).remote.address`; tests inject a fixed address. Determine local access once per request from `new URL(c.req.url)` and the real address. Do not read forwarding headers.

For login, only attempt administrator verification after an ordinary-password failure and only for a local request. A missing `admin.json` is treated as no fallback; a malformed `admin.json` returns `AUTH_CONFIG_ERROR`.

- [ ] **Step 6: Implement the three administrator-confirmed mutations and error mapping**

Accept these JSON bodies:

```ts
type EnableBody = { adminPassword: string; newPassword: string };
type ChangePasswordBody = { adminPassword: string; newPassword: string };
type DisableBody = { adminPassword: string };
type LoginBody = { password: string };
```

Map the six `AuthError` codes to the exact HTTP statuses in the design. Both `/enable` and `/change-password` call `authService.setLoginPassword(newPassword)` after local/admin checks; they differ only in UI intent. `/disable` calls `authService.disableAuth()`. Successful mutations delete `SESSION_COOKIE_NAME`; retain the existing secure-cookie calculation for login.

```ts
const AUTH_HTTP_STATUS = {
  AUTH_ADMIN_NOT_CONFIGURED: 409,
  AUTH_ADMIN_INVALID: 401,
  AUTH_LOGIN_INVALID: 401,
  AUTH_LOCAL_REQUIRED: 403,
  AUTH_PASSWORD_INVALID: 400,
  AUTH_CONFIG_ERROR: 500,
} as const;
```

Instantiate one `AdminPasswordService` in `index.ts` and pass it through `createApp`; remove all obsolete setup-required and bypass branches from middleware and app wiring. Move the `/api/auth/*` skip before the desktop-token-floor branch so all auth endpoints reach their route-local authorization, while retaining the current desktop token, session and `localhostOpen` behavior for every non-auth API.

- [ ] **Step 7: Run task 2 focused and combined backend verification**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/auth/localManagement.test.ts test/auth/AuthRoutes.test.ts test/auth/AuthMiddleware.test.ts
pnpm --filter @yep-anywhere/server test -- test/auth/AuthService.test.ts test/auth/privateJsonFile.test.ts test/auth/AdminPasswordService.test.ts test/auth/CliAdminPassword.test.ts test/auth/localManagement.test.ts test/auth/AuthRoutes.test.ts test/auth/AuthMiddleware.test.ts
git diff --check
git status --short
```

Expected: all task 1～2 authentication tests pass; no unrelated file changes. Do not commit without user approval.

---

## 第二阶段任务 3：现有设置页密码管理、文档和整体验收

**Files:**

- Modify: `packages/client/src/api/client.ts`
- Modify: `packages/client/src/api/client.test.ts`
- Modify: `packages/client/src/contexts/AuthContext.tsx`
- Create: `packages/client/src/contexts/__tests__/AuthContext.test.tsx`
- Modify: `packages/client/src/lib/connection/DirectConnection.ts`
- Modify: `packages/client/src/lib/connection/WireProtocol.ts`
- Modify: `packages/client/src/pages/LoginPage.tsx`
- Create: `packages/client/src/pages/__tests__/LoginPage.test.tsx`
- Create: `packages/client/src/pages/settings/LocalAccessAuthCard.tsx`
- Modify: `packages/client/src/pages/settings/LocalAccessSettings.tsx`
- Create: `packages/client/src/pages/settings/__tests__/LocalAccessAuth.test.tsx`
- Modify: `packages/client/src/i18n/en.json`
- Modify: `packages/client/src/i18n/zh-CN.json`
- Modify: `packages/client/src/i18n/es.json`
- Modify: `packages/client/src/i18n/fr.json`
- Modify: `packages/client/src/i18n/de.json`
- Modify: `packages/client/src/i18n/ja.json`
- Modify: `README.md` (authentication paragraph only)
- Modify: `CLAUDE.md` (authentication/recovery instructions only)
- Modify: `docs/project/remote-access.md` (password management and proxy boundary only)
- Modify: `docs/project/ws-auth-state-model.md` (remove runtime bypass state only)

**Interfaces:**

- Consumes the task 2 status shape and JSON bodies.
- Produces `AuthContextValue.localManagementAllowed` and three admin-confirmed client methods.
- Reuses the existing `/settings/local-access` route and styles; creates no new category.

- [ ] **Step 1: Write API client and `AuthContext` RED tests**

Update `AuthStatus` to the exact shape:

```ts
export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
  hasDesktopToken: boolean;
  localhostOpen: boolean;
  localManagementAllowed: boolean;
}
```

Tests must assert these request bodies and no other password fields:

```ts
api.enableAuth("admin-password", "login-password");
// POST /auth/enable { adminPassword, newPassword }

api.changePassword("admin-password", "next-password");
// POST /auth/change-password { adminPassword, newPassword }

api.disableAuth("admin-password");
// POST /auth/disable { adminPassword }
```

In `AuthContext.test.tsx`, assert status propagation, removal of `isSetupMode`/`authDisabledByEnv`/`authFilePath`/`setupAccount`, redirect to login after enable/change, and authenticated open state after disable. In `client.test.ts`, assert a 401 response no longer reads or attaches `X-Setup-Required`/`ApiError.setupRequired`.

- [ ] **Step 2: Run client data-layer tests and confirm RED**

Run:

```powershell
pnpm --filter @yep-anywhere/client test -- src/api/client.test.ts src/contexts/__tests__/AuthContext.test.tsx
```

Expected: FAIL on the old status and method signatures.

- [ ] **Step 3: Implement the minimal API client and context changes**

Expose these context methods:

```ts
enableAuth(adminPassword: string, newPassword: string): Promise<void>;
changePassword(adminPassword: string, newPassword: string): Promise<void>;
disableAuth(adminPassword: string): Promise<void>;
```

Do not store either password in context state. After successful enable/change, set `authEnabled=true`, `isAuthenticated=false` and allow the existing redirect effect to open `/login`. After disable, set `authEnabled=false`, `isAuthenticated=true`. Keep `login`, `logout`, `localhostOpen`, desktop token and auth events intact.

Remove `setupRequired` from `ApiError`, `fetchJSON`, `DirectConnection` and `WireProtocol`, because task 2 no longer emits `X-Setup-Required` and `/setup` no longer exists. Do not change their unrelated connection/error behavior.

- [ ] **Step 4: Write login-page and local-access authentication-card RED tests**

`LoginPage.test.tsx` must prove:

- no setup/confirm-password mode remains.
- remote mode shows only the ordinary login text.
- local mode displays the administrator recovery hint.
- `AUTH_LOGIN_INVALID` maps to “登录密码错误” remotely and “登录密码或管理员密码错误” locally.
- the password input is cleared after every failed or successful request.

`LocalAccessAuth.test.tsx` must prove:

- no new settings category or route is created; the card renders inside existing `LocalAccessSettings`.
- remote mode displays status plus the local-only explanation and renders no administrator input.
- local disabled state renders enable fields; local enabled state renders separate change and disable controls.
- each form sends only its required fields and blocks mismatched confirmation locally.
- network binding/allowed-host/`localhostOpen` save requests never contain administrator or ordinary password fields.
- administrator and ordinary-password fields use `type="password"`, are disabled while submitting, and clear on resolve, reject, cancel and unmount.
- `AUTH_ADMIN_NOT_CONFIGURED` displays `pnpm yep setup-admin-password`; the remaining stable codes map to specific existing-language messages.

- [ ] **Step 5: Run UI tests and confirm RED**

Run:

```powershell
pnpm --filter @yep-anywhere/client test -- src/pages/__tests__/LoginPage.test.tsx src/pages/settings/__tests__/LocalAccessAuth.test.tsx
```

Expected: FAIL because the old combined form and setup mode are still present.

- [ ] **Step 6: Implement the existing-page UI with surgical edits**

In `LoginPage.tsx`, remove setup account state and confirmation UI. Use `localManagementAllowed` only to select the recovery hint and safe error text; the backend remains authoritative.

In `LocalAccessSettings.tsx`, keep the network form and its current save path intact, remove password fields from its change calculation and submit handler, and render `LocalAccessAuthCard` at the current authentication-card position. `LocalAccessAuthCard.tsx` owns only password status/presentation and the three administrator-confirmed mutations; it receives the existing auth context value, uses existing settings CSS classes, and creates no route, navigation category or stylesheet.

Use component-local strings for `adminPassword`, `newPassword`, `confirmPassword`, selected action, error and pending state. Clear all password state in a shared `finally` path and an unmount cleanup.

```ts
type PasswordAction = "enable" | "change" | "disable" | null;

function clearSensitiveFields(): void {
  setAdminPassword("");
  setNewPassword("");
  setConfirmPassword("");
}
```

- [ ] **Step 7: Update only existing authentication translations and active documentation**

Update the six existing locale JSON files using these same keys across languages; values must be natural translations of the listed English meaning:

```text
loginAdminRecoveryHint = Forgot the login password? On the server computer, use the administrator password to sign in and change it in Local Access settings.
loginErrorInvalidPasswordOrAdmin = Login or administrator password is incorrect.
localAccessPasswordManagementTitle = Password login
localAccessPasswordManagementLocalOnly = Password management is available only from localhost on the server computer.
localAccessAdminPasswordLabel = Administrator password
localAccessEnablePassword = Enable password login
localAccessChangePassword = Change login password
localAccessDisablePassword = Disable password login
authErrorAdminNotConfigured = Set the administrator password first with: pnpm yep setup-admin-password
authErrorAdminInvalid = Administrator password is incorrect.
authErrorLoginInvalid = Login password is incorrect.
authErrorLocalRequired = This operation is available only from localhost on the server computer.
authErrorPasswordInvalid = Passwords must contain at least 6 characters.
authErrorConfig = Authentication configuration could not be read or saved safely.
```

Remove text that recommends `--setup-auth` or `--auth-disable`. Reuse existing ordinary/new/confirm password labels where their meaning already matches. Do not add a settings-navigation label.

Update only relevant paragraphs in `README.md`, `CLAUDE.md`, `docs/project/remote-access.md` and `docs/project/ws-auth-state-model.md`:

- `pnpm yep setup-admin-password` is the only administrator setup/reset command.
- global administrator credentials apply to every Profile for the current system user.
- ordinary passwords are managed only from a loopback page in existing Local Access settings.
- remote users can only log in with the ordinary password.
- same-host reverse proxies must preserve the external Host and must not rewrite administrator requests as loopback.
- there is no runtime auth bypass.

Do not edit historical plans or archives merely to remove old terms.

- [ ] **Step 8: Run all focused second-stage verification**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/auth/AuthService.test.ts test/auth/privateJsonFile.test.ts test/auth/AdminPasswordService.test.ts test/auth/CliAdminPassword.test.ts test/auth/localManagement.test.ts test/auth/AuthRoutes.test.ts test/auth/AuthMiddleware.test.ts
pnpm --filter @yep-anywhere/server test -- test/service/yep-entry.test.ts test/service/windows-service-scripts.test.ts test/service/macos-service-scripts.test.ts
pnpm --filter @yep-anywhere/client test -- src/api/client.test.ts src/contexts/__tests__/AuthContext.test.tsx src/pages/__tests__/LoginPage.test.tsx src/pages/settings/__tests__/LocalAccessAuth.test.tsx
rg -n -- '--setup-auth|--auth-disable|AUTH_DISABLED|authDisabled' packages scripts README.md CLAUDE.md docs/project
rg -n -- 'setupRequired|X-Setup-Required|setupAccount|isSetupMode' packages/server/src packages/client/src
pnpm lint
pnpm typecheck
```

Expected: tests, lint and typecheck exit 0; both `rg` commands return no matches (exit 1 means none).

- [ ] **Step 9: Run full regression and classify any pre-existing failure**

Run:

```powershell
pnpm test
git diff --check
git status --short
```

Expected: full suite exits 0. If the isolated worktree baseline already failed before task 1, compare exact failing test names and counts against the recorded baseline; do not fix unrelated failures, and do not claim the full suite passed. Report both baseline and final evidence.

- [ ] **Step 10: Perform completion verification and final code review before deployment**

Invoke `superpowers:verification-before-completion`, then `superpowers:requesting-code-review`. Review every changed line against:

- the approved design and this plan;
- the “only listed files” scope;
- absence of plaintext passwords, bypasses, proxy trust and persistent administrator state;
- task 1～3 focused test evidence and full regression evidence.

Resolve all Critical and Important findings with TDD and rerun affected verification. Do not commit, push or merge without user approval.

- [ ] **Step 11: Rebuild and verify production mode using the approved service flow**

Only after step 10 has no unresolved Critical/Important findings, run the already-authorized production update:

```powershell
pnpm yep rebuild
pnpm yep status
```

Verify that rebuild completes lint, typecheck, staging Bundle build, `npm ci --omit=dev`, Bundle verification, safe swap, production restart and `buildId` comparison. Confirm status reports the expected production Profile/port and does not change autostart configuration.

Then perform non-destructive HTTP checks against the reported production loopback URL:

```powershell
Invoke-RestMethod http://127.0.0.1:8022/api/version
Invoke-RestMethod http://127.0.0.1:8022/api/auth/status
```

Do not set a real administrator password automatically and do not run UI password mutations with user credentials. Record those as remaining manual acceptance steps.

## Completion Report Requirements

The final report must include:

- isolated worktree path and branch;
- exact changed files and `git diff --stat`;
- commit status (expected: uncommitted unless the user later authorizes commits), push and merge status;
- RED/GREEN evidence for each task;
- focused, lint, typecheck, full-suite, code-review and production rebuild results;
- production `buildId`, service/Profile/port/autostart status;
- remaining manual checks: create/reset a real administrator password, local administrator fallback login, local enable/change/disable ordinary password, and remote rejection;
- explicit confirmation that no unrelated files or behavior were changed.

Stop after reporting and wait for the user's review. Do not push or merge automatically.
