import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  type CanUseTool as ClaudeCanUseTool,
  type SDKMessage as ClaudeSDKMessage,
  type Query,
  type SDKUserMessage,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ContextStatusSdkPayload,
  DEFAULT_PERMISSION_MODE,
  type ModelInfo,
  type RemoteExecutorConfig,
  type SlashCommand,
  getModelContextWindow,
} from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { logSDKMessage } from "../messageLogger.js";
import { MessageQueue } from "../messageQueue.js";
import { getRemoteSessionStorageMode } from "../remote-executor-config.js";
import {
  isLocalPathWithin,
  isRemotePathWithin,
} from "../remote-path-mapping.js";
import {
  createRemoteSpawn,
  executorLabel,
  inLoginShell,
  quoteShell,
  runRemoteCommand,
  testRemoteExecutor,
  translateSharedPath,
} from "../remote-spawn.js";
import { materializeRemoteSessionFile } from "../session-sync.js";
import type { ContentBlock, SDKMessage, UserMessage } from "../types.js";
import { filterEnvForChildProcess } from "./env-filter.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderName,
  StartSessionOptions,
} from "./types.js";

const CLAUDE_MODELS: ModelInfo[] = [
  {
    id: "default",
    name: "Default (recommended)",
    description: "Claude Code chooses the recommended model for the account",
    contextWindow: getModelContextWindow("default", "claude"),
  },
  {
    id: "sonnet",
    name: "Sonnet",
    description: "Balanced Claude Code model for everyday coding",
    contextWindow: getModelContextWindow("sonnet", "claude"),
  },
  {
    id: "sonnet[1m]",
    name: "Sonnet 1M",
    description: "Sonnet with the extended context window",
    contextWindow: getModelContextWindow("sonnet[1m]", "claude"),
  },
  {
    id: "opus",
    name: "Opus",
    description: "Highest-capability Claude Code model",
    contextWindow: getModelContextWindow("opus", "claude"),
  },
  {
    id: "opus[1m]",
    name: "Opus 1M",
    description: "Opus with the extended context window",
    contextWindow: getModelContextWindow("opus[1m]", "claude"),
  },
  {
    id: "haiku",
    name: "Haiku",
    description: "Fast model for small tasks",
    contextWindow: getModelContextWindow("haiku", "claude"),
  },
];

export interface ClaudeProviderConfig {
  remoteExecutors?: RemoteExecutorConfig[];
  /** Local Claude projects root used for the remote JSONL replicas. */
  localSessionsDir?: string;
  onSessionFileUpdated?: (update: ClaudeSessionFileUpdate) => void;
}

export interface ClaudeSessionFileUpdate {
  executor: RemoteExecutorConfig;
  sessionId: string;
  localPath: string;
  projectsDir: string;
  mode: "shared" | "ssh-replica";
}

function assertLocalSharedRoot(executor: RemoteExecutorConfig): void {
  try {
    if (statSync(executor.localRoot).isDirectory()) return;
  } catch {
    // Throw the purpose-built error below.
  }
  throw new Error(
    `Claude remote shared root does not exist locally: ${executor.localRoot}`,
  );
}

export function safeAttachmentName(
  messageId: string,
  originalName: string,
): string {
  const safeMessageId = messageId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  const safeName = basename(originalName)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 160);
  return `${safeMessageId || "message"}-${safeName || "attachment"}`;
}

/**
 * Translate attachment paths to the VM. Uploads outside the shared root are
 * copied into a transient directory inside that root first.
 */
class RemoteMessageQueue extends MessageQueue {
  private readonly uploadDir: string;

  constructor(
    private readonly executor: RemoteExecutorConfig,
    sessionToken: string,
  ) {
    super();
    this.uploadDir = join(
      executor.localRoot,
      ".yep-anywhere",
      "remote-uploads",
      sessionToken,
    );
  }

  override push(message: UserMessage): number {
    if (!message.attachments?.length) return super.push(message);

    const attachments = message.attachments.map((attachment) => {
      try {
        return {
          ...attachment,
          path: translateSharedPath(attachment.path, this.executor),
        };
      } catch {
        mkdirSync(this.uploadDir, { recursive: true });
        const localCopy = join(
          this.uploadDir,
          safeAttachmentName(
            message.uuid ?? "message",
            attachment.originalName,
          ),
        );
        copyFileSync(attachment.path, localCopy);
        return {
          ...attachment,
          path: translateSharedPath(localCopy, this.executor),
        };
      }
    });

    return super.push({ ...message, attachments });
  }

  cleanup(): void {
    rmSync(this.uploadDir, { recursive: true, force: true });
  }
}

function mapContextUsage(
  usage: Awaited<ReturnType<Query["getContextUsage"]>>,
): ContextStatusSdkPayload | null {
  if (!usage) return null;
  return {
    source: "sdk",
    model: usage.model,
    totalTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
    rawMaxTokens: usage.rawMaxTokens,
    percentage: usage.percentage,
    autoCompactThreshold: usage.autoCompactThreshold,
    categories: usage.categories.map((category) => ({
      name: category.name,
      tokens: category.tokens,
      color: category.color,
    })),
    mcpTools: usage.mcpTools.map((tool) => ({
      name: tool.name,
      serverName: tool.serverName,
      tokens: tool.tokens,
      isLoaded: tool.isLoaded,
    })),
    memoryFiles: usage.memoryFiles.map((file) => ({
      path: file.path,
      type: file.type,
      tokens: file.tokens,
    })),
    agents: usage.agents.map((agent) => ({
      agentType: agent.agentType,
      source: agent.source,
      tokens: agent.tokens,
    })),
    slashCommands: usage.slashCommands
      ? {
          totalCommands: usage.slashCommands.totalCommands,
          includedCommands: usage.slashCommands.includedCommands,
          tokens: usage.slashCommands.tokens,
        }
      : undefined,
    skills: usage.skills
      ? {
          totalSkills: usage.skills.totalSkills,
          includedSkills: usage.skills.includedSkills,
          tokens: usage.skills.tokens,
          skillFrontmatter: usage.skills.skillFrontmatter.map((skill) => ({
            name: skill.name,
            source: skill.source,
            tokens: skill.tokens,
          })),
        }
      : undefined,
    systemPromptSections: usage.systemPromptSections?.map((section) => ({
      name: section.name,
      tokens: section.tokens,
    })),
    systemTools: usage.systemTools?.map((tool) => ({
      name: tool.name,
      tokens: tool.tokens,
    })),
    deferredBuiltinTools: usage.deferredBuiltinTools?.map((tool) => ({
      name: tool.name,
      tokens: tool.tokens,
      isLoaded: tool.isLoaded,
    })),
  };
}

/** Claude Code provider whose CLI is intentionally remote-only. */
export class ClaudeProvider implements AgentProvider {
  readonly name: ProviderName = "claude";
  readonly displayName = "Claude Code (SSH)";
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = true;
  readonly supportsSlashCommands = true;

  private remoteExecutors: RemoteExecutorConfig[];
  private readonly localSessionsDir: string;
  private onSessionFileUpdated:
    | ((update: ClaudeSessionFileUpdate) => void)
    | undefined;

  constructor(config: ClaudeProviderConfig = {}) {
    this.remoteExecutors = [...(config.remoteExecutors ?? [])];
    this.localSessionsDir =
      config.localSessionsDir ??
      process.env.CLAUDE_SESSIONS_DIR ??
      join(
        process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
        "projects",
      );
    this.onSessionFileUpdated = config.onSessionFileUpdated;
  }

  setRemoteExecutors(executors: RemoteExecutorConfig[]): void {
    this.remoteExecutors = executors.map((executor) => ({ ...executor }));
  }

  setSessionFileObserver(
    observer: ((update: ClaudeSessionFileUpdate) => void) | undefined,
  ): void {
    this.onSessionFileUpdated = observer;
  }

  async isInstalled(): Promise<boolean> {
    return this.remoteExecutors.length > 0;
  }

  async isAuthenticated(): Promise<boolean> {
    // Credentials live in the VM and are verified by Claude itself at launch.
    return this.remoteExecutors.length > 0;
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const firstExecutor = this.remoteExecutors[0];
    const configured = firstExecutor !== undefined;
    return {
      installed: configured,
      authenticated: configured,
      enabled: configured,
      user: firstExecutor ? { name: executorLabel(firstExecutor) } : undefined,
    };
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    // The live session refreshes this list through supportedModels(). Keeping
    // provider discovery static avoids starting a paid probe turn.
    return CLAUDE_MODELS.map((model) => ({ ...model }));
  }

  private resolveExecutor(options: StartSessionOptions): RemoteExecutorConfig {
    if (options.executor) {
      const configured = this.remoteExecutors.find(
        (candidate) =>
          candidate.host === options.executor ||
          executorLabel(candidate) === options.executor,
      );
      if (configured) return configured;
    }
    const onlyExecutor = this.remoteExecutors[0];
    if (
      !options.executor &&
      this.remoteExecutors.length === 1 &&
      onlyExecutor
    ) {
      return onlyExecutor;
    }
    throw new Error(
      "Claude Code is remote-only. Select a configured SSH executor before starting the session.",
    );
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const executor = this.resolveExecutor(options);
    assertLocalSharedRoot(executor);
    const remoteCwd = translateSharedPath(options.cwd, executor);
    const remoteStatus = await testRemoteExecutor(executor);
    if (!remoteStatus.success) {
      throw new Error(
        `SSH connection to ${executorLabel(executor)} failed: ${remoteStatus.error ?? "unknown error"}`,
      );
    }
    if (!remoteStatus.claudeAvailable) {
      throw new Error(
        `Claude CLI is unavailable on ${executorLabel(executor)}: ${remoteStatus.error ?? "command not found"}`,
      );
    }
    if (!remoteStatus.sharedRootAvailable) {
      throw new Error(
        `The shared root is not mounted read/write on ${executorLabel(executor)}: ${executor.remoteRoot}`,
      );
    }
    if (!remoteStatus.localRootAvailable) {
      throw new Error(
        `The shared root is unavailable locally: ${executor.localRoot}`,
      );
    }

    if (getRemoteSessionStorageMode(executor) === "shared") {
      const storage = executor.sessionStorage;
      if (!storage?.localProjectsDir || !storage.remoteProjectsDir) {
        throw new Error(
          "Shared Claude session storage requires localProjectsDir and remoteProjectsDir",
        );
      }
      if (
        isLocalPathWithin(options.cwd, storage.localProjectsDir) ||
        isLocalPathWithin(storage.localProjectsDir, options.cwd) ||
        isRemotePathWithin(remoteCwd, storage.remoteProjectsDir) ||
        isRemotePathWithin(storage.remoteProjectsDir, remoteCwd)
      ) {
        throw new Error(
          "The shared Claude projects directory cannot overlap the project working directory",
        );
      }
      if (!remoteStatus.localProjectsDirAvailable) {
        throw new Error(
          "The shared Claude projects directory is unavailable locally",
        );
      }
      if (!remoteStatus.localProjectsDirPermissionsSecure) {
        throw new Error(
          "The shared Claude projects directory must use 0700 or 0750 permissions",
        );
      }
      if (!remoteStatus.remoteProjectsDirAvailable) {
        throw new Error(
          "The shared Claude projects directory is unavailable remotely",
        );
      }
      if (!remoteStatus.remoteProjectsDirPermissionsSecure) {
        throw new Error(
          "The remote shared Claude projects directory must use 0700 or 0750 permissions",
        );
      }
      if (!remoteStatus.remoteSessionStoreLinked) {
        throw new Error(
          "Remote ~/.claude/projects is not linked to the configured shared projects directory",
        );
      }
      if (!remoteStatus.credentialStoragePrivate) {
        throw new Error(
          "Remote Claude credentials must remain outside the shared root",
        );
      }
      if (!remoteStatus.remoteClaudeConfigDirUnset) {
        throw new Error(
          "Remote CLAUDE_CONFIG_DIR must be unset for shared session storage",
        );
      }
    }

    const cwdCheck = await runRemoteCommand(
      executor,
      inLoginShell(
        `test -d ${quoteShell(remoteCwd)} && test -r ${quoteShell(remoteCwd)} && test -w ${quoteShell(remoteCwd)}`,
      ),
    );
    if (!cwdCheck.success) {
      throw new Error(
        `Project directory is unavailable on ${executorLabel(executor)}: ${remoteCwd}`,
      );
    }

    const abortController = new AbortController();
    const queue = new RemoteMessageQueue(executor, randomUUID());
    if (options.initialMessage) queue.push(options.initialMessage);

    const onToolApproval = options.onToolApproval;
    const canUseTool: ClaudeCanUseTool | undefined = onToolApproval
      ? async (toolName, input, approvalOptions) => {
          const result = await onToolApproval(toolName, input, approvalOptions);
          if (result.behavior === "allow") {
            return {
              behavior: "allow" as const,
              updatedInput: (result.updatedInput ?? input) as Record<
                string,
                unknown
              >,
            };
          }
          return {
            behavior: "deny" as const,
            message: result.message ?? "Permission denied",
            interrupt: result.interrupt,
          };
        }
      : undefined;

    let capturedProcess: ChildProcess | null = null;
    const spawnClaudeCodeProcess = createRemoteSpawn({
      executor,
      onSpawn: (process) => {
        capturedProcess = process;
      },
    });

    let sdkQuery: Query;
    try {
      sdkQuery = query({
        prompt: queue.generator() as AsyncGenerator<SDKUserMessage>,
        options: {
          cwd: remoteCwd,
          resume: options.resumeSessionId,
          resumeSessionAt: options.resumeSessionAt,
          abortController,
          permissionMode:
            options.permissionMode === "bypassPermissions"
              ? "default"
              : (options.permissionMode ?? DEFAULT_PERMISSION_MODE),
          canUseTool,
          systemPrompt: options.globalInstructions
            ? {
                type: "preset",
                preset: "claude_code",
                append: options.globalInstructions,
              }
            : { type: "preset", preset: "claude_code" },
          settingSources: ["user", "project", "local"],
          includePartialMessages: true,
          model: options.model,
          thinking: options.thinking,
          effort: options.effort,
          env: filterEnvForChildProcess(),
          spawnClaudeCodeProcess,
        },
      });
    } catch (error) {
      queue.cleanup();
      throw new Error(
        `Failed to start remote Claude CLI: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const iterator = this.wrapIterator(sdkQuery, {
      executor,
      localCwd: options.cwd,
      remoteCwd,
      cleanup: () => queue.cleanup(),
    });

    return {
      iterator,
      queue,
      abort: () => {
        abortController.abort();
        queue.cleanup();
      },
      steer: async (message) => {
        queue.push(message);
        return true;
      },
      isProcessAlive: () =>
        capturedProcess !== null &&
        capturedProcess.exitCode === null &&
        !capturedProcess.killed,
      get pid() {
        return (capturedProcess as ChildProcess | null)?.pid;
      },
      setMaxThinkingTokens: (tokens) => sdkQuery.setMaxThinkingTokens(tokens),
      interrupt: async () => {
        await sdkQuery.interrupt();
      },
      supportedModels: async () => {
        const models = await sdkQuery.supportedModels();
        return models.map((model) => ({
          id: model.value,
          name: model.displayName,
          description: model.description,
          contextWindow:
            (model as { contextWindow?: number }).contextWindow ??
            getModelContextWindow(model.value, "claude"),
        }));
      },
      supportedCommands: async (): Promise<SlashCommand[]> => {
        const commands = await sdkQuery.supportedCommands();
        return commands.map((command) => ({
          name: command.name,
          description: command.description,
          argumentHint: command.argumentHint || undefined,
        }));
      },
      setModel: (model) => sdkQuery.setModel(model),
      getContextUsage: async () => {
        try {
          return mapContextUsage(await sdkQuery.getContextUsage());
        } catch (error) {
          getLogger().warn(
            {
              event: "claude_remote_context_usage_failed",
              error: error instanceof Error ? error.message : String(error),
            },
            "Unable to read Claude context usage",
          );
          return null;
        }
      },
      initializationResult: async () => {
        const result = await sdkQuery.initializationResult();
        if (!result?.models) return null;
        return {
          models: result.models.map((model) => ({
            id: model.value,
            contextWindow: (model as { contextWindow?: number }).contextWindow,
          })),
        };
      },
    };
  }

  private async *wrapIterator(
    iterator: AsyncIterable<ClaudeSDKMessage>,
    options: {
      executor: RemoteExecutorConfig;
      localCwd: string;
      remoteCwd: string;
      cleanup: () => void;
    },
  ): AsyncIterableIterator<SDKMessage> {
    let sessionId = "unknown";
    try {
      for await (const message of iterator) {
        sessionId =
          (message as { session_id?: string }).session_id ?? sessionId;
        logSDKMessage(sessionId, message, { provider: "claude" });
        const converted = this.convertMessage(message);

        if (converted.type === "result" && sessionId !== "unknown") {
          const sync = await materializeRemoteSessionFile({
            executor: options.executor,
            localCwd: options.localCwd,
            remoteCwd: options.remoteCwd,
            sessionId,
            localSessionsDir: this.localSessionsDir,
          });
          if (!sync.success) {
            getLogger().warn(
              {
                event:
                  sync.mode === "shared"
                    ? "claude_shared_session_not_visible"
                    : "claude_remote_session_sync_failed",
                executor: executorLabel(options.executor),
                sessionId,
                error: sync.error,
              },
              sync.mode === "shared"
                ? "Remote Claude turn completed, but the shared JSONL was not visible locally"
                : "Remote Claude turn completed, but its JSONL replica could not be updated",
            );
          } else if (sync.localPath) {
            this.onSessionFileUpdated?.({
              executor: options.executor,
              sessionId,
              localPath: sync.localPath,
              projectsDir:
                sync.mode === "shared"
                  ? (options.executor.sessionStorage?.localProjectsDir ??
                    this.localSessionsDir)
                  : this.localSessionsDir,
              mode: sync.mode,
            });
          }
        }

        yield converted;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      throw error;
    } finally {
      options.cleanup();
    }
  }

  private convertMessage(message: ClaudeSDKMessage): SDKMessage {
    const sdkMessage = message as unknown as SDKMessage;
    if (!sdkMessage.message?.content) return sdkMessage;
    return {
      ...sdkMessage,
      message: {
        ...sdkMessage.message,
        content: this.normalizeContent(sdkMessage.message.content),
      },
    };
  }

  private normalizeContent(
    content: string | ContentBlock[] | unknown,
  ): string | ContentBlock[] {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map(
        (block): ContentBlock =>
          typeof block === "string" ? { type: "text", text: block } : block,
      );
    }
    return String(content);
  }
}

export const claudeProvider = new ClaudeProvider();

/** Update the singleton used by provider discovery and Supervisor resolution. */
export function configureClaudeRemoteExecutors(
  executors: RemoteExecutorConfig[],
): void {
  claudeProvider.setRemoteExecutors(executors);
}

export function configureClaudeSessionFileObserver(
  observer: ((update: ClaudeSessionFileUpdate) => void) | undefined,
): void {
  claudeProvider.setSessionFileObserver(observer);
}
