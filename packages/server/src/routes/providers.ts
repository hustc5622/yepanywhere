import type { ProviderInfo, ProviderName } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { getClaudeCodeSettings } from "../sdk/providers/claude-settings.js";
import { getAllProviders } from "../sdk/providers/index.js";
import type { AgentProvider } from "../sdk/providers/types.js";
import type { ModelInfoService } from "../services/ModelInfoService.js";

interface ProviderRouteDeps {
  modelInfoService?: ModelInfoService;
  /** If non-empty, only these provider names are exposed. */
  enabledProviders?: string[];
}

/**
 * Reasoning-effort levels each provider actually accepts, in canonical order.
 * These are the verbatim native keywords (exactly what the provider's own
 * CLI / VS Code plugin uses) passed straight through to the SDK, so the UI
 * never presents a phantom level and never remaps one provider's name onto
 * another's.
 */
const PROVIDER_REASONING_LEVELS: Record<string, string[]> = {
  // Codex CLI/SDK native levels.
  codex: ["low", "medium", "high", "xhigh"],
  "codex-oss": ["low", "medium", "high", "xhigh"],
  // Claude Code CLI/SDK native levels.
  claude: ["low", "medium", "high", "max"],
};

function reasoningEffortLevelsFor(name: string): string[] | undefined {
  return PROVIDER_REASONING_LEVELS[name];
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

  const claudeSettings =
    provider.name === "claude" ? await getClaudeCodeSettings() : null;

  return {
    name: provider.name,
    displayName: provider.displayName,
    installed: authStatus.installed,
    authenticated: authStatus.authenticated,
    enabled: authStatus.enabled,
    expiresAt: authStatus.expiresAt?.toISOString(),
    user: authStatus.user,
    models,
    currentModel: claudeSettings?.model,
    currentEffortLevel: claudeSettings?.effortLevel,
    supportsPermissionMode: provider.supportsPermissionMode,
    supportsThinkingToggle: provider.supportsThinkingToggle,
    supportsSlashCommands: provider.supportsSlashCommands,
    reasoningEffortLevels: reasoningEffortLevelsFor(provider.name),
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
