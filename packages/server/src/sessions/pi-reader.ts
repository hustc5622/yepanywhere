import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  type AgentMapping,
  type ContextCompactEvent,
  type ContextCumulativeUsage,
  type PiAssistantMessage,
  type PiMessageEntry,
  type PiSessionContent,
  type PiSessionEntry,
  type ProviderName,
  SESSION_TITLE_MAX_LENGTH,
  type SessionBranchState,
  type UrlProjectId,
  type ZCodeStoredMessage,
  getModelContextWindow,
  getPiMessageText,
  parsePiSessionHeader,
  parsePiSessionJsonl,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type {
  ContextUsage,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import {
  PI_SESSIONS_DIR,
  type PiSessionFileRecord,
  listPiSessionFiles,
} from "./pi-files.js";
import { sanitizePublicUserPrompt } from "./public-user-prompt.js";
import type { AgentSession as AgentSessionResult } from "./reader.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
  SessionFileEntry,
} from "./types.js";
import { createSessionQuestion } from "./user-questions.js";
import { buildCopiedPrefixForkBranchView } from "./zcode-branch.js";

export interface PiSessionReaderOptions {
  sessionsDir?: string;
  projectPath?: string;
  /** Optional live/persisted model metadata resolver. */
  getContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
    sessionId?: string,
  ) => number | undefined;
}

interface PiDerivedSession {
  model?: string;
  reasoningEffort?: string;
  titleText: string;
  messageCount: number;
  userQuestions: NonNullable<SessionSummary["userQuestions"]>;
  contextUsage?: ContextUsage;
  cumulativeUsage?: ContextCumulativeUsage;
  compactEvents?: ContextCompactEvent[];
  lastTurnStatus?: SessionSummary["lastTurnStatus"];
  lastErrorMessage?: string;
}

function isPiMessageEntry(entry: PiSessionEntry): entry is PiMessageEntry {
  return entry.type === "message" && "message" in entry;
}

function isPiAssistantMessage(
  entry: PiSessionEntry,
): entry is PiMessageEntry & { message: PiAssistantMessage } {
  return isPiMessageEntry(entry) && entry.message.role === "assistant";
}

function truncateTitle(text: string): string | null {
  if (!text) return null;
  return text.length <= SESSION_TITLE_MAX_LENGTH
    ? text
    : `${text.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
}

async function readPiParentSessionId(
  parentSessionPath: string | undefined,
): Promise<string | undefined> {
  if (!parentSessionPath) return undefined;
  try {
    const firstLine = (await readFile(parentSessionPath, "utf8"))
      .split("\n")
      .find((line) => line.trim());
    if (!firstLine) return undefined;
    return parsePiSessionHeader(JSON.parse(firstLine))?.id;
  } catch {
    return undefined;
  }
}

/** Read Pi's append-only JSONL tree and project only its active branch. */
export class PiSessionReader implements ISessionReader {
  private readonly sessionsDir: string;
  private readonly projectPath?: string;
  private readonly getContextWindow?: PiSessionReaderOptions["getContextWindow"];
  private cache: { records: PiSessionFileRecord[]; at: number } | null = null;

  constructor(options: PiSessionReaderOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? PI_SESSIONS_DIR;
    this.projectPath = options.projectPath;
    this.getContextWindow = options.getContextWindow;
  }

  invalidateCache(): void {
    this.cache = null;
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const records = await this.scan();
    const summaries = await Promise.all(
      records
        .filter(
          (record) => !this.projectPath || record.cwd === this.projectPath,
        )
        .map((record) => this.getSessionSummary(record.sessionId, projectId)),
    );
    return summaries
      .filter((summary): summary is SessionSummary => summary !== null)
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const record = await this.findRecord(sessionId);
    if (!record || (this.projectPath && record.cwd !== this.projectPath)) {
      return null;
    }

    try {
      const parsed = parsePiSessionJsonl(
        await readFile(record.filePath, "utf8"),
      );
      if (!parsed) return null;
      const derived = this.derive(parsed);
      if (derived.messageCount === 0) return null;
      const fullTitle = sanitizePublicUserPrompt(derived.titleText).trim();
      const forkParentSessionId = await readPiParentSessionId(
        parsed.header.parentSession,
      );

      return {
        id: sessionId,
        projectId,
        title: truncateTitle(fullTitle),
        fullTitle: fullTitle || null,
        createdAt: parsed.header.timestamp,
        updatedAt:
          parsed.activeEntries.at(-1)?.timestamp ??
          new Date(record.mtime).toISOString(),
        messageCount: derived.messageCount,
        userQuestions: derived.userQuestions,
        ownership: { owner: "none" },
        provider: "pi",
        model: derived.model,
        reasoningEffort: derived.reasoningEffort,
        contextUsage: derived.contextUsage,
        cumulativeUsage: derived.cumulativeUsage,
        compactCount: derived.compactEvents?.length ?? 0,
        compactEvents: derived.compactEvents,
        lastTurnStatus: derived.lastTurnStatus,
        lastErrorMessage: derived.lastErrorMessage,
        forkParentSessionId,
      };
    } catch {
      return null;
    }
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    _afterMessageId?: string,
    options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const record = await this.findRecord(sessionId);
    if (!record || (this.projectPath && record.cwd !== this.projectPath)) {
      return null;
    }
    const [summary, content] = await Promise.all([
      this.getSessionSummary(sessionId, projectId),
      readFile(record.filePath, "utf8"),
    ]);
    const session = parsePiSessionJsonl(content);
    if (!summary || !session) return null;
    const branchState = await this.loadBranchState(
      sessionId,
      options?.branchId,
    );
    return {
      summary,
      data: { provider: "pi", session },
      ...(branchState ? { branchState } : {}),
    };
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const record = await this.findRecord(sessionId, true);
    if (!record) return null;
    if (record.mtime === cachedMtime && record.size === cachedSize) return null;
    const summary = await this.getSessionSummary(sessionId, projectId);
    return summary ? { summary, mtime: record.mtime, size: record.size } : null;
  }

  async getAgentMappings(): Promise<AgentMapping[]> {
    return [];
  }

  async getAgentSession(): Promise<AgentSessionResult | null> {
    return null;
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    return (await this.findRecord(sessionId))?.filePath ?? null;
  }

  async getSessionFileStats(
    sessionId: string,
  ): Promise<{ mtime: number; size: number } | null> {
    const record = await this.findRecord(sessionId, true);
    return record ? { mtime: record.mtime, size: record.size } : null;
  }

  async listSessionFiles(_sessionDir: string): Promise<SessionFileEntry[]> {
    const records = await this.scan(true);
    return records
      .filter((record) => !this.projectPath || record.cwd === this.projectPath)
      .map((record) => ({
        sessionId: record.sessionId,
        filePath: record.filePath,
        mtime: record.mtime,
        size: record.size,
      }));
  }

  getIndexScopeKey(): string {
    return `pi::${this.sessionsDir}::${this.projectPath ?? "*"}`;
  }

  /** Build the cross-session edit-fork family produced by Pi RPC `fork`. */
  private async loadBranchState(
    currentSessionId: string,
    selectedBranchId?: string,
  ): Promise<SessionBranchState | undefined> {
    const records = (await this.scan()).filter(
      (record) => !this.projectPath || record.cwd === this.projectPath,
    );
    const byPath = new Map(
      records.map((record) => [resolve(record.filePath), record]),
    );
    const parentOf = new Map<string, string>();
    for (const record of records) {
      if (!record.parentSession) continue;
      const parentPath = isAbsolute(record.parentSession)
        ? resolve(record.parentSession)
        : resolve(dirname(record.filePath), record.parentSession);
      const parent = byPath.get(parentPath);
      if (parent) parentOf.set(record.sessionId, parent.sessionId);
    }
    if (parentOf.size === 0) return undefined;

    let rootId = currentSessionId;
    const ancestors = new Set([rootId]);
    while (parentOf.has(rootId)) {
      const parentId = parentOf.get(rootId);
      if (!parentId || ancestors.has(parentId)) break;
      rootId = parentId;
      ancestors.add(parentId);
    }

    const childrenByParent = new Map<string, string[]>();
    for (const [childId, parentId] of parentOf) {
      const children = childrenByParent.get(parentId) ?? [];
      children.push(childId);
      childrenByParent.set(parentId, children);
    }
    const familyIds: string[] = [];
    const queue = [rootId];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      familyIds.push(id);
      queue.push(...(childrenByParent.get(id) ?? []));
    }
    if (familyIds.length <= 1 || !seen.has(currentSessionId)) return undefined;

    const byId = new Map(records.map((record) => [record.sessionId, record]));
    const familySessions = (
      await Promise.all(
        familyIds.map(async (id) => {
          const record = byId.get(id);
          if (!record) return null;
          const parsed = parsePiSessionJsonl(
            await readFile(record.filePath, "utf8"),
          );
          if (!parsed) return null;
          const messages: ZCodeStoredMessage[] = parsed.activeEntries.flatMap(
            (entry): ZCodeStoredMessage[] => {
              if (!isPiMessageEntry(entry)) return [];
              const text = getPiMessageText(entry.message);
              return [
                {
                  id: entry.id,
                  role: entry.message.role,
                  createdAt: Date.parse(entry.timestamp),
                  parts: [
                    {
                      id: `${entry.id}:text`,
                      messageID: entry.id,
                      sessionID: id,
                      type: "text",
                      text,
                    },
                  ],
                },
              ];
            },
          );
          return {
            id,
            parentId: parentOf.get(id) ?? null,
            createdAt: record.createdAt,
            messages,
          };
        }),
      )
    ).filter((session): session is NonNullable<typeof session> =>
      Boolean(session),
    );

    const view = buildCopiedPrefixForkBranchView(
      familySessions,
      currentSessionId,
      selectedBranchId,
      { provider: "pi", sessionRootPrefix: "pi-session-root" },
    );
    for (const diagnostic of view.diagnostics) {
      getLogger().debug(
        { event: "pi_branch_view_diagnostic", ...diagnostic },
        "Pi branch relation was ignored",
      );
    }
    return view.branchState;
  }

  private derive(session: PiSessionContent): PiDerivedSession {
    let model: string | undefined;
    let reasoningEffort: string | undefined;
    let explicitName: string | undefined;
    let firstUserText = "";
    let messageCount = 0;
    let lastConversationRole: string | undefined;
    let lastAssistant: PiAssistantMessage | undefined;
    const userQuestions: NonNullable<SessionSummary["userQuestions"]> = [];
    const compactEvents: ContextCompactEvent[] = [];
    const cumulative: ContextCumulativeUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      turnCount: 0,
    };

    for (const entry of session.activeEntries) {
      if (entry.type === "session_info" && "name" in entry) {
        const name = entry.name;
        if (typeof name === "string" && name.trim()) explicitName = name;
      } else if (entry.type === "model_change" && "modelId" in entry) {
        if (typeof entry.modelId === "string") model = entry.modelId;
      } else if (
        entry.type === "thinking_level_change" &&
        "thinkingLevel" in entry &&
        typeof entry.thinkingLevel === "string"
      ) {
        reasoningEffort = entry.thinkingLevel;
      } else if (entry.type === "compaction" && "summary" in entry) {
        const beforeTokens =
          "tokensBefore" in entry && typeof entry.tokensBefore === "number"
            ? entry.tokensBefore
            : undefined;
        compactEvents.push({
          timestamp: entry.timestamp,
          beforeTokens,
          trigger: "pi",
        });
      }

      if (!isPiMessageEntry(entry)) continue;
      const message = entry.message;
      if (message.role === "user") {
        messageCount += 1;
        lastConversationRole = "user";
        const text = getPiMessageText(message);
        if (!firstUserText && text.trim()) firstUserText = text;
        const question = createSessionQuestion(
          { id: entry.id, text, timestamp: entry.timestamp },
          `pi-user-${userQuestions.length}`,
        );
        if (question) userQuestions.push(question);
      } else if (message.role === "assistant") {
        messageCount += 1;
        lastConversationRole = "assistant";
        lastAssistant = message;
        model = message.model ?? model;
        if (message.usage) {
          cumulative.inputTokens += message.usage.input ?? 0;
          cumulative.outputTokens += message.usage.output ?? 0;
          cumulative.cacheReadTokens += message.usage.cacheRead ?? 0;
          cumulative.cacheCreationTokens += message.usage.cacheWrite ?? 0;
          cumulative.totalTokens =
            (cumulative.totalTokens ?? 0) + (message.usage.totalTokens ?? 0);
          cumulative.turnCount += 1;
        }
      }
    }

    const usage = lastAssistant?.usage;
    const contextWindow =
      this.getContextWindow?.(model, "pi", session.header.id) ??
      (model ? getModelContextWindow(model, "pi") : undefined);
    const inputTokens = usage
      ? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
      : 0;
    const contextUsage =
      usage && contextWindow
        ? {
            inputTokens,
            outputTokens: usage.output ?? 0,
            cacheReadTokens: usage.cacheRead ?? 0,
            cacheCreationTokens: usage.cacheWrite ?? 0,
            contextWindow,
            percentage: Math.min(100, (inputTokens / contextWindow) * 100),
          }
        : undefined;
    const stopReason = lastAssistant?.stopReason;
    const lastTurnStatus =
      lastConversationRole === "user"
        ? ("interrupted" as const)
        : stopReason === "error"
          ? ("failed" as const)
          : stopReason === "aborted"
            ? ("interrupted" as const)
            : lastAssistant
              ? ("completed" as const)
              : undefined;

    return {
      model,
      reasoningEffort,
      titleText: explicitName ?? firstUserText,
      messageCount,
      userQuestions,
      contextUsage,
      cumulativeUsage: cumulative.turnCount > 0 ? cumulative : undefined,
      compactEvents: compactEvents.length > 0 ? compactEvents : undefined,
      lastTurnStatus,
      lastErrorMessage:
        stopReason === "error" ? lastAssistant?.errorMessage : undefined,
    };
  }

  private async scan(force = false): Promise<PiSessionFileRecord[]> {
    if (!force && this.cache && Date.now() - this.cache.at < 5_000) {
      return this.cache.records;
    }
    const records = await listPiSessionFiles(this.sessionsDir);
    this.cache = { records, at: Date.now() };
    return records;
  }

  private async findRecord(
    sessionId: string,
    force = false,
  ): Promise<PiSessionFileRecord | null> {
    const record = (await this.scan(force)).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (record || force) return record ?? null;

    // Pi creates a new JSONL file when an edit forks a session. A reader may
    // still hold the source-session scan from the request that initiated that
    // fork, so retry misses without waiting for the short list cache to expire.
    return (
      (await this.scan(true)).find(
        (candidate) => candidate.sessionId === sessionId,
      ) ?? null
    );
  }
}
