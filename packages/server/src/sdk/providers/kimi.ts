/**
 * Kimi ACP Provider implementation using Agent Client Protocol.
 *
 * Kimi Code CLI ships a first-class ACP server (`kimi acp`) that is richer
 * than Gemini's: it supports session/new, session/load (history replay),
 * session/resume, configOptions (model + mode selection) and terminal-auth.
 *
 * Like Gemini, Kimi executes its own tools internally and only asks for
 * permission on sensitive operations. This provider routes those ACP
 * `session/request_permission` requests through yepanywhere's approval flow
 * (the same in-process path Gemini uses) — no standalone bridge process is
 * required, unlike the Codex (4510) / OpenCode (4520) bridges.
 *
 * Session content modification (fork / branch / rollback) is intentionally
 * not implemented in this phase: Kimi only exposes fork/undo through its
 * node-sdk / kap-server REST surface, never over ACP. See
 * docs/project/kimi-cli-integration.md.
 */

import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { ModelInfo } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { whichCommand } from "../cli-detection.js";
const execAsync = promisify(exec);
import { MessageQueue } from "../messageQueue.js";
import type {
  CanUseTool,
  PermissionMode,
  SDKMessage,
  ToolApprovalResult,
  UserMessage,
} from "../types.js";
import { ACPClient } from "./acp/client.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderName,
  StartSessionOptions,
} from "./types.js";

/** Kimi home directory (config + sessions live here). */
const KIMI_HOME = process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");
/** Kimi global config file. */
const KIMI_CONFIG_PATH = join(KIMI_HOME, "config.toml");

/**
 * Fallback model list used when config.toml cannot be parsed. The real
 * catalog is derived from `[models."..."]` sections in config.toml.
 */
const KIMI_FALLBACK_MODELS: ModelInfo[] = [{ id: "kimi-k3", name: "Kimi K3" }];

/**
 * Configuration for the Kimi ACP provider.
 */
export interface KimiProviderConfig {
  /** Path to the kimi binary (auto-detected if not specified). */
  kimiPath?: string;
}

/**
 * Kimi ACP Provider implementation.
 *
 * Uses `kimi acp` (ACP over stdio). The agent controls its own tool loop;
 * we only handle permission requests and stream session updates back as
 * SDKMessages.
 */
export class KimiProvider implements AgentProvider {
  readonly name: ProviderName = "kimi";
  readonly displayName = "Kimi";
  // ACP permission requests are routed through Yep's approval flow.
  readonly supportsPermissionMode = true;
  readonly permissionModes = [
    "default",
    "plan",
    "acceptEdits",
    "bypassPermissions",
  ] as const;
  // Kimi exposes thinking effort levels via config; a simple toggle is not
  // the right surface, so keep it off for the initial integration.
  readonly supportsThinkingToggle = false;
  readonly supportsSlashCommands = false;

  private readonly kimiPath?: string;
  private log = getLogger();

  constructor(config: KimiProviderConfig = {}) {
    this.kimiPath = config.kimiPath;
  }

  async isInstalled(): Promise<boolean> {
    const path = await this.findKimiPath();
    return path !== null;
  }

  async isAuthenticated(): Promise<boolean> {
    const authStatus = await this.getAuthStatus();
    return authStatus.authenticated;
  }

  /**
   * Detailed auth status.
   *
   * Kimi stores credentials/config under ~/.kimi-code. For the initial
   * integration we treat a config.toml that declares a provider or an
   * api_key (managed OAuth also writes here) as "authenticated". A full
   * device-code login check can be layered on later.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    if (!installed) {
      return { installed: false, authenticated: false, enabled: false };
    }

    if (!existsSync(KIMI_CONFIG_PATH)) {
      return { installed: true, authenticated: false, enabled: false };
    }

    try {
      const config = readFileSync(KIMI_CONFIG_PATH, "utf-8");
      const configured =
        /\bapi_key\s*=/.test(config) || /\[providers\./.test(config);
      return {
        installed: true,
        authenticated: configured,
        enabled: configured,
      };
    } catch {
      return { installed: true, authenticated: false, enabled: false };
    }
  }

  /**
   * Available models, derived from `[models."..."]` sections in config.toml.
   * Falls back to a static list when the config cannot be read/parsed.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    if (!existsSync(KIMI_CONFIG_PATH)) {
      return KIMI_FALLBACK_MODELS;
    }
    try {
      const config = readFileSync(KIMI_CONFIG_PATH, "utf-8");
      const models = this.parseModelIds(config);
      return models.length > 0 ? models : KIMI_FALLBACK_MODELS;
    } catch {
      return KIMI_FALLBACK_MODELS;
    }
  }

  /**
   * Extract model alias ids from `[models."<id>"]` TOML section headers.
   * Lightweight, dependency-free — sufficient for the picker.
   */
  private parseModelIds(configToml: string): ModelInfo[] {
    const ids = new Set<string>();
    const sectionRe = /^\s*\[models\.(?:"([^"]+)"|([^\]\s.]+))\]/gm;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
    while ((match = sectionRe.exec(configToml)) !== null) {
      const id = match[1] ?? match[2];
      if (id) ids.add(id);
    }
    return Array.from(ids, (id) => ({ id, name: this.modelDisplayName(id) }));
  }

  /** Human-friendly label for a model alias id like "custom-kimi/kimi-k3". */
  private modelDisplayName(id: string): string {
    const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
    return tail;
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue();
    const abortController = new AbortController();

    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    const client = new ACPClient();
    const iterator = this.runSession(
      client,
      options,
      queue,
      abortController.signal,
    );

    return {
      iterator,
      queue,
      abort: () => {
        abortController.abort();
        client.close();
      },
      get pid() {
        return client.pid;
      },
    };
  }

  /**
   * Main session loop using the ACP protocol.
   */
  private async *runSession(
    client: ACPClient,
    options: StartSessionOptions,
    queue: MessageQueue,
    signal: AbortSignal,
  ): AsyncIterableIterator<SDKMessage> {
    const kimiPath = await this.findKimiPath();
    if (!kimiPath) {
      yield {
        type: "error",
        error:
          "Kimi CLI not found. Install it from https://moonshotai.github.io/kimi-code/",
      } as SDKMessage;
      return;
    }

    // `kimi acp` runs the ACP server; the global `-m` flag (accepted before
    // the subcommand) selects the model alias for this invocation. Thinking
    // effort is not exposed as a CLI flag, so it falls back to the model's
    // config.toml default; per-session effort override would require ACP
    // configOptions support in ACPClient.
    const args: string[] = [];
    if (options.model) {
      args.push("-m", options.model);
    }
    args.push("acp");

    // Collect session updates to convert to SDKMessages.
    const updateQueue: SessionNotification[] = [];
    let updateResolver: (() => void) | null = null;
    client.setSessionUpdateCallback((update) => {
      updateQueue.push(update);
      if (updateResolver) {
        updateResolver();
        updateResolver = null;
      }
    });

    this.log.debug(
      { hasOnToolApproval: !!options.onToolApproval },
      "Setting up Kimi ACP permission handler",
    );
    if (options.onToolApproval) {
      client.setPermissionRequestCallback(async (request) =>
        this.handlePermissionRequest(request, options, signal),
      );
    } else {
      this.log.warn(
        "No onToolApproval callback provided - Kimi permissions will be auto-denied",
      );
    }

    try {
      const connectStart = Date.now();
      await client.connect({ command: kimiPath, args, cwd: options.cwd });
      this.log.info(
        { durationMs: Date.now() - connectStart },
        "Kimi ACP connected (kimi acp)",
      );

      const initStart = Date.now();
      await client.initialize({});
      this.log.debug(
        { durationMs: Date.now() - initStart },
        "Kimi ACP initialized",
      );

      // Create or resume the ACP session.
      let sessionId: string;
      if (options.resumeSessionId) {
        try {
          sessionId = await client.resumeSession(
            options.resumeSessionId,
            options.cwd,
          );
          this.log.debug({ sessionId }, "Kimi ACP session resumed");
        } catch (resumeErr) {
          this.log.warn(
            { err: resumeErr, resumeSessionId: options.resumeSessionId },
            "Failed to resume Kimi ACP session, creating new session",
          );
          sessionId = await client.newSession(options.cwd);
          this.log.debug(
            { sessionId, originalSessionId: options.resumeSessionId },
            "Created new Kimi ACP session (resume failed)",
          );
        }
      } else {
        sessionId = await client.newSession(options.cwd);
        this.log.debug({ sessionId }, "Kimi ACP session created");
      }

      yield {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: options.cwd,
      } as SDKMessage;

      const messageGen = queue.generator();
      let isFirstNewMessage = true;
      for await (const message of messageGen) {
        if (signal.aborted) break;

        let userText = this.extractTextFromMessage(message);

        if (isFirstNewMessage && options.globalInstructions) {
          userText = `[Global context]\n${options.globalInstructions}\n\n---\n\n${userText}`;
        }
        isFirstNewMessage = false;

        const userUuid = (message as { uuid?: string }).uuid ?? randomUUID();
        yield {
          type: "user",
          uuid: userUuid,
          session_id: sessionId,
          message: { role: "user", content: userText },
        } as SDKMessage;

        updateQueue.length = 0;

        const promptStart = Date.now();
        this.log.debug(
          { textLength: userText.length },
          "Sending prompt to Kimi",
        );
        const promptPromise = client.prompt(sessionId, userText);

        for await (const msg of this.yieldUpdates(
          promptPromise,
          updateQueue,
          sessionId,
          signal,
        )) {
          yield msg;
        }
        this.log.debug(
          { durationMs: Date.now() - promptStart },
          "Kimi prompt complete",
        );

        yield { type: "result", session_id: sessionId } as SDKMessage;
      }
    } catch (err) {
      this.log.error({ err }, "Kimi ACP session error");
      yield {
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      } as SDKMessage;
    } finally {
      client.close();
    }
  }

  /**
   * Handle an ACP permission request by routing to Yep's approval flow.
   */
  private async handlePermissionRequest(
    request: RequestPermissionRequest,
    options: StartSessionOptions,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const { onToolApproval, permissionMode } = options;
    if (!onToolApproval) {
      return { outcome: { outcome: "cancelled" } };
    }

    const toolCall = request.toolCall;
    const kind = toolCall.kind ?? "other";

    if (this.shouldAutoApprove(kind, permissionMode)) {
      this.log.debug(
        { kind, permissionMode },
        "Auto-approving Kimi ACP permission request",
      );
      const allowOnceOption = request.options.find(
        (o) => o.kind === "allow_once",
      );
      return {
        outcome: {
          outcome: "selected",
          optionId: allowOnceOption?.optionId ?? "approve_once",
        },
      };
    }

    const toolName = this.mapKindToToolName(kind, toolCall.title ?? undefined);
    const toolInput = {
      kind,
      title: toolCall.title,
      locations: toolCall.locations,
      content: toolCall.content,
      rawInput: toolCall.rawInput,
      // Surface the agent's offered options (e.g. plan_review A/B/C, revise,
      // reject) so the approval UI can display them. Multi-select routing is
      // future work; allow/deny maps to approve/reject below.
      options: request.options,
    };

    this.log.debug(
      { toolName, toolInput },
      "Requesting user approval for Kimi ACP permission",
    );

    const result = await onToolApproval(toolName, toolInput, { signal });
    return this.convertApprovalResultToACPResponse(result, request);
  }

  /**
   * Auto-approve policy based on permission mode and tool kind.
   *
   * Kimi is always run in its default (manual) ACP mode so every sensitive
   * operation surfaces to us; the auto-approve decision is made here rather
   * than by switching Kimi's own mode. `bypassPermissions` approves all;
   * `acceptEdits` approves edits/reads but still prompts for shell commands.
   */
  private shouldAutoApprove(
    kind: ToolKind | null | undefined,
    permissionMode?: PermissionMode,
  ): boolean {
    switch (permissionMode) {
      case "bypassPermissions":
        return true;
      case "acceptEdits":
        return kind === "edit" || kind === "read" || kind === "search";
      case "plan":
        return kind === "read" || kind === "search" || kind === "fetch";
      default:
        return false;
    }
  }

  /**
   * Map an ACP tool kind to a human-readable tool name for the approval UI.
   */
  private mapKindToToolName(
    kind: ToolKind | null | undefined,
    title?: string,
  ): string {
    switch (kind) {
      case "edit":
        return "Write";
      case "delete":
        return "Delete";
      case "move":
        return "Move";
      case "execute":
        return "Bash";
      case "read":
        return "Read";
      case "search":
        return "Search";
      case "fetch":
        return "WebFetch";
      case "think":
        return "Think";
      case "switch_mode":
        return "SwitchMode";
      default:
        return title ?? "KimiTool";
    }
  }

  /**
   * Convert a Yep ToolApprovalResult into an ACP RequestPermissionResponse.
   *
   * Kimi advertises standard ACP option kinds. On approve we pick an
   * allow option (for plan_review, `allow_once` is the first plan option =
   * approve the plan). On deny we prefer a reject option (`reject_once` /
   * plan `Revise` / `Reject and Exit`) so rejection is semantically correct;
   * only when no reject option is offered do we fall back to `cancelled`.
   */
  private convertApprovalResultToACPResponse(
    result: ToolApprovalResult,
    request: RequestPermissionRequest,
  ): RequestPermissionResponse {
    if (result.behavior === "allow") {
      const allowOnceOption = request.options.find(
        (o) => o.kind === "allow_once",
      );
      const allowAlwaysOption = request.options.find(
        (o) => o.kind === "allow_always",
      );
      const selectedOption = allowOnceOption ?? allowAlwaysOption;

      if (selectedOption) {
        return {
          outcome: { outcome: "selected", optionId: selectedOption.optionId },
        };
      }
      return { outcome: { outcome: "selected", optionId: "approve_once" } };
    }

    // Deny: prefer an explicit reject option when the agent offers one.
    const rejectOption = request.options.find(
      (o) => o.kind === "reject_once" || o.kind === "reject_always",
    );
    if (rejectOption) {
      return {
        outcome: { outcome: "selected", optionId: rejectOption.optionId },
      };
    }
    return { outcome: { outcome: "cancelled" } };
  }

  /**
   * Async generator yielding session updates as SDKMessages.
   */
  private async *yieldUpdates(
    promptPromise: Promise<unknown>,
    updateQueue: SessionNotification[],
    sessionId: string,
    signal: AbortSignal,
  ): AsyncIterableIterator<SDKMessage> {
    let promptDone = false;
    promptPromise
      .then(() => {
        promptDone = true;
      })
      .catch((err) => {
        promptDone = true;
        this.log.error({ err }, "Kimi prompt error");
      });

    let assistantTextBuffer = "";
    let assistantMessageId: string | null = null;

    while (!signal.aborted && !promptDone) {
      await new Promise((resolve) => setTimeout(resolve, 50));

      while (updateQueue.length > 0) {
        const notification = updateQueue.shift();
        if (!notification) break;

        const sessionUpdate = notification.update;

        if (
          sessionUpdate.sessionUpdate === "agent_message_chunk" &&
          "content" in sessionUpdate
        ) {
          const content = sessionUpdate.content;
          if (content && typeof content === "object" && "type" in content) {
            if (content.type === "text" && "text" in content) {
              assistantTextBuffer += content.text;
              if (!assistantMessageId) {
                assistantMessageId = randomUUID();
              }
            }
          }
          continue;
        }

        if (assistantTextBuffer) {
          yield {
            type: "assistant",
            uuid: assistantMessageId ?? undefined,
            session_id: sessionId,
            message: { role: "assistant", content: assistantTextBuffer },
          } as SDKMessage;
          assistantTextBuffer = "";
          assistantMessageId = null;
        }

        const sdkMessage = this.convertUpdateToSDKMessage(
          sessionUpdate,
          sessionId,
        );
        if (sdkMessage) {
          yield sdkMessage;
        }
      }
    }

    if (assistantTextBuffer) {
      yield {
        type: "assistant",
        uuid: assistantMessageId ?? undefined,
        session_id: sessionId,
        message: { role: "assistant", content: assistantTextBuffer },
      } as SDKMessage;
    }
  }

  /**
   * Convert an ACP session update into an SDKMessage.
   */
  private convertUpdateToSDKMessage(
    update: SessionUpdate,
    sessionId: string,
  ): SDKMessage | null {
    const updateType = update.sessionUpdate;

    switch (updateType) {
      case "agent_message_chunk": {
        if ("content" in update) {
          const contentBlock = update.content;
          if (
            contentBlock &&
            typeof contentBlock === "object" &&
            "type" in contentBlock &&
            contentBlock.type === "text" &&
            "text" in contentBlock
          ) {
            return {
              type: "assistant",
              session_id: sessionId,
              message: {
                role: "assistant",
                content: contentBlock.text as string,
              },
            } as SDKMessage;
          }
        }
        return null;
      }

      case "tool_call": {
        const toolUpdate = update as {
          toolCallId?: string;
          title?: string;
          status?: string;
        };
        return {
          type: "assistant",
          session_id: sessionId,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: toolUpdate.toolCallId ?? randomUUID(),
                name: toolUpdate.title ?? "unknown_tool",
                input: {},
              },
            ],
          },
        } as SDKMessage;
      }

      case "tool_call_update": {
        const toolResultUpdate = update as {
          toolCallId?: string;
          status?: string;
          error?: string;
        };
        if (toolResultUpdate.error) {
          return {
            type: "user",
            session_id: sessionId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolResultUpdate.toolCallId ?? "",
                  content: toolResultUpdate.error,
                },
              ],
            },
          } as SDKMessage;
        }
        return null;
      }

      case "plan": {
        const planUpdate = update as { content?: string };
        if (planUpdate.content) {
          return {
            type: "assistant",
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: planUpdate.content }],
            },
          } as SDKMessage;
        }
        return null;
      }

      default:
        this.log.trace(
          { updateType, update },
          "Unhandled Kimi ACP update type",
        );
        return null;
    }
  }

  /**
   * Extract text content from a user message.
   */
  private extractTextFromMessage(message: unknown): string {
    if (!message || typeof message !== "object") {
      return "";
    }

    const userMsg = message as { text?: string };
    if (typeof userMsg.text === "string") {
      return userMsg.text;
    }

    const sdkMsg = message as { message?: { content?: string | unknown[] } };
    const content = sdkMsg.message?.content;

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((block: unknown) => {
          if (typeof block === "string") return block;
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as { type: string }).type === "text" &&
            "text" in block
          ) {
            return (block as { text: string }).text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    return "";
  }

  /**
   * Find the kimi CLI path.
   */
  private async findKimiPath(): Promise<string | null> {
    if (this.kimiPath && existsSync(this.kimiPath)) {
      return this.kimiPath;
    }

    const commonPaths = [
      join(KIMI_HOME, "bin", "kimi"),
      join(homedir(), ".local", "bin", "kimi"),
      "/usr/local/bin/kimi",
      join(homedir(), "bin", "kimi"),
    ];

    for (const path of commonPaths) {
      if (existsSync(path)) {
        return path;
      }
    }

    try {
      const { stdout } = await execAsync(whichCommand("kimi"), {
        encoding: "utf-8",
      });
      const result = stdout.trim().split("\n")[0]?.trim();
      if (result && existsSync(result)) {
        return result;
      }
    } catch {
      // Not in PATH
    }

    return null;
  }
}

/**
 * Default Kimi provider instance.
 */
export const kimiProvider = new KimiProvider();
