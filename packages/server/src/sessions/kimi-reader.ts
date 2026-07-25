/**
 * KimiSessionReader - Reads Kimi Code CLI sessions from disk.
 *
 * Kimi stores sessions under
 *   ~/.kimi-code/sessions/<workspace>/session_<uuid>/
 *     ├── state.json               (title / timestamps / workDir)
 *     └── agents/main/wire.jsonl   (append-only event log)
 *
 * The session id is the `session_<uuid>` directory name. Sessions are linear
 * (no DAG). The transcript is reconstructed from the wire.jsonl records by the
 * normalization layer; this reader is responsible for discovery, filtering by
 * project cwd, and summary metadata.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type ContextCumulativeUsage,
  type KimiStepEndEvent,
  type KimiWireRecord,
  SESSION_TITLE_MAX_LENGTH,
  type SessionQuestion,
  type UrlProjectId,
  getKimiPromptText,
  getModelContextWindow,
  isKimiLoopEventRecord,
  isKimiModelConfigRecord,
  isKimiTurnPromptRecord,
  parseKimiSessionState,
  parseKimiWireJsonl,
} from "@yep-anywhere/shared";
import type {
  ContextUsage,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
  SessionFileEntry,
} from "./types.js";
import { createSessionQuestion } from "./user-questions.js";

export interface KimiSessionReaderOptions {
  /** Base directory for Kimi sessions (~/.kimi-code/sessions). */
  sessionsDir: string;
  /** Project cwd to filter sessions by (matched against state.json workDir). */
  projectPath?: string;
}

interface KimiSessionCacheEntry {
  id: string;
  /** Path to agents/main/wire.jsonl */
  filePath: string;
  sessionDir: string;
  workDir?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  mtime: number;
  size: number;
}

/** Aggregate derived from a parsed wire.jsonl. */
interface KimiWireDerived {
  records: KimiWireRecord[];
  model: string | undefined;
  messageCount: number;
  contextUsage: ContextUsage | undefined;
  cumulativeUsage: ContextCumulativeUsage | undefined;
  firstPromptText: string | undefined;
}

export class KimiSessionReader implements ISessionReader {
  private sessionsDir: string;
  private projectPath?: string;

  private sessionFileCache: Map<string, KimiSessionCacheEntry> = new Map();
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 5000;

  constructor(options: KimiSessionReaderOptions) {
    this.sessionsDir = options.sessionsDir;
    this.projectPath = options.projectPath;
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    const sessions = await this.scanSessions();

    for (const session of sessions) {
      if (this.projectPath && session.workDir !== this.projectPath) {
        continue;
      }
      const summary = await this.getSessionSummary(session.id, projectId);
      if (summary) summaries.push(summary);
    }

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
    const entry = await this.findSessionFile(sessionId);
    if (!entry) return null;

    try {
      const content = await readFile(entry.filePath, "utf-8");
      const derived = this.deriveFromWire(content);
      if (derived.messageCount === 0) return null;

      const stats = await stat(entry.filePath);
      const fullTitle = (
        entry.title && entry.title !== "New Session"
          ? entry.title
          : (derived.firstPromptText ?? entry.title ?? "")
      ).trim();
      const title =
        fullTitle.length === 0
          ? null
          : fullTitle.length <= SESSION_TITLE_MAX_LENGTH
            ? fullTitle
            : `${fullTitle.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;

      return {
        id: sessionId,
        projectId,
        title,
        fullTitle: fullTitle.length === 0 ? null : fullTitle,
        createdAt: entry.createdAt ?? stats.birthtime.toISOString(),
        updatedAt: entry.updatedAt ?? stats.mtime.toISOString(),
        messageCount: derived.messageCount,
        userQuestions: this.extractUserQuestions(derived.records, sessionId),
        ownership: { owner: "none" },
        contextUsage: derived.contextUsage,
        cumulativeUsage: derived.cumulativeUsage,
        provider: "kimi",
        model: derived.model,
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

    const entry = await this.findSessionFile(sessionId);
    if (!entry) return null;

    const content = await readFile(entry.filePath, "utf-8");
    const records = parseKimiWireJsonl(content);

    return {
      summary,
      data: {
        provider: "kimi",
        session: {
          sessionId,
          workDir: entry.workDir,
          title: entry.title,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          model: summary.model,
          records,
        },
      },
      // afterMessageId incremental fetch is not supported for Kimi (message
      // ids are synthesized during normalization). Callers fall back to full
      // fetch; kept in the signature for interface parity.
      ...(afterMessageId ? {} : {}),
    };
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const entry = await this.findSessionFile(sessionId);
    if (!entry) return null;

    try {
      const stats = await stat(entry.filePath);
      if (stats.mtimeMs === cachedMtime && stats.size === cachedSize) {
        return null;
      }
      const summary = await this.getSessionSummary(sessionId, projectId);
      if (!summary) return null;
      return { summary, mtime: stats.mtimeMs, size: stats.size };
    } catch {
      return null;
    }
  }

  /** Kimi subagents are not surfaced in this phase. */
  async getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]> {
    return [];
  }

  /** Kimi subagents are not surfaced in this phase. */
  async getAgentSession(
    _agentId: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    return null;
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    const entry = await this.findSessionFile(sessionId);
    return entry?.filePath ?? null;
  }

  getIndexScopeKey(sessionDir: string): string {
    return `kimi::${sessionDir}::${this.projectPath ?? "*"}`;
  }

  async listSessionFiles(_sessionDir: string): Promise<SessionFileEntry[]> {
    const sessions = await this.scanSessions();
    const results: SessionFileEntry[] = [];
    for (const session of sessions) {
      if (this.projectPath && session.workDir !== this.projectPath) continue;
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
   * Scan the sessions root for `<workspace>/session_<uuid>` directories.
   */
  private async scanSessions(): Promise<KimiSessionCacheEntry[]> {
    if (Date.now() - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return Array.from(this.sessionFileCache.values());
    }

    const sessions: KimiSessionCacheEntry[] = [];
    this.sessionFileCache.clear();

    let workspaceDirs: string[];
    try {
      const entries = await readdir(this.sessionsDir, { withFileTypes: true });
      workspaceDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => join(this.sessionsDir, e.name));
    } catch {
      return [];
    }

    for (const workspaceDir of workspaceDirs) {
      let sessionDirs: string[];
      try {
        const entries = await readdir(workspaceDir, { withFileTypes: true });
        sessionDirs = entries
          .filter((e) => e.isDirectory() && e.name.startsWith("session_"))
          .map((e) => e.name);
      } catch {
        continue;
      }

      for (const sessionName of sessionDirs) {
        const sessionDir = join(workspaceDir, sessionName);
        const entry = await this.readSessionMeta(sessionName, sessionDir);
        if (entry) {
          sessions.push(entry);
          this.sessionFileCache.set(entry.id, entry);
        }
      }
    }

    this.cacheTimestamp = Date.now();
    return sessions;
  }

  private async readSessionMeta(
    sessionId: string,
    sessionDir: string,
  ): Promise<KimiSessionCacheEntry | null> {
    const filePath = join(sessionDir, "agents", "main", "wire.jsonl");
    try {
      const stats = await stat(filePath);
      let workDir: string | undefined;
      let title: string | undefined;
      let createdAt: string | undefined;
      let updatedAt: string | undefined;

      try {
        const stateRaw = await readFile(
          join(sessionDir, "state.json"),
          "utf-8",
        );
        const state = parseKimiSessionState(stateRaw);
        if (state) {
          workDir = state.workDir;
          title = state.title;
          createdAt = state.createdAt;
          updatedAt = state.updatedAt;
        }
      } catch {
        // state.json missing/unreadable — fall back to file stats below.
      }

      return {
        id: sessionId,
        filePath,
        sessionDir,
        workDir,
        title,
        createdAt,
        updatedAt,
        mtime: stats.mtimeMs,
        size: stats.size,
      };
    } catch {
      // No wire.jsonl — not a usable session.
      return null;
    }
  }

  private async findSessionFile(
    sessionId: string,
  ): Promise<KimiSessionCacheEntry | null> {
    const cached = this.sessionFileCache.get(sessionId);
    if (cached) return cached;
    await this.scanSessions();
    return this.sessionFileCache.get(sessionId) ?? null;
  }

  /**
   * Derive summary aggregates from a wire.jsonl body without building the full
   * normalized message list. Message counting mirrors the normalization rule:
   * user turns come from `turn.prompt`; assistant messages are flushed at each
   * tool.result / turn boundary; tool results are individual messages.
   */
  private deriveFromWire(content: string): KimiWireDerived {
    const records = parseKimiWireJsonl(content);

    let model: string | undefined;
    let firstPromptText: string | undefined;
    let messageCount = 0;
    let turnCount = 0;

    // Assistant-segment tracking (mirrors convertKimiMessages flush points).
    let pendingAssistantBlocks = 0;
    const flushAssistant = () => {
      if (pendingAssistantBlocks > 0) {
        messageCount += 1;
        pendingAssistantBlocks = 0;
      }
    };

    // Cumulative usage accumulators.
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let lastContextInput: number | undefined;

    for (const record of records) {
      if (isKimiModelConfigRecord(record)) {
        model = record.modelAlias;
        continue;
      }
      if (isKimiTurnPromptRecord(record)) {
        flushAssistant();
        messageCount += 1;
        turnCount += 1;
        if (firstPromptText === undefined) {
          firstPromptText = getKimiPromptText(record.input);
        }
        continue;
      }
      if (!isKimiLoopEventRecord(record)) continue;

      const event = record.event;
      switch (event.type) {
        case "content.part":
        case "tool.call":
          pendingAssistantBlocks += 1;
          break;
        case "tool.result":
          flushAssistant();
          messageCount += 1;
          break;
        case "step.end": {
          const usage = (event as KimiStepEndEvent).usage;
          if (usage) {
            const other = usage.inputOther ?? 0;
            const cacheRead = usage.inputCacheRead ?? 0;
            const cacheCreation = usage.inputCacheCreation ?? 0;
            inputTokens += other;
            outputTokens += usage.output ?? 0;
            cacheReadTokens += cacheRead;
            cacheCreationTokens += cacheCreation;
            lastContextInput = other + cacheRead + cacheCreation;
          }
          break;
        }
        default:
          break;
      }
    }
    flushAssistant();

    const contextWindow = getModelContextWindow(model, "kimi");
    const contextUsage: ContextUsage | undefined =
      lastContextInput !== undefined
        ? {
            inputTokens: lastContextInput,
            percentage: Math.round((lastContextInput / contextWindow) * 100),
            contextWindow,
          }
        : undefined;

    const cumulativeUsage: ContextCumulativeUsage | undefined =
      turnCount > 0
        ? {
            totalTokens:
              inputTokens +
              outputTokens +
              cacheReadTokens +
              cacheCreationTokens,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            turnCount,
          }
        : undefined;

    return {
      records,
      model,
      messageCount,
      contextUsage,
      cumulativeUsage,
      firstPromptText,
    };
  }

  private extractUserQuestions(
    records: KimiWireRecord[],
    sessionId: string,
  ): SessionQuestion[] {
    const questions: SessionQuestion[] = [];
    let index = 0;
    for (const record of records) {
      if (!isKimiTurnPromptRecord(record)) continue;
      const question = createSessionQuestion(
        {
          id: `${sessionId}-user-${index}`,
          text: getKimiPromptText(record.input),
          timestamp: record.time ? new Date(record.time).toISOString() : "",
        },
        `kimi-user-${index}`,
      );
      if (question) questions.push(question);
      index += 1;
    }
    return questions;
  }
}
