/**
 * Gemini Provider implementation using `gemini -o stream-json`.
 *
 * This provider enables using Google's Gemini CLI as an agent backend.
 * It spawns the Gemini CLI process and parses its JSON stream output.
 */

import { type ChildProcess, exec, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type {
  GeminiEvent,
  GeminiInitEvent,
  GeminiMessageEvent,
  GeminiResultEvent,
  GeminiStats,
  GeminiToolResultEvent,
  GeminiToolUseEvent,
  ModelInfo,
} from "@yep-anywhere/shared";
import { whichCommand } from "../cli-detection.js";
const execAsync = promisify(exec);

/** Standard Gemini models (always available) */
const GEMINI_MODELS: ModelInfo[] = [
  { id: "auto", name: "Auto (recommended)" },
  { id: "gemini-3-pro", name: "Gemini 3 Pro" },
  { id: "gemini-3-flash", name: "Gemini 3 Flash" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
  { id: "gemini-2.0-flash-lite", name: "Gemini 2.0 Flash Lite" },
];

/** Preview models (require previewFeatures enabled in ~/.gemini/settings.json) */
const GEMINI_PREVIEW_MODELS: ModelInfo[] = [];
import { parseGeminiEvent } from "@yep-anywhere/shared";
import { MessageQueue, getUserPromptProjection } from "../messageQueue.js";
import type { SDKMessage } from "../types.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";

/**
 * Configuration for Gemini provider.
 */
export interface GeminiProviderConfig {
  /** Path to gemini binary (auto-detected if not specified) */
  geminiPath?: string;
  /** Request timeout in ms (default: 300000 = 5 minutes) */
  timeout?: number;
}

/**
 * Settings from ~/.gemini/settings.json
 */
interface GeminiSettings {
  general?: {
    previewFeatures?: boolean;
  };
}

/**
 * Gemini Provider implementation.
 *
 * Uses the Gemini CLI's `-o stream-json` mode for streaming responses.
 * Parses JSON stream output and normalizes events to our SDKMessage format.
 */
export class GeminiProvider implements AgentProvider {
  readonly name = "gemini" as const;
  readonly displayName = "Gemini";
  readonly supportsPermissionMode = false;
  readonly supportsThinkingToggle = false;
  readonly supportsSlashCommands = false;

  private readonly geminiPath?: string;
  private readonly timeout: number;

  constructor(config: GeminiProviderConfig = {}) {
    this.geminiPath = config.geminiPath;
    this.timeout = config.timeout ?? 300000; // 5 minutes default
  }

  /**
   * Check if the Gemini CLI is installed.
   */
  async isInstalled(): Promise<boolean> {
    const path = await this.findGeminiPath();
    return path !== null;
  }

  /**
   * Check if Gemini is authenticated.
   */
  async isAuthenticated(): Promise<boolean> {
    const authStatus = await this.getAuthStatus();
    return authStatus.authenticated;
  }

  /**
   * Get detailed authentication status.
   * If Gemini CLI is installed, assume it's authenticated.
   * The CLI handles auth internally and will error at session start if not authenticated.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    return {
      installed,
      authenticated: installed,
      enabled: installed,
    };
  }

  /**
   * Get available Gemini models.
   * Returns standard models plus preview models if previewFeatures is enabled.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    const models = [...GEMINI_MODELS];

    // Check if preview features are enabled
    if (this.hasPreviewFeaturesEnabled()) {
      models.push(...GEMINI_PREVIEW_MODELS);
    }

    return models;
  }

  /**
   * Check if preview features are enabled in ~/.gemini/settings.json
   */
  private hasPreviewFeaturesEnabled(): boolean {
    const settingsPath = join(homedir(), ".gemini", "settings.json");
    if (!existsSync(settingsPath)) {
      return false;
    }

    try {
      const settings: GeminiSettings = JSON.parse(
        readFileSync(settingsPath, "utf-8"),
      );
      return settings.general?.previewFeatures === true;
    } catch {
      return false;
    }
  }

  /**
   * Start a new Gemini session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue();
    const abortController = new AbortController();
    const pidRef: { value?: number } = {};

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
    );

    return {
      iterator,
      queue,
      abort: () => abortController.abort(),
      get pid() {
        return pidRef.value;
      },
    };
  }

  /**
   * Main session loop.
   */
  private async *runSession(
    cwd: string,
    queue: MessageQueue,
    signal: AbortSignal,
    options: StartSessionOptions,
    pidRef: { value?: number },
  ): AsyncIterableIterator<SDKMessage> {
    console.log("[GeminiProvider] Starting NON-ACP session (stream-json mode)");
    const geminiPath = await this.findGeminiPath();
    if (!geminiPath) {
      yield {
        type: "error",
        error: "Gemini CLI not found",
      } as SDKMessage;
      return;
    }

    // Use existing session ID if resuming, otherwise generate a new one
    let currentSessionId =
      options.resumeSessionId ??
      `gemini-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Emit init message
    yield {
      type: "system",
      subtype: "init",
      session_id: currentSessionId,
      cwd,
    } as SDKMessage;

    // Track whether this is the first message (for --resume logic)
    let isFirstMessage = true;

    // Process messages from the queue in a loop
    const messageGen = queue.generator();
    for await (const message of messageGen) {
      if (signal.aborted) break;

      let { internalPrompt, publicPrompt } = getUserPromptProjection(message);

      // Prepend global instructions to the first message of new sessions
      if (
        isFirstMessage &&
        !options.resumeSessionId &&
        options.globalInstructions
      ) {
        const prefix = `[Global context]\n${options.globalInstructions}\n\n---\n\n`;
        internalPrompt = `${prefix}${internalPrompt}`;
        publicPrompt = `${prefix}${publicPrompt}`;
      }

      // Emit user message with UUID from queue to enable deduplication
      // The UUID was set by Process.queueMessage() and passed through MessageQueue
      yield {
        type: "user",
        uuid: message.uuid,
        session_id: currentSessionId,
        message: {
          role: "user",
          content: publicPrompt,
        },
      } as SDKMessage;

      // Build gemini command arguments
      const args: string[] = [];

      // Set output mode to stream-json
      args.push("-o", "stream-json");

      // Add resume flag: use it if resuming an existing session OR if this is a follow-up message
      if (options.resumeSessionId || !isFirstMessage) {
        args.push("--resume", currentSessionId);
      }

      // Add model if specified
      if (options.model) {
        args.push("-m", options.model);
      }

      // Note: Gemini CLI may have different permission flags
      // For now, we assume auto-approve is the default in agentic mode

      // Add the prompt
      args.push(internalPrompt);

      // Spawn the gemini process
      let geminiProcess: ChildProcess;
      try {
        geminiProcess = spawn(geminiPath, args, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
          },
          shell: process.platform === "win32",
        });
        pidRef.value = geminiProcess.pid;
      } catch (error) {
        yield {
          type: "error",
          session_id: currentSessionId,
          error: `Failed to spawn Gemini process: ${error instanceof Error ? error.message : String(error)}`,
        } as SDKMessage;
        return;
      }

      // Handle abort
      const abortHandler = () => {
        geminiProcess.kill("SIGTERM");
      };
      signal.addEventListener("abort", abortHandler);

      // Set up timeout
      const timeoutId = setTimeout(() => {
        geminiProcess.kill("SIGTERM");
      }, this.timeout);

      try {
        // Parse JSON from stdout
        if (!geminiProcess.stdout) {
          yield {
            type: "error",
            session_id: currentSessionId,
            error: "Gemini process has no stdout",
          } as SDKMessage;
          return;
        }

        const rl = createInterface({
          input: geminiProcess.stdout,
          crlfDelay: Number.POSITIVE_INFINITY,
        });

        let lastStats: GeminiStats | undefined;
        let assistantContentBuffer: string | null = null;
        let assistantBufferTimestamp: string | null = null;
        // Track unique ID for the current assistant response to enable markdown augment tracking
        let currentAssistantMessageId: string | null = null;

        for await (const line of rl) {
          if (signal.aborted) break;

          const event = parseGeminiEvent(line);
          if (!event) continue;

          // Update session ID from init event (Gemini returns the real session ID)
          if (event.type === "init") {
            const init = event as GeminiInitEvent;
            if (init.session_id) {
              currentSessionId = init.session_id;
            }
          }

          // Track stats from result event
          if (event.type === "result") {
            const result = event as GeminiResultEvent;
            lastStats = result.stats;
          }

          // Buffer assistant messages to combine fragments
          if (event.type === "message") {
            const msg = event as GeminiMessageEvent;
            if (msg.role === "assistant") {
              if (assistantContentBuffer === null) {
                assistantContentBuffer = "";
                // Capture timestamp of the first fragment
                assistantBufferTimestamp = msg.timestamp ?? null;
                // Generate a stable ID for this assistant response if we don't have one
                if (!currentAssistantMessageId) {
                  currentAssistantMessageId = randomUUID();
                }
              }
              assistantContentBuffer += msg.content;
              // Continue to next line without yielding - we'll yield when we see a non-assistant message or end of stream
              continue;
            }
          }

          // If we had a buffered assistant message, flush it now
          if (assistantContentBuffer !== null) {
            yield {
              type: "assistant",
              session_id: currentSessionId,
              timestamp: assistantBufferTimestamp ?? new Date().toISOString(),
              uuid: currentAssistantMessageId ?? undefined,
              message: {
                role: "assistant",
                content: assistantContentBuffer,
              },
            } as SDKMessage;
            assistantContentBuffer = null;
            assistantBufferTimestamp = null;
          }

          // Convert Gemini event to SDKMessage
          const sdkMessage = this.convertEventToSDKMessage(
            event,
            currentSessionId,
            message.uuid,
          );
          if (sdkMessage) {
            yield sdkMessage;
          }
        }

        // Flush any remaining buffered assistant message after stream ends
        if (assistantContentBuffer !== null) {
          yield {
            type: "assistant",
            session_id: currentSessionId,
            timestamp: assistantBufferTimestamp ?? new Date().toISOString(),
            uuid: currentAssistantMessageId ?? undefined,
            message: {
              role: "assistant",
              content: assistantContentBuffer,
            },
          } as SDKMessage;
        }

        // Wait for process to exit
        const exitCode = await new Promise<number | null>((resolve) => {
          geminiProcess.on("close", resolve);
          geminiProcess.on("error", () => resolve(null));
        });

        // Emit result message for this turn
        yield {
          type: "result",
          session_id: currentSessionId,
          exitCode,
          usage: lastStats
            ? {
                input_tokens: lastStats.input_tokens,
                output_tokens: lastStats.output_tokens,
              }
            : undefined,
        } as SDKMessage;
      } finally {
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", abortHandler);

        // Ensure process is killed
        if (!geminiProcess.killed) {
          geminiProcess.kill("SIGTERM");
        }
      }

      // After first message, all subsequent messages are continuations
      isFirstMessage = false;
    }
  }

  /**
   * Convert a Gemini event to an SDKMessage.
   */
  private convertEventToSDKMessage(
    event: GeminiEvent,
    sessionId: string,
    uuid?: string,
  ): SDKMessage | null {
    switch (event.type) {
      case "init": {
        const init = event as GeminiInitEvent;
        return {
          type: "system",
          subtype: "init",
          session_id: init.session_id,
          model: init.model,
        } as SDKMessage;
      }

      case "message": {
        const msg = event as GeminiMessageEvent;
        if (msg.role === "user") {
          return {
            type: "user",
            uuid, // Use the UUID from the request if available
            session_id: sessionId,
            timestamp: msg.timestamp,
            message: {
              role: "user",
              content: msg.content,
            },
          } as SDKMessage;
        }
        // Assistant message
        return {
          type: "assistant",
          session_id: sessionId,
          timestamp: msg.timestamp,
          // Note: for streaming messages, the loop above manually adds uuid
          // This path is for non-streaming single messages (rare in current implementation)
          message: {
            role: "assistant",
            content: msg.content,
            // Delta messages are streamed chunks
          },
        } as SDKMessage;
      }

      case "tool_use": {
        const toolUse = event as GeminiToolUseEvent;
        return {
          type: "assistant",
          session_id: sessionId,
          timestamp: toolUse.timestamp,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: toolUse.tool_id,
                name: toolUse.tool_name,
                input: toolUse.parameters ?? {},
              },
            ],
          },
        } as SDKMessage;
      }

      case "tool_result": {
        const toolResult = event as GeminiToolResultEvent;
        return {
          type: "user",
          session_id: sessionId,
          timestamp: toolResult.timestamp,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolResult.tool_id,
                content:
                  toolResult.status === "error"
                    ? (toolResult.error ?? "Tool error")
                    : (toolResult.output ?? ""),
              },
            ],
          },
        } as SDKMessage;
      }

      case "result": {
        // Result events are tracked for stats but don't emit a separate message
        // The final result is emitted after the process exits
        return null;
      }

      case "error": {
        return {
          type: "error",
          session_id: sessionId,
          error: event.error ?? event.message ?? "Unknown error",
        } as SDKMessage;
      }
    }

    return null;
  }

  /**
   * Find the Gemini CLI path.
   */
  private async findGeminiPath(): Promise<string | null> {
    // Use configured path if provided
    if (this.geminiPath && existsSync(this.geminiPath)) {
      return this.geminiPath;
    }

    // Check common locations
    const commonPaths = [
      join(homedir(), ".local", "bin", "gemini"),
      "/usr/local/bin/gemini",
      join(homedir(), ".gemini", "bin", "gemini"),
      join(homedir(), "bin", "gemini"),
    ];

    for (const path of commonPaths) {
      if (existsSync(path)) {
        return path;
      }
    }

    // Try to find in PATH using which
    try {
      const { stdout } = await execAsync(whichCommand("gemini"), {
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
 * Default Gemini provider instance.
 */
export const geminiProvider = new GeminiProvider();
