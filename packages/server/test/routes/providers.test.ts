import { describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import { createProvidersRoutes } from "../../src/routes/providers.js";
import type { RuntimeController } from "../../src/runtime/types.js";
import { getAllProviders, getProvider } from "../../src/sdk/providers/index.js";
import type { AgentProvider } from "../../src/sdk/providers/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("provider routes", () => {
  it("drives Antigravity sign-in through the login service", async () => {
    const pending = {
      status: "pending" as const,
      authUrl: "https://accounts.google.com/x",
      error: null,
      startedAt: "2026-11-21T10:00:00Z",
    };
    const agyLogin = {
      getAccount: vi.fn(async () => ({
        installed: true,
        authenticated: false,
        agyPath: "/h/agy",
        login: null,
      })),
      startLogin: vi.fn(async () => pending),
      getLoginState: vi.fn(() => pending),
      submitCode: vi.fn(async (code: unknown) => {
        if (code !== "good") throw new Error("Malformed auth code.");
        return { ...pending, status: "completed" as const, authUrl: null };
      }),
      cancelLogin: vi.fn(),
      logout: vi.fn(async () => undefined),
    };
    const app = createProvidersRoutes({ agyLogin: agyLogin as never });

    expect(
      await (await app.request("/agy/account?fresh=1")).json(),
    ).toMatchObject({ installed: true, authenticated: false });
    expect(agyLogin.getAccount).toHaveBeenCalledWith({ fresh: true });
    expect(
      await (await app.request("/agy/login", { method: "POST" })).json(),
    ).toEqual({ login: pending, error: null });

    const ok = await app.request("/agy/login/code", {
      method: "POST",
      body: JSON.stringify({ code: "good" }),
    });
    expect((await ok.json()).login.status).toBe("completed");
    const bad = await app.request("/agy/login/code", {
      method: "POST",
      body: JSON.stringify({ code: "bad" }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      login: null,
      error: "Malformed auth code.",
    });

    await app.request("/agy/login", { method: "DELETE" });
    expect(agyLogin.cancelLogin).toHaveBeenCalled();
    await app.request("/agy/logout", { method: "POST" });
    expect(agyLogin.logout).toHaveBeenCalled();

    const disabled = createProvidersRoutes({
      agyLogin: agyLogin as never,
      enabledProviders: ["codex"],
    });
    expect(
      (await disabled.request("/agy/login", { method: "POST" })).status,
    ).toBe(404);
  });

  it("serves Cursor account usage and flags a runtime that predates Cursor", async () => {
    const getCursorAccount = vi.fn(async () => ({
      installed: true,
      authenticated: true,
      user: { email: "cursor@example.com" },
      usage: null,
    }));
    const provider = {
      name: "cursor",
      displayName: "Cursor",
      getAuthStatus: async () => ({
        installed: true,
        authenticated: true,
        enabled: true,
        user: { email: "cursor@example.com" },
      }),
      getAvailableModels: async () => [],
    } as unknown as AgentProvider;
    const app = createProvidersRoutes({
      providers: [provider],
      getCursorAccount,
      runtimeController: {
        mode: "external",
        getStatus: async () => ({ protocolVersion: 6 }),
      } as unknown as RuntimeController,
    });
    const info = await (await app.request("/cursor")).json();
    expect(info.provider).toMatchObject({
      authenticated: true,
      user: { email: "cursor@example.com" },
      unavailableReason: "runtime-update-required",
    });
    const account = await app.request("/cursor/account?fresh=1");
    expect(account.status).toBe(200);
    expect(getCursorAccount).toHaveBeenCalledWith({ fresh: true });
    const prepareCursorSession = vi.fn(async () => undefined);
    const discardCursorPrepare = vi.fn(async () => undefined);
    const warmCursorAuth = vi.fn(async () => undefined);
    const projectId = encodeProjectId("/tmp/cursor-prepare");
    const forwarded = createProvidersRoutes({
      runtimeController: {
        mode: "external",
        prepareCursorSession,
        discardCursorPrepare,
        warmCursorAuth,
      } as unknown as RuntimeController,
    });
    expect(
      (
        await forwarded.request("/cursor/prepare", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId,
            model: "auto",
            permissionMode: "plan",
          }),
        })
      ).status,
    ).toBe(200);
    expect(prepareCursorSession).toHaveBeenCalledWith({
      cwd: "/tmp/cursor-prepare",
      model: "auto",
      permissionMode: "plan",
    });
    expect(
      (
        await forwarded.request("/cursor/prepare/discard", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, model: "auto" }),
        })
      ).status,
    ).toBe(200);
    expect(discardCursorPrepare).toHaveBeenCalledWith({
      cwd: "/tmp/cursor-prepare",
      model: "auto",
    });
    expect(
      (
        await forwarded.request("/cursor/warm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, model: "auto" }),
        })
      ).status,
    ).toBe(200);
    await vi.waitFor(() =>
      expect(warmCursorAuth).toHaveBeenCalledWith({
        cwd: "/tmp/cursor-prepare",
        model: "auto",
      }),
    );
    expect(
      (
        await createProvidersRoutes({
          enabledProviders: ["pi"],
          getCursorAccount,
        }).request("/cursor/account")
      ).status,
    ).toBe(404);
  });
  it("retires Claude SSH from discovery while preserving history lookup", () => {
    expect(getAllProviders().map((provider) => provider.name)).not.toContain(
      "claude",
    );
    expect(getProvider("claude")?.name).toBe("claude");
  });

  it.each(["opencode", "zcode", "kimi"])(
    "does not expose the retired %s provider",
    (name) => {
      expect(getAllProviders().map((provider) => provider.name)).not.toContain(
        name,
      );
      expect(getProvider(name)).toBeNull();
    },
  );

  it("returns a stable retired response for legacy provider detail requests", async () => {
    const response = await createProvidersRoutes({ providers: [] }).request(
      "/opencode",
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: "OpenCode provider has been retired",
      code: "provider_retired",
    });
  });

  it("returns a retired response for ZCode provider detail requests", async () => {
    const response = await createProvidersRoutes({ providers: [] }).request(
      "/zcode",
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: "ZCode provider has been retired",
      code: "provider_retired",
    });
  });

  it("loads provider metadata concurrently without waiting for remote refreshes", async () => {
    const gate = deferred();
    const started: string[] = [];
    const provider = (name: "claude" | "codex"): AgentProvider =>
      ({
        name,
        displayName: name,
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        getAuthStatus: vi.fn(async () => {
          started.push(`${name}:auth`);
          await gate.promise;
          return { installed: true, authenticated: true, enabled: true };
        }),
        getAvailableModels: vi.fn(async (options) => {
          started.push(`${name}:models:${String(options?.waitForRefresh)}`);
          await gate.promise;
          return [];
        }),
      }) as unknown as AgentProvider;
    const routes = createProvidersRoutes({
      providers: [provider("claude"), provider("codex")],
    });

    const responsePromise = routes.request("/");
    await vi.waitFor(() => {
      expect(started).toHaveLength(4);
    });

    expect(started).toEqual(
      expect.arrayContaining([
        "claude:auth",
        "claude:models:false",
        "codex:auth",
        "codex:models:false",
      ]),
    );

    gate.resolve();
    const response = await responsePromise;
    expect(response.status).toBe(200);
  });

  it("allows an explicit fresh provider catalog request", async () => {
    const getAvailableModels = vi.fn(async () => []);
    const provider = {
      name: "codex",
      displayName: "Codex",
      supportsPermissionMode: true,
      supportsThinkingToggle: true,
      supportsSlashCommands: true,
      getAuthStatus: vi.fn(async () => ({
        installed: true,
        authenticated: true,
        enabled: true,
      })),
      getAvailableModels,
    } as unknown as AgentProvider;
    const routes = createProvidersRoutes({ providers: [provider] });

    const response = await routes.request("/?fresh=1");

    expect(response.status).toBe(200);
    expect(getAvailableModels).toHaveBeenCalledWith({ waitForRefresh: true });
  });

  it("returns remote Claude usage and forwards the fresh flag", async () => {
    const getClaudeUsage = vi.fn(async () => ({
      usage: {
        primary: {
          usedPercent: 12,
          windowDurationMins: 300,
          resetsAt: null,
        },
        secondary: null,
        planType: "pro",
        resetCredits: null,
        additionalBuckets: [],
        updatedAt: "2026-07-16T08:00:00.000Z",
      },
      error: null,
    }));
    const routes = createProvidersRoutes({ getClaudeUsage });

    const response = await routes.request("/claude/usage?fresh=1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      usage: { planType: "pro", primary: { usedPercent: 12 } },
    });
    expect(getClaudeUsage).toHaveBeenCalledWith({ fresh: true });
  });
});
