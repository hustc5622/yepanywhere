import {
  type LiveProviderName,
  type PermissionMode,
  type ProviderInfo,
  type ProviderName,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import type { CursorAccountResponse } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { canonicalizeProjectPath, decodeProjectId } from "../projects/paths.js";
import { getCursorRuntimeAvailability } from "../runtime/cursor-availability.js";
import type { RuntimeController } from "../runtime/types.js";
import type { ClaudeUsageResponse } from "../sdk/providers/claude-control.js";
import { getCodexModelSourceRegistry } from "../sdk/providers/codex-model-sources.js";
import { cursorAccountService } from "../sdk/providers/cursor-account.js";
import {
  discardCursorPrepare,
  prepareCursorSession,
  warmCursorAuth,
} from "../sdk/providers/cursor-prepare.js";
import { claudeProvider, getAllProviders } from "../sdk/providers/index.js";
import {
  isProviderEnabled,
  isRetiredProviderName,
  retiredProviderMessage,
} from "../sdk/providers/policy.js";
import type { AgentProvider } from "../sdk/providers/types.js";
import type { ModelInfoService } from "../services/ModelInfoService.js";

interface ProviderRouteDeps {
  runtimeController?: RuntimeController;
  getCursorAccount?: (options: {
    fresh?: boolean;
  }) => Promise<CursorAccountResponse>;
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
  runtimeController?: RuntimeController,
): Promise<ProviderInfo> {
  const [authStatus, models] = await Promise.all([
    provider.getAuthStatus(),
    provider.getAvailableModels({ waitForRefresh: waitForModelRefresh }),
  ]);
  modelInfoService?.ingestModels(provider.name as ProviderName, models);
  const availability =
    provider.name === "cursor" && runtimeController
      ? await getCursorRuntimeAvailability(runtimeController)
      : "ready";

  return {
    name: provider.name as LiveProviderName,
    displayName: provider.displayName,
    installed: authStatus.installed,
    authenticated: authStatus.authenticated,
    enabled: authStatus.enabled,
    ...(availability !== "ready" ? { unavailableReason: availability } : {}),
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

  routes.get("/cursor/account", async (c) => {
    if (!isProviderEnabled("cursor", deps.enabledProviders))
      return c.json({ error: "Provider not found" }, 404);
    const getAccount =
      deps.getCursorAccount ??
      ((options) => cursorAccountService.getAccount(options));
    return c.json(await getAccount({ fresh: c.req.query("fresh") === "1" }));
  });

  routes.post("/cursor/prepare", async (c) => {
    if (!isProviderEnabled("cursor", deps.enabledProviders))
      return c.json({ error: "Provider not found" }, 404);
    const body = await readJsonObject(c);
    const cwd = cursorPrepareCwd(body);
    if (!cwd) return c.json({ error: "projectId is required" }, 400);
    try {
      const input = {
        cwd,
        model: stringField(body, "model"),
        permissionMode: cursorPermissionMode(body.permissionMode),
      };
      if (deps.runtimeController?.mode === "external") {
        await deps.runtimeController.prepareCursorSession(input);
      } else {
        await prepareCursorSession(input);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Prepare failed";
      return c.json({ error: message }, 503);
    }
    return c.json({ ok: true });
  });

  routes.post("/cursor/prepare/discard", async (c) => {
    if (!isProviderEnabled("cursor", deps.enabledProviders))
      return c.json({ error: "Provider not found" }, 404);
    const body = await readJsonObject(c);
    const cwd = cursorPrepareCwd(body);
    if (!cwd) return c.json({ error: "projectId is required" }, 400);
    const input = { cwd, model: stringField(body, "model") };
    if (deps.runtimeController?.mode === "external") {
      await deps.runtimeController.discardCursorPrepare(input);
    } else {
      await discardCursorPrepare(input);
    }
    return c.json({ ok: true });
  });

  routes.post("/cursor/warm", async (c) => {
    if (!isProviderEnabled("cursor", deps.enabledProviders))
      return c.json({ error: "Provider not found" }, 404);
    const body = await readJsonObject(c);
    const model = stringField(body, "model");
    if (deps.runtimeController?.mode === "external") {
      void deps.runtimeController.warmCursorAuth(model).catch(() => undefined);
    } else {
      void warmCursorAuth(model).catch(() => undefined);
    }
    return c.json({ ok: true });
  });

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
    const providers = (deps.providers ?? getAllProviders()).filter((provider) =>
      isProviderEnabled(provider.name, deps.enabledProviders),
    );
    const waitForModelRefresh = c.req.query("fresh") === "1";
    const providerInfos = await Promise.all(
      providers.map((provider) =>
        buildProviderInfo(
          provider,
          deps.modelInfoService,
          waitForModelRefresh,
          deps.runtimeController,
        ),
      ),
    );

    return c.json({ providers: providerInfos });
  });

  // GET /api/providers/:name - Get specific provider status with models
  routes.get("/:name", async (c) => {
    const name = c.req.param("name");
    if (isRetiredProviderName(name)) {
      return c.json(
        {
          error: retiredProviderMessage(name),
          code: "provider_retired",
        },
        410,
      );
    }
    if (!isProviderEnabled(name, deps.enabledProviders)) {
      return c.json({ error: "Provider not found" }, 404);
    }
    const providers = deps.providers ?? getAllProviders();
    const provider = providers.find((p) => p.name === name);

    if (!provider) {
      return c.json({ error: "Provider not found" }, 404);
    }

    const providerInfo = await buildProviderInfo(
      provider,
      deps.modelInfoService,
      c.req.query("fresh") === "1",
      deps.runtimeController,
    );

    return c.json({ provider: providerInfo });
  });

  return routes;
}

async function readJsonObject(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // Callers treat a missing body as an empty object and validate fields.
  }
  return {};
}

function stringField(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function cursorPermissionMode(value: unknown): PermissionMode | undefined {
  if (
    value === "default" ||
    value === "plan" ||
    value === "bypassPermissions"
  ) {
    return value;
  }
  return undefined;
}

function cursorPrepareCwd(body: Record<string, unknown>): string | null {
  if (typeof body.projectId === "string" && isUrlProjectId(body.projectId)) {
    return canonicalizeProjectPath(decodeProjectId(body.projectId));
  }
  if (typeof body.cwd === "string" && body.cwd.trim()) {
    return canonicalizeProjectPath(body.cwd);
  }
  return null;
}
