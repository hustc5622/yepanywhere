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
  type OpenCodeModelLimits,
  type PermissionMode,
  type ProviderName,
  type ThinkingOption,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { updateClaudeCodeSettings } from "../sdk/providers/claude-settings.js";
import { testSSHConnection } from "../sdk/remote-spawn.js";
import type {
  ServerSettings,
  ServerSettingsService,
} from "../services/ServerSettingsService.js";
import {
  isValidSshHostAlias,
  normalizeSshHostAlias,
} from "../utils/sshHostAlias.js";

const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "max"];

export interface SettingsRoutesDeps {
  serverSettingsService: ServerSettingsService;
  /** Callback to apply allowedHosts changes at runtime */
  onAllowedHostsChanged?: (value: string | undefined) => void;
  /** Callback to apply Ollama URL changes at runtime */
  onOllamaUrlChanged?: (url: string | undefined) => void;
  /** Callback to apply Ollama system prompt changes at runtime */
  onOllamaSystemPromptChanged?: (prompt: string | undefined) => void;
  /** Callback to apply Ollama full system prompt toggle at runtime */
  onOllamaUseFullSystemPromptChanged?: (enabled: boolean) => void;
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

function getEffortFromThinkingOption(
  option: ThinkingOption | undefined,
): EffortLevel | undefined {
  if (!option || option === "off" || option === "auto") return undefined;
  if (option.startsWith("on:")) {
    const effort = option.slice(3);
    return isEffortLevel(effort) ? effort : undefined;
  }
  return isEffortLevel(option) ? option : undefined;
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
  const output = parsePositiveTokenLimit(input.output);

  if (context === null || output === null) return null;
  return { context, output };
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
  if (typeof raw !== "object") return null;

  const input = raw as Record<string, unknown>;
  const parsed: NewSessionDefaults = {};

  if ("provider" in input) {
    if (
      input.provider !== undefined &&
      input.provider !== null &&
      input.provider !== "" &&
      !ALL_PROVIDERS.includes(input.provider as ProviderName)
    ) {
      return null;
    }
    if (typeof input.provider === "string" && input.provider.length > 0) {
      parsed.provider = input.provider as ProviderName;
    }
  }

  if ("model" in input) {
    if (
      input.model !== undefined &&
      input.model !== null &&
      input.model !== "" &&
      typeof input.model !== "string"
    ) {
      return null;
    }
    if (typeof input.model === "string" && input.model.length > 0) {
      parsed.model = input.model;
    }
  }

  if ("thinking" in input) {
    if (
      input.thinking !== undefined &&
      input.thinking !== null &&
      input.thinking !== "" &&
      !isThinkingOption(input.thinking)
    ) {
      return null;
    }
    if (isThinkingOption(input.thinking)) {
      parsed.thinking = input.thinking;
    }
  }

  if ("permissionMode" in input) {
    if (
      input.permissionMode !== undefined &&
      input.permissionMode !== null &&
      input.permissionMode !== "" &&
      !ALL_PERMISSION_MODES.includes(input.permissionMode as PermissionMode)
    ) {
      return null;
    }
    if (
      typeof input.permissionMode === "string" &&
      input.permissionMode.length > 0
    ) {
      parsed.permissionMode = input.permissionMode as PermissionMode;
    }
  }

  if ("codexMcpMode" in input) {
    if (
      input.codexMcpMode !== undefined &&
      input.codexMcpMode !== null &&
      input.codexMcpMode !== "" &&
      !ALL_CODEX_MCP_MODES.includes(input.codexMcpMode as CodexMcpMode)
    ) {
      return null;
    }
    if (
      typeof input.codexMcpMode === "string" &&
      input.codexMcpMode.length > 0
    ) {
      parsed.codexMcpMode = input.codexMcpMode as CodexMcpMode;
    }
  }

  if ("opencodeModelLimits" in input) {
    const limits = parseOpenCodeModelLimits(input.opencodeModelLimits);
    if (limits === null) return null;
    if (limits) parsed.opencodeModelLimits = limits;
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function createSettingsRoutes(deps: SettingsRoutesDeps): Hono {
  const app = new Hono();
  const {
    serverSettingsService,
    onAllowedHostsChanged,
    onOllamaUrlChanged,
    onOllamaSystemPromptChanged,
    onOllamaUseFullSystemPromptChanged,
  } = deps;

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
    // Handle remoteExecutors array
    if (Array.isArray(body.remoteExecutors)) {
      const { hosts, invalidHost } = parseHostAliasList(body.remoteExecutors);
      if (invalidHost) {
        return c.json(
          { error: `Invalid remote executor host alias: ${invalidHost}` },
          400,
        );
      }
      updates.remoteExecutors = hosts;
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

    // Handle ollamaUrl string (URL, or undefined/null/"" to clear)
    if ("ollamaUrl" in body) {
      if (
        body.ollamaUrl === undefined ||
        body.ollamaUrl === null ||
        body.ollamaUrl === ""
      ) {
        updates.ollamaUrl = undefined;
      } else if (typeof body.ollamaUrl === "string") {
        updates.ollamaUrl = body.ollamaUrl;
      }
    }

    // Handle ollamaSystemPrompt string (free-form text, or undefined/null/"" to clear)
    if ("ollamaSystemPrompt" in body) {
      if (
        body.ollamaSystemPrompt === undefined ||
        body.ollamaSystemPrompt === null ||
        body.ollamaSystemPrompt === ""
      ) {
        updates.ollamaSystemPrompt = undefined;
      } else if (typeof body.ollamaSystemPrompt === "string") {
        updates.ollamaSystemPrompt = body.ollamaSystemPrompt.slice(0, 10000);
      }
    }

    // Handle ollamaUseFullSystemPrompt boolean
    if (typeof body.ollamaUseFullSystemPrompt === "boolean") {
      updates.ollamaUseFullSystemPrompt = body.ollamaUseFullSystemPrompt;
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
      if (parsedDefaults?.provider === "claude") {
        try {
          const claudeSettingsPatch: Parameters<
            typeof updateClaudeCodeSettings
          >[0] = {};
          if (parsedDefaults.model !== undefined) {
            claudeSettingsPatch.model = parsedDefaults.model;
          }
          const effortLevel = getEffortFromThinkingOption(
            parsedDefaults.thinking,
          );
          if (effortLevel !== undefined) {
            claudeSettingsPatch.effortLevel = effortLevel;
          }
          if (Object.keys(claudeSettingsPatch).length > 0) {
            await updateClaudeCodeSettings(claudeSettingsPatch);
          }
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Unknown Claude Code settings error";
          return c.json(
            { error: `Failed to update Claude Code settings: ${message}` },
            500,
          );
        }
      }
      updates.newSessionDefaults = parsedDefaults;
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
    if ("ollamaUrl" in updates && onOllamaUrlChanged) {
      onOllamaUrlChanged(settings.ollamaUrl);
    }
    if ("ollamaSystemPrompt" in updates && onOllamaSystemPromptChanged) {
      onOllamaSystemPromptChanged(settings.ollamaSystemPrompt);
    }
    if (
      "ollamaUseFullSystemPrompt" in updates &&
      onOllamaUseFullSystemPromptChanged
    ) {
      onOllamaUseFullSystemPromptChanged(
        settings.ollamaUseFullSystemPrompt ?? false,
      );
    }

    return c.json({ settings });
  });

  /**
   * GET /api/settings/remote-executors
   * Get list of configured remote executors
   */
  app.get("/remote-executors", (c) => {
    const settings = serverSettingsService.getSettings();
    return c.json({ executors: settings.remoteExecutors ?? [] });
  });

  /**
   * PUT /api/settings/remote-executors
   * Update list of remote executors
   */
  app.put("/remote-executors", async (c) => {
    const body = await c.req.json<{ executors: string[] }>();

    if (!Array.isArray(body.executors)) {
      return c.json({ error: "executors must be an array" }, 400);
    }

    const { hosts: validExecutors, invalidHost } = parseHostAliasList(
      body.executors,
    );
    if (invalidHost) {
      return c.json(
        { error: `Invalid remote executor host alias: ${invalidHost}` },
        400,
      );
    }

    await serverSettingsService.updateSettings({
      remoteExecutors: validExecutors,
    });

    return c.json({ executors: validExecutors });
  });

  /**
   * POST /api/settings/remote-executors/:host/test
   * Test SSH connection to a remote executor
   */
  app.post("/remote-executors/:host/test", async (c) => {
    const host = normalizeSshHostAlias(c.req.param("host"));

    if (!host) {
      return c.json({ error: "host is required" }, 400);
    }
    if (!isValidSshHostAlias(host)) {
      return c.json({ error: "host must be a valid SSH host alias" }, 400);
    }

    const result = await testSSHConnection(host);
    return c.json(result);
  });

  return app;
}
