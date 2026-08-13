import { describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import { createProvidersRoutes } from "../../src/routes/providers.js";
import type { AgentProvider } from "../../src/sdk/providers/types.js";
import { ZCodeProtocolError } from "../../src/sdk/providers/zcode-protocol/types.js";

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

  describe("GET /zcode/mcp-servers", () => {
    const projectPath = "/tmp/mcp-proj";
    const projectId = encodeProjectId(projectPath);

    it("returns the provider's MCP server statuses for the project workspace", async () => {
      const listMcpServers = vi.fn(async () => ({
        context7: {
          status: "connected",
          transport: "http",
          toolCount: 4,
          updatedAt: "2026-08-13T00:00:00Z",
        },
      }));
      const provider = {
        name: "zcode",
        displayName: "ZCode",
        listMcpServers,
      } as unknown as AgentProvider;
      const routes = createProvidersRoutes({ providers: [provider] });

      const response = await routes.request(
        `/zcode/mcp-servers?projectId=${encodeURIComponent(projectId)}`,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        servers: {
          context7: {
            status: "connected",
            transport: "http",
            toolCount: 4,
            updatedAt: "2026-08-13T00:00:00Z",
          },
        },
      });
      expect(listMcpServers).toHaveBeenCalledWith(projectPath);
    });

    it("requires a projectId query parameter", async () => {
      const routes = createProvidersRoutes({ providers: [] });
      const response = await routes.request("/zcode/mcp-servers");
      expect(response.status).toBe(400);
    });

    it("reports 404 when no provider supports MCP listing", async () => {
      const provider = {
        name: "zcode",
        displayName: "ZCode",
      } as unknown as AgentProvider;
      const routes = createProvidersRoutes({ providers: [provider] });
      const response = await routes.request(
        `/zcode/mcp-servers?projectId=${encodeURIComponent(projectId)}`,
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        code: "mcp_list_unsupported",
      });
    });

    it("maps provider capability failures to 503 with the stable code", async () => {
      const listMcpServers = vi.fn(async () => {
        throw new ZCodeProtocolError(
          "zcode_cli_not_found",
          "ZCode CLI unavailable: zcode_cli_not_found",
        );
      });
      const provider = {
        name: "zcode",
        displayName: "ZCode",
        listMcpServers,
      } as unknown as AgentProvider;
      const routes = createProvidersRoutes({ providers: [provider] });

      const response = await routes.request(
        `/zcode/mcp-servers?projectId=${encodeURIComponent(projectId)}`,
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: "zcode_cli_not_found",
      });
    });

    it("maps protocol failures to 502", async () => {
      const listMcpServers = vi.fn(async () => {
        throw new ZCodeProtocolError(
          "zcode_protocol_timeout",
          "ZCode request timed out",
        );
      });
      const provider = {
        name: "zcode",
        displayName: "ZCode",
        listMcpServers,
      } as unknown as AgentProvider;
      const routes = createProvidersRoutes({ providers: [provider] });

      const response = await routes.request(
        `/zcode/mcp-servers?projectId=${encodeURIComponent(projectId)}`,
      );

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        code: "zcode_protocol_timeout",
      });
    });
  });
});
