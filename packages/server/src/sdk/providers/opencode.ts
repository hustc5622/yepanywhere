/**
 * OpenCode Provider implementation using `opencode serve`.
 *
 * This provider enables using OpenCode as an agent backend.
 * It spawns a per-session OpenCode server and communicates via HTTP/SSE.
 *
 * Architecture:
 * - Each session gets its own `opencode serve` process on a unique port
 * - Messages are sent via HTTP POST to /session/:id/message
 * - Responses are streamed via SSE from /event
 * - Server is killed when session is aborted or times out
 */

import { type ChildProcess, exec, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ModelInfo,
  OpenCodeMessagePartUpdatedEvent,
  OpenCodeMessageUpdatedEvent,
  OpenCodeModelLimits,
  OpenCodePart,
  OpenCodeSSEEvent,
  PermissionMode,
} from "@yep-anywhere/shared";
import { parseOpenCodeSSEEvent } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { whichCommand } from "../cli-detection.js";
import { MessageQueue } from "../messageQueue.js";
import type { SDKMessage, ToolApprovalResult } from "../types.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Configuration for OpenCode provider.
 */
export interface OpenCodeProviderConfig {
  /** Path to opencode binary (auto-detected if not specified) */
  opencodePath?: string;
  /** Request timeout in ms (default: 300000 = 5 minutes) */
  timeout?: number;
  /** Base port to start from (auto-selects if not specified) */
  basePort?: number;
}

type OpenCodePermissionAction = "allow" | "ask" | "deny";
type OpenCodePermissionConfig = Record<string, OpenCodePermissionAction>;

type OpenCodeProviderModelLimitConfig = Record<
  string,
  {
    models: Record<
      string,
      {
        limit: OpenCodeModelLimits;
      }
    >;
  }
>;

interface OpenCodePermissionAskedEvent {
  type: "permission.asked";
  properties: {
    id: string;
    sessionID: string;
    permission: string;
    patterns?: string[];
    metadata?: unknown;
    always?: string[];
    tool?: {
      messageID?: string;
      callID?: string;
    };
  };
}

interface OpenCodePermissionRepliedEvent {
  type: "permission.replied";
  properties?: {
    id?: string;
    sessionID?: string;
  };
}

interface OpenCodeMessageResponse {
  info?: {
    error?: {
      name?: string;
      data?: unknown;
    };
  };
}

interface OpenCodeModelRef {
  providerID: string;
  modelID: string;
}

interface OpenCodeRuntimeRef {
  baseUrl?: string;
  currentModel?: string | null;
  cwd?: string;
}

interface OpenCodeSessionCreatePayload {
  title: string;
  location?: {
    directory: string;
  };
  model?: {
    providerID: string;
    id: string;
  };
}

interface OpenCodeMessagePayload {
  parts: Array<{ type: "text"; text: string }>;
  model?: OpenCodeModelRef;
}

interface OpenCodeSessionResponse {
  id: string;
}

interface OpenCodeStreamBlockState {
  index: number;
  type: "text" | "thinking";
  text: string;
}

interface OpenCodeAssistantStreamState {
  messageId: string | null;
  started: boolean;
  stopped: boolean;
  nextBlockIndex: number;
  partBlocks: Map<string, OpenCodeStreamBlockState>;
}

interface OpenCodeEmissionState {
  toolUseIds: Set<string>;
  toolResultIds: Set<string>;
  assistantStream?: OpenCodeAssistantStreamState;
  latestUsage?: Record<string, unknown>;
  latestCost?: number;
  latestModel?: string;
  latestFinish?: string;
  emittedUsageResult?: boolean;
}

type OpenCodeRuntimeEvent =
  | OpenCodeSSEEvent
  | OpenCodePermissionAskedEvent
  | OpenCodePermissionRepliedEvent;

/** Port counter for unique port assignment */
let nextPort = 14100;

/**
 * Get next available port for OpenCode server.
 */
function getNextPort(): number {
  return nextPort++;
}

/**
 * OpenCode Provider implementation.
 *
 * Uses `opencode serve` to run a per-session server, communicating via HTTP/SSE.
 */
export class OpenCodeProvider implements AgentProvider {
  readonly name = "opencode" as const;
  readonly displayName = "OpenCode";
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = false;
  readonly supportsSlashCommands = false;

  private readonly opencodePath?: string;
  private readonly timeout: number;

  constructor(config: OpenCodeProviderConfig = {}) {
    this.opencodePath = config.opencodePath;
    this.timeout = config.timeout ?? 300000; // 5 minutes default
  }

  /**
   * Check if the OpenCode CLI is installed.
   */
  async isInstalled(): Promise<boolean> {
    const path = await this.findOpenCodePath();
    return path !== null;
  }

  /**
   * Check if OpenCode is authenticated.
   * OpenCode handles auth internally via `opencode auth`.
   */
  async isAuthenticated(): Promise<boolean> {
    // OpenCode is authenticated if installed - it has built-in free models
    return this.isInstalled();
  }

  /**
   * Get detailed authentication status.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    if (!installed) {
      return {
        installed: false,
        authenticated: false,
        enabled: false,
      };
    }

    // OpenCode is always authenticated if installed (has free models)
    return {
      installed: true,
      authenticated: true,
      enabled: true,
    };
  }

  /**
   * Get available OpenCode models.
   * Queries the OpenCode CLI for available models.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    const opencodePath = await this.findOpenCodePath();
    if (!opencodePath) {
      return [];
    }

    try {
      const { stdout: result } = await execFileAsync(opencodePath, ["models"], {
        encoding: "utf-8",
        timeout: 10000,
      });

      // Parse model list output. Current OpenCode emits one model per line as
      // provider/model; older/newer versions may include headings or table art.
      const models: ModelInfo[] = [];
      for (const line of result.split("\n")) {
        const trimmed = line.trim();
        if (
          trimmed &&
          !trimmed.startsWith("─") &&
          !trimmed.startsWith("opencode models") &&
          trimmed.includes("/")
        ) {
          models.push({
            id: trimmed,
            name: this.formatModelName(trimmed),
          });
        }
      }

      return models;
    } catch {
      // Return default models if command fails
      return [
        { id: "opencode/big-pickle", name: "Big Pickle (Free)" },
        { id: "auto", name: "Auto (recommended)" },
      ];
    }
  }

  /**
   * Start a new OpenCode session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue();
    const abortController = new AbortController();
    const pidRef: { value?: number } = {};
    const runtimeRef: OpenCodeRuntimeRef = {};

    // Push initial message if provided
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    const iterator = this.runSession(
      options.cwd,
      queue,
      abortController.signal,
      options,
      pidRef,
      runtimeRef,
    );

    return {
      iterator,
      queue,
      abort: () => abortController.abort(),
      get pid() {
        return pidRef.value;
      },
      supportedModels: () => this.getAvailableModels(),
      setModel: async (model?: string) => {
        if (!runtimeRef.baseUrl) return;
        const normalizedModel = await this.resolveOpenCodeModelOption(model);
        await this.patchServerConfig(
          runtimeRef.baseUrl,
          {
            model: normalizedModel ?? undefined,
          },
          runtimeRef.cwd,
        );
        runtimeRef.currentModel = normalizedModel;
      },
    };
  }

  /**
   * Main session loop.
   * Spawns an OpenCode server and manages HTTP/SSE communication.
   */
  private async *runSession(
    cwd: string,
    queue: MessageQueue,
    signal: AbortSignal,
    options: StartSessionOptions,
    pidRef: { value?: number },
    runtimeRef: OpenCodeRuntimeRef,
  ): AsyncIterableIterator<SDKMessage> {
    const log = getLogger();
    const opencodePath = await this.findOpenCodePath();

    if (!opencodePath) {
      yield {
        type: "error",
        error: "OpenCode CLI not found",
      } as SDKMessage;
      return;
    }

    // Allocate a unique port for this session
    const port = getNextPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    runtimeRef.baseUrl = baseUrl;
    runtimeRef.cwd = cwd;

    // Start the OpenCode server
    let serverProcess: ChildProcess;
    try {
      serverProcess = spawn(
        opencodePath,
        [
          "serve",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(port),
          "--print-logs",
        ],
        {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: this.getOpenCodeEnv(),
          shell: process.platform === "win32",
        },
      );
      pidRef.value = serverProcess.pid;
    } catch (error) {
      yield {
        type: "error",
        error: `Failed to spawn OpenCode server: ${error instanceof Error ? error.message : String(error)}`,
      } as SDKMessage;
      return;
    }

    // Handle abort
    const abortHandler = () => {
      log.info({ port }, "Aborting OpenCode server");
      serverProcess.kill("SIGTERM");
    };
    signal.addEventListener("abort", abortHandler);

    // Wait for server to be ready
    const serverReady = await this.waitForServer(baseUrl, 10000, cwd);
    if (!serverReady) {
      serverProcess.kill("SIGTERM");
      signal.removeEventListener("abort", abortHandler);
      yield {
        type: "error",
        error: "OpenCode server failed to start",
      } as SDKMessage;
      return;
    }

    log.info({ port, cwd }, "OpenCode server ready");

    const configApplied = await this.configureServer(baseUrl, options, cwd);
    if (!configApplied.ok) {
      serverProcess.kill("SIGTERM");
      signal.removeEventListener("abort", abortHandler);
      yield {
        type: "error",
        error: configApplied.error,
      } as SDKMessage;
      return;
    }
    runtimeRef.currentModel = configApplied.model;

    // Create, resume, or fork a session on the server.
    let opencodeSessionId: string;
    try {
      const sessionData = await this.prepareOpenCodeSession(
        baseUrl,
        options,
        cwd,
        configApplied.model,
      );
      opencodeSessionId = sessionData.id;
      log.info(
        {
          opencodeSessionId,
          resumeSessionId: options.resumeSessionId ?? null,
          resumeSessionAt: options.resumeSessionAt ?? null,
        },
        "OpenCode session prepared",
      );
    } catch (error) {
      serverProcess.kill("SIGTERM");
      signal.removeEventListener("abort", abortHandler);
      yield {
        type: "error",
        error: `Failed to create OpenCode session: ${error instanceof Error ? error.message : String(error)}`,
      } as SDKMessage;
      return;
    }

    // Use OpenCode's persisted session ID so Yep process ownership lines up
    // with the session stored in ~/.local/share/opencode/opencode.db.
    const sessionId = opencodeSessionId;

    // Emit init message
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd,
      model: runtimeRef.currentModel ?? undefined,
    } as SDKMessage;

    try {
      // Process messages from the queue
      const messageGen = queue.generator();
      let isFirstNewMessage = true;
      for await (const message of messageGen) {
        if (signal.aborted) break;

        // Extract text from the user message
        let userPrompt = this.extractTextFromMessage(message);

        // Prepend global instructions to the first message of new sessions
        if (isFirstNewMessage && options.globalInstructions) {
          userPrompt = `[Global context]\n${options.globalInstructions}\n\n---\n\n${userPrompt}`;
        }
        isFirstNewMessage = false;

        // Emit user message
        yield {
          type: "user",
          uuid: message.uuid,
          session_id: sessionId,
          message: {
            role: "user",
            content: userPrompt,
          },
        } as SDKMessage;

        // Send message to OpenCode server and stream response
        yield* this.sendMessageAndStream(
          baseUrl,
          opencodeSessionId,
          sessionId,
          userPrompt,
          signal,
          options.onToolApproval,
          runtimeRef.currentModel,
          cwd,
        );
      }
    } finally {
      // Clean up server
      log.info({ port, sessionId }, "Shutting down OpenCode server");
      signal.removeEventListener("abort", abortHandler);

      if (!serverProcess.killed) {
        serverProcess.kill("SIGTERM");
      }
      runtimeRef.baseUrl = undefined;
      runtimeRef.cwd = undefined;
    }
  }

  private async prepareOpenCodeSession(
    baseUrl: string,
    options: StartSessionOptions,
    cwd: string,
    model: string | null,
  ): Promise<OpenCodeSessionResponse> {
    if (!options.resumeSessionId) {
      return this.createOpenCodeSession(baseUrl, cwd, model);
    }

    if (options.resumeSessionAt) {
      return this.forkOpenCodeSession(
        baseUrl,
        options.resumeSessionId,
        options.resumeSessionAt,
        cwd,
      );
    }

    await this.getOpenCodeSession(baseUrl, options.resumeSessionId, cwd);
    return { id: options.resumeSessionId };
  }

  private async createOpenCodeSession(
    baseUrl: string,
    cwd: string,
    model: string | null,
  ): Promise<OpenCodeSessionResponse> {
    const response = await fetch(this.openCodeUrl(baseUrl, "/session", cwd), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...this.openCodeDirectoryHeaders(cwd),
      },
      body: JSON.stringify(this.buildOpenCodeSessionCreatePayload(cwd, model)),
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.status}`);
    }

    return (await response.json()) as OpenCodeSessionResponse;
  }

  private async getOpenCodeSession(
    baseUrl: string,
    sessionId: string,
    cwd?: string,
  ): Promise<OpenCodeSessionResponse> {
    const response = await fetch(
      this.openCodeUrl(
        baseUrl,
        `/session/${encodeURIComponent(sessionId)}`,
        cwd,
      ),
      {
        headers: {
          Accept: "application/json",
          ...this.openCodeDirectoryHeaders(cwd),
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to load session ${sessionId}: ${response.status}`,
      );
    }

    return (await response.json()) as OpenCodeSessionResponse;
  }

  private async forkOpenCodeSession(
    baseUrl: string,
    sessionId: string,
    messageId: string,
    cwd?: string,
  ): Promise<OpenCodeSessionResponse> {
    const response = await fetch(
      this.openCodeUrl(
        baseUrl,
        `/session/${encodeURIComponent(sessionId)}/fork`,
        cwd,
      ),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...this.openCodeDirectoryHeaders(cwd),
        },
        body: JSON.stringify({ messageID: messageId }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Failed to fork session ${sessionId} at ${messageId}: ${response.status}${errorText ? ` ${errorText}` : ""}`,
      );
    }

    return (await response.json()) as OpenCodeSessionResponse;
  }

  /**
   * Send a message to OpenCode and stream the response via SSE.
   */
  private async *sendMessageAndStream(
    baseUrl: string,
    opencodeSessionId: string,
    sessionId: string,
    text: string,
    signal: AbortSignal,
    onToolApproval?: StartSessionOptions["onToolApproval"],
    model?: string | null,
    cwd?: string,
  ): AsyncIterableIterator<SDKMessage> {
    const log = getLogger();

    const sseUrl = this.openCodeUrl(baseUrl, "/event", cwd);
    const sseController = new AbortController();
    const emissionState: OpenCodeEmissionState = {
      toolUseIds: new Set(),
      toolResultIds: new Set(),
    };

    // Event buffer and signaling for producer/consumer pattern
    // Using an object to avoid TypeScript control flow issues across async boundaries
    const state = {
      eventBuffer: [] as SDKMessage[],
      sseError: null as Error | null,
      sseComplete: false,
      postComplete: false,
      postError: null as Error | null,
      responseError: null as string | null,
      resolveWaiting: null as (() => void) | null,
    };

    // Start SSE connection immediately (runs in background)
    const ssePromise = (async () => {
      try {
        const response = await fetch(sseUrl, {
          headers: {
            Accept: "text/event-stream",
            ...this.openCodeDirectoryHeaders(cwd),
          },
          signal: sseController.signal,
        });

        if (!response.ok || !response.body) {
          log.error({ status: response.status }, "Failed to connect to SSE");
          state.sseError = new Error(
            `SSE connection failed: ${response.status}`,
          );
          return;
        }

        log.debug({ sseUrl }, "SSE connected");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentAssistantMessageId: string | null = null;
        const messageRoles = new Map<string, "user" | "assistant">();

        while (!sseController.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete lines
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;

            const data = line.slice(6);
            const event = parseOpenCodeSSEEvent(data);
            if (!event) continue;

            log.trace({ event }, "SSE event received");

            // Filter to only events for our session
            if (
              "properties" in event &&
              event.properties &&
              "sessionID" in event.properties
            ) {
              if (event.properties.sessionID !== opencodeSessionId) continue;
            }

            if (event.type === "message.updated") {
              const info = (event as OpenCodeMessageUpdatedEvent).properties
                .info;
              messageRoles.set(info.id, info.role);
            }

            // Convert to SDK message
            const sdkMessages = await this.convertSSEEventToSDKMessages(
              event,
              baseUrl,
              sessionId,
              currentAssistantMessageId,
              signal,
              messageRoles,
              emissionState,
              text,
              onToolApproval,
              cwd,
            );

            for (const sdkMessage of sdkMessages) {
              // Track assistant message ID for consistent streaming
              if (
                sdkMessage.type === "assistant" &&
                "uuid" in sdkMessage &&
                sdkMessage.uuid
              ) {
                currentAssistantMessageId = sdkMessage.uuid as string;
              }
              state.eventBuffer.push(sdkMessage);
            }
            // Wake up consumer if waiting
            if (sdkMessages.length > 0) state.resolveWaiting?.();

            // Stop on session.idle
            if (event.type === "session.idle") {
              log.debug({ opencodeSessionId }, "Session idle, stopping SSE");
              return;
            }
          }
        }
      } catch (error) {
        if (!sseController.signal.aborted) {
          log.error({ error }, "SSE connection error");
          state.sseError =
            error instanceof Error ? error : new Error(String(error));
        }
      } finally {
        state.sseComplete = true;
        state.resolveWaiting?.();
      }
    })();

    // Wait briefly for SSE connection to establish
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Send the message without blocking SSE draining. The POST response is a
    // final summary/error envelope; token/content streaming comes from SSE.
    const messagePromise = (async () => {
      log.debug(
        { opencodeSessionId, textLength: text.length },
        "Sending message to OpenCode",
      );
      const response = await fetch(
        this.openCodeUrl(
          baseUrl,
          `/session/${encodeURIComponent(opencodeSessionId)}/message`,
          cwd,
        ),
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...this.openCodeDirectoryHeaders(cwd),
          },
          body: JSON.stringify(this.buildOpenCodeMessagePayload(text, model)),
          signal,
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to send message: ${response.status} ${errorText}`,
        );
      }
      const responseBody = (await response
        .json()
        .catch(() => null)) as OpenCodeMessageResponse | null;
      const responseError = this.extractMessageResponseError(responseBody);
      if (responseError) {
        log.warn(
          { opencodeSessionId, error: responseError },
          "OpenCode message response contained an error",
        );
        state.responseError = responseError;
      }
      log.debug({ opencodeSessionId }, "Message sent successfully");
    })()
      .catch((error) => {
        if (signal.aborted) return;
        state.postError =
          error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        state.postComplete = true;
        state.resolveWaiting?.();
      });

    // Yield events from buffer as they arrive
    try {
      while (!signal.aborted) {
        // Yield any buffered events
        while (state.eventBuffer.length > 0) {
          const event = state.eventBuffer.shift();
          if (event) yield event;
        }

        if (state.postError) {
          sseController.abort();
          const error = state.postError;
          log.error({ error }, "Failed to send message to OpenCode");
          yield {
            type: "error",
            session_id: sessionId,
            error: error.message,
          } as SDKMessage;
          break;
        }

        if (state.responseError) {
          sseController.abort();
          yield {
            type: "error",
            session_id: sessionId,
            error: state.responseError,
          } as SDKMessage;
          break;
        }

        if (state.sseError) {
          yield {
            type: "error",
            session_id: sessionId,
            error: state.sseError.message,
          } as SDKMessage;
          break;
        }

        // session.idle closes our SSE reader; wait for the POST summary too so
        // 200-with-error responses are not lost at turn end.
        if (state.sseComplete && state.postComplete) break;

        // Wait for more events
        await new Promise<void>((resolve) => {
          state.resolveWaiting = resolve;
          // Also resolve after a short timeout to check conditions
          setTimeout(resolve, 100);
        });
        state.resolveWaiting = null;
      }
    } finally {
      sseController.abort();
      await Promise.allSettled([ssePromise, messagePromise]);
    }

    // Emit result message
    yield this.createResultMessage(
      sessionId,
      emissionState.emittedUsageResult ? undefined : emissionState.latestUsage,
    );
  }

  /**
   * Convert an OpenCode SSE event to SDK messages.
   */
  private async convertSSEEventToSDKMessages(
    event: OpenCodeRuntimeEvent,
    baseUrl: string,
    sessionId: string,
    currentMessageId: string | null,
    signal: AbortSignal,
    messageRoles: ReadonlyMap<string, "user" | "assistant">,
    emissionState: OpenCodeEmissionState,
    submittedText: string,
    onToolApproval?: StartSessionOptions["onToolApproval"],
    cwd?: string,
  ): Promise<SDKMessage[]> {
    switch (event.type) {
      case "permission.asked": {
        await this.handlePermissionAsked(
          baseUrl,
          event as OpenCodePermissionAskedEvent,
          signal,
          onToolApproval,
          cwd,
        );
        return [];
      }

      case "message.part.updated": {
        const partEvent = event as OpenCodeMessagePartUpdatedEvent;
        const part = partEvent.properties.part;
        const delta = partEvent.properties.delta;

        return this.convertPartToSDKMessages(
          part,
          sessionId,
          delta,
          currentMessageId,
          messageRoles.get(part.messageID),
          emissionState,
          submittedText,
        );
      }

      case "session.idle":
        return this.flushAssistantStreamMessages(emissionState, sessionId);

      case "message.updated": {
        const info = (event as OpenCodeMessageUpdatedEvent).properties.info;
        if (info.role === "assistant") {
          this.updateEmissionUsageFromMessageInfo(emissionState, info);
        }
        return [];
      }

      case "session.status":
      case "session.created":
      case "session.updated":
      case "session.diff":
      case "server.connected":
      case "permission.replied":
        // These are status events, not content - skip
        return [];

      default:
        return [];
    }
  }

  private updateEmissionUsageFromMessageInfo(
    emissionState: OpenCodeEmissionState,
    info: OpenCodeMessageUpdatedEvent["properties"]["info"],
  ): void {
    const usage = this.createUsageSummary(info.tokens, info.cost);
    if (usage) {
      emissionState.latestUsage = usage;
    }
    if (typeof info.cost === "number") {
      emissionState.latestCost = info.cost;
    }
    const model =
      info.modelID ??
      info.model?.modelID ??
      (info.providerID && info.model?.modelID
        ? `${info.providerID}/${info.model.modelID}`
        : undefined);
    if (model) {
      emissionState.latestModel = model;
    }
    if (info.finish) {
      emissionState.latestFinish = info.finish;
    }
  }

  private createUsageSummary(
    tokens: OpenCodePart["tokens"] | undefined,
    cost: number | undefined,
  ): Record<string, unknown> | undefined {
    if (!tokens && cost === undefined) return undefined;

    const usage: Record<string, unknown> = {};
    const inputTokens = tokens?.input;
    const outputTokens = tokens?.output;
    const reasoningTokens = tokens?.reasoning;
    const cacheReadTokens = tokens?.cache?.read;
    const cacheWriteTokens = tokens?.cache?.write;

    if (inputTokens !== undefined) usage.input_tokens = inputTokens;
    if (outputTokens !== undefined) usage.output_tokens = outputTokens;
    if (reasoningTokens !== undefined) usage.reasoning_tokens = reasoningTokens;
    if (cacheReadTokens !== undefined) {
      usage.cache_read_input_tokens = cacheReadTokens;
    }
    if (cacheWriteTokens !== undefined) {
      usage.cache_creation_input_tokens = cacheWriteTokens;
    }
    if (cost !== undefined) usage.cost_usd = cost;

    return Object.keys(usage).length > 0 ? usage : undefined;
  }

  private createResultMessage(
    sessionId: string,
    usage?: Record<string, unknown>,
  ): SDKMessage {
    return {
      type: "result",
      session_id: sessionId,
      ...(usage ? { usage } : {}),
    } as SDKMessage;
  }

  /**
   * Convert an OpenCode part to SDK messages.
   */
  private convertPartToSDKMessages(
    part: OpenCodePart,
    sessionId: string,
    delta: string | undefined,
    currentMessageId: string | null,
    role: "user" | "assistant" | undefined,
    emissionState: OpenCodeEmissionState,
    submittedText?: string,
  ): SDKMessage[] {
    switch (part.type) {
      case "text": {
        if (role === "user") return [];
        if (
          !role &&
          submittedText &&
          (delta ?? part.text ?? "").trim() === submittedText.trim()
        ) {
          return [];
        }
        return this.convertStreamingTextPartToSDKMessages(
          part,
          sessionId,
          delta,
          currentMessageId,
          emissionState,
          "text",
        );
      }

      case "reasoning": {
        if (role === "user") return [];
        return this.convertStreamingTextPartToSDKMessages(
          part,
          sessionId,
          delta,
          currentMessageId,
          emissionState,
          "thinking",
        );
      }

      case "step-start":
        // Start of a processing step - no content to emit
        return [];

      case "step-finish": {
        const messages = this.flushAssistantStreamMessages(
          emissionState,
          sessionId,
        );

        // End of processing step - emit usage info if available
        const usage = this.createUsageSummary(part.tokens, part.cost);
        if (usage) {
          emissionState.latestUsage = usage;
          emissionState.emittedUsageResult = true;
          messages.push(this.createResultMessage(sessionId, usage));
        }
        return messages;
      }

      case "tool": {
        const toolUseId = part.callID ?? part.id;
        const messages: SDKMessage[] = [];
        const input = part.state?.input ?? part.input ?? {};
        const status = part.state?.status;

        if (!emissionState.toolUseIds.has(toolUseId)) {
          emissionState.toolUseIds.add(toolUseId);
          messages.push({
            type: "assistant",
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: toolUseId,
                  name: part.tool ?? "unknown",
                  input,
                  opencodeStatus: status,
                  opencodeTitle: part.state?.title,
                  opencodeMetadata: part.state?.metadata,
                  opencodeTime: part.state?.time ?? part.time,
                },
              ],
            },
          } as unknown as SDKMessage);
        }

        if (
          (status === "completed" || status === "error") &&
          !emissionState.toolResultIds.has(toolUseId)
        ) {
          emissionState.toolResultIds.add(toolUseId);
          messages.push({
            type: "user",
            session_id: sessionId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content:
                    part.state?.error ??
                    part.error ??
                    this.formatToolOutput(part.state?.output ?? part.output),
                  is_error: status === "error" || !!part.state?.error,
                  opencodeStatus: status,
                  opencodeTitle: part.state?.title,
                  opencodeMetadata: part.state?.metadata,
                  opencodeTime: part.state?.time ?? part.time,
                },
              ],
            },
          } as unknown as SDKMessage);
        }

        return messages;
      }

      case "tool-use": {
        // Tool invocation
        return [
          {
            type: "assistant",
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: part.id,
                  name: part.tool ?? "unknown",
                  input: part.input ?? {},
                  opencodeTime: part.time,
                },
              ],
            },
          } as unknown as SDKMessage,
        ];
      }

      case "tool-result": {
        // Tool result
        return [
          {
            type: "user",
            session_id: sessionId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: part.id,
                  content: part.error ?? this.formatToolOutput(part.output),
                  is_error: !!part.error,
                  opencodeTime: part.time,
                },
              ],
            },
          } as unknown as SDKMessage,
        ];
      }

      default:
        return [];
    }
  }

  private createAssistantStreamState(): OpenCodeAssistantStreamState {
    return {
      messageId: null,
      started: false,
      stopped: false,
      nextBlockIndex: 0,
      partBlocks: new Map(),
    };
  }

  private getAssistantStreamState(
    emissionState: OpenCodeEmissionState,
  ): OpenCodeAssistantStreamState {
    if (!emissionState.assistantStream?.stopped) {
      emissionState.assistantStream ??= this.createAssistantStreamState();
      return emissionState.assistantStream;
    }

    emissionState.assistantStream = this.createAssistantStreamState();
    return emissionState.assistantStream;
  }

  private convertStreamingTextPartToSDKMessages(
    part: OpenCodePart,
    sessionId: string,
    delta: string | undefined,
    currentMessageId: string | null,
    emissionState: OpenCodeEmissionState,
    blockType: "text" | "thinking",
  ): SDKMessage[] {
    const streamState = this.getAssistantStreamState(emissionState);
    const messageId =
      streamState.messageId ?? currentMessageId ?? part.messageID;

    if (
      streamState.messageId &&
      streamState.messageId !== messageId &&
      !streamState.stopped
    ) {
      return [
        ...this.flushAssistantStreamMessages(emissionState, sessionId),
        ...this.convertStreamingTextPartToSDKMessages(
          part,
          sessionId,
          delta,
          currentMessageId,
          emissionState,
          blockType,
        ),
      ];
    }

    streamState.messageId = messageId;

    let block = streamState.partBlocks.get(part.id);
    let isNewBlock = false;
    if (!block) {
      block = {
        index: streamState.nextBlockIndex,
        type: blockType,
        text: "",
      };
      streamState.nextBlockIndex += 1;
      streamState.partBlocks.set(part.id, block);
      isNewBlock = true;
    }

    let deltaText = "";
    if (delta !== undefined) {
      deltaText = delta;
      block.text += delta;
    } else {
      const fullText = part.text ?? "";
      if (fullText.startsWith(block.text)) {
        deltaText = fullText.slice(block.text.length);
      } else {
        deltaText = fullText;
      }
      block.text = fullText;
    }

    if (!deltaText && !isNewBlock) return [];
    if (!deltaText && isNewBlock && !block.text) {
      streamState.partBlocks.delete(part.id);
      streamState.nextBlockIndex -= 1;
      return [];
    }

    const messages: SDKMessage[] = [];

    if (!streamState.started) {
      streamState.started = true;
      messages.push(
        this.createStreamEventMessage(sessionId, {
          type: "message_start",
          message: {
            id: messageId,
            role: "assistant",
            content: [],
          },
        }),
      );
    }

    if (isNewBlock) {
      messages.push(
        this.createStreamEventMessage(sessionId, {
          type: "content_block_start",
          index: block.index,
          content_block:
            block.type === "thinking"
              ? { type: "thinking", thinking: "" }
              : { type: "text", text: "" },
        }),
      );
    }

    if (deltaText) {
      messages.push(
        this.createStreamEventMessage(sessionId, {
          type: "content_block_delta",
          index: block.index,
          delta:
            block.type === "thinking"
              ? { type: "thinking_delta", thinking: deltaText }
              : { type: "text_delta", text: deltaText },
        }),
      );
    }

    return messages;
  }

  private flushAssistantStreamMessages(
    emissionState: OpenCodeEmissionState,
    sessionId: string,
  ): SDKMessage[] {
    const streamState = emissionState.assistantStream;
    if (
      !streamState?.started ||
      streamState.stopped ||
      !streamState.messageId
    ) {
      return [];
    }

    streamState.stopped = true;

    const messages: SDKMessage[] = [
      this.createStreamEventMessage(sessionId, {
        type: "message_stop",
      }),
    ];

    const contentBlocks = Array.from(streamState.partBlocks.values())
      .sort((a, b) => a.index - b.index)
      .filter((block) => block.text.length > 0)
      .map((block) =>
        block.type === "thinking"
          ? { type: "thinking" as const, thinking: block.text }
          : { type: "text" as const, text: block.text },
      );

    if (contentBlocks.length > 0) {
      const content =
        contentBlocks.length === 1 && contentBlocks[0]?.type === "text"
          ? contentBlocks[0].text
          : contentBlocks;

      messages.push({
        type: "assistant",
        session_id: sessionId,
        uuid: streamState.messageId,
        message: {
          role: "assistant",
          content,
        },
      } as SDKMessage);
    }

    return messages;
  }

  private createStreamEventMessage(
    sessionId: string,
    event: Record<string, unknown>,
  ): SDKMessage {
    return {
      type: "stream_event",
      session_id: sessionId,
      event,
    } as SDKMessage;
  }

  /**
   * Apply per-session OpenCode config to the dedicated server process.
   */
  private async configureServer(
    baseUrl: string,
    options: StartSessionOptions,
    cwd?: string,
  ): Promise<
    { ok: true; model: string | null } | { ok: false; error: string }
  > {
    const config: Record<string, unknown> = {
      permission: this.mapPermissionModeToOpenCode(options.permissionMode),
    };
    const model = await this.resolveOpenCodeModelOption(options.model);
    if (model) {
      config.model = model;
    }
    if (options.opencodeModelLimits) {
      const providerLimitConfig = this.buildOpenCodeModelLimitConfig(
        model,
        options.opencodeModelLimits,
      );
      if (!providerLimitConfig) {
        return {
          ok: false,
          error:
            "OpenCode model limits require an explicit model in provider/model format",
        };
      }
      config.provider = providerLimitConfig;
    }

    try {
      await this.patchServerConfig(baseUrl, config, cwd);

      getLogger().info(
        {
          permissionMode: options.permissionMode ?? "default",
          model,
          opencodeModelLimits: options.opencodeModelLimits,
        },
        "Configured OpenCode server",
      );
      return { ok: true, model };
    } catch (error) {
      return {
        ok: false,
        error: `Failed to configure OpenCode server: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async patchServerConfig(
    baseUrl: string,
    config: Record<string, unknown>,
    cwd?: string,
  ): Promise<void> {
    const response = await fetch(this.openCodeUrl(baseUrl, "/config", cwd), {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...this.openCodeDirectoryHeaders(cwd),
      },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Failed to configure OpenCode server: ${response.status}${errorText ? ` ${errorText}` : ""}`,
      );
    }
  }

  private mapPermissionModeToOpenCode(
    mode: PermissionMode | undefined,
  ): OpenCodePermissionConfig {
    switch (mode) {
      case "bypassPermissions":
        return { "*": "allow" };

      case "acceptEdits":
        return {
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          edit: "allow",
          write: "allow",
          webfetch: "allow",
          websearch: "allow",
          bash: "ask",
          "*": "ask",
        };

      case "plan":
        return {
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          webfetch: "allow",
          websearch: "allow",
          edit: "ask",
          write: "ask",
          bash: "ask",
          "*": "ask",
        };

      default:
        return {
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          webfetch: "allow",
          websearch: "allow",
          edit: "ask",
          write: "ask",
          bash: "ask",
          "*": "ask",
        };
    }
  }

  private normalizeOpenCodeModelOption(
    model: string | undefined,
  ): string | null {
    const trimmed = model?.trim();
    if (!trimmed || trimmed === "default" || trimmed === "auto") {
      return null;
    }
    return trimmed;
  }

  private async resolveOpenCodeModelOption(
    model: string | undefined,
  ): Promise<string | null> {
    const normalized = this.normalizeOpenCodeModelOption(model);
    if (!normalized || normalized.includes("/")) return normalized;

    const models = await this.getAvailableModels();
    const suffixMatches = models
      .map((item) => item.id)
      .filter((id) => id.split("/").at(-1) === normalized);
    if (suffixMatches.length === 1) {
      return suffixMatches[0] ?? normalized;
    }

    const anthropicMatch = suffixMatches.find((id) =>
      id.startsWith("anthropic/"),
    );
    if (anthropicMatch) return anthropicMatch;

    const openaiMatch = suffixMatches.find((id) => id.startsWith("openai/"));
    if (openaiMatch) return openaiMatch;

    return normalized;
  }

  private parseOpenCodeModelOption(
    model: string | null | undefined,
  ): OpenCodeModelRef | null {
    if (!model) return null;
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) return null;
    return {
      providerID: model.slice(0, slash),
      modelID: model.slice(slash + 1),
    };
  }

  private buildOpenCodeModelLimitConfig(
    model: string | null | undefined,
    limits: OpenCodeModelLimits | undefined,
  ): OpenCodeProviderModelLimitConfig | null {
    if (!limits) return null;
    const parsed = this.parseOpenCodeModelOption(model);
    if (!parsed) return null;

    return {
      [parsed.providerID]: {
        models: {
          [parsed.modelID]: {
            limit: limits,
          },
        },
      },
    };
  }

  private buildOpenCodeSessionCreatePayload(
    cwd: string,
    model: string | null | undefined,
  ): OpenCodeSessionCreatePayload {
    const payload: OpenCodeSessionCreatePayload = {
      title: "Yep Anywhere Session",
      location: { directory: cwd },
    };
    const parsed = this.parseOpenCodeModelOption(model);
    if (parsed) {
      payload.model = {
        providerID: parsed.providerID,
        id: parsed.modelID,
      };
    }
    return payload;
  }

  private openCodeUrl(baseUrl: string, path: string, cwd?: string): string {
    const url = new URL(path, baseUrl);
    if (cwd) url.searchParams.set("directory", cwd);
    return url.toString();
  }

  private openCodeDirectoryHeaders(cwd?: string): Record<string, string> {
    return cwd ? { "x-opencode-directory": cwd } : {};
  }

  private buildOpenCodeMessagePayload(
    text: string,
    model: string | null | undefined,
  ): OpenCodeMessagePayload {
    const payload: OpenCodeMessagePayload = {
      parts: [{ type: "text", text }],
    };
    const parsed = this.parseOpenCodeModelOption(model);
    if (parsed) payload.model = parsed;
    return payload;
  }

  private async handlePermissionAsked(
    baseUrl: string,
    event: OpenCodePermissionAskedEvent,
    signal: AbortSignal,
    onToolApproval?: StartSessionOptions["onToolApproval"],
    cwd?: string,
  ): Promise<void> {
    const permission = event.properties.permission;
    const toolName = this.mapOpenCodePermissionToToolName(permission);
    const toolInput = {
      permission,
      patterns: event.properties.patterns ?? [],
      metadata: event.properties.metadata ?? {},
      always: event.properties.always ?? [],
      messageID: event.properties.tool?.messageID,
      callID: event.properties.tool?.callID,
    };

    let result: ToolApprovalResult = {
      behavior: "deny",
      message: "No approval handler available",
      interrupt: true,
    };

    if (onToolApproval) {
      try {
        result = await onToolApproval(toolName, toolInput, { signal });
      } catch (error) {
        getLogger().warn(
          { permissionId: event.properties.id, toolName, error },
          "OpenCode approval callback failed; denying permission",
        );
      }
    }

    const reply = result.behavior === "allow" ? "once" : "reject";
    const response = await fetch(
      this.openCodeUrl(
        baseUrl,
        `/permission/${encodeURIComponent(event.properties.id)}/reply`,
        cwd,
      ),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...this.openCodeDirectoryHeaders(cwd),
        },
        body: JSON.stringify({ reply }),
        signal,
      },
    );

    if (!response.ok) {
      getLogger().warn(
        {
          permissionId: event.properties.id,
          status: response.status,
          reply,
        },
        "Failed to reply to OpenCode permission request",
      );
    }
  }

  private mapOpenCodePermissionToToolName(permission: string): string {
    switch (permission.toLowerCase()) {
      case "bash":
        return "Bash";
      case "edit":
      case "write":
        return "Edit";
      case "read":
        return "Read";
      case "glob":
        return "Glob";
      case "grep":
        return "Grep";
      case "webfetch":
        return "WebFetch";
      case "websearch":
        return "WebSearch";
      default:
        return permission;
    }
  }

  private formatModelName(model: string): string {
    const [provider, modelId] = model.split("/", 2);
    if (!provider || !modelId) return model;
    return `${provider} / ${modelId}`;
  }

  private formatToolOutput(output: unknown): string {
    if (typeof output === "string") return output;
    if (output === undefined || output === null) return "";
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }

  private getOpenCodeEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    env.LLM_API_KEY ??=
      process.env.SESSION_TITLE_LLM_API_KEY ?? process.env.OPENAI_API_KEY;
    env.LLM_API_BASE ??=
      process.env.SESSION_TITLE_LLM_API_BASE ?? process.env.LLM_API_BASE;
    env.LLM_SUB_MODULE ??=
      process.env.SESSION_TITLE_SUB_MODULE ?? process.env.LLM_SUB_MODULE;
    return env;
  }

  private extractMessageResponseError(
    response: OpenCodeMessageResponse | null,
  ): string | null {
    const error = response?.info?.error;
    if (!error) return null;

    const data = error.data;
    if (data && typeof data === "object") {
      const message = (data as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return message;
      }
    }

    if (typeof error.name === "string" && error.name.trim()) {
      return error.name;
    }
    return "OpenCode message failed";
  }

  /**
   * Wait for server to be ready.
   */
  private async waitForServer(
    baseUrl: string,
    timeoutMs: number,
    cwd?: string,
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(
          this.openCodeUrl(baseUrl, "/session", cwd),
          {
            headers: {
              Accept: "application/json",
              ...this.openCodeDirectoryHeaders(cwd),
            },
            signal: AbortSignal.timeout(1000),
          },
        );
        if (response.ok) {
          return true;
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    return false;
  }

  /**
   * Extract text content from a user message.
   */
  private extractTextFromMessage(message: SDKUserMessage): string {
    const content = message.message?.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      // Extract text from content blocks
      return content
        .filter(
          (block): block is { type: "text"; text: string } =>
            typeof block === "object" && block.type === "text",
        )
        .map((block) => block.text)
        .join("\n");
    }
    return "";
  }

  /**
   * Find the OpenCode CLI path.
   */
  private async findOpenCodePath(): Promise<string | null> {
    // Use configured path if provided
    if (this.opencodePath && existsSync(this.opencodePath)) {
      return this.opencodePath;
    }

    // Check common locations
    const commonPaths = [
      join(homedir(), ".local", "bin", "opencode"),
      "/usr/local/bin/opencode",
      join(homedir(), "bin", "opencode"),
    ];

    for (const path of commonPaths) {
      if (existsSync(path)) {
        return path;
      }
    }

    // Try to find in PATH using which
    try {
      const { stdout } = await execAsync(whichCommand("opencode"), {
        encoding: "utf-8",
      });
      const result = stdout.trim();
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
 * Default OpenCode provider instance.
 */
export const opencodeProvider = new OpenCodeProvider();
