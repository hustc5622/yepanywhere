import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type AgentMapping,
  type ContextUsage,
  type CursorSessionContent,
  type CursorTranscriptMessage,
  SESSION_TITLE_MAX_LENGTH,
  type SessionLastTurnStatus,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { canonicalizeProjectPath } from "../projects/paths.js";
import { cursorStreamError } from "../sdk/providers/cursor-errors.js";
import type { SessionSummary } from "../supervisor/types.js";
import {
  getCursorSessionFileStats,
  readCursorSessionDir,
  readCursorSessionMeta,
} from "./cursor-store.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
  SessionFileEntry,
} from "./types.js";
import { createSessionQuestion } from "./user-questions.js";

export const CURSOR_ACP_SESSIONS_DIR = join(
  process.env.CURSOR_CONFIG_DIR?.trim() || join(homedir(), ".cursor"),
  "acp-sessions",
);

const CURSOR_SESSION_FILES = new Set([
  "store.db",
  "store.db-wal",
  "store.db-shm",
  "meta.json",
]);

/** Session id is the parent directory of store.db, its WAL, or meta.json. */
export function cursorSessionIdFromWatchPath(filePath: string): string | null {
  if (!CURSOR_SESSION_FILES.has(basename(filePath))) return null;
  const sessionId = basename(dirname(filePath));
  if (!sessionId || sessionId === "acp-sessions" || sessionId === ".") {
    return null;
  }
  return sessionId;
}

export interface CursorSessionReaderOptions {
  sessionsDir?: string;
  projectPath?: string;
}

export class CursorSessionReader implements ISessionReader {
  private readonly sessionsDir: string;
  private readonly projectPath: string | undefined;

  constructor(options: CursorSessionReaderOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? CURSOR_ACP_SESSIONS_DIR;
    this.projectPath = options.projectPath
      ? canonicalizeProjectPath(options.projectPath)
      : undefined;
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const sessions = await this.loadProjectSessions();
    return sessions.map((session) => toSummary(session, projectId));
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const session = await this.loadOne(sessionId);
    return session ? toSummary(session, projectId) : null;
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    _afterMessageId?: string,
    _options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const session = await this.loadOne(sessionId);
    if (!session) return null;
    const summary = toSummary(session, projectId);
    const content: CursorSessionContent = { messages: session.messages };
    return {
      summary,
      data: { provider: "cursor", session: content },
    };
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const stats = await this.getSessionFileStats(sessionId);
    if (!stats) return null;
    if (stats.mtime === cachedMtime && stats.size === cachedSize) return null;
    const summary = await this.getSessionSummary(sessionId, projectId);
    if (!summary) return null;
    return { summary, ...stats };
  }

  async getAgentMappings(_sessionId?: string): Promise<AgentMapping[]> {
    return [];
  }

  async getAgentSession(_agentId: string, _sessionId?: string): Promise<null> {
    return null;
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    const dbPath = join(this.sessionsDir, sessionId, "store.db");
    try {
      await stat(dbPath);
      return dbPath;
    } catch {
      return null;
    }
  }

  async getSessionFileStats(
    sessionId: string,
  ): Promise<{ mtime: number; size: number } | null> {
    return getCursorSessionFileStats(join(this.sessionsDir, sessionId));
  }

  async listSessionFiles(sessionDir: string): Promise<SessionFileEntry[]> {
    const entries = await readSessionDirs(sessionDir);
    const files: SessionFileEntry[] = [];
    for (const sessionId of entries) {
      try {
        // Every project scope shares one sessions directory. Listing only
        // this project's sessions keeps each scope from opening every other
        // project's store.db and from being dirtied by their writes.
        if (!(await this.metaMatchesProject(join(sessionDir, sessionId))))
          continue;
        const info = await getCursorSessionFileStats(
          join(sessionDir, sessionId),
        );
        if (!info) continue;
        files.push({
          sessionId,
          filePath: join(sessionDir, sessionId, "store.db"),
          mtime: info.mtime,
          size: info.size,
        });
      } catch {
        // meta-only sessions are not durable history.
      }
    }
    return files;
  }

  getIndexScopeKey(sessionDir: string): string {
    // Rebuild older summaries (pre-usage, pre-turn-status) even for sessions
    // whose database is unchanged.
    return `cursor::${sessionDir}::${this.projectPath ?? "*"}::turn-status-v1`;
  }

  private async loadOne(sessionId: string) {
    const sessionDir = join(this.sessionsDir, sessionId);
    if (!(await this.metaMatchesProject(sessionDir))) return null;
    const session = await readCursorSessionDir(sessionDir);
    if (!session || !this.matchesProject(session.cwd)) return null;
    return session;
  }

  /** Project check from meta.json alone, before any store.db is opened. */
  private async metaMatchesProject(sessionDir: string): Promise<boolean> {
    if (!this.projectPath) return true;
    const meta = await readCursorSessionMeta(sessionDir);
    return meta !== null && this.matchesProject(meta.cwd);
  }

  private async loadProjectSessions() {
    const ids = await readSessionDirs(this.sessionsDir);
    const sessions = [];
    for (const sessionId of ids) {
      const session = await this.loadOne(sessionId);
      if (session) sessions.push(session);
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private matchesProject(cwd: string): boolean {
    if (!this.projectPath) return true;
    return canonicalizeProjectPath(cwd) === this.projectPath;
  }
}

async function readSessionDirs(sessionsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function toSummary(
  session: {
    sessionId: string;
    title: string | null;
    createdAt: string;
    updatedAt: string;
    messages: CursorSessionContent["messages"];
    contextUsage?: ContextUsage;
  },
  projectId: UrlProjectId,
): SessionSummary {
  const firstUser = session.messages.find((message) => message.role === "user");
  const titleSource = session.title ?? firstUser?.text ?? null;
  const title = truncateTitle(titleSource);
  const userQuestions = session.messages.flatMap((message, index) => {
    if (message.role !== "user") return [];
    const question = createSessionQuestion(
      { id: message.id, text: message.text },
      `cursor-q-${index}`,
    );
    return question ? [question] : [];
  });
  return {
    id: session.sessionId,
    projectId,
    title,
    fullTitle: titleSource,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    userQuestions,
    userQuestionCoverage: "complete",
    ownership: { owner: "none" },
    provider: "cursor",
    contextUsage: session.contextUsage,
    lastTurnStatus: deriveCursorLastTurnStatus(session.messages),
  };
}

/**
 * How the newest turn ended, read off the transcript's shape. Compaction
 * markers and background-task notices are not part of a turn.
 */
export function deriveCursorLastTurnStatus(
  messages: readonly CursorTranscriptMessage[],
): SessionLastTurnStatus | undefined {
  const turn: CursorTranscriptMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role === "compaction" || message.role === "notice")
      continue;
    turn.unshift(message);
    if (message.role === "user") break;
  }
  const last = turn.at(-1);
  if (!last) return undefined;
  // A prompt without a reply, or a tool result the agent never answered.
  if (last.role !== "assistant") return "incomplete";
  const results = new Set<string>();
  for (const message of turn)
    for (const block of message.blocks ?? [])
      if (block.type === "tool_result") results.add(block.tool_use_id);
  const openCall = turn.some((message) =>
    (message.blocks ?? []).some(
      (block) => block.type === "tool_use" && !results.has(block.id),
    ),
  );
  if (openCall) return "incomplete";
  if (cursorStreamError(last.text)) return "failed";
  return "completed";
}

function truncateTitle(text: string | null): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= SESSION_TITLE_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
}
