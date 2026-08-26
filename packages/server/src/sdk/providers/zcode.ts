/**
 * ZCode Agent Provider.
 *
 * Implements `AgentProvider` using the ZCode `app-server` JSON over stdio
 * protocol. Each active session spawns a dedicated `app-server` child
 * process, injects the provider registry, subscribes to events, and drains
 * a `MessageQueue` of user messages.
 *
 * Real ZCode CLI 0.16.1 protocol contract:
 *   - No `jsonrpc` field in messages (handled by ZCodeProtocolClient).
 *   - `workspace/readState` requires `workspace: {workspacePath, workspaceKey}`.
 *   - `workspace/updateProviderRegistry` requires `{workspace, registry: {revision, generatedAt, providers[]}}`.
 *   - `session/create` requires `workspace` (NOT `cwd`), optional `model`, `runtimeModel`, `mode`, `persistence`.
 *   - `session/create` result is a snapshot: `result.session.sessionId` (NOT `result.id`).
 *   - `session/resume` uses `sessionId` (NOT `id`).
 *   - `session/send` uses `content` (string, NOT nested message object), `sessionId`, optional `inputId`/`queryId`/`attachments`.
 *   - `session/setModel` uses `model: {providerId, modelId}` (NOT top-level fields).
 *   - `session/event` notifications use `{type, payload, seq, sessionId}` envelope.
 *
 * The session lifecycle:
 *   1. Discover CLI + resolve launch command.
 *   2. Spawn `app-server` via `ZCodeProtocolClient`.
 *   3. Read server-side config, build registry, `workspace/updateProviderRegistry`.
 *   4. `session/create` or `session/resume` with explicit runtime model/mode.
 *   5. `session/subscribe` with `web-remote-replayable` delivery kind.
 *   6. Drain `MessageQueue` → `session/send` → process `nextNotification` loop.
 *   7. Map events to `SDKMessage` via `convertZCodeNotificationToSDKMessages`.
 *   8. Handle `interaction/requestPermission` / `interaction/requestUserInput`
 *      via `setServerRequestHandler` → `options.onToolApproval`.
 *   9. `interrupt` calls `session/stop`; `abort` closes the client.
 *
 * Security: secrets never leave the server-side config adapter; the client
 * API only returns composite model IDs and provider labels.
 */

import type { ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ModelInfo,
  PermissionMode,
  ProviderMcpServerStatus,
  ZCodeMcpListResult,
  ZCodeSessionForkResult,
  ZCodeSessionGoalResult,
} from "@yep-anywhere/shared";
import {
  YEP_TO_ZCODE_MODE_MAP,
  ZCODE_COMPATIBILITY_BASELINE,
  ZCODE_PREFERRED_DELIVERY_KIND,
  isZCodeVersionGte,
} from "@yep-anywhere/shared";

import { getLogger } from "../../logging/logger.js";
import { MessageQueue, getUserPromptProjection } from "../messageQueue.js";
import type { CanUseTool, SDKMessage } from "../types.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";
import { buildZCodeWireAttachments } from "./zcode-protocol/attachments.js";
import { ZCodeProtocolClient } from "./zcode-protocol/client.js";
import {
  buildZCodeCatalogMap,
  buildZCodeProviderRegistry,
  parseZCodeConfig,
  resolveZCodeThoughtLevel,
} from "./zcode-protocol/config.js";
import {
  discoverZCodeCli,
  resolveZCodeLaunchCommand,
} from "./zcode-protocol/discovery.js";
import {
  convertZCodeNotificationToSDKMessages,
  createZCodeEventConverterState,
} from "./zcode-protocol/events.js";
import type { ZCodeEventConverterState } from "./zcode-protocol/events.js";
import type { ZCodeConfigParseResult } from "./zcode-protocol/types.js";
import { ZCodeProtocolError } from "./zcode-protocol/types.js";

const log = getLogger().child({ component: "zcode-provider" });

// =============================================================================
// Workspace identity builder
// =============================================================================

/**
 * Build the ZCode workspace identity object required by most protocol methods.
 *
 * Real CLI 0.16.1 requires at minimum:
 *   - `workspacePath`: absolute path to the working directory
 *   - `workspaceKey`: a stable key identifying the workspace
 *
 * `workspaceIdentity` is optional and used for remote session correlation.
 */
function buildWorkspaceIdentity(cwd: string): {
  workspacePath: string;
  workspaceKey: string;
} {
  return {
    workspacePath: cwd,
    workspaceKey: cwd,
  };
}

/**
 * Extract ordered message IDs from a `session/messages` result.
 *
 * The real CLI's result shape is not field-by-field contractual, so this is
 * deliberately tolerant: the array may live at `result.messages` (or be the
 * result itself), and each entry's ID is `m.id ?? m.info?.id`. Returned
 * order matches the session's message order.
 */
function extractZCodeMessageIds(result: unknown): string[] {
  const container = Array.isArray(result)
    ? result
    : (result as { messages?: unknown } | null | undefined)?.messages;
  if (!Array.isArray(container)) return [];
  const ids: string[] = [];
  for (const entry of container) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const info = record.info as Record<string, unknown> | undefined;
    const id =
      typeof record.id === "string"
        ? record.id
        : typeof info?.id === "string"
          ? info.id
          : undefined;
    if (id) ids.push(id);
  }
  return ids;
}

// =============================================================================
// Config
// =============================================================================

export interface ZCodeProviderConfig {
  /** Explicit CLI path override (bypasses discovery). */
  cliPath?: string;
  /** Explicit config dir override (default: ~/.zcode). */
  configDir?: string;
}

// =============================================================================
// Provider
// =============================================================================

export class ZCodeProvider implements AgentProvider {
  readonly name = "zcode" as const;
  readonly displayName = "ZCode";
  readonly supportsPermissionMode = true;
  /**
   * Yep modes that map onto a working ZCode mode, in ZCode's picker order.
   *
   * `auto` is deliberately absent: ZCode's native `auto` denies every tool
   * call (`mode.auto.unimplemented`), so advertising it would make it the
   * implicit default (`DEFAULT_PERMISSION_MODE`) and break every session.
   */
  readonly permissionModes: readonly PermissionMode[] = [
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
  ];
  /**
   * ZCode has no Claude-style extended-thinking token budget, so the generic
   * thinking toggle stays off. Its reasoning control is a named per-model
   * "thought level" (derived from the model's `reasoning.variants`), surfaced
   * through `ModelInfo.supportedReasoningEfforts` instead — a model without a
   * reasoning capability offers no levels at all, which a provider-wide
   * boolean cannot express.
   */
  readonly supportsThinkingToggle = false;
  readonly supportsSlashCommands = false;

  private readonly config: ZCodeProviderConfig;
  /** Cached discovery result (path, version, errorCode). */
  private discoveryCache: {
    path: string | null;
    version: string | null;
    errorCode: string | null;
    isCjs: boolean;
  } | null = null;
  /** Cached model catalog. */
  private modelCache: ModelInfo[] | null = null;

  constructor(config: ZCodeProviderConfig = {}) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // AgentProvider: installation / auth status
  // -------------------------------------------------------------------------

  async isInstalled(): Promise<boolean> {
    const discovery = await this.getDiscovery();
    return discovery.path !== null && discovery.errorCode === null;
  }

  async isAuthenticated(): Promise<boolean> {
    const config = await this.loadConfig();
    return config.errorCode === null && config.catalog.some((e) => e.available);
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    if (!installed) {
      const discovery = await this.getDiscovery();
      return {
        installed: false,
        authenticated: false,
        enabled: false,
      };
    }
    const config = await this.loadConfig();
    const hasAvailableModel = config.catalog.some((e) => e.available);
    return {
      installed: true,
      authenticated: hasAvailableModel,
      enabled: hasAvailableModel,
    };
  }

  // -------------------------------------------------------------------------
  // AgentProvider: models
  // -------------------------------------------------------------------------

  async getAvailableModels(): Promise<ModelInfo[]> {
    if (this.modelCache) return this.modelCache;

    const config = await this.loadConfig();
    const models: ModelInfo[] = config.catalog
      .filter((e) => e.available)
      .map((e) => ({
        id: e.compositeId,
        name: e.modelLabel ?? e.modelId,
        ...(e.providerLabel !== undefined ? { ownedBy: e.providerLabel } : {}),
        // Thought levels are per-model: a model without a reasoning capability
        // advertises none, so the client hides the picker for it.
        ...(e.thoughtLevels.length > 0
          ? {
              supportsEffort: true,
              supportedReasoningEfforts: e.thoughtLevels.map((level) => ({
                reasoningEffort: level,
              })),
              ...(e.defaultThoughtLevel
                ? { defaultReasoningEffort: e.defaultThoughtLevel }
                : {}),
            }
          : {}),
      }));

    this.modelCache = models;
    return models;
  }

  // -------------------------------------------------------------------------
  // AgentProvider: MCP server status (read-only introspection)
  // -------------------------------------------------------------------------

  /**
   * List MCP server statuses for a workspace.
   *
   * Spawns a dedicated, short-lived app-server purely for the query (no
   * provider registry injection, no session create) and always sends
   * `mode: "status"` so no MCP connections are opened. Only the documented
   * safe fields are projected — raw server config never leaves the CLI.
   *
   * Throws `ZCodeProtocolError` with a stable code when the CLI is
   * unavailable or the query fails; the route layer maps that to HTTP.
   */
  async listMcpServers(
    cwd: string,
  ): Promise<Record<string, ProviderMcpServerStatus>> {
    const discovery = await this.getDiscovery();
    if (!discovery.path || discovery.errorCode) {
      throw new ZCodeProtocolError(
        discovery.errorCode === "zcode_cli_unsupported_version"
          ? "zcode_cli_unsupported_version"
          : "zcode_cli_not_found",
        `ZCode CLI unavailable: ${discovery.errorCode ?? "not found"}`,
      );
    }
    const config = await this.loadConfig();
    if (config.errorCode) {
      throw new ZCodeProtocolError(
        config.errorCode,
        `ZCode config unavailable: ${config.errorCode}`,
      );
    }

    const launch = resolveZCodeLaunchCommand(discovery.path);
    const client = new ZCodeProtocolClient({
      command: launch.command,
      args: launch.args,
      env: process.env,
      cwd,
    });

    try {
      await client.connect();
      const result = await client.request<Partial<ZCodeMcpListResult>>(
        "mcp/list",
        {
          workspace: buildWorkspaceIdentity(cwd),
          mode: "status",
        },
      );
      const statuses = result?.statuses ?? {};
      const servers: Record<string, ProviderMcpServerStatus> = {};
      for (const [name, entry] of Object.entries(statuses)) {
        servers[name] = {
          status: entry.status,
          transport: entry.transport,
          toolCount: entry.toolCount,
          updatedAt: entry.updatedAt,
          ...(entry.error !== undefined ? { error: entry.error } : {}),
        };
      }
      return servers;
    } finally {
      client.close();
    }
  }

  // -------------------------------------------------------------------------
  // AgentProvider: session
  // -------------------------------------------------------------------------

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const discovery = await this.getDiscovery();
    if (!discovery.path || discovery.errorCode) {
      throw new ZCodeProtocolError(
        discovery.errorCode === "zcode_cli_unsupported_version"
          ? "zcode_cli_unsupported_version"
          : "zcode_cli_not_found",
        `ZCode CLI unavailable: ${discovery.errorCode ?? "not found"}`,
      );
    }

    const launch = resolveZCodeLaunchCommand(discovery.path);
    const queue = new MessageQueue({ preserveAttachments: true });
    const abortController = new AbortController();
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    let activeClient: ZCodeProtocolClient | null = null;
    let sessionId: string | undefined;
    /** Tracks the session's current model for capability checks (setModel
     * switches update it). */
    let currentModel = options.model;

    const state: ZCodeEventConverterState = createZCodeEventConverterState();

    const iterator = this.runSession(
      options,
      launch,
      queue,
      abortController.signal,
      state,
      (client) => {
        activeClient = client;
      },
      (id) => {
        sessionId = id;
      },
    );

    return {
      iterator,
      queue,
      abort: () => {
        abortController.abort();
        activeClient?.close();
      },
      isProcessAlive: () => activeClient?.isAlive() ?? false,
      pid: () => activeClient?.pid,
      get sessionId() {
        return sessionId;
      },
      interrupt: async () => {
        const client = activeClient;
        if (!client?.isAlive() || !sessionId) {
          throw new Error("ZCode interrupt requires an active session");
        }
        await client.request("session/stop", { sessionId });
      },
      setModel: async (model?: string) => {
        const client = activeClient;
        if (!client?.isAlive() || !sessionId) {
          throw new Error("ZCode setModel requires an active session");
        }
        // Resolve composite ID back to provider/model pair.
        const config = await this.loadConfig();
        const catalogMap = buildZCodeCatalogMap(config.catalog);
        const entry = model ? catalogMap.get(model) : undefined;
        if (model && !entry) {
          throw new ZCodeProtocolError(
            "zcode_model_unavailable",
            `Unknown model: ${model}`,
          );
        }
        // Real CLI uses `model: {providerId, modelId}` (NOT top-level fields).
        await client.request("session/setModel", {
          sessionId,
          ...(entry
            ? {
                model: { providerId: entry.providerId, modelId: entry.modelId },
              }
            : {}),
        });
        currentModel = model;
      },
      compact: async () => {
        const client = activeClient;
        if (!client?.isAlive() || !sessionId) {
          throw new Error("ZCode compact requires an active session");
        }
        // Real CLI 0.16.1: strict params {sessionId}, requires an active
        // session — the error text above covers the inactive case.
        await client.request("session/compact", { sessionId });
      },
      getGoal: async () => {
        const client = activeClient;
        if (!client?.isAlive() || !sessionId) {
          throw new Error("ZCode goal requires an active session");
        }
        // Real CLI 0.16.1: strict params {sessionId, action, ...}; the result
        // `response` is the CLI-rendered goal status text.
        const result = await client.request<ZCodeSessionGoalResult>(
          "session/goal",
          { sessionId, action: "show" },
        );
        return {
          response: result.response,
          ...(result.startedTurn !== undefined
            ? { startedTurn: result.startedTurn }
            : {}),
        };
      },
      goalAction: async (action, objective) => {
        const client = activeClient;
        if (!client?.isAlive() || !sessionId) {
          throw new Error("ZCode goal requires an active session");
        }
        // set/replace carry the objective text and may start a turn
        // immediately (startedTurn) — the user triggers them explicitly.
        const result = await client.request<ZCodeSessionGoalResult>(
          "session/goal",
          {
            sessionId,
            action,
            ...(objective !== undefined ? { objective } : {}),
          },
        );
        return {
          response: result.response,
          ...(result.startedTurn !== undefined
            ? { startedTurn: result.startedTurn }
            : {}),
        };
      },
      setReasoningEffort: async (effort: string) => {
        const client = activeClient;
        if (!client?.isAlive() || !sessionId) {
          throw new Error(
            "ZCode setReasoningEffort requires an active session",
          );
        }
        // Fail closed: the thought level must be one the session's current
        // model actually advertises. When the model is unknown (no explicit
        // selection) ZCode keeps its own default, so any mid-session switch
        // is rejected rather than sent blind.
        const config = await this.loadConfig();
        const catalogMap = buildZCodeCatalogMap(config.catalog);
        const modelEntry = currentModel
          ? catalogMap.get(currentModel)
          : undefined;
        const thoughtLevel = resolveZCodeThoughtLevel(modelEntry, effort);
        if (!thoughtLevel) {
          throw new ZCodeProtocolError(
            "zcode_model_unavailable",
            `Thought level "${effort}" is not supported by the current model`,
          );
        }
        await client.request("session/setThoughtLevel", {
          sessionId,
          thoughtLevel,
        });
      },
      setPermissionMode: async (mode: PermissionMode) => {
        const client = activeClient;
        if (!client?.isAlive() || !sessionId) {
          throw new Error("ZCode setPermissionMode requires an active session");
        }
        const zcodeMode = YEP_TO_ZCODE_MODE_MAP[mode];
        await client.request("session/setMode", { sessionId, mode: zcodeMode });
      },
      // Model catalog with per-model thought levels, so the mid-session
      // switcher (ModelSwitchModal) can offer both models and effort levels.
      supportedModels: () => this.getAvailableModels(),
    };
  }

  // -------------------------------------------------------------------------
  // runSession — the async generator that yields SDKMessages
  // -------------------------------------------------------------------------

  private async *runSession(
    options: StartSessionOptions,
    launch: { command: string; args: string[]; isCjs: boolean },
    queue: MessageQueue,
    signal: AbortSignal,
    state: ZCodeEventConverterState,
    setActiveClient: (client: ZCodeProtocolClient) => void,
    setSessionId: (id: string) => void,
  ): AsyncIterableIterator<SDKMessage> {
    const client = new ZCodeProtocolClient({
      command: launch.command,
      args: launch.args,
      env: process.env,
      cwd: options.cwd,
    });
    setActiveClient(client);

    let resolvedSessionId: string | undefined;

    try {
      // Query-only provider APIs intentionally stop at loadConfig(). Creating
      // the CLI bootstrap file is a session-start side effect and belongs only
      // on this execution path.
      const config = await this.loadConfig();
      await this.ensureCliConfig(this.getConfigDir(), config);

      await client.connect();
      log.info("zcode app-server connected");

      // Build workspace identity for all protocol methods.
      const workspace = buildWorkspaceIdentity(options.cwd);

      // Inject provider registry.
      // Real ZCode 0.16.1 requires:
      //   {workspace, registry: {revision, generatedAt, providers[]}, includeWorkspaceState?}
      const registryProviders = buildZCodeProviderRegistry(config);
      if (registryProviders.length > 0) {
        const registry = {
          revision: `yep-${Date.now()}`,
          generatedAt: Date.now(),
          providers: registryProviders,
        };
        await client.request("workspace/updateProviderRegistry", {
          workspace,
          registry,
        });
      }

      // Wire server request handler for permission/user-input requests.
      client.setServerRequestHandler(async (request) =>
        this.handleServerRequest(request, options, signal),
      );

      // Create or resume session.
      // Real ZCode 0.16.1 session/create requires `workspace` (NOT `cwd`),
      // and optional `model`, `runtimeModel`, `mode`, `persistence`,
      // `thoughtLevel`.
      // The result is a snapshot: result.session.sessionId (NOT result.id).
      const zcodeMode = options.permissionMode
        ? YEP_TO_ZCODE_MODE_MAP[options.permissionMode]
        : undefined;
      const catalogMap = buildZCodeCatalogMap(config.catalog);
      const modelEntry = options.model
        ? catalogMap.get(options.model)
        : undefined;
      const modelRef = modelEntry
        ? { providerId: modelEntry.providerId, modelId: modelEntry.modelId }
        : undefined;
      const thoughtLevel = resolveZCodeThoughtLevel(
        modelEntry,
        options.reasoningEffort,
      );

      interface ZCodeSessionSnapshot {
        session: { sessionId: string; title?: string };
      }

      let snapshot: ZCodeSessionSnapshot | undefined;
      if (options.resumeSessionId && options.resumeSessionAt) {
        // Edit-fork: fork the source session before the edited message.
        // The forked session becomes active+resumed inside this app-server,
        // so no second resume snapshot is produced.
        resolvedSessionId = await this.forkSessionForEdit(
          client,
          options.resumeSessionId,
          options.resumeSessionAt,
          workspace,
          thoughtLevel,
        );
      } else if (options.resumeSessionId) {
        // Real CLI uses `sessionId` (NOT `id`), and the params schema is
        // `.strict()`: it accepts only sessionId/workspace/runtimeModel/
        // thoughtLevel/mcpServers/toolAllowlist/toolDenylist. Sending `model`
        // or `mode` here fails the whole resume with -32602, so both are
        // applied afterwards through their own methods.
        snapshot = await client.request<ZCodeSessionSnapshot>(
          "session/resume",
          {
            sessionId: options.resumeSessionId,
            workspace,
            ...(thoughtLevel ? { thoughtLevel } : {}),
          },
        );
      } else {
        snapshot = await client.request<ZCodeSessionSnapshot>(
          "session/create",
          {
            workspace,
            ...(modelRef ? { model: modelRef } : {}),
            ...(zcodeMode ? { mode: zcodeMode } : {}),
            ...(thoughtLevel ? { thoughtLevel } : {}),
          },
        );
      }

      // Parse session ID from snapshot: result.session.sessionId
      resolvedSessionId = resolvedSessionId ?? snapshot?.session?.sessionId;
      if (!resolvedSessionId) {
        throw new ZCodeProtocolError(
          "zcode_protocol_closed",
          "ZCode session/create did not return a session ID",
        );
      }
      setSessionId(resolvedSessionId);

      // Resume cannot carry model/mode, so apply them once the session exists.
      // The same holds for edit-fork: the fork inherits the source's
      // mode/model/thoughtLevel, and explicit overrides are applied here.
      if (options.resumeSessionId) {
        if (modelRef) {
          await client.request("session/setModel", {
            sessionId: resolvedSessionId,
            model: modelRef,
          });
        }
        if (zcodeMode) {
          await client.request("session/setMode", {
            sessionId: resolvedSessionId,
            mode: zcodeMode,
          });
        }
      }

      // Subscribe to events.
      await client.request("session/subscribe", {
        sessionId: resolvedSessionId,
        deliveryKind: ZCODE_PREFERRED_DELIVERY_KIND,
      });

      // Yield system/init.
      yield {
        type: "system",
        subtype: "init",
        session_id: resolvedSessionId,
        cwd: options.cwd,
        ...(options.model ? { model: options.model } : {}),
      };

      // Turn loop: drain queue → send → process notifications.
      const messageGen = queue.generator();
      let isFirstMessage = true;

      for await (const message of messageGen) {
        if (signal.aborted) break;

        const { internalPrompt, publicPrompt } =
          getUserPromptProjection(message);
        if (!internalPrompt) continue;

        // Prepend global instructions to the first message.
        let prompt = internalPrompt;
        if (isFirstMessage && options.globalInstructions) {
          prompt = `${options.globalInstructions}\n\n${internalPrompt}`;
          isFirstMessage = false;
        }

        // Send user message to app-server.
        // Real CLI uses `content` (string, NOT nested message object),
        // plus `sessionId` and optional `inputId`/`queryId`/`attachments`.
        // Attachments use the CLI's loose record shape — see attachments.ts.
        const wireAttachments = buildZCodeWireAttachments(message);
        await client.request("session/send", {
          sessionId: resolvedSessionId,
          content: prompt,
          ...(wireAttachments ? { attachments: wireAttachments } : {}),
        });

        // Yield the user echo.
        yield {
          type: "user",
          uuid: message.uuid,
          session_id: resolvedSessionId,
          message: {
            role: "user",
            content: publicPrompt ?? internalPrompt,
          },
        };

        // Drain notifications until turn completes or fails.
        let turnComplete = false;
        while (!turnComplete && !signal.aborted) {
          let notification: { method: string; params?: unknown };
          try {
            notification = await client.nextNotification(signal);
          } catch (notifError) {
            // Notification queue closed (process exited or abort).
            if (signal.aborted) break;
            throw notifError;
          }

          // Terminal error notification from process close.
          if (notification.method === "error") {
            const params =
              (notification.params as Record<string, unknown>) ?? {};
            const errorObj = params.error as { message?: string } | undefined;
            yield {
              type: "error",
              session_id: resolvedSessionId,
              error:
                errorObj?.message ?? "ZCode app-server closed unexpectedly",
            };
            turnComplete = true;
            break;
          }

          const messages = convertZCodeNotificationToSDKMessages(
            notification,
            state,
            resolvedSessionId,
          );

          for (const msg of messages) {
            yield msg;
            // Check for terminal messages.
            if (msg.type === "result") {
              turnComplete = true;
            }
          }
        }
      }
    } catch (error) {
      if (signal.aborted) {
        // Aborted — don't yield error, just exit.
        return;
      }
      const errorMessage =
        error instanceof Error ? error.message : "ZCode session failed";
      log.error({ error: errorMessage }, "zcode session error");
      if (resolvedSessionId) {
        yield {
          type: "error",
          session_id: resolvedSessionId,
          error: errorMessage,
        };
      } else {
        yield {
          type: "error",
          error: errorMessage,
        };
      }
    } finally {
      client.close();
      if (resolvedSessionId) {
        yield {
          type: "result",
          session_id: resolvedSessionId,
        };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Edit-fork (resumeSessionAt)
  // -------------------------------------------------------------------------

  /**
   * Fork the source session before an edited user message and return the
   * forked session ID.
   *
   * Real ZCode CLI 0.16.1 semantics:
   *   - Fork requires the source session to be active in this app-server
   *     process, so it is resumed first.
   *   - A `message` target forks INCLUSIVELY (history up to and including the
   *     target). Yep's edit semantics are exclusive, so the fork targets the
   *     message BEFORE the edited one.
   *   - Editing the first message has no predecessor to target, so this path
   *     fails closed with `zcode_first_message_edit_unsupported`.
   *   - The fork inherits the source's mode/model/thoughtLevel and becomes
   *     active+resumed automatically; the source stays preserved on disk and
   *     is closed here as a best-effort cleanup.
   */
  private async forkSessionForEdit(
    client: ZCodeProtocolClient,
    sourceSessionId: string,
    editedMessageId: string,
    workspace: { workspacePath: string; workspaceKey: string },
    thoughtLevel: string | undefined,
  ): Promise<string> {
    // Activate the source session inside this app-server process.
    await client.request("session/resume", {
      sessionId: sourceSessionId,
      workspace,
      ...(thoughtLevel ? { thoughtLevel } : {}),
    });

    // Locate the edited message in the ordered message list. The result
    // shape is only contractually `{messages: [...]}` with tolerant id
    // extraction (`m.id ?? m.info?.id`); order is authoritative.
    const messagesResult = await client.request<unknown>("session/messages", {
      sessionId: sourceSessionId,
    });
    const messageIds = extractZCodeMessageIds(messagesResult);
    const editIndex = messageIds.indexOf(editedMessageId);
    if (editIndex < 0) {
      throw new ZCodeProtocolError(
        "zcode_session_not_found",
        "ZCode edit fork could not find message in session: edited message not present in session/messages",
      );
    }
    if (editIndex === 0) {
      throw new ZCodeProtocolError(
        "zcode_first_message_edit_unsupported",
        "ZCode edit fork cannot rewind before the first message of a session; editing the first message is not supported",
      );
    }

    const forkResult = await client.request<ZCodeSessionForkResult>(
      "session/fork",
      {
        sessionId: sourceSessionId,
        target: { kind: "message", messageId: messageIds[editIndex - 1] },
      },
    );
    const forkedSessionId = forkResult.forkedSessionId;
    if (!forkedSessionId) {
      throw new ZCodeProtocolError(
        "zcode_protocol_closed",
        "ZCode session/fork did not return a forked session ID",
      );
    }

    // The forked child is already active in this app-server; release the
    // source session. Best-effort: a close failure must not abandon the fork.
    try {
      await client.request("session/close", { sessionId: sourceSessionId });
    } catch (closeError) {
      log.warn(
        {
          error:
            closeError instanceof Error
              ? closeError.message
              : String(closeError),
        },
        "zcode edit-fork source session close failed (continuing)",
      );
    }

    return forkedSessionId;
  }

  // -------------------------------------------------------------------------
  // Server request handler (permission / user input)
  // -------------------------------------------------------------------------

  private async handleServerRequest(
    request: {
      id: string | number;
      method: string;
      params?: unknown;
    },
    options: StartSessionOptions,
    signal: AbortSignal,
  ): Promise<unknown> {
    const method = request.method;
    const params =
      (request.params as Record<string, unknown> | undefined) ?? {};

    if (method === "interaction/requestPermission") {
      return this.handlePermissionRequest(params, options, signal, request.id);
    }

    if (method === "interaction/requestUserInput") {
      return this.handleUserInputRequest(params, options, signal, request.id);
    }

    if (method === "interaction/requestProviderRuntimeHeaders") {
      return this.handleRuntimeHeadersRequest(params);
    }

    if (method === "session/requestRuntimePreferences") {
      return this.handleRuntimePreferencesRequest(options);
    }

    // Browser requests are unsupported in P1.
    if (
      method === "interaction/browserList" ||
      method === "interaction/browserExecute"
    ) {
      throw new ZCodeProtocolError(
        "zcode_server_request_unsupported",
        `Browser requests are not supported: ${method}`,
      );
    }

    throw new ZCodeProtocolError(
      "zcode_server_request_unsupported",
      `Unsupported server request: ${method}`,
    );
  }

  private async handlePermissionRequest(
    params: Record<string, unknown>,
    options: StartSessionOptions,
    signal: AbortSignal,
    requestId: string | number,
  ): Promise<{ decision: string }> {
    const toolName =
      typeof params.toolName === "string" ? params.toolName : "Unknown";
    const toolInput = params.input ?? params;

    if (!options.onToolApproval) {
      return { decision: "deny" };
    }

    const result = await options.onToolApproval(toolName, toolInput, {
      signal,
      requestId: `zcode:${typeof requestId}:${String(requestId)}`,
      requestMethod: "interaction/requestPermission",
      respectProviderDecision: true,
    });

    // Map Yep result to ZCode native decision.
    if (result.behavior === "allow") {
      if (result.approvalScope === "always") {
        return { decision: "allow_always" };
      }
      if (result.providerDecision === "approve_for_session") {
        return { decision: "allow_session" };
      }
      return { decision: "allow_once" };
    }
    return { decision: "deny" };
  }

  private async handleUserInputRequest(
    params: Record<string, unknown>,
    options: StartSessionOptions,
    signal: AbortSignal,
    requestId: string | number,
  ): Promise<{ answers: unknown }> {
    const toolName =
      typeof params.toolName === "string" ? params.toolName : "AskUserQuestion";
    const toolInput = {
      ...params,
      isBlocking: true,
    };

    if (!options.onToolApproval) {
      throw new ZCodeProtocolError(
        "zcode_server_request_unsupported",
        "No interactive input handler available",
      );
    }

    const result = await options.onToolApproval(toolName, toolInput, {
      signal,
      requestId: `zcode:${typeof requestId}:${String(requestId)}`,
      requestMethod: "interaction/requestUserInput",
      respectProviderDecision: true,
    });

    if (result.behavior !== "allow") {
      throw new ZCodeProtocolError(
        "zcode_server_request_unsupported",
        "User input request was declined",
      );
    }

    const answers =
      (result.updatedInput as { answers?: unknown })?.answers ?? {};
    return { answers };
  }

  private async handleRuntimeHeadersRequest(
    params: Record<string, unknown>,
  ): Promise<{ headers: Record<string, string> }> {
    // Real CLI 0.16.1 sends `interaction/requestProviderRuntimeHeaders` before
    // each model request.  The response should contain the runtime headers
    // (e.g. Authorization, X-Sub-Module) for the provider.
    // We return headers from the provider config options, never logging them.
    const providerId =
      typeof params.providerId === "string" ? params.providerId : null;
    if (!providerId) return { headers: {} };

    const config = await this.loadConfig();
    const provider = config.providers.find((p) => p.id === providerId);
    if (!provider?.headers) return { headers: {} };

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(provider.headers)) {
      if (typeof v === "string") headers[k] = v;
    }
    return { headers };
  }

  private async handleRuntimePreferencesRequest(
    _options: StartSessionOptions,
  ): Promise<unknown> {
    // Real CLI 0.16.1 `session/requestRuntimePreferences` expects a response
    // with `nativeSearchEnhancementsEnabled` (boolean, required) and optionally
    // `memoryEnabled` (boolean).  It does NOT accept `model` or `mode` fields.
    return {
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async getDiscovery(): Promise<{
    path: string | null;
    version: string | null;
    errorCode: string | null;
    isCjs: boolean;
  }> {
    if (this.discoveryCache) return this.discoveryCache;

    if (this.config.cliPath) {
      this.discoveryCache = {
        path: this.config.cliPath,
        version: null,
        errorCode: null,
        isCjs: this.config.cliPath.endsWith(".cjs"),
      };
      return this.discoveryCache;
    }

    const result = await discoverZCodeCli();
    this.discoveryCache = {
      path: result.path,
      version: result.version,
      errorCode: result.errorCode,
      isCjs: result.isCjs,
    };
    return this.discoveryCache;
  }

  private getConfigDir(): string {
    return this.config.configDir ?? join(homedir(), ".zcode");
  }

  private async loadConfig(): Promise<ZCodeConfigParseResult> {
    const configDir = this.getConfigDir();
    const v2Dir = join(configDir, "v2");
    let configJson: unknown;
    let credentialsJson: unknown;

    try {
      const configRaw = await fs.readFile(join(v2Dir, "config.json"), "utf-8");
      configJson = JSON.parse(configRaw);
    } catch {
      return {
        providers: [],
        models: [],
        catalog: [],
        errorCode: "zcode_config_unavailable",
      };
    }

    try {
      const credRaw = await fs.readFile(
        join(v2Dir, "credentials.json"),
        "utf-8",
      );
      credentialsJson = JSON.parse(credRaw);
    } catch {
      credentialsJson = {};
    }

    return parseZCodeConfig(configJson, credentialsJson);
  }

  /**
   * Ensure `~/.zcode/cli/config.json` exists with a selected model. The real
   * CLI 0.16.1 accepts the composite model string here; provider definitions
   * and credentials are injected later through `workspace/updateProviderRegistry`.
   *
   * Security invariants:
   *   - Never copy `v2/config.json`: it may contain API keys and headers.
   *   - Create the file atomically with mode 0600.
   *   - Preserve existing content, but tighten an existing file to mode 0600.
   *   - Call only from the session execution path, never provider queries.
   */
  private async ensureCliConfig(
    configDir: string,
    parsed: ZCodeConfigParseResult,
  ): Promise<void> {
    const cliDir = join(configDir, "cli");
    const cliConfigPath = join(cliDir, "config.json");

    // Preserve an existing ZCode-managed config, but ensure secrets in it are
    // not readable by group/other users.
    try {
      await fs.chmod(cliConfigPath, 0o600);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    // Find the first available model.
    const availableModel = parsed.catalog.find((e) => e.available);
    if (!availableModel) return;

    // The model ref is the only bootstrap value the CLI needs before Yep
    // injects the full in-memory provider registry over stdio.
    const cliConfig = {
      model: `${availableModel.providerId}/${availableModel.modelId}`,
    };

    try {
      await fs.mkdir(cliDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(cliConfigPath, JSON.stringify(cliConfig, null, 2), {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      log.info(
        {
          providerId: availableModel.providerId,
          modelId: availableModel.modelId,
        },
        "zcode cli config created for model resolution",
      );
    } catch (err) {
      // Another concurrent session may have created the file after our
      // initial chmod attempt. Preserve its content and secure its mode.
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        await fs.chmod(cliConfigPath, 0o600);
        return;
      }
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "zcode cli config creation failed",
      );
    }
  }
}

// =============================================================================
// Singleton
// =============================================================================

export const zcodeProvider = new ZCodeProvider();

// Suppress unused import warnings for types used only in signatures.
void ZCODE_COMPATIBILITY_BASELINE;
void isZCodeVersionGte;
void (null as unknown as ChildProcess);
