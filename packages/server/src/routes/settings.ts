/**
 * Server settings API routes
 */

import {
  ALL_CODEX_MCP_MODES,
  ALL_PERMISSION_MODES,
  ALL_PROVIDERS,
  type CodexMcpMode,
  type EffortLevel,
  type NewSessionDefaults,
  type NewSessionProviderDefaults,
  type OpenCodeJsonObject,
  type OpenCodeModelLimits,
  type OpenCodeSessionConfig,
  type PermissionMode,
  type ProviderName,
  type RemoteExecutorConfig,
  type ThinkingOption,
  mergeNewSessionDefaults,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import {
  parseRemoteExecutorConfig,
  parseRemoteExecutorConfigs,
} from "../sdk/remote-executor-config.js";
import { testRemoteExecutor } from "../sdk/remote-spawn.js";
import type { OhMyRouterBenchmarkService } from "../services/OhMyRouterBenchmarkService.js";
import type {
  ServerSettings,
  ServerSettingsService,
} from "../services/ServerSettingsService.js";
import {
  isValidSshHostAlias,
  normalizeSshHostAlias,
} from "../utils/sshHostAlias.js";

const EFFORT_LEVELS: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface SettingsRoutesDeps {
  serverSettingsService: ServerSettingsService;
  /** Runs and persists an OhMyRouter model throughput benchmark. */
  ohmyrouterBenchmarkService?: OhMyRouterBenchmarkService;
  /** Callback to apply allowedHosts changes at runtime */
  onAllowedHostsChanged?: (value: string | undefined) => void;
  /** Callback to refresh Claude provider discovery after executor changes. */
  onRemoteExecutorsChanged?: (
    executors: RemoteExecutorConfig[],
  ) => void | Promise<void>;
}

function parseHostAliasList(rawHosts: unknown[]): {
  hosts: string[];
  invalidHost?: string;
} {
  const hosts: string[] = [];

  for (const rawHost of rawHosts) {
    if (typeof rawHost !== "string") continue;

    const host = normalizeSshHostAlias(rawHost);
    if (!host) continue;
    if (!isValidSshHostAlias(host)) {
      return { hosts: [], invalidHost: host };
    }

    hosts.push(host);
  }

  return { hosts };
}

function isEffortLevel(value: string): value is EffortLevel {
  return EFFORT_LEVELS.includes(value as EffortLevel);
}

function isThinkingOption(value: unknown): value is ThinkingOption {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value === "off" || value === "auto") return true;
  if (isEffortLevel(value)) return true;
  if (!value.startsWith("on:")) return false;
  return isEffortLevel(value.slice(3));
}

function isReasoningEffort(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    /^[a-z0-9_-]+$/i.test(value)
  );
}

function parsePositiveTokenLimit(value: unknown): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    return null;
  }
  return value;
}

function parseOpenCodeModelLimits(
  raw: unknown,
): OpenCodeModelLimits | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "object") return null;

  const input = raw as Record<string, unknown>;
  const hasContext = input.context !== undefined && input.context !== null;
  const hasOutput = input.output !== undefined && input.output !== null;
  if (!hasContext && !hasOutput) return undefined;
  if (!hasContext || !hasOutput) return null;

  const context = parsePositiveTokenLimit(input.context);
  const inputLimit =
    input.input === undefined || input.input === null
      ? undefined
      : parsePositiveTokenLimit(input.input);
  const output = parsePositiveTokenLimit(input.output);

  if (context === null || output === null || inputLimit === null) return null;
  return {
    context,
    ...(inputLimit === undefined ? {} : { input: inputLimit }),
    output,
  };
}

function isJsonObject(value: unknown): value is OpenCodeJsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      return false;
    }
    if (!isJsonValue(item, 1)) return false;
  }
  return JSON.stringify(value).length <= 65_536;
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > 12) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      key !== "__proto__" &&
      key !== "prototype" &&
      key !== "constructor" &&
      isJsonValue(item, depth + 1),
  );
}

function parseOpenCodeSessionConfig(
  raw: unknown,
): OpenCodeSessionConfig | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (
    !model ||
    model.length > 512 ||
    model === "__proto__" ||
    model === "prototype" ||
    model === "constructor" ||
    Array.from(model).some((character) => character.charCodeAt(0) < 32)
  ) {
    return null;
  }
  if (
    input.requestProtocol !== "openai-compatible" &&
    input.requestProtocol !== "anthropic"
  ) {
    return null;
  }

  const limits = parseOpenCodeModelLimits(input.limits);
  if (limits === null) return null;

  let capabilities: OpenCodeSessionConfig["capabilities"];
  if (input.capabilities !== undefined && input.capabilities !== null) {
    if (
      typeof input.capabilities !== "object" ||
      Array.isArray(input.capabilities)
    ) {
      return null;
    }
    capabilities = {};
    const rawCapabilities = input.capabilities as Record<string, unknown>;
    for (const key of [
      "attachment",
      "reasoning",
      "temperature",
      "toolCall",
    ] as const) {
      const value = rawCapabilities[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean") return null;
      capabilities[key] = value;
    }
  }

  let advanced: OpenCodeSessionConfig["advanced"];
  if (input.advanced !== undefined && input.advanced !== null) {
    if (typeof input.advanced !== "object" || Array.isArray(input.advanced)) {
      return null;
    }
    const rawAdvanced = input.advanced as Record<string, unknown>;
    if (
      rawAdvanced.provider !== undefined &&
      !isJsonObject(rawAdvanced.provider)
    ) {
      return null;
    }
    if (rawAdvanced.model !== undefined && !isJsonObject(rawAdvanced.model)) {
      return null;
    }
    advanced = {
      provider: rawAdvanced.provider as OpenCodeJsonObject | undefined,
      model: rawAdvanced.model as OpenCodeJsonObject | undefined,
    };
  }

  const name =
    typeof input.name === "string" && input.name.trim()
      ? input.name.trim()
      : undefined;
  if (name && name.length > 200) return null;

  return {
    model,
    requestProtocol: input.requestProtocol,
    ...(name ? { name } : {}),
    ...(limits ? { limits } : {}),
    ...(capabilities && Object.keys(capabilities).length > 0
      ? { capabilities }
      : {}),
    ...(advanced ? { advanced } : {}),
  };
}

function parseNewSessionProviderDefaults(
  raw: Record<string, unknown>,
  provider?: ProviderName,
): NewSessionProviderDefaults | undefined | null {
  const parsed: NewSessionProviderDefaults = {};

  if ("model" in raw) {
    if (
      raw.model !== undefined &&
      raw.model !== null &&
      raw.model !== "" &&
      typeof raw.model !== "string"
    ) {
      return null;
    }
    if (typeof raw.model === "string" && raw.model.length > 0) {
      parsed.model = raw.model;
    }
  }

  if ("thinking" in raw) {
    if (
      raw.thinking !== undefined &&
      raw.thinking !== null &&
      raw.thinking !== "" &&
      !isThinkingOption(raw.thinking)
    ) {
      return null;
    }
    if (isThinkingOption(raw.thinking)) {
      parsed.thinking = raw.thinking;
    }
  }

  if ("reasoningEffort" in raw) {
    if (
      raw.reasoningEffort !== undefined &&
      raw.reasoningEffort !== null &&
      raw.reasoningEffort !== "" &&
      !isReasoningEffort(raw.reasoningEffort)
    ) {
      return null;
    }
    if (isReasoningEffort(raw.reasoningEffort)) {
      parsed.reasoningEffort = raw.reasoningEffort;
    }
  }

  if ("permissionMode" in raw) {
    if (
      raw.permissionMode !== undefined &&
      raw.permissionMode !== null &&
      raw.permissionMode !== "" &&
      !ALL_PERMISSION_MODES.includes(raw.permissionMode as PermissionMode)
    ) {
      return null;
    }
    if (
      typeof raw.permissionMode === "string" &&
      raw.permissionMode.length > 0
    ) {
      parsed.permissionMode = raw.permissionMode as PermissionMode;
    }
  }

  if ("codexMcpMode" in raw) {
    if (
      raw.codexMcpMode !== undefined &&
      raw.codexMcpMode !== null &&
      raw.codexMcpMode !== "" &&
      (!ALL_CODEX_MCP_MODES.includes(raw.codexMcpMode as CodexMcpMode) ||
        (provider !== undefined && provider !== "codex"))
    ) {
      return null;
    }
    if (typeof raw.codexMcpMode === "string" && raw.codexMcpMode.length > 0) {
      parsed.codexMcpMode = raw.codexMcpMode as CodexMcpMode;
    }
  }

  if ("opencodeConfig" in raw) {
    const config = parseOpenCodeSessionConfig(raw.opencodeConfig);
    if (config === null) return null;
    if (config) {
      if (
        provider !== undefined &&
        provider !== "opencode" &&
        provider !== "pi"
      ) {
        return null;
      }
      parsed.opencodeConfig = config;
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function isSavedNewSessionProvider(value: string): value is ProviderName {
  return (
    value !== "claude-ollama" && ALL_PROVIDERS.includes(value as ProviderName)
  );
}

/**
 * Returns:
 * - `null` when the payload is invalid
 * - `undefined` when the setting should be cleared
 * - an object when valid defaults should be saved
 */
function parseNewSessionDefaults(
  raw: unknown,
): NewSessionDefaults | undefined | null {
  if (raw === undefined) return null;
  if (raw === null || raw === "") return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;

  const input = raw as Record<string, unknown>;
  let provider: ProviderName | undefined;
  if (
    input.provider !== undefined &&
    input.provider !== null &&
    input.provider !== ""
  ) {
    if (
      typeof input.provider !== "string" ||
      !isSavedNewSessionProvider(input.provider)
    ) {
      return null;
    }
    provider = input.provider;
  }

  const flatDefaults = parseNewSessionProviderDefaults(input, provider);
  if (flatDefaults === null) return null;

  const byProvider: Partial<Record<ProviderName, NewSessionProviderDefaults>> =
    {};
  if (
    input.byProvider !== undefined &&
    input.byProvider !== null &&
    input.byProvider !== ""
  ) {
    if (
      typeof input.byProvider !== "object" ||
      Array.isArray(input.byProvider)
    ) {
      return null;
    }
    for (const [providerName, rawProviderDefaults] of Object.entries(
      input.byProvider,
    )) {
      if (
        !isSavedNewSessionProvider(providerName) ||
        typeof rawProviderDefaults !== "object" ||
        rawProviderDefaults === null ||
        Array.isArray(rawProviderDefaults)
      ) {
        return null;
      }
      const parsedProviderDefaults = parseNewSessionProviderDefaults(
        rawProviderDefaults as Record<string, unknown>,
        providerName,
      );
      if (parsedProviderDefaults === null) return null;
      if (parsedProviderDefaults) {
        byProvider[providerName] = parsedProviderDefaults;
      }
    }
  }

  const parsed: NewSessionDefaults = {
    ...(provider ? { provider } : {}),
    ...flatDefaults,
    ...(Object.keys(byProvider).length > 0 ? { byProvider } : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function createSettingsRoutes(deps: SettingsRoutesDeps): Hono {
  const app = new Hono();
  const {
    serverSettingsService,
    onAllowedHostsChanged,
    onRemoteExecutorsChanged,
    ohmyrouterBenchmarkService,
  } = deps;

  if (ohmyrouterBenchmarkService) {
    app.get("/ohmyrouter-throughput", (c) =>
      c.json(ohmyrouterBenchmarkService.getStatus()),
    );
    app.post("/ohmyrouter-throughput", async (c) => {
      try {
        const benchmark = await ohmyrouterBenchmarkService.start();
        return c.json({ benchmark }, 202);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: message }, 400);
      }
    });
  }

  /**
   * GET /api/settings
   * Get all server settings
   */
  app.get("/", (c) => {
    const settings = serverSettingsService.getSettings();
    return c.json({ settings });
  });

  /**
   * PUT /api/settings
   * Update server settings
   */
  app.put("/", async (c) => {
    const body = await c.req.json<Partial<ServerSettings>>();

    const updates: Partial<ServerSettings> = {};

    // Handle boolean settings
    if (typeof body.serviceWorkerEnabled === "boolean") {
      updates.serviceWorkerEnabled = body.serviceWorkerEnabled;
    }
    if ("remoteExecutors" in body) {
      const parsed = parseRemoteExecutorConfigs(body.remoteExecutors);
      if (!parsed.executors) {
        return c.json(
          { error: parsed.error ?? "Invalid remoteExecutors setting" },
          400,
        );
      }
      updates.remoteExecutors = parsed.executors;
    }
    // Handle chromeOsHosts array
    if (Array.isArray(body.chromeOsHosts)) {
      const { hosts, invalidHost } = parseHostAliasList(body.chromeOsHosts);
      if (invalidHost) {
        return c.json(
          { error: `Invalid ChromeOS host alias: ${invalidHost}` },
          400,
        );
      }
      updates.chromeOsHosts = hosts;
    }

    // Handle allowedHosts string ("*", comma-separated hostnames, or undefined to clear)
    if ("allowedHosts" in body) {
      if (
        body.allowedHosts === undefined ||
        body.allowedHosts === null ||
        body.allowedHosts === ""
      ) {
        updates.allowedHosts = undefined;
      } else if (typeof body.allowedHosts === "string") {
        updates.allowedHosts = body.allowedHosts;
      }
    }

    // Handle globalInstructions string (free-form text, or undefined/null/"" to clear)
    if ("globalInstructions" in body) {
      if (
        body.globalInstructions === undefined ||
        body.globalInstructions === null ||
        body.globalInstructions === ""
      ) {
        updates.globalInstructions = undefined;
      } else if (typeof body.globalInstructions === "string") {
        updates.globalInstructions = body.globalInstructions.slice(0, 10000);
      }
    }

    // Handle deviceBridgeEnabled boolean
    if (typeof body.deviceBridgeEnabled === "boolean") {
      updates.deviceBridgeEnabled = body.deviceBridgeEnabled;
    }

    if ("newSessionDefaults" in body) {
      const parsedDefaults = parseNewSessionDefaults(body.newSessionDefaults);
      if (parsedDefaults === null) {
        return c.json({ error: "Invalid newSessionDefaults setting" }, 400);
      }
      if (parsedDefaults === undefined) {
        updates.newSessionDefaults = undefined;
      } else {
        const currentDefaults =
          serverSettingsService.getSetting("newSessionDefaults");
        const scopedDefaults =
          parsedDefaults.provider !== undefined ||
          currentDefaults?.provider === undefined
            ? parsedDefaults
            : { ...parsedDefaults, provider: currentDefaults.provider };
        updates.newSessionDefaults = mergeNewSessionDefaults(
          currentDefaults,
          scopedDefaults,
        );
      }
    }

    if (typeof body.lifecycleWebhooksEnabled === "boolean") {
      updates.lifecycleWebhooksEnabled = body.lifecycleWebhooksEnabled;
    }
    if (typeof body.lifecycleWebhookDryRun === "boolean") {
      updates.lifecycleWebhookDryRun = body.lifecycleWebhookDryRun;
    }
    if ("lifecycleWebhookUrl" in body) {
      if (
        body.lifecycleWebhookUrl === undefined ||
        body.lifecycleWebhookUrl === null ||
        body.lifecycleWebhookUrl === ""
      ) {
        updates.lifecycleWebhookUrl = undefined;
      } else if (typeof body.lifecycleWebhookUrl === "string") {
        updates.lifecycleWebhookUrl = body.lifecycleWebhookUrl.slice(0, 2000);
      }
    }
    if ("lifecycleWebhookToken" in body) {
      if (
        body.lifecycleWebhookToken === undefined ||
        body.lifecycleWebhookToken === null ||
        body.lifecycleWebhookToken === ""
      ) {
        updates.lifecycleWebhookToken = undefined;
      } else if (typeof body.lifecycleWebhookToken === "string") {
        updates.lifecycleWebhookToken = body.lifecycleWebhookToken.slice(
          0,
          5000,
        );
      }
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "At least one valid setting is required" }, 400);
    }

    const settings = await serverSettingsService.updateSettings(updates);

    // Apply allowedHosts change to middleware at runtime
    if ("allowedHosts" in updates && onAllowedHostsChanged) {
      onAllowedHostsChanged(settings.allowedHosts);
    }
    if ("remoteExecutors" in updates && onRemoteExecutorsChanged) {
      await onRemoteExecutorsChanged(settings.remoteExecutors ?? []);
    }
    return c.json({ settings });
  });

  app.get("/remote-executors", (c) => {
    return c.json({
      executors: serverSettingsService.getSetting("remoteExecutors") ?? [],
    });
  });

  app.put("/remote-executors", async (c) => {
    let body: { executors?: unknown };
    try {
      body = await c.req.json<{ executors?: unknown }>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = parseRemoteExecutorConfigs(body.executors);
    if (!parsed.executors) {
      return c.json({ error: parsed.error ?? "Invalid executors" }, 400);
    }
    const settings = await serverSettingsService.updateSettings({
      remoteExecutors: parsed.executors,
    });
    await onRemoteExecutorsChanged?.(parsed.executors);
    return c.json({ executors: settings.remoteExecutors ?? [] });
  });

  app.post("/remote-executors/test", async (c) => {
    let body: { executor?: unknown };
    try {
      body = await c.req.json<{ executor?: unknown }>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = parseRemoteExecutorConfig(body.executor);
    if (!parsed.executor) {
      return c.json({ error: parsed.error ?? "Invalid executor" }, 400);
    }
    return c.json(await testRemoteExecutor(parsed.executor));
  });

  return app;
}
