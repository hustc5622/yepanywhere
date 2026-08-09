/**
 * GeminiSessionReader - Reads Gemini sessions from disk.
 *
 * Gemini stores sessions at ~/.gemini/tmp/<projectHash>/chats/session-*.json
 * with a different format than Claude or Codex:
 * - JSON files (not JSONL)
 * - sessionId, projectHash, startTime, lastUpdated
 * - messages[] array with user and gemini message types
 *
 * Unlike Claude's DAG structure, Gemini sessions are linear.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type ContextCumulativeUsage,
  type GeminiAssistantMessage,
  type GeminiSessionFile,
  type GeminiSessionMessage,
  type GeminiUserMessage,
  SESSION_TITLE_MAX_LENGTH,
  type SessionQuestion,
  type UnifiedSession,
  type UrlProjectId,
  getGeminiUserMessageText,
  getModelContextWindow,
  parseGeminiSessionFile,
} from "@yep-anywhere/shared";
import type {
  ContentBlock,
  ContextUsage,
  Message,
  Session,
  SessionSummary,
} from "../supervisor/types.js";
import { sanitizePublicUserPrompt } from "./public-user-prompt.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
  SessionFileEntry,
} from "./types.js";
import { createSessionQuestion } from "./user-questions.js";

export interface GeminiSessionReaderOptions {
  /**
   * Base directory for Gemini sessions (~/.gemini/tmp).
   * Sessions are stored in <projectHash>/chats/session-*.json structure.
   */
  sessionsDir: string;
  /**
   * The project path (cwd) to filter sessions by.
   * Only sessions with this cwd will be listed.
   */
  projectPath?: string;
  /**
   * Optional map of projectHash -> cwd for filtering.
   * If not provided, all sessions will be listed.
   * Can be a Map or a Promise that resolves to a Map.
   */
  hashToCwd?: Map<string, string> | Promise<Map<string, string>>;
}

interface GeminiSessionCacheEntry {
  id: string;
  filePath: string;
  projectHash: string;
  startTime: string;
  mtime: number;
  size: number;
}

/**
 * Gemini-specific session reader for Gemini CLI JSON files.
 *
 * Handles Gemini's linear conversation structure with user and gemini messages.
 */
export class GeminiSessionReader implements ISessionReader {
  private sessionsDir: string;
  private projectPath?: string;
  private hashToCwd?: Map<string, string> | Promise<Map<string, string>>;

  // Cache of session ID -> file info for quick lookups
  private sessionFileCache: Map<string, GeminiSessionCacheEntry> = new Map();
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 5000; // 5 second cache

  constructor(options: GeminiSessionReaderOptions) {
    this.sessionsDir = options.sessionsDir;
    this.projectPath = options.projectPath;
    this.hashToCwd = options.hashToCwd;
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    const sessions = await this.scanSessions();

    for (const session of sessions) {
      // Filter by project path if set
      if (this.projectPath) {
        // Resolve hashToCwd if needed
        let map: Map<string, string> | undefined;
        if (this.hashToCwd instanceof Promise) {
          map = await this.hashToCwd;
        } else {
          map = this.hashToCwd;
        }

        const cwd = map?.get(session.projectHash);
        if (cwd !== this.projectPath) {
          continue;
        }
      }

      const summary = await this.getSessionSummary(session.id, projectId);
      if (summary) {
        summaries.push(summary);
      }
    }

    // Sort by updatedAt descending
    summaries.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return summaries;
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const sessionCache = await this.findSessionFile(sessionId);
    if (!sessionCache) return null;

    try {
      const content = await readFile(sessionCache.filePath, "utf-8");
      const session = parseGeminiSessionFile(content);

      if (!session || session.messages.length === 0) return null;

      const stats = await stat(sessionCache.filePath);
      const { title, fullTitle } = this.extractTitle(session.messages);
      const userQuestions = this.extractUserQuestions(session.messages);
      const messageCount = session.messages.length;
      const model = this.extractModel(session.messages);
      const contextUsage = this.extractContextUsage(session.messages, model);
      const cumulativeUsage = this.extractCumulativeTokenUsage(
        session.messages,
      );

      // Skip sessions with no actual conversation messages
      if (messageCount === 0) return null;

      return {
        id: sessionId,
        projectId,
        title,
        fullTitle,
        createdAt: session.startTime,
        updatedAt: session.lastUpdated ?? stats.mtime.toISOString(),
        messageCount,
        userQuestions,
        ownership: { owner: "none" },
        contextUsage,
        cumulativeUsage,
        provider: "gemini",
        model,
      };
    } catch {
      return null;
    }
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    _options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const summary = await this.getSessionSummary(sessionId, projectId);
    if (!summary) return null;

    const sessionCache = await this.findSessionFile(sessionId);
    if (!sessionCache) return null;

    const content = await readFile(sessionCache.filePath, "utf-8");
    const sessionFile = parseGeminiSessionFile(content);
    if (!sessionFile) return null;

    // Filter messages for incremental fetching if needed
    // For Gemini, messages have 'id' which we map to 'uuid'
    // This is a bit tricky with raw session return, similar to Claude reader note.
    // For now, we return the full session or slice the messages array if we can.
    let messages = sessionFile.messages;
    if (afterMessageId) {
      const afterIndex = messages.findIndex((m) => m.id === afterMessageId);
      if (afterIndex !== -1) {
        messages = messages.slice(afterIndex + 1);
      }
    }

    return {
      summary,
      data: {
        provider: "gemini",
        session: {
          ...sessionFile,
          messages,
        },
      },
    };
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const sessionCache = await this.findSessionFile(sessionId);
    if (!sessionCache) return null;

    try {
      const stats = await stat(sessionCache.filePath);
      const mtime = stats.mtimeMs;
      const size = stats.size;

      // If mtime and size match cached values, return null (no change)
      if (mtime === cachedMtime && size === cachedSize) {
        return null;
      }

      const summary = await this.getSessionSummary(sessionId, projectId);
      if (!summary) return null;

      return { summary, mtime, size };
    } catch {
      return null;
    }
  }

  /**
   * Gemini doesn't have subagent sessions like Claude.
   * Returns empty array for compatibility.
   */
  async getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]> {
    return [];
  }

  /**
   * Gemini doesn't have subagent sessions like Claude.
   * Returns null for compatibility.
   */
  async getAgentSession(
    _agentId: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    return null;
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    const sessionCache = await this.findSessionFile(sessionId);
    return sessionCache?.filePath ?? null;
  }

  getIndexScopeKey(sessionDir: string): string {
    return `gemini::${sessionDir}::${this.projectPath ?? "*"}`;
  }

  /**
   * Enumerate session files in a directory for SessionIndexService.
   * Reuses the reader's scan cache because Gemini IDs are inside JSON content.
   */
  async listSessionFiles(_sessionDir: string): Promise<SessionFileEntry[]> {
    const sessions = await this.scanSessions();
    const results: SessionFileEntry[] = [];

    let map: Map<string, string> | undefined;
    if (this.projectPath) {
      map =
        this.hashToCwd instanceof Promise
          ? await this.hashToCwd
          : this.hashToCwd;
    }

    for (const session of sessions) {
      if (
        this.projectPath &&
        map?.get(session.projectHash) !== this.projectPath
      ) {
        continue;
      }
      results.push({
        sessionId: session.id,
        filePath: session.filePath,
        mtime: session.mtime,
        size: session.size,
      });
    }

    return results;
  }

  /**
   * Scan the sessions directory and find all session files.
   */
  private async scanSessions(): Promise<GeminiSessionCacheEntry[]> {
    // Check cache
    if (Date.now() - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return Array.from(this.sessionFileCache.values());
    }

    const sessions: GeminiSessionCacheEntry[] = [];

    try {
      await stat(this.sessionsDir);
    } catch {
      // Directory doesn't exist
      return [];
    }

    // Scan ~/.gemini/tmp/{dirName}/chats/*.json
    // dirName may be a slug (v0.29+) or a SHA-256 hash (older CLI)
    const projectDirs = await this.findProjectDirs();

    for (const { dir, dirName } of projectDirs) {
      const chatsDir = join(dir, "chats");
      try {
        await stat(chatsDir);
        const files = await this.findSessionFiles(chatsDir);

        for (const filePath of files) {
          const session = await this.readSessionMeta(filePath, dirName);
          if (session) {
            sessions.push(session);
            this.sessionFileCache.set(session.id, session);
          }
        }
      } catch {
        // Chats directory doesn't exist, skip
      }
    }

    this.cacheTimestamp = Date.now();
    return sessions;
  }

  /**
   * Find all project directories in ~/.gemini/tmp/
   * Directory names may be slugs (v0.29+) or SHA-256 hashes (older CLI).
   */
  private async findProjectDirs(): Promise<{ dir: string; dirName: string }[]> {
    const dirs: { dir: string; dirName: string }[] = [];

    try {
      const entries = await readdir(this.sessionsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          dirs.push({
            dir: join(this.sessionsDir, entry.name),
            dirName: entry.name,
          });
        }
      }
    } catch {
      // Ignore errors
    }

    return dirs;
  }

  /**
   * Find all session JSON files in a chats directory.
   */
  private async findSessionFiles(chatsDir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await readdir(chatsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (
          entry.isFile() &&
          entry.name.startsWith("session-") &&
          entry.name.endsWith(".json")
        ) {
          files.push(join(chatsDir, entry.name));
        }
      }
    } catch {
      // Ignore errors
    }

    return files;
  }

  /**
   * Find a session file by ID.
   */
  private async findSessionFile(
    sessionId: string,
  ): Promise<GeminiSessionCacheEntry | null> {
    // Check cache first
    const cached = this.sessionFileCache.get(sessionId);
    if (cached) return cached;

    // Scan if cache miss
    await this.scanSessions();
    return this.sessionFileCache.get(sessionId) ?? null;
  }

  /**
   * Read session metadata from a file.
   */
  private async readSessionMeta(
    filePath: string,
    _dirName: string,
  ): Promise<GeminiSessionCacheEntry | null> {
    try {
      const stats = await stat(filePath);
      const content = await readFile(filePath, "utf-8");
      const session = parseGeminiSessionFile(content);

      if (!session) return null;

      return {
        id: session.sessionId,
        filePath,
        // Use projectHash from file content (SHA-256), not directory name.
        // Gemini CLI ≥ v0.29 uses slug-based directory names instead of hashes.
        projectHash: session.projectHash,
        startTime: session.startTime,
        mtime: stats.mtimeMs,
        size: stats.size,
      };
    } catch {
      return null;
    }
  }

  /**
   * Extract title from messages (first user message).
   */
  private extractTitle(messages: GeminiSessionMessage[]): {
    title: string | null;
    fullTitle: string | null;
  } {
    // Find first user message
    for (const msg of messages) {
      if (msg.type === "user") {
        const userMsg = msg as GeminiUserMessage;
        const fullTitle = sanitizePublicUserPrompt(
          getGeminiUserMessageText(userMsg.content),
        ).trim();
        const title =
          fullTitle.length <= SESSION_TITLE_MAX_LENGTH
            ? fullTitle
            : `${fullTitle.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
        return { title, fullTitle };
      }
    }

    return { title: null, fullTitle: null };
  }

  private extractUserQuestions(
    messages: GeminiSessionMessage[],
  ): SessionQuestion[] {
    const questions: SessionQuestion[] = [];

    for (let index = 0; index < messages.length; index++) {
      const msg = messages[index];
      if (!msg || msg.type !== "user") continue;

      const userMsg = msg as GeminiUserMessage;
      const question = createSessionQuestion(
        {
          id: userMsg.id,
          text: getGeminiUserMessageText(userMsg.content),
          timestamp: userMsg.timestamp,
        },
        `gemini-user-${index}`,
      );
      if (question) {
        questions.push(question);
      }
    }

    return questions;
  }

  /**
   * Extract context usage from token counts in messages.
   *
   * @param messages - Gemini session messages
   * @param model - Model ID for determining context window size
   */
  private extractContextUsage(
    messages: GeminiSessionMessage[],
    model: string | undefined,
  ): ContextUsage | undefined {
    const contextWindowSize = getModelContextWindow(model);

    // Find last assistant message with token info
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.type === "gemini") {
        const assistantMsg = msg as GeminiAssistantMessage;
        if (assistantMsg.tokens?.input) {
          const inputTokens =
            assistantMsg.tokens.input + (assistantMsg.tokens.cached ?? 0);
          const percentage = Math.round(
            (inputTokens / contextWindowSize) * 100,
          );

          return { inputTokens, percentage, contextWindow: contextWindowSize };
        }
      }
    }

    return undefined;
  }

  private extractCumulativeTokenUsage(
    messages: GeminiSessionMessage[],
  ): ContextCumulativeUsage | undefined {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let totalTokens = 0;
    let turnCount = 0;

    for (const msg of messages) {
      if (msg.type !== "gemini") continue;
      const tokens = (msg as GeminiAssistantMessage).tokens;
      if (!tokens) continue;

      const input = tokens.input ?? 0;
      const output = tokens.output ?? 0;
      const cached = tokens.cached ?? 0;
      const total = tokens.total ?? input + output + cached;

      inputTokens += input;
      outputTokens += output;
      cacheReadTokens += cached;
      totalTokens += total;
      turnCount += 1;
    }

    if (turnCount === 0) return undefined;

    return {
      totalTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens: 0,
      turnCount,
    };
  }

  /**
   * Extract the model from the first assistant message.
   */
  private extractModel(messages: GeminiSessionMessage[]): string | undefined {
    // Find the first assistant message with a model field
    for (const msg of messages) {
      if (msg.type === "gemini") {
        const assistantMsg = msg as GeminiAssistantMessage;
        if (assistantMsg.model) {
          return assistantMsg.model;
        }
      }
    }
    return undefined;
  }
}
