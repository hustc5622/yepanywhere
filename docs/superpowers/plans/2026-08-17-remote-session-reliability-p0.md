# Remote Session Reliability P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以最小改动修复手机公网访问时的超大会话响应、加载失败后 React #300、AI 回复后无法续发、旧 chunk 无法恢复，并补足判定消息请求和 WebSocket 断线位置所需的日志。

**Architecture:** 在 Session HTTP 边界创建不修改原始 Session 的浏览器投影，只返回一份清理后的消息列表，并仅压缩 Session JSON。前端保留现有 `useSession`/`useSessionMessages`/`SessionPage` 结构，只补齐可重试加载状态、固定 Hook 顺序和发送就绪保护。静态资源恢复独立于 React 挂载；消息队列与 WebSocket 只增加结构化诊断，不预先改变 provider、心跳或 FRP 行为。

**Tech Stack:** TypeScript 5.7、Hono 4.12、React 19、Vite 6、Vitest 2、Testing Library、Pino、PowerShell 生产脚本。

**Design:** `docs/superpowers/specs/2026-08-17-remote-session-reliability-design.md`，本计划只执行其中的 P0 边界。

## Global Constraints

- P0 只包含设计文档的阶段 1–3、queue/resume 日志和 WebSocket 生命周期日志；不得修改 supervisor、维护端口、部署事务或 FRP 配置。
- 原始 Session JSONL、用户上传图片、普通 HTTP/HTTPS 图片、生成图片路径、`ViewImage` 输入和 provider resume 协议保持不变。
- 最近 100 条问题会话的未压缩浏览器响应必须小于 1 MiB，且不含通用工具结果中不可见的 `data:image/*;base64`。
- HTTP 压缩只作用于 Session `application/json`；不得成为全局中间件，不得改变 WebSocket、SSE 或其他流式响应。
- 所有缺陷先以失败测试固定；每个任务只提交列出的文件，不顺手重构相邻代码。
- queue/resume/WS 日志不得记录消息正文、附件内容、图片、令牌、Cookie 或凭据。
- 首次 P0 发布前已经打开的旧标签页可能仍需最后一次手动刷新；不能宣称入口脚本本身缺失时可以由尚未加载的恢复代码自救。
- P0 发布使用现有 `pnpm yep rebuild`；若现有孤儿进程导致脚本拒绝执行，停止发布并单独请求精准清理授权，不在 P0 中改写服务管理脚本。

---

## File Map

**新增文件**

- `packages/server/src/sessions/browser-session-projection.ts`：唯一的浏览器消息清理和 `session.messages` 去重边界。
- `packages/server/test/sessions/browser-session-projection.test.ts`：投影的递归、不可变性、数据保留和体积预算测试。
- `packages/client/src/pages/__tests__/SessionPage.reliability.test.tsx`：真实 `SessionPageContent` 的 Hook、重试、发送保护和续发网络边界测试。
- `packages/client/src/hooks/__tests__/useSessionMessages.reliability.test.tsx`：初始加载失败与显式重试测试。
- `packages/client/src/lib/buildRecovery.ts`：React 外的构建检查、动态 import 识别和单次刷新策略。
- `packages/client/src/lib/__tests__/buildRecovery.test.ts`：BASE_PATH、刷新去重和事件处理测试。
- `packages/client/src/components/__tests__/ErrorBoundary.test.tsx`：客户端/服务端 build 信息展示测试。
- `packages/server/test/routes/ws.test.ts`：WebSocket 连接生命周期结构化日志测试。

**修改文件**

- `packages/server/src/routes/sessions.ts`：三条 Session detail 返回分支共用投影；Session JSON 压缩；queue 接受/拒绝日志。
- `packages/server/test/api/sessions.test.ts`：实时、桥接、持久化契约与压缩；queue 日志。
- `packages/client/src/types.ts`：新增 `BrowserSessionMetadata`，保留内部完整 `Session` 类型。
- `packages/client/src/api/client.ts`：Session API 返回 metadata + 独立 messages。
- `packages/client/src/hooks/useSessionMessages.ts`：metadata 状态、初始加载重试。
- `packages/client/src/hooks/useSession.ts`：加载错误所有权、错误清除和重试出口。
- `packages/client/src/pages/SessionPage.tsx`：Hook 后置错误分支、重试按钮、ready 发送保护。
- `packages/client/src/i18n/{en,zh-CN,ja,fr,es,de}.json`：重试按钮文案。
- `packages/server/src/frontend/static.ts`：缺失静态资源/API 404，HTML 导航才允许 SPA fallback。
- `packages/server/test/frontend/static.test.ts`：404/no-store、Accept、BASE_PATH 回归。
- `packages/client/src/hooks/useBuildRefresh.ts`：复用命令式构建恢复函数。
- `packages/client/src/main.tsx`：`createRoot` 前安装恢复监听器。
- `packages/client/src/components/ErrorBoundary.tsx`：展示客户端 build ID、服务端 build ID 和版本。
- `packages/server/src/routes/ws.ts`：连接 ID、持续时间、关闭码/原因日志；保持 30 秒 ping 不变。

---

### Task 1: Create the immutable browser Session projection

**Files:**
- Create: `packages/server/src/sessions/browser-session-projection.ts`
- Create: `packages/server/test/sessions/browser-session-projection.test.ts`

**Interfaces:**
- Consumes: `Message` from `packages/server/src/supervisor/types.ts`.
- Produces: `projectBrowserMessages(messages: readonly Message[]): Message[]`.
- Produces: `createBrowserSessionProjection<TSession extends object>(session: TSession, messages: readonly Message[]): { session: Omit<TSession, "messages">; messages: Message[] }`.
- Produces omitted marker shape `{ omitted_image: { mimeType: string; byteLength: number } }` at the original `input_image` position.

- [ ] **Step 1: Write failing tests for scoped recursive omission**

Create tests with one user-owned `input_image` outside a tool result and the same data URL inside both a raw `tool_result.content` JSON string and `toolUseResult`. Assert that only the two tool-result copies are removed:

```ts
const dataUrl = `data:image/png;base64,${Buffer.from("image-bytes").toString("base64")}`;
const messages: Message[] = [
  {
    type: "user",
    uuid: "user-1",
    message: {
      content: [{ type: "input_image", image_url: dataUrl }],
    },
  },
  {
    type: "user",
    uuid: "tool-result-1",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: JSON.stringify({
            output: [{ type: "input_image", image_url: dataUrl }],
          }),
        },
      ],
    },
    toolUseResult: {
      output: [{ type: "input_image", image_url: dataUrl }],
    },
  },
];

const projected = projectBrowserMessages(messages);

expect(JSON.stringify(projected[0])).toContain(dataUrl);
expect(JSON.stringify(projected[1])).not.toContain("data:image/png;base64");
expect(projected[1].toolUseResult).toMatchObject({
  output: [
    {
      type: "input_image",
      omitted_image: { mimeType: "image/png", byteLength: 11 },
    },
  ],
});
expect(messages[1]?.toolUseResult).toMatchObject({
  output: [{ image_url: dataUrl }],
});
```

Add separate cases proving invalid JSON strings are byte-for-byte unchanged, HTTP image URLs are unchanged, primitives pass through, and unchanged messages retain object identity.

- [ ] **Step 2: Run the projection test and verify RED**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/sessions/browser-session-projection.test.ts
```

Expected: FAIL because `browser-session-projection.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal scoped projector**

Implement the projector with these exact boundaries:

```ts
import type { Message } from "../supervisor/types.js";

interface ProjectionResult<T> {
  value: T;
  changed: boolean;
}

const DATA_IMAGE_URL = /^data:(image\/[A-Za-z0-9.+-]+);base64,([\s\S]*)$/i;

function decodedBase64Bytes(payload: string): number {
  const compact = payload.replace(/\s/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function projectUnknown(value: unknown): ProjectionResult<unknown> {
  if (Array.isArray(value)) {
    const projected = value.map(projectUnknown);
    const changed = projected.some((entry) => entry.changed);
    return {
      value: changed ? projected.map((entry) => entry.value) : value,
      changed,
    };
  }
  if (!value || typeof value !== "object") return { value, changed: false };

  const record = value as Record<string, unknown>;
  const imageUrl = record.image_url;
  if (record.type === "input_image" && typeof imageUrl === "string") {
    const match = DATA_IMAGE_URL.exec(imageUrl);
    if (match?.[1] && match[2] !== undefined) {
      const { image_url: _removed, ...rest } = record;
      return {
        value: {
          ...rest,
          omitted_image: {
            mimeType: match[1].toLowerCase(),
            byteLength: decodedBase64Bytes(match[2]),
          },
        },
        changed: true,
      };
    }
  }

  let changed = false;
  const entries = Object.entries(record).map(([key, entry]) => {
    const projected = projectUnknown(entry);
    changed ||= projected.changed;
    return [key, projected.value] as const;
  });
  return { value: changed ? Object.fromEntries(entries) : value, changed };
}

function projectToolResultContent(content: unknown): ProjectionResult<unknown> {
  if (typeof content !== "string") return projectUnknown(content);
  try {
    const projected = projectUnknown(JSON.parse(content));
    return projected.changed
      ? { value: JSON.stringify(projected.value), changed: true }
      : { value: content, changed: false };
  } catch {
    return { value: content, changed: false };
  }
}
```

In `projectBrowserMessages`, traverse only `message.content` blocks whose `type === "tool_result"` and the top-level `toolUseResult`. Copy the message, nested `message`, content array and changed blocks only when an omission occurs. Do not call `projectUnknown` on arbitrary user or assistant content.

Implement `createBrowserSessionProjection` by shallow-copying `session`, deleting the copied `messages` property, and returning `projectBrowserMessages(messages)` as the sole list. Never delete from the input object.

- [ ] **Step 4: Add the fixed-size budget test**

Generate 30 distinct 512 KiB data URLs inside tool results, duplicate each in raw content and `toolUseResult`, then assert:

```ts
const projection = createBrowserSessionProjection(
  { id: "large", messages, title: "Large session" },
  messages,
);
const encoded = JSON.stringify(projection);

expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(1024 * 1024);
expect(encoded).not.toContain("data:image/");
expect(projection.session).not.toHaveProperty("messages");
```

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/sessions/browser-session-projection.test.ts
pnpm typecheck
git add packages/server/src/sessions/browser-session-projection.ts packages/server/test/sessions/browser-session-projection.test.ts
git commit -m "fix: project compact browser session messages"
```

Expected: projection tests PASS; typecheck exits 0; the commit contains only the new projector and tests.

---

### Task 2: Apply the projection to every Session response and narrow JSON compression

**Files:**
- Modify: `packages/server/src/routes/sessions.ts:20-30,644-646,1277-1467`
- Modify: `packages/server/test/api/sessions.test.ts:195-258`
- Modify: `packages/client/src/types.ts:163-182`
- Modify: `packages/client/src/api/client.ts:768-817`
- Modify: `packages/client/src/hooks/useSessionMessages.ts:18,40-118,404-438,606-807`

**Interfaces:**
- Consumes: `createBrowserSessionProjection` from Task 1.
- Produces: `BrowserSessionMetadata = Omit<Session, "messages">` in `packages/client/src/types.ts`.
- Produces Session detail response `{ session: BrowserSessionMetadata; messages: Message[]; ownership; runtime; pendingInputRequest; slashCommands; pagination? }`.

- [ ] **Step 1: Add failing route-contract tests for all three branches**

Extend `GET /api/projects/:projectId/sessions/:sessionId` tests with persisted, process-memory and bridge-only fixtures. For each response assert the same contract:

```ts
expect(response.status).toBe(200);
const json = await response.json();
expect(json.session).not.toHaveProperty("messages");
expect(Array.isArray(json.messages)).toBe(true);
expect(JSON.stringify(json.messages)).not.toContain("data:image/png;base64");
```

For the live-process case, return `null` from the reader, return a process from `supervisor.getProcessForSession`, and give that process a `getMessageHistory()` containing the data-image tool result. For the bridge-only case, return `null` from both reader and supervisor, and make `codexBridgeService.getSessionView()` return a matching `CodexBridgeSessionView`; assert `json.messages` is an empty array and the metadata has no synthetic `messages` property.

- [ ] **Step 2: Add failing compression tests**

Request a persisted Session with enough visible text to exceed 1024 bytes:

```ts
const compressed = await app.request(sessionUrl, {
  headers: {
    "X-Yep-Anywhere": "true",
    "Accept-Encoding": "gzip",
  },
});
expect(compressed.headers.get("content-encoding")).toBe("gzip");

const identity = await app.request(sessionUrl, {
  headers: {
    "X-Yep-Anywhere": "true",
    "Accept-Encoding": "identity",
  },
});
expect(identity.headers.has("content-encoding")).toBe(false);
```

Run the existing WebSocket transport test after enabling HTTP compression; its existing binary/gzip tests must remain unchanged and pass.

- [ ] **Step 3: Run route tests and verify RED**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/api/sessions.test.ts
```

Expected: FAIL because current responses contain `session.messages` and do not negotiate HTTP gzip.

- [ ] **Step 4: Wire the shared projection into all response branches**

Import Task 1's function and replace each direct Session-detail `c.json` construction with this pattern:

```ts
const projection = createBrowserSessionProjection(sessionMetadata, messages);
return c.json({
  ...projection,
  ownership,
  runtime,
  pendingInputRequest,
  slashCommands,
  ...(paginationInfo && { pagination: paginationInfo }),
});
```

Use it in all three branches:

1. Process-memory branch: `sessionMetadata` is the current object at lines 1278–1302 and `messages` is `processMessages`.
2. Bridge-only branch: `sessionMetadata` is the current bridged metadata object at lines 1320–1334 and `messages` is `[]`.
3. Persisted branch: `sessionMetadata` is the current enriched object at lines 1443–1460 and `messages` is `session.messages`.

Do not apply the projector before pagination or `augmentPersistedSessionMessages`; those server-side operations require the complete internal messages.

- [ ] **Step 5: Add route-scoped JSON-only compression**

At the start of `createSessionsRoutes`, add Hono's middleware only to this router:

```ts
import { compress } from "hono/compress";

const routes = new Hono();
routes.use(
  "*",
  compress({
    threshold: 1024,
    contentTypeFilter: /^application\/json\b/i,
  }),
);
```

Do not add `compress()` in `app.ts` or `index.ts`. This router does not own `/api/ws` or SSE endpoints, and the content filter excludes non-JSON responses.

- [ ] **Step 6: Migrate the client contract without retaining fake message arrays**

In `types.ts` add:

```ts
export type BrowserSessionMetadata = Omit<Session, "messages">;
```

Change `api.getSession` and `api.getSessionMetadata` to return `BrowserSessionMetadata`. Change `SessionLoadResult.session`, `UseSessionMessagesResult.session`, `setSession`, `applySessionSnapshot` and `refreshSessionMessages` to that type. Replace the two metadata merges that currently preserve `prev.messages` with:

```ts
setSession((prev) => (prev ? { ...prev, ...data.session } : data.session));
```

Do not weaken the API type with `messages?: Message[]` and do not synthesize `{ messages: [] }` on the client.

- [ ] **Step 7: Run focused and transport tests, then commit**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/sessions/browser-session-projection.test.ts test/api/sessions.test.ts test/e2e/ws-transport.e2e.test.ts
pnpm --filter @yep-anywhere/client test -- src/api/client.test.ts
pnpm typecheck
git add packages/server/src/routes/sessions.ts packages/server/test/api/sessions.test.ts packages/client/src/types.ts packages/client/src/api/client.ts packages/client/src/hooks/useSessionMessages.ts
git commit -m "fix: return compact compressed session responses"
```

Expected: all commands exit 0; API responses contain one message list; WebSocket transport behavior is unchanged.

---

### Task 3: Make initial load retryable and block sends until ready

**Files:**
- Modify: `packages/client/src/hooks/useSessionMessages.ts:443-503,829-855`
- Modify: `packages/client/src/hooks/useSession.ts:128,172-176,200-291,1232-1277`
- Modify: `packages/client/src/pages/SessionPage.tsx:158,206-310,713-741,1545,1970-2020`
- Modify: `packages/client/src/i18n/en.json`
- Modify: `packages/client/src/i18n/zh-CN.json`
- Modify: `packages/client/src/i18n/ja.json`
- Modify: `packages/client/src/i18n/fr.json`
- Modify: `packages/client/src/i18n/es.json`
- Modify: `packages/client/src/i18n/de.json`
- Create: `packages/client/src/hooks/__tests__/useSessionMessages.reliability.test.tsx`
- Create: `packages/client/src/pages/__tests__/SessionPage.reliability.test.tsx`

**Interfaces:**
- Produces `retryInitialLoad(): void` from `useSessionMessages` and `useSession`.
- `useSession` remains the sole owner of `error: Error | null`.
- `SessionPageContent` uses `isSessionReady = !loading && error === null && session !== null` for both UI disabled state and handler guards.

- [ ] **Step 1: Add failing hook tests for retry and key changes**

Mock `api.getSession` to reject once and then resolve. Render `useSessionMessages`, assert the first failure calls `onLoadError`, invoke `retryInitialLoad`, and assert the resolved snapshot becomes ready:

```ts
api.getSession
  .mockRejectedValueOnce(new Error("network down"))
  .mockResolvedValueOnce(sessionResponse);

const { result } = renderHook(() =>
  useSessionMessages({
    projectId: "project-1",
    sessionId: "session-1",
    onLoadComplete,
    onLoadError,
  }),
);

await waitFor(() => expect(onLoadError).toHaveBeenCalledTimes(1));
act(() => result.current.retryInitialLoad());
await waitFor(() => expect(result.current.loading).toBe(false));
expect(onLoadComplete).toHaveBeenCalledWith(
  expect.objectContaining({ session: sessionResponse.session }),
);
```

Rerender with a different `sessionId` and prove it performs a fresh load rather than retaining the previous failed attempt.

- [ ] **Step 2: Add failing real-component tests for Hook order and send readiness**

Export `SessionPageContent` by name only to make the real component renderable in tests. Mock its external hooks and heavy child components, but do not replace `SessionPageContent` itself.

Test the exact React #300 transition: first return `{ loading: true, error: null, session: null }` from mocked `useSession`, then rerender with `{ loading: false, error: new Error("load failed"), session: null }`. Assert the retry button appears and `console.error` never contains `Rendered fewer hooks than expected`.

Use a lightweight `MessageInput` test double that exposes `disabled` and calls `onSend("follow up")` when clicked. Add these assertions:

```ts
expect(
  (screen.getByTestId("message-input") as HTMLButtonElement).disabled,
).toBe(true);
fireEvent.click(screen.getByTestId("message-input"));
expect(api.resumeSession).not.toHaveBeenCalled();
expect(api.queueMessage).not.toHaveBeenCalled();
expect(addPendingMessage).not.toHaveBeenCalled();
```

Then rerender ready with `status: { owner: "none" }`, click, and assert `api.resumeSession` receives `projectId`, `sessionId`, `"follow up"` and a `tempId`. Rerender ready with `status: { owner: "self", processId: "process-1" }`, click, and assert `api.queueMessage` is called.

- [ ] **Step 3: Run client tests and verify RED**

Run:

```powershell
pnpm --filter @yep-anywhere/client test -- src/hooks/__tests__/useSessionMessages.reliability.test.tsx src/pages/__tests__/SessionPage.reliability.test.tsx
```

Expected: FAIL because retry is absent, loading input is enabled, and the current early error return changes Hook count.

- [ ] **Step 4: Extract a reusable initial-load attempt and expose retry**

In `useSessionMessages`, add an attempt counter and a retry callback:

```ts
const [initialLoadAttempt, setInitialLoadAttempt] = useState(0);

const retryInitialLoad = useCallback(() => {
  initialLoadCompleteRef.current = false;
  setLoading(true);
  setInitialLoadAttempt((attempt) => attempt + 1);
}, []);
```

Add `initialLoadAttempt` to the existing initial-load effect dependencies and return `retryInitialLoad` from the hook. Preserve branch reload behavior and stream buffering. Normalize caught non-Error values before calling `onLoadError`.

In `useSession`, destructure the hook retry as `retryMessagesInitialLoad`, clear `error` in `handleLoadComplete`, and expose:

```ts
const retryInitialLoad = useCallback(() => {
  setError(null);
  retryMessagesInitialLoad();
}, [retryMessagesInitialLoad]);

useEffect(() => {
  setError(null);
}, [projectId, sessionId]);
```

This keeps error ownership in `useSession`; `useSessionMessages` must not gain a second public error state.

- [ ] **Step 5: Move error rendering after every Hook and add retry UI**

Delete the returns currently at lines 264–282. Immediately before the main JSX return at approximately line 1545, add:

```tsx
const loadFailure =
  error ??
  (!loading && !session
    ? new Error("Session data could not be loaded")
    : null);

if (loadFailure) {
  return (
    <div className="error session-load-error">
      <div>
        {t("sessionErrorPrefix")} {loadFailure.message}
      </div>
      <button type="button" onClick={retryInitialLoad}>
        {t("sessionRetry")}
      </button>
    </div>
  );
}
```

All component Hooks, including `useDeveloperMode`, `useActivityBusState`, state Hooks and engagement Hooks, must remain above this branch.

Add `sessionRetry` translations: English `Retry`, Chinese `重试`, Japanese `再試行`, French `Réessayer`, Spanish `Reintentar`, German `Erneut versuchen`.

- [ ] **Step 6: Use one ready predicate at the handler and UI seams**

Define:

```ts
const isSessionReady = !loading && error === null && session !== null;
```

Make the first statement of both `handleSend` and `handleQueue`:

```ts
if (!isSessionReady) return;
```

This statement must execute before `addPendingMessage`, attachment clearing, optimistic `setProcessState` or draft clearing. Pass `disabled={!isSessionReady}` to `MessageInput`, and only provide `onQueue` when `isSessionReady` and the existing owner/process-state condition are both true. Keep the existing catch block that restores draft and attachments.

- [ ] **Step 7: Run tests and commit**

Run:

```powershell
pnpm --filter @yep-anywhere/client test -- src/hooks/__tests__/useSessionMessages.reliability.test.tsx src/pages/__tests__/SessionPage.reliability.test.tsx
pnpm --filter @yep-anywhere/client test
pnpm typecheck
git add packages/client/src/hooks/useSessionMessages.ts packages/client/src/hooks/useSession.ts packages/client/src/pages/SessionPage.tsx packages/client/src/i18n packages/client/src/hooks/__tests__/useSessionMessages.reliability.test.tsx packages/client/src/pages/__tests__/SessionPage.reliability.test.tsx
git commit -m "fix: recover failed session loads before sending"
```

Expected: the Hook transition test, retry test, resume test and queue test PASS; full client tests and typecheck exit 0.

---

### Task 4: Return real 404 responses for missing static assets

**Files:**
- Modify: `packages/server/src/frontend/static.ts:14-114`
- Modify: `packages/server/test/frontend/static.test.ts:20-79`

**Interfaces:**
- Existing `createStaticRoutes(options: StaticServeOptions): Hono` remains unchanged.
- Missing explicit assets and `/api/**` return status 404 with `Cache-Control: no-store`.
- SPA fallback is allowed only for `Accept` containing `text/html` and a non-static, non-API path.

- [ ] **Step 1: Add failing BASE_PATH and Accept tests**

Add these cases using `basePath: "/yep"`:

```ts
const missingAsset = await routes.request("/yep/assets/missing-deadbeef.js", {
  headers: { Accept: "text/html,application/xhtml+xml" },
});
expect(missingAsset.status).toBe(404);
expect(missingAsset.headers.get("content-type")).toContain("text/plain");
expect(missingAsset.headers.get("cache-control")).toBe("no-store");

const missingApi = await routes.request("/yep/api/missing", {
  headers: { Accept: "text/html" },
});
expect(missingApi.status).toBe(404);

const navigation = await routes.request("/yep/projects/project-1", {
  headers: { Accept: "text/html,application/xhtml+xml" },
});
expect(navigation.status).toBe(200);
expect(await navigation.text()).toContain("<div>app</div>");

const nonHtmlNavigation = await routes.request("/yep/projects/project-1", {
  headers: { Accept: "application/json" },
});
expect(nonHtmlNavigation.status).toBe(404);
```

Also cover missing `.css`, `.woff2`, `.json` and an existing hashed asset.

- [ ] **Step 2: Run static tests and verify RED**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/frontend/static.test.ts
```

Expected: FAIL because every missing path currently receives `index.html` with status 200.

- [ ] **Step 3: Add explicit fallback classification**

Add a finite extension set rather than treating every dotted application route as a file:

```ts
const STATIC_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".css",
  ".map",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
]);

function isExplicitStaticRequest(reqPath: string): boolean {
  return reqPath.startsWith("/assets/") || STATIC_EXTENSIONS.has(path.extname(reqPath).toLowerCase());
}

function acceptsHtml(accept: string | undefined): boolean {
  return accept?.toLowerCase().includes("text/html") ?? false;
}
```

After exact-file lookup fails and before reading `index.html`, return `c.text("Not found", 404, { "Cache-Control": "no-store" })` when `reqPath === "/api"`, `reqPath.startsWith("/api/")`, `isExplicitStaticRequest(reqPath)`, or `!acceptsHtml(c.req.header("accept"))`.

Update the existing SPA-shell test to send `Accept: text/html`; do not weaken the new behavior to preserve its previous headerless test.

- [ ] **Step 4: Run tests and commit**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/frontend/static.test.ts
pnpm typecheck
git add packages/server/src/frontend/static.ts packages/server/test/frontend/static.test.ts
git commit -m "fix: return 404 for missing frontend assets"
```

Expected: static tests PASS and a missing hashed JS request can no longer return HTML 200.

---

### Task 5: Recover stale dynamic imports before React fails

**Files:**
- Create: `packages/client/src/lib/buildRecovery.ts`
- Create: `packages/client/src/lib/__tests__/buildRecovery.test.ts`
- Modify: `packages/client/src/hooks/useBuildRefresh.ts:1-91`
- Modify: `packages/client/src/main.tsx:1-136`
- Modify: `packages/client/src/components/ErrorBoundary.tsx:1-100`
- Create: `packages/client/src/components/__tests__/ErrorBoundary.test.tsx`

**Interfaces:**
- Produces `CLIENT_BUILD_ID: string`.
- Produces `checkForBuildRecovery(reason: BuildRecoveryReason, deps?: BuildRecoveryDeps): Promise<BuildRecoveryResult>`.
- Produces `installBuildRecoveryListeners(deps?: BuildRecoveryDeps): () => void`.
- `BuildRecoveryReason` is `"routine" | "vite-preload-error" | "dynamic-import-error"`.

- [ ] **Step 1: Add failing pure recovery tests**

Use injected `fetchImpl`, `storage`, `reload`, `now`, `baseUrl`, `currentBuildId` and `buildProfile`; do not mutate real navigation in Vitest. Cover:

```ts
const deps = makeDeps({
  baseUrl: "/yep/",
  currentBuildId: "client-a",
  serverBuildId: "server-b",
});

await expect(checkForBuildRecovery("vite-preload-error", deps)).resolves.toBe(
  "reloaded",
);
expect(deps.fetchImpl).toHaveBeenCalledWith(
  expect.stringMatching(/^\/yep\/build-info\.json\?fresh=1&t=/),
  expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
);
expect(deps.reload).toHaveBeenCalledTimes(1);

await checkForBuildRecovery("vite-preload-error", deps);
expect(deps.reload).toHaveBeenCalledTimes(1);
```

Add same-build dynamic-import failure, failed build-info request, dev-profile disabled, storage unavailable, and full-URL preservation cases. URL preservation means the implementation calls `location.reload()` and never assigns a replacement pathname.

- [ ] **Step 2: Add failing listener tests**

Install listeners with injected deps, dispatch a cancelable `vite:preloadError`, and synchronously assert `defaultPrevented` before awaiting the fetch:

```ts
const remove = installBuildRecoveryListeners(deps);
const event = new Event("vite:preloadError", { cancelable: true });
window.dispatchEvent(event);
expect(event.defaultPrevented).toBe(true);
await vi.waitFor(() => expect(deps.reload).toHaveBeenCalledTimes(1));
remove();
```

Dispatch `PromiseRejectionEvent`/`ErrorEvent` variants containing `Importing a module script failed` and `Failed to fetch dynamically imported module`. Assert unrelated errors do not trigger a build check.

- [ ] **Step 3: Run recovery tests and verify RED**

Run:

```powershell
pnpm --filter @yep-anywhere/client test -- src/lib/__tests__/buildRecovery.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement one command-style recovery module**

Define:

```ts
export type BuildRecoveryReason =
  | "routine"
  | "vite-preload-error"
  | "dynamic-import-error";

export type BuildRecoveryResult =
  | "disabled"
  | "unavailable"
  | "current"
  | "already-reloaded"
  | "reloaded";

export interface BuildRecoveryDeps {
  baseUrl: string;
  currentBuildId: string;
  buildProfile: string;
  fetchImpl: typeof fetch;
  storage: Pick<Storage, "getItem" | "setItem">;
  reload: () => void;
  now: () => number;
}
```

`checkForBuildRecovery` fetches `${normalizedBase}build-info.json?fresh=1&t=${now()}`. For `routine`, refresh only when server and client build IDs differ. For a module failure, allow one refresh even when IDs match. Store the marker before reload under:

```ts
const effectiveReason =
  serverBuildId === deps.currentBuildId ? reason : "build-mismatch";
const key = `yep-anywhere:auto-reloaded:${deps.currentBuildId}->${serverBuildId}:${effectiveReason}`;
```

`installBuildRecoveryListeners` must call `preventDefault()` synchronously for `vite:preloadError`, classify only known dynamic-import messages in `unhandledrejection`/`error`, and return a cleanup function.

The Vite listener starts with the cancellation, before any promise is created:

```ts
const onVitePreloadError = (event: Event) => {
  event.preventDefault();
  void checkForBuildRecovery("vite-preload-error", deps);
};
```

- [ ] **Step 5: Reuse recovery from the Hook and install it before React**

Replace the duplicate build-info/reload logic in `useBuildRefresh` with `checkForBuildRecovery("routine")`; retain the existing activity reconnect, refresh, focus, visibility and debounce triggers.

In `main.tsx`, immediately before the existing `createRoot(rootElement).render` call, call:

```ts
installBuildRecoveryListeners();
```

Do not move this call into `App`, a Hook, `Suspense` or `ErrorBoundary`.

- [ ] **Step 6: Show build identity in ErrorBoundary**

Add `serverBuildId` to ErrorBoundary state. Parse `/api/version` as:

```ts
const data = (await res.json()) as {
  current?: string;
  build?: { buildId?: string };
};
this.setState({
  serverVersion: data.current ?? null,
  serverBuildId: data.build?.buildId ?? null,
});
```

Render rows for client build (`CLIENT_BUILD_ID`), server build, and server version. Add a component test that throws from a child, mocks `/api/version`, and asserts all three values appear.

- [ ] **Step 7: Run tests, build the non-root profile, and commit**

Run:

```powershell
pnpm --filter @yep-anywhere/client test -- src/lib/__tests__/buildRecovery.test.ts src/components/__tests__/ErrorBoundary.test.tsx
pnpm --filter @yep-anywhere/client build:stable
pnpm typecheck
git add packages/client/src/lib/buildRecovery.ts packages/client/src/lib/__tests__/buildRecovery.test.ts packages/client/src/hooks/useBuildRefresh.ts packages/client/src/main.tsx packages/client/src/components/ErrorBoundary.tsx packages/client/src/components/__tests__/ErrorBoundary.test.tsx
git commit -m "fix: recover stale client module imports"
```

Expected: tests PASS; stable build succeeds under `/_stable/`; no recovery test reloads more than once per build/reason key.

---

### Task 6: Add privacy-safe queue and WebSocket lifecycle diagnostics

**Files:**
- Modify: `packages/server/src/routes/sessions.ts:2010-2131`
- Modify: `packages/server/test/api/sessions.test.ts:510-527`
- Modify: `packages/server/src/routes/ws.ts:1-5,114-228`
- Create: `packages/server/test/routes/ws.test.ts`

**Interfaces:**
- Queue events: `session_queue_requested`, `session_queue_accepted`, `session_queue_rejected`.
- WebSocket events: `ws_client_connected`, `ws_client_disconnected`, `ws_client_error`.
- Common queue fields: `sessionId`, optional `tempId`, `messageLength`, `processState`, optional `reason`.
- Common WS fields: `connectionId`; disconnect also has `durationMs`, `closeCode`, optional `closeReason`.

- [ ] **Step 1: Add failing queue-log tests**

Spy on `getLogger().info`/`warn`. Exercise no-process, terminated, deferred, queue failure and queue success results. For success assert:

```ts
expect(info).toHaveBeenCalledWith(
  expect.objectContaining({
    event: "session_queue_accepted",
    sessionId: "sess-active",
    tempId: "temp-1",
    messageLength: 11,
    processState: "in-turn",
  }),
  expect.any(String),
);
const payloads = info.mock.calls.map(([payload]) => JSON.stringify(payload));
expect(payloads.join("\n")).not.toContain("secret body");
```

Use `message: "secret body"` in the request so the privacy assertion is meaningful.

- [ ] **Step 2: Add a failing WebSocket lifecycle unit test**

Pass a fake `upgradeWebSocket` that captures the event factory. Invoke `onOpen` with a minimal socket, advance fake time by 31 seconds, then invoke `onClose` with `{ code: 1006, reason: "proxy reset" }`. Assert connected and disconnected logs share one UUID-shaped `connectionId`, and disconnect contains `durationMs: 31000`, `closeCode: 1006`, `closeReason: "proxy reset"`.

Do not assert a different ping interval; the P0 decision is to observe the current 30-second behavior.

- [ ] **Step 3: Run diagnostics tests and verify RED**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/api/sessions.test.ts test/routes/ws.test.ts
```

Expected: FAIL because current queue routes do not log and WS logs are unstructured strings.

- [ ] **Step 4: Add structured queue outcomes without content**

After valid JSON/message parsing, construct only this safe context:

```ts
const queueLogContext = {
  sessionId,
  tempId: body.tempId,
  messageLength: body.message.length,
  processState: process.state.type,
};
```

Log requested before defer/queue handling, accepted on deferred and normal success, and rejected before every post-parse 4xx/410 return. For the pre-parse no-process case, log only `sessionId` and `reason: "no_active_process"`. Never spread `body` or `userMessage` into a log object.

- [ ] **Step 5: Add correlated WebSocket lifecycle fields**

Import `randomUUID` and `getLogger`. Create `connectionId` and set `connectedAt = Date.now()` inside `onOpen`. Replace console lifecycle strings with Pino objects. In `onClose`, extract code/reason defensively:

```ts
const closeEvent = evt as { code?: number; reason?: string };
getLogger().info(
  {
    event: "ws_client_disconnected",
    connectionId,
    durationMs: Math.max(0, Date.now() - connectedAt),
    closeCode: closeEvent.code,
    closeReason: closeEvent.reason || undefined,
  },
  "WebSocket client disconnected",
);
```

Include `connectionId` on unexpected message errors and `onError`. Keep cleanup order and the existing 30,000 ms ping interval unchanged.

- [ ] **Step 6: Run tests and commit**

Run:

```powershell
pnpm --filter @yep-anywhere/server test -- test/api/sessions.test.ts test/routes/ws.test.ts test/e2e/ws-transport.e2e.test.ts
pnpm typecheck
git add packages/server/src/routes/sessions.ts packages/server/test/api/sessions.test.ts packages/server/src/routes/ws.ts packages/server/test/routes/ws.test.ts
git commit -m "chore: correlate session queue and websocket logs"
```

Expected: tests PASS; no assertion or log payload contains the request body; WebSocket protocol tests remain unchanged.

---

### Task 7: Verify, deploy, and validate P0 without entering P1

**Files:**
- No planned source changes.
- Read: `docs/superpowers/specs/2026-08-17-remote-session-reliability-design.md`.
- Read: `CLAUDE.md:240-276` for the supported Windows rebuild path.

**Interfaces:**
- Consumes the six reviewed commits from Tasks 1–6.
- Produces evidence for automated checks, the original 62 MiB Session, mobile resume/queue, stale chunk recovery and two-minute public WebSocket stability.

- [ ] **Step 1: Run the complete P0 verification set**

Run from repository root:

```powershell
pnpm --filter @yep-anywhere/server test -- test/sessions/browser-session-projection.test.ts test/api/sessions.test.ts test/frontend/static.test.ts test/routes/ws.test.ts test/e2e/ws-transport.e2e.test.ts
pnpm --filter @yep-anywhere/client test -- src/api/client.test.ts src/hooks/__tests__/useSessionMessages.reliability.test.tsx src/pages/__tests__/SessionPage.reliability.test.tsx src/lib/__tests__/buildRecovery.test.ts src/components/__tests__/ErrorBoundary.test.tsx
pnpm --filter @yep-anywhere/server test
pnpm --filter @yep-anywhere/client test
pnpm lint
pnpm typecheck
pnpm build:bundle
```

Expected: every command exits 0. If a pre-existing unrelated full-suite failure occurs, record its exact test and prove every P0-focused command still exits 0; do not edit unrelated code.

- [ ] **Step 2: Inspect scope and build identity before production mutation**

Run:

```powershell
git status --short
git diff HEAD~6 --stat
pnpm yep status
```

Expected: working tree is clean; the six commits touch only files listed in this plan; current production status and build ID are recorded. Confirm there is no active AI turn before rebuilding. If status shows the known orphaned supervisor/port conflict and `rebuild` cannot safely identify the current processes, stop here and request targeted process-cleanup authority.

- [ ] **Step 3: Deploy through the supported P0 path**

Run only after Step 2 is safe:

```powershell
pnpm yep rebuild
pnpm yep status
```

Expected: lint/typecheck/staged bundle/runtime verification complete; production restarts on 8022; `/api/version` reports the new commit/build ID. Do not edit `scripts/yep.ps1`, `scripts/run-yepanywhere.ps1` or maintenance-port configuration if deployment reveals the deferred P1 issue.

- [ ] **Step 4: Measure the original problem Session against the production API**

Use the known incident identifiers:

```powershell
$projectId = 'RDovUHl0aG9uUHJvamVjdHMvUHl0aG9uX3Byb2plY3RzX2FuYWNvbmRhX3pwYi_lj6zlm57kuK3lv4Mt5LqL5pWF5pWw5o2u5YiG5p6Q'
$sessionId = '01a00ced-6cbb-7253-ac80-6d9b2dacbe5f'
$sessionUrl = "http://127.0.0.1:8022/api/projects/$projectId/sessions/$sessionId`?tailCompactions=2&maxMessages=100"
$response = Invoke-WebRequest -UseBasicParsing -Uri $sessionUrl -Headers @{
  'X-Yep-Anywhere' = 'true'
  'Accept-Encoding' = 'identity'
}
$bodyBytes = [Text.Encoding]::UTF8.GetByteCount($response.Content)
$json = $response.Content | ConvertFrom-Json
[pscustomobject]@{
  Status = $response.StatusCode
  BodyBytes = $bodyBytes
  HasSessionMessages = $null -ne $json.session.PSObject.Properties['messages']
  DataImageCount = ([regex]::Matches($response.Content, 'data:image/')).Count
  MessageCount = $json.messages.Count
}
```

Expected: status 200, `BodyBytes < 1048576`, `HasSessionMessages = False`, `DataImageCount = 0`, and messages remain present.

Make a second request with `Accept-Encoding: gzip` and confirm `Content-Encoding: gzip` without changing the decoded JSON contract.

- [ ] **Step 5: Perform the real phone and stale-build acceptance**

Using the existing public URL and no FRP changes:

1. Open the incident Session on 4G; confirm no long skeleton stall and no React #300.
2. Simulate a failed initial request with browser throttling/offline, restore connectivity, tap `Retry`, and confirm the same Session loads without losing a typed draft.
3. Wait for an AI turn to finish, send `P0 mobile resume acceptance`, and confirm the backend emits `session_resume_requested` or `session_queue_requested`, followed by an accepted event and a new provider turn.
4. Keep the public page connected for at least two minutes. If it disconnects, record `connectionId`, `durationMs`, `closeCode` and `closeReason`; do not change the heartbeat during this task.
5. Serve the previous client build against the new server in the stable/non-root profile; trigger a missing lazy chunk and confirm exactly one reload preserves pathname, query and hash. Repeat the same failure and confirm it reaches ErrorBoundary rather than looping.

- [ ] **Step 6: Record the release outcome without claiming P1**

Report:

- focused/full test counts and commands;
- production commit/build ID;
- measured uncompressed bytes and gzip header;
- resume/queue event IDs and provider turn evidence;
- WebSocket two-minute result or correlated close evidence;
- stale-chunk single-refresh result;
- any remaining P1 supervisor/maintenance/deployment limitation.

P0 is complete only when Steps 1–5 pass. Do not state that supervisor adoption, 8023 maintenance service, FRP tuning or transactional rollback is fixed.
