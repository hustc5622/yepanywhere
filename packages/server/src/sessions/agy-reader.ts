import {
  type AgentMapping,
  type PiMessageEntry,
  type PiSessionContent,
  type PiSessionEntry,
  type ProviderName,
  SESSION_TITLE_MAX_LENGTH,
  type SessionBranchState,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import { canonicalizeProjectPath } from "../projects/paths.js";
import type { SessionSummary } from "../supervisor/types.js";
import {
  AGY_DATA_DIR,
  type AgySessionRecord,
  annotateAgyReplyPhases,
  getAgyTranscriptStats,
  listAgySessionRecords,
  parseAgyStepEntryId,
  readAgyTranscript,
} from "./agy-store.js";
import {
  type CopiedPrefixFamilySession,
  type CopiedPrefixMessage,
  buildCopiedPrefixForkBranchView,
} from "./copied-prefix-branch.js";
import { convertPiSession, derivePiSession } from "./normalization.js";
import { sanitizePublicUserPrompt } from "./public-user-prompt.js";
import type { AgentSession as AgentSessionResult } from "./reader.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
  SessionFileEntry,
} from "./types.js";

const CATALOG_CACHE_TTL_MS = 3_000;

/** Yep-recorded edit-fork edge; agy itself keeps no fork lineage. */
export interface AgyForkLineage {
  sessionId: string;
  forkParentSessionId: string;
  /** Source prompt the fork replaced (its persisted message id). */
  forkTargetMessageId?: string;
}

export interface AgySessionReaderOptions {
  dataDir?: string;
  projectPath?: string;
  getContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
    sessionId?: string,
  ) => number | undefined;
  /** Edit-fork edges recorded by Yep (session metadata). */
  getForkLineage?: () => readonly AgyForkLineage[];
}

function truncateTitle(text: string | null): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= SESSION_TITLE_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
}

/**
 * Read Antigravity CLI (`agy`) conversations.
 *
 * `conversation_summaries.db` provides cwd/title/timestamps; the transcript
 * (`brain/<id>/.system_generated/logs/transcript_full.jsonl`) is adapted into
 * a linear Pi session and projected through Pi's converter.
 */
export class AgySessionReader implements ISessionReader {
  private readonly dataDir: string;
  private readonly projectPath: string | undefined;
  private readonly getContextWindow?: AgySessionReaderOptions["getContextWindow"];
  private readonly getForkLineage?: AgySessionReaderOptions["getForkLineage"];
  private catalog: { records: AgySessionRecord[]; at: number } | null = null;

  constructor(options: AgySessionReaderOptions = {}) {
    this.dataDir = options.dataDir ?? AGY_DATA_DIR;
    this.projectPath = options.projectPath
      ? canonicalizeProjectPath(options.projectPath)
      : undefined;
    this.getContextWindow = options.getContextWindow;
    this.getForkLineage = options.getForkLineage;
  }

  invalidateCache(): void {
    this.catalog = null;
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const records = await this.scopedRecords();
    const summaries = await Promise.all(
      records.map((record) => this.summaryFor(record, projectId)),
    );
    return summaries
      .filter((summary): summary is SessionSummary => summary !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const record = await this.findRecord(sessionId);
    return record ? this.summaryFor(record, projectId) : null;
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    _afterMessageId?: string,
    options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const record = await this.findRecord(sessionId);
    if (!record) return null;
    const deferMedia = options?.deferMedia === true;
    const deferThinking = options?.deferThinking === true;
    const session = await readAgyTranscript(record, {
      deferMedia,
      deferThinking,
    });
    if (!session) return null;
    const conversion = convertPiSession(session, {
      deferMedia,
      deferThinking,
      getContextWindow: this.getContextWindow,
    });
    const summary = this.buildSummary(
      record,
      projectId,
      session,
      conversion.derived,
    );
    const branchState = await this.loadBranchState(
      sessionId,
      options?.branchId,
      session,
    );
    return {
      summary,
      data: { provider: "agy", session },
      precomputedPiMessages: {
        messages: annotateAgyReplyPhases(conversion.messages),
        deferMedia,
        deferThinking,
      },
      ...(branchState ? { branchState } : {}),
    };
  }

  async getBranchState(
    sessionId: string,
    branchId?: string,
  ): Promise<SessionBranchState | undefined> {
    return this.loadBranchState(sessionId, branchId);
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const record = await this.findRecord(sessionId, true);
    if (!record) return null;
    const stats = await getAgyTranscriptStats(record.transcriptPath);
    if (!stats) return null;
    if (stats.mtime === cachedMtime && stats.size === cachedSize) return null;
    const summary = await this.summaryFor(record, projectId);
    return summary ? { summary, ...stats } : null;
  }

  async getAgentMappings(): Promise<AgentMapping[]> {
    return [];
  }

  async getAgentSession(): Promise<AgentSessionResult | null> {
    return null;
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    return (await this.findRecord(sessionId))?.transcriptPath ?? null;
  }

  async getSessionFileStats(
    sessionId: string,
  ): Promise<{ mtime: number; size: number } | null> {
    const record = await this.findRecord(sessionId, true);
    return record ? getAgyTranscriptStats(record.transcriptPath) : null;
  }

  async listSessionFiles(_sessionDir: string): Promise<SessionFileEntry[]> {
    const records = await this.scopedRecords(true);
    const files: SessionFileEntry[] = [];
    for (const record of records) {
      const stats = await getAgyTranscriptStats(record.transcriptPath);
      if (!stats) continue;
      files.push({
        sessionId: record.sessionId,
        filePath: record.transcriptPath,
        mtime: stats.mtime,
        size: stats.size,
      });
    }
    return files;
  }

  getIndexScopeKey(): string {
    return `agy::${this.dataDir}::${this.projectPath ?? "*"}::v1`;
  }

  /**
   * Branch tree of the edit-fork family `sessionId` belongs to. A fork keeps
   * its source's step indexes and timestamps for the copied history, which
   * is how copied rows are told apart from the edited prompt.
   */
  private async loadBranchState(
    sessionId: string,
    selectedBranchId?: string,
    currentSession?: PiSessionContent,
  ): Promise<SessionBranchState | undefined> {
    const lineage = this.getForkLineage?.() ?? [];
    if (lineage.length === 0) return undefined;
    const records = await this.scopedRecords();
    const byId = new Map(records.map((record) => [record.sessionId, record]));
    const parentOf = new Map<string, AgyForkLineage>();
    for (const edge of lineage) {
      if (
        edge.sessionId !== edge.forkParentSessionId &&
        byId.has(edge.sessionId) &&
        byId.has(edge.forkParentSessionId)
      ) {
        parentOf.set(edge.sessionId, edge);
      }
    }
    if (parentOf.size === 0 || !byId.has(sessionId)) return undefined;

    let rootId = sessionId;
    const ancestors = new Set([rootId]);
    for (;;) {
      const parentId = parentOf.get(rootId)?.forkParentSessionId;
      if (!parentId || ancestors.has(parentId)) break;
      rootId = parentId;
      ancestors.add(parentId);
    }
    const childrenOf = new Map<string, string[]>();
    for (const edge of parentOf.values()) {
      const children = childrenOf.get(edge.forkParentSessionId) ?? [];
      children.push(edge.sessionId);
      childrenOf.set(edge.forkParentSessionId, children);
    }
    const familyIds: string[] = [];
    const queue = [rootId];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      familyIds.push(id);
      queue.push(...(childrenOf.get(id) ?? []));
    }
    if (familyIds.length <= 1 || !seen.has(sessionId)) return undefined;

    const familySessions = (
      await Promise.all(
        familyIds.map(async (id): Promise<CopiedPrefixFamilySession | null> => {
          const record = byId.get(id);
          if (!record) return null;
          const session =
            id === sessionId && currentSession
              ? currentSession
              : await readAgyTranscript(record, {
                  deferMedia: true,
                  deferThinking: true,
                  resolveCallIds: false,
                });
          if (!session) return null;
          const edge = parentOf.get(id);
          return {
            id,
            parentId: edge?.forkParentSessionId ?? null,
            forkBoundaryMessageId: edge?.forkTargetMessageId,
            createdAt: session.header.timestamp,
            messages: copiedPrefixMessages(id, session),
          };
        }),
      )
    ).filter((session): session is CopiedPrefixFamilySession =>
      Boolean(session),
    );

    const view = buildCopiedPrefixForkBranchView(
      familySessions,
      sessionId,
      selectedBranchId,
      {
        provider: "agy",
        sessionRootPrefix: "agy-session-root",
        isCopiedMessage: isCopiedAgyMessage,
      },
    );
    for (const diagnostic of view.diagnostics) {
      getLogger().debug(
        { event: "agy_branch_view_diagnostic", ...diagnostic },
        "Antigravity branch relation was ignored",
      );
    }
    return view.branchState;
  }

  private async summaryFor(
    record: AgySessionRecord,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const session = await readAgyTranscript(record, {
      deferMedia: true,
      deferThinking: true,
      resolveCallIds: false,
    });
    if (!session) return null;
    const derived = derivePiSession(session, {
      getContextWindow: this.getContextWindow,
    });
    if (derived.messageCount === 0) return null;
    return this.buildSummary(record, projectId, session, derived);
  }

  private buildSummary(
    record: AgySessionRecord,
    projectId: UrlProjectId,
    session: PiSessionContent,
    derived: ReturnType<typeof derivePiSession>,
  ): SessionSummary {
    // agy generates a concise title server-side; fall back to the first
    // genuine user prompt for sessions whose title is not ready yet.
    const promptTitle = sanitizePublicUserPrompt(derived.titleText).trim();
    const fullTitle = record.title?.trim() || promptTitle || null;
    const lastTimestamp = session.activeEntries.at(-1)?.timestamp;
    const updatedAt = new Date(
      Math.max(
        record.updatedAtMs,
        lastTimestamp ? Date.parse(lastTimestamp) || 0 : 0,
      ),
    ).toISOString();
    return {
      id: record.sessionId,
      projectId,
      title: truncateTitle(fullTitle),
      fullTitle,
      // The catalog has no creation time; the first transcript step does.
      createdAt: session.header.timestamp,
      updatedAt,
      messageCount: derived.messageCount,
      userQuestions: derived.userQuestions,
      ownership: { owner: "none" },
      provider: "agy",
      model: derived.model,
      reasoningEffort: derived.reasoningEffort,
      contextUsage: derived.contextUsage,
      cumulativeUsage: derived.cumulativeUsage,
      compactCount: derived.compactEvents?.length ?? 0,
      compactEvents: derived.compactEvents,
      lastTurnStatus: derived.lastTurnStatus,
      lastErrorMessage: derived.lastErrorMessage,
    };
  }

  private async records(force = false): Promise<AgySessionRecord[]> {
    if (
      !force &&
      this.catalog &&
      Date.now() - this.catalog.at < CATALOG_CACHE_TTL_MS
    ) {
      return this.catalog.records;
    }
    const records = await listAgySessionRecords({
      dataDir: this.dataDir,
    });
    this.catalog = { records, at: Date.now() };
    return records;
  }

  private async scopedRecords(force = false): Promise<AgySessionRecord[]> {
    const records = await this.records(force);
    if (!this.projectPath) return records;
    return records.filter(
      (record) => canonicalizeProjectPath(record.cwd) === this.projectPath,
    );
  }

  private async findRecord(
    sessionId: string,
    force = false,
  ): Promise<AgySessionRecord | null> {
    const match = (records: AgySessionRecord[]) =>
      records.find((record) => record.sessionId === sessionId) ?? null;
    const scoped = await this.scopedRecords(force);
    const found = match(scoped);
    if (found || force) return found;
    // A session created through ACP a moment ago may postdate the cached
    // catalog; retry once with a fresh read before reporting a miss.
    return match(await this.scopedRecords(true));
  }
}

function isAgyMessageEntry(entry: PiSessionEntry): entry is PiMessageEntry {
  return (
    entry.type === "message" &&
    "message" in entry &&
    typeof entry.message === "object" &&
    entry.message !== null
  );
}

/** User/assistant rows of one family member, in transcript order. */
function copiedPrefixMessages(
  sessionId: string,
  session: PiSessionContent,
): CopiedPrefixMessage[] {
  const messages: CopiedPrefixMessage[] = [];
  for (const entry of session.activeEntries) {
    if (!isAgyMessageEntry(entry)) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = entry.message.content;
    // Same join as the display's user-text normalization, so copied prompts
    // resolve to their canonical branch by timestamp and text.
    const text = Array.isArray(content)
      ? content
          .map((block) =>
            block?.type === "text" && typeof block.text === "string"
              ? block.text
              : "",
          )
          .join("")
      : typeof content === "string"
        ? content
        : "";
    messages.push({
      id: entry.id,
      role,
      createdAt: Date.parse(entry.timestamp),
      parts: [
        {
          id: `${entry.id}:text`,
          messageID: entry.id,
          sessionID: sessionId,
          type: "text",
          text,
        },
      ],
    });
  }
  return messages;
}

/**
 * A fork keeps the copied steps' indexes and timestamps. Requiring both (on
 * top of role and text) keeps a resubmitted identical prompt, or an edited
 * first prompt that started a fresh conversation, from passing as a copy.
 */
function isCopiedAgyMessage(
  child: CopiedPrefixMessage,
  parent: CopiedPrefixMessage,
): boolean {
  const childStep = parseAgyStepEntryId(child.id)?.stepIndex;
  if (childStep === undefined) return false;
  return (
    childStep === parseAgyStepEntryId(parent.id)?.stepIndex &&
    child.role === parent.role &&
    child.createdAt === parent.createdAt &&
    prefixText(child) === prefixText(parent)
  );
}

function prefixText(message: CopiedPrefixMessage): string {
  return message.parts.map((part) => String(part.text ?? "")).join("");
}
