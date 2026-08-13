import {
  type ProviderInfo,
  type ProviderName,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { decodeProjectId } from "../projects/paths.js";
import type { ClaudeUsageResponse } from "../sdk/providers/claude-control.js";
import { getCodexModelSourceRegistry } from "../sdk/providers/codex-model-sources.js";
import { claudeProvider, getAllProviders } from "../sdk/providers/index.js";
import type { AgentProvider } from "../sdk/providers/types.js";
import { ZCodeProtocolError } from "../sdk/providers/zcode-protocol/types.js";
import type { ModelInfoService } from "../services/ModelInfoService.js";

interface ProviderRouteDeps {
  modelInfoService?: ModelInfoService;
  /** If non-empty, only these provider names are exposed. */
  enabledProviders?: string[];
  /** Test seam for provider discovery. */
  providers?: AgentProvider[];
  /** Test seam for the remote Claude control channel. */
  getClaudeUsage?: (options: {
    fresh?: boolean;
  }) => Promise<ClaudeUsageResponse>;
}

async function buildProviderInfo(
  provider: AgentProvider,
  modelInfoService?: ModelInfoService,
  waitForModelRefresh = false,
): Promise<ProviderInfo> {
  const [authStatus, models] = await Promise.all([
    provider.getAuthStatus(),
    provider.getAvailableModels({ waitForRefresh: waitForModelRefresh }),
  ]);
  modelInfoService?.ingestModels(provider.name as ProviderName, models);

  return {
    name: provider.name,
    displayName: provider.displayName,
    installed: authStatus.installed,
    authenticated: authStatus.authenticated,
    enabled: authStatus.enabled,
    expiresAt: authStatus.expiresAt?.toISOString(),
    user: authStatus.user,
    models,
    ...(provider.name === "codex"
      ? { codexModelSources: getCodexModelSourceRegistry().getPublicSources() }
      : {}),
    supportsPermissionMode: provider.supportsPermissionMode,
    permissionModes: provider.permissionModes,
    supportsThinkingToggle: provider.supportsThinkingToggle,
    supportsSlashCommands: provider.supportsSlashCommands,
  };
}

/**
 * Creates provider-related API routes.
 *
 * GET /api/providers - Get all providers with their auth status
 * GET /api/providers/:name - Get specific provider status
 */
export function createProvidersRoutes(deps: ProviderRouteDeps = {}): Hono {
  const routes = new Hono();

  // GET /api/providers/claude/usage - Claude.ai plan utilization from the
  // configured VM's structured Claude Code /usage control response.
  routes.get("/claude/usage", async (c) => {
    const getUsage =
      deps.getClaudeUsage ??
      ((options: { fresh?: boolean }) => claudeProvider.getUsage(options));
    return c.json(await getUsage({ fresh: c.req.query("fresh") === "1" }));
  });

  // GET /api/providers/zcode/mcp-servers?projectId=<id> - Read-only MCP
  // server status snapshot for a project's workspace. ZCode is the only
  // provider that can report MCP statuses today.
  routes.get("/zcode/mcp-servers", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId || !isUrlProjectId(projectId)) {
      return c.json({ error: "projectId query parameter is required" }, 400);
    }

    const providers = deps.providers ?? getAllProviders();
    const provider = providers.find((p) => p.name === "zcode");
    if (!provider?.listMcpServers) {
      return c.json(
        {
          error: "Provider does not support MCP server status listing",
          code: "mcp_list_unsupported",
        },
        404,
      );
    }

    try {
      const servers = await provider.listMcpServers(decodeProjectId(projectId));
      return c.json({ servers });
    } catch (error) {
      if (error instanceof ZCodeProtocolError) {
        const unavailable =
          error.code === "zcode_cli_not_found" ||
          error.code === "zcode_cli_unsupported_version" ||
          error.code === "zcode_config_unavailable";
        return c.json(
          { error: error.message, code: error.code },
          unavailable ? 503 : 502,
        );
      }
      const message =
        error instanceof Error ? error.message : "mcp/list failed";
      return c.json({ error: message, code: "zcode_protocol_error" }, 502);
    }
  });

  // GET /api/providers - Get all available providers with auth status and models
  routes.get("/", async (c) => {
    let providers = deps.providers ?? getAllProviders();
    if (deps.enabledProviders && deps.enabledProviders.length > 0) {
      const enabled = new Set(deps.enabledProviders);
      providers = providers.filter((p) => enabled.has(p.name));
    }
    const waitForModelRefresh = c.req.query("fresh") === "1";
    const providerInfos = await Promise.all(
      providers.map((provider) =>
        buildProviderInfo(provider, deps.modelInfoService, waitForModelRefresh),
      ),
    );

    return c.json({ providers: providerInfos });
  });

  // GET /api/providers/:name - Get specific provider status with models
  routes.get("/:name", async (c) => {
    const name = c.req.param("name");
    const providers = getAllProviders();
    const provider = providers.find((p) => p.name === name);

    if (!provider) {
      return c.json({ error: "Provider not found" }, 404);
    }

    const providerInfo = await buildProviderInfo(
      provider,
      deps.modelInfoService,
      c.req.query("fresh") === "1",
    );

    return c.json({ provider: providerInfo });
  });

  return routes;
}
