import type { ProviderInfo, ProviderName } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { ClaudeUsageResponse } from "../sdk/providers/claude-control.js";
import { getCodexModelSourceRegistry } from "../sdk/providers/codex-model-sources.js";
import { claudeProvider, getAllProviders } from "../sdk/providers/index.js";
import type { AgentProvider } from "../sdk/providers/types.js";
import type { ModelInfoService } from "../services/ModelInfoService.js";

interface ProviderRouteDeps {
  modelInfoService?: ModelInfoService;
  /** If non-empty, only these provider names are exposed. */
  enabledProviders?: string[];
  /** Test seam for the remote Claude control channel. */
  getClaudeUsage?: (options: {
    fresh?: boolean;
  }) => Promise<ClaudeUsageResponse>;
}

async function buildProviderInfo(
  provider: AgentProvider,
  modelInfoService?: ModelInfoService,
): Promise<ProviderInfo> {
  const [authStatus, models] = await Promise.all([
    provider.getAuthStatus(),
    provider.getAvailableModels(),
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

  // GET /api/providers - Get all available providers with auth status and models
  routes.get("/", async (c) => {
    let providers = getAllProviders();
    if (deps.enabledProviders && deps.enabledProviders.length > 0) {
      const enabled = new Set(deps.enabledProviders);
      providers = providers.filter((p) => enabled.has(p.name));
    }
    const providerInfos: ProviderInfo[] = [];

    for (const provider of providers) {
      providerInfos.push(
        await buildProviderInfo(provider, deps.modelInfoService),
      );
    }

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
    );

    return c.json({ provider: providerInfo });
  });

  return routes;
}
