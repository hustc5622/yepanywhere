/**
 * SessionMetadataService manages custom session metadata (titles, archive and
 * pin status). This enables renaming, retention pins, and archive visibility.
 *
 * State is persisted to a JSON file for durability across server restarts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  CodexMcpMode,
  LlmGatewaySessionConfig,
  PermissionMode,
  ProviderName,
  SessionCreatedBy,
  SessionOriginChannel,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { isLiveProviderName } from "../sdk/providers/policy.js";

export interface SessionMetadata {
  /** Custom title that overrides auto-generated title */
  customTitle?: string;
  /** AI-generated title that overrides auto-generated title, but not customTitle */
  aiTitle?: string;
  /** Whether the session is archived (hidden from default list) */
  isArchived?: boolean;
  /** Whether the session is pinned (legacy persisted key kept for compatibility) */
  isStarred?: boolean;
  /** Model used for this session (resolved, not "default") */
  model?: string;
  /** Provider used for this session (for backward compatibility with sessions that don't have provider in JSONL) */
  provider?: ProviderName | string;
  /**
   * Project that owned this session when Yep started it.
   *
   * Recorded so a bare session id can be resolved back to a project without
   * the expensive per-project, per-provider reader scan. Treated as a hint
   * only: the path goes stale if the project directory is moved, so callers
   * must verify it still exists before trusting it.
   */
  projectId?: UrlProjectId;
  projectPath?: string;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Codex MCP profile for app-server sessions. */
  codexMcpMode?: CodexMcpMode;
  /** Effective Codex model source (Codex `model_provider`) for this session. */
  codexModelProvider?: string;
  /** Managed LLM gateway settings used to resume the session. */
  llmGatewayConfig?: LlmGatewaySessionConfig;
  /** @deprecated Persisted compatibility; never written by the live runtime. */
  opencodeConfig?: LlmGatewaySessionConfig;
  /** Last permission/session mode selected for this session. */
  permissionMode?: PermissionMode;
  /** Source session for a provider-native, source-preserving edit fork. */
  forkParentSessionId?: string;
  /** Exact source user-message id replaced by this edit fork. */
  forkTargetMessageId?: string;
  /** Stable logical-session title shared by every member of the fork family. */
  forkFamilyTitle?: string;
  forkFamilyFullTitle?: string;
  /** Whether Yep created this session, or it was discovered from an external client. */
  createdBy?: SessionCreatedBy;
  /** Non-identifying inbound channel. Channel/chat identities are stored separately. */
  originChannel?: SessionOriginChannel;
}

export interface SessionMetadataState {
  /** Map of sessionId -> metadata */
  sessions: Record<string, SessionMetadata>;
  /** Durable mapping from provider bootstrap IDs to their final session IDs. */
  sessionIdAliases?: Record<string, string>;
  /** Schema version for future migrations */
  version: number;
}

const CURRENT_VERSION = 2;

export interface SessionMetadataServiceOptions {
  /** Directory to store metadata state (defaults to ~/.yep-anywhere) */
  dataDir?: string;
}

export class SessionMetadataService {
  private state: SessionMetadataState;
  private dataDir: string;
  private filePath: string;
  /** Providers may replace a temporary bootstrap ID with a durable ID. */
  private sessionIdAliases = new Map<string, string>();
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;

  constructor(options: SessionMetadataServiceOptions = {}) {
    this.dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.filePath = path.join(this.dataDir, "session-metadata.json");
    this.state = {
      sessions: {},
      sessionIdAliases: {},
      version: CURRENT_VERSION,
    };
  }

  /**
   * Initialize the service by loading state from disk.
   * Creates the data directory and file if they don't exist.
   */
  async initialize(): Promise<void> {
    console.log(`[SessionMetadataService] Initializing from: ${this.filePath}`);
    try {
      // Ensure data directory exists
      await fs.mkdir(this.dataDir, { recursive: true });

      // Try to load existing state
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as SessionMetadataState;
      console.log(
        `[SessionMetadataService] Loaded ${Object.keys(parsed.sessions).length} sessions from disk`,
      );

      // Validate and migrate if needed
      if (parsed.version === CURRENT_VERSION) {
        this.state = {
          ...parsed,
          sessionIdAliases: parsed.sessionIdAliases ?? {},
        };
      } else {
        // Version 1 had no durable session ID aliases.
        this.state = {
          sessions: parsed.sessions ?? {},
          sessionIdAliases: parsed.sessionIdAliases ?? {},
          version: CURRENT_VERSION,
        };
        await this.save();
      }
      this.sessionIdAliases = new Map(
        Object.entries(this.state.sessionIdAliases ?? {}),
      );
    } catch (error) {
      // File doesn't exist or is invalid - start fresh
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[SessionMetadataService] Failed to load state, starting fresh:",
          error,
        );
      }
      this.state = {
        sessions: {},
        sessionIdAliases: {},
        version: CURRENT_VERSION,
      };
      this.sessionIdAliases.clear();
    }
  }

  /**
   * Get metadata for a session.
   */
  getMetadata(sessionId: string): SessionMetadata | undefined {
    return this.state.sessions[this.resolveSessionId(sessionId)];
  }

  /**
   * Get all session metadata.
   */
  getAllMetadata(): Record<string, SessionMetadata> {
    return { ...this.state.sessions };
  }

  /**
   * Set the custom title for a session.
   * Pass undefined or empty string to clear the custom title.
   */
  async setTitle(sessionId: string, title: string | undefined): Promise<void> {
    const trimmedTitle = title?.trim();
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      customTitle: trimmedTitle || undefined,
    }));
    await this.save();
  }

  /**
   * Set the AI-generated title for a session.
   * Pass undefined or empty string to clear the AI title.
   */
  async setAiTitle(
    sessionId: string,
    title: string | undefined,
  ): Promise<void> {
    const trimmedTitle = title?.trim();
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      aiTitle: trimmedTitle || undefined,
    }));
    await this.save();
  }

  /**
   * Replace the visible title with an explicitly requested AI title.
   *
   * A custom title normally wins display precedence over `aiTitle`. Clearing it
   * in the same persisted update ensures that clicking "Generate title" has an
   * immediate, deterministic visible result rather than silently writing a
   * hidden title underneath an older rename.
   */
  async setGeneratedTitle(sessionId: string, title: string): Promise<void> {
    const trimmedTitle = title.trim();
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      customTitle: undefined,
      aiTitle: trimmedTitle || undefined,
    }));
    await this.save();
  }

  /**
   * Set the archived status for a session.
   */
  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      isArchived: archived || undefined,
    }));
    await this.save();
  }

  /**
   * Set the legacy persisted bit now used as the session pin status.
   */
  async setStarred(sessionId: string, starred: boolean): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      isStarred: starred || undefined,
    }));
    await this.save();
  }

  /**
   * Set the provider for a session.
   * This stores the provider name for backward compatibility with sessions
   * that don't have provider information in their JSONL files.
   */
  async setProvider(
    sessionId: string,
    provider: ProviderName | undefined,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      provider: provider || undefined,
    }));
    await this.save();
  }

  /**
   * Record which project a session belongs to.
   *
   * This is the reverse index that makes a bare session id resolvable: without
   * it, finding the owning project means scanning every project with every
   * provider reader.
   */
  async setProjectLocation(
    sessionId: string,
    projectId: UrlProjectId | undefined,
    projectPath: string | undefined,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      projectId: projectId || undefined,
      projectPath: projectPath || undefined,
    }));
    await this.save();
  }

  /**
   * Set the executor (SSH host) for a session.
   * Used to track which remote executor ran a session for resume.
   */
  async setExecutor(
    sessionId: string,
    executor: string | undefined,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      executor: executor || undefined,
    }));
    await this.save();
  }

  /**
   * Persist the Codex MCP profile used to launch an app-server session so
   * resumes/restarts reload the same MCP configuration.
   */
  async setCodexMcpMode(
    sessionId: string,
    codexMcpMode: CodexMcpMode | undefined,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      codexMcpMode: codexMcpMode || undefined,
    }));
    await this.save();
  }

  /**
   * Persist the effective Codex model source (Codex `model_provider`) so
   * resumes/restarts start the app-server with the same provider and catalog.
   */
  async setCodexModelProvider(
    sessionId: string,
    codexModelProvider: string | undefined,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      codexModelProvider: codexModelProvider || undefined,
    }));
    await this.save();
  }

  /** Persist the managed LLM gateway contract for restarts. */
  async setLlmGatewayConfig(
    sessionId: string,
    llmGatewayConfig: LlmGatewaySessionConfig | undefined,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      llmGatewayConfig,
    }));
    await this.save();
  }

  /** Persist the mode independently from the lifetime of a provider process. */
  async setPermissionMode(
    sessionId: string,
    permissionMode: PermissionMode | undefined,
  ): Promise<void> {
    if (this.getPermissionMode(sessionId) === permissionMode) return;
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      permissionMode,
    }));
    await this.save();
  }

  /**
   * Get the provider for a session.
   * Returns undefined if the provider was never explicitly saved.
   */
  getProvider(sessionId: string): ProviderName | undefined {
    const provider = this.getPersistedProvider(sessionId);
    return isLiveProviderName(provider) ? provider : undefined;
  }

  /** Raw persisted value for explicit retired-provider error handling only. */
  getPersistedProvider(sessionId: string): string | undefined {
    return this.getMetadata(sessionId)?.provider;
  }

  /**
   * Get the recorded project for a session, if Yep started it.
   *
   * Both fields are required for the result to be useful, so a partially
   * written entry reports as unknown rather than half an answer.
   */
  getProjectLocation(
    sessionId: string,
  ): { projectId: UrlProjectId; projectPath: string } | undefined {
    const metadata = this.getMetadata(sessionId);
    if (!metadata?.projectId || !metadata.projectPath) return undefined;
    return {
      projectId: metadata.projectId,
      projectPath: metadata.projectPath,
    };
  }

  /**
   * Get the executor for a session.
   * Returns undefined if the session ran locally or executor is unknown.
   */
  getExecutor(sessionId: string): string | undefined {
    return this.getMetadata(sessionId)?.executor;
  }

  /**
   * Get the Codex MCP profile for a session.
   * Returns undefined when the session should use provider defaults.
   */
  getCodexMcpMode(sessionId: string): CodexMcpMode | undefined {
    return this.getMetadata(sessionId)?.codexMcpMode;
  }

  getCodexModelProvider(sessionId: string): string | undefined {
    return this.getMetadata(sessionId)?.codexModelProvider;
  }

  getLlmGatewayConfig(sessionId: string): LlmGatewaySessionConfig | undefined {
    const metadata = this.getMetadata(sessionId);
    return metadata?.llmGatewayConfig ?? metadata?.opencodeConfig;
  }

  getPermissionMode(sessionId: string): PermissionMode | undefined {
    return this.getMetadata(sessionId)?.permissionMode;
  }

  /** Persist manual lineage when the provider cannot encode it itself. */
  async setForkParentSessionId(
    sessionId: string,
    forkParentSessionId: string | undefined,
  ): Promise<void> {
    if (this.getForkParentSessionId(sessionId) === forkParentSessionId) return;
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      forkParentSessionId: forkParentSessionId || undefined,
    }));
    await this.save();
  }

  getForkParentSessionId(sessionId: string): string | undefined {
    return this.getMetadata(sessionId)?.forkParentSessionId;
  }

  async setEditForkMetadata(
    sessionId: string,
    input: {
      forkParentSessionId: string;
      forkTargetMessageId?: string;
      forkFamilyTitle?: string;
      forkFamilyFullTitle?: string;
    },
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      forkParentSessionId: input.forkParentSessionId,
      forkTargetMessageId: input.forkTargetMessageId,
      forkFamilyTitle: input.forkFamilyTitle,
      forkFamilyFullTitle: input.forkFamilyFullTitle,
    }));
    await this.save();
  }

  getForkTargetMessageId(sessionId: string): string | undefined {
    return this.getMetadata(sessionId)?.forkTargetMessageId;
  }

  getForkFamilyTitle(
    sessionId: string,
  ): { title?: string; fullTitle?: string } | undefined {
    const metadata = this.getMetadata(sessionId);
    if (!metadata?.forkFamilyTitle && !metadata?.forkFamilyFullTitle) {
      return undefined;
    }
    return {
      title: metadata.forkFamilyTitle,
      fullTitle: metadata.forkFamilyFullTitle,
    };
  }

  /**
   * Move metadata from a provider's temporary session ID to its durable ID.
   *
   * The alias is registered before reading state so a later write that still
   * uses the temporary ID is redirected even when this method wins the race
   * against the HTTP creation route.
   */
  async remapSessionId(
    oldSessionId: string,
    newSessionId: string,
  ): Promise<void> {
    if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) {
      return;
    }

    const resolvedOldSessionId = this.resolveSessionId(oldSessionId);
    const resolvedNewSessionId = this.resolveSessionId(newSessionId);

    this.sessionIdAliases.set(oldSessionId, resolvedNewSessionId);
    if (resolvedOldSessionId !== oldSessionId) {
      this.sessionIdAliases.set(resolvedOldSessionId, resolvedNewSessionId);
    }
    for (const [alias, target] of this.sessionIdAliases) {
      if (target === resolvedOldSessionId) {
        this.sessionIdAliases.set(alias, resolvedNewSessionId);
      }
    }
    this.state.sessionIdAliases = Object.fromEntries(this.sessionIdAliases);

    const oldMetadata = this.state.sessions[resolvedOldSessionId];
    const newMetadata = this.state.sessions[resolvedNewSessionId];
    if (!oldMetadata && !newMetadata) {
      await this.save();
      return;
    }

    // Durable-ID metadata wins when both entries already exist; the temporary
    // entry only fills fields that have not yet been persisted on the target.
    const mergedMetadata = { ...oldMetadata, ...newMetadata };
    delete this.state.sessions[oldSessionId];
    delete this.state.sessions[resolvedOldSessionId];
    this.state.sessions[resolvedNewSessionId] = mergedMetadata;
    await this.save();
  }

  /**
   * Set the creation source for a session.
   */
  async setCreatedBy(
    sessionId: string,
    createdBy: SessionCreatedBy | undefined,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      createdBy: createdBy || undefined,
    }));
    await this.save();
  }

  async setOrigin(
    sessionId: string,
    origin: {
      createdBy?: SessionCreatedBy;
      originChannel?: SessionOriginChannel;
    },
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      createdBy: origin.createdBy || undefined,
      originChannel: origin.originChannel || undefined,
    }));
    await this.save();
  }

  /**
   * Update metadata for a session (title, archived, pinned compatibility bit).
   */
  async updateMetadata(
    sessionId: string,
    updates: { title?: string; archived?: boolean; starred?: boolean },
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => {
      const result = { ...metadata };

      // Handle title
      if (updates.title !== undefined) {
        const trimmedTitle = updates.title.trim();
        result.customTitle = trimmedTitle || undefined;
      }

      // Handle archived
      if (updates.archived !== undefined) {
        result.isArchived = updates.archived || undefined;
      }

      // Handle starred
      if (updates.starred !== undefined) {
        result.isStarred = updates.starred || undefined;
      }

      return result;
    });
    await this.save();
  }

  /**
   * Helper to update session metadata and clean up empty entries.
   */
  private updateSessionMetadata(
    sessionId: string,
    updater: (current: SessionMetadata) => SessionMetadata,
  ): void {
    const resolvedSessionId = this.resolveSessionId(sessionId);
    const existing = this.state.sessions[resolvedSessionId] ?? {};
    const updated = updater(existing);

    // Remove undefined values and check if entry should be deleted
    const cleaned: SessionMetadata = {};
    if (updated.customTitle) cleaned.customTitle = updated.customTitle;
    if (updated.aiTitle) cleaned.aiTitle = updated.aiTitle;
    if (updated.isArchived) cleaned.isArchived = updated.isArchived;
    if (updated.isStarred) cleaned.isStarred = updated.isStarred;
    if (updated.model) cleaned.model = updated.model;
    if (updated.provider) cleaned.provider = updated.provider;
    if (updated.executor) cleaned.executor = updated.executor;
    if (updated.codexMcpMode) cleaned.codexMcpMode = updated.codexMcpMode;
    if (updated.codexModelProvider) {
      cleaned.codexModelProvider = updated.codexModelProvider;
    }
    const llmGatewayConfig = updated.llmGatewayConfig ?? updated.opencodeConfig;
    if (llmGatewayConfig) {
      cleaned.llmGatewayConfig = llmGatewayConfig;
    }
    if (updated.permissionMode) {
      cleaned.permissionMode = updated.permissionMode;
    }
    if (updated.forkParentSessionId) {
      cleaned.forkParentSessionId = updated.forkParentSessionId;
    }
    if (updated.forkTargetMessageId) {
      cleaned.forkTargetMessageId = updated.forkTargetMessageId;
    }
    if (updated.forkFamilyTitle) {
      cleaned.forkFamilyTitle = updated.forkFamilyTitle;
    }
    if (updated.forkFamilyFullTitle) {
      cleaned.forkFamilyFullTitle = updated.forkFamilyFullTitle;
    }
    if (updated.createdBy) cleaned.createdBy = updated.createdBy;
    if (updated.originChannel) cleaned.originChannel = updated.originChannel;
    if (updated.projectId) cleaned.projectId = updated.projectId;
    if (updated.projectPath) cleaned.projectPath = updated.projectPath;

    if (Object.keys(cleaned).length === 0) {
      // Remove the entry entirely if empty
      const { [resolvedSessionId]: _, ...rest } = this.state.sessions;
      this.state.sessions = rest;
    } else {
      this.state.sessions[resolvedSessionId] = cleaned;
    }
  }

  private resolveSessionId(sessionId: string): string {
    let resolved = sessionId;
    const visited = new Set<string>();
    while (!visited.has(resolved)) {
      visited.add(resolved);
      const next = this.sessionIdAliases.get(resolved);
      if (!next) break;
      resolved = next;
    }
    return resolved;
  }

  /** Resolve a temporary provider ID to the durable ID used on disk. */
  getCanonicalSessionId(sessionId: string): string {
    return this.resolveSessionId(sessionId);
  }

  /**
   * Clear all metadata for a session.
   * Useful when a session is deleted.
   */
  async clearSession(sessionId: string): Promise<void> {
    const resolvedSessionId = this.resolveSessionId(sessionId);
    if (this.state.sessions[resolvedSessionId]) {
      const { [resolvedSessionId]: _, ...rest } = this.state.sessions;
      this.state.sessions = rest;
      await this.save();
    }
  }

  /**
   * Save state to disk with debouncing to prevent excessive writes.
   */
  private async save(): Promise<void> {
    // If a save is in progress, mark that we need another save
    if (this.savePromise) {
      this.pendingSave = true;
      return;
    }

    this.savePromise = this.doSave();
    await this.savePromise;
    this.savePromise = null;

    // If another save was requested while we were saving, do it now
    if (this.pendingSave) {
      this.pendingSave = false;
      await this.save();
    }
  }

  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.filePath, content, "utf-8");
    } catch (error) {
      console.error("[SessionMetadataService] Failed to save state:", error);
      throw error;
    }
  }

  /**
   * Get the file path for testing purposes.
   */
  getFilePath(): string {
    return this.filePath;
  }
}
