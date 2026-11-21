import {
  type AgentMapping,
  type PiSessionContent,
  type ProviderName,
  SESSION_TITLE_MAX_LENGTH,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { canonicalizeProjectPath } from "../projects/paths.js";
import type { SessionSummary } from "../supervisor/types.js";
import {
  AGY_DATA_DIR,
  type AgySessionRecord,
  annotateAgyReplyPhases,
  getAgyTranscriptStats,
  listAgySessionRecords,
  readAgyTranscript,
} from "./agy-store.js";
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

export interface AgySessionReaderOptions {
  dataDir?: string;
  projectPath?: string;
  getContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
    sessionId?: string,
  ) => number | undefined;
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
  private catalog: { records: AgySessionRecord[]; at: number } | null = null;

  constructor(options: AgySessionReaderOptions = {}) {
    this.dataDir = options.dataDir ?? AGY_DATA_DIR;
    this.projectPath = options.projectPath
      ? canonicalizeProjectPath(options.projectPath)
      : undefined;
    this.getContextWindow = options.getContextWindow;
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
    return {
      summary,
      data: { provider: "agy", session },
      precomputedPiMessages: {
        messages: annotateAgyReplyPhases(conversion.messages),
        deferMedia,
        deferThinking,
      },
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
