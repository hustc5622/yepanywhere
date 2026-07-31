import { describe, expect, it, vi } from "vitest";
import { createProvidersRoutes } from "../../src/routes/providers.js";
import type { AgentProvider } from "../../src/sdk/providers/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("provider routes", () => {
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
