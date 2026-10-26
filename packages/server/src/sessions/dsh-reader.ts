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
  DSH_SESSIONS_DIR,
  type DshLogFacts,
  type DshSessionRecord,
  getDshLogStats,
  listDshSessionRecords,
  readDshTranscript,
} from "./dsh-store.js";
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

export interface DshSessionReaderOptions {
  sessionsDir?: string;
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
 * Read-only DeepSeek Harness sessions from `$DSH_HOME/sessions`.
 *
 * The event log is projected into a linear Pi session so Pi's transcript
 * conversion and tool renderers can be reused. Yep never starts or resumes
 * dsh sessions; the embedded dsh Web UI owns every mutation.
 */
export class DshSessionReader implements ISessionReader {
  private readonly sessionsDir: string;
  private readonly projectPath: string | undefined;
  private readonly getContextWindow?: DshSessionReaderOptions["getContextWindow"];
  private catalog: { records: DshSessionRecord[]; at: number } | null = null;

  constructor(options: DshSessionReaderOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? DSH_SESSIONS_DIR;
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
    const transcript = await readDshTranscript(record, {
      deferMedia,
      deferThinking,
    });
    if (!transcript) return null;
    const { session, facts } = transcript;
    const conversion = convertPiSession(session, {
      deferMedia,
      deferThinking,
      getContextWindow: this.contextWindowFor(facts),
    });
    return {
      summary: this.buildSummary(
        record,
        projectId,
        session,
        facts,
        conversion.derived,
      ),
      data: { provider: "dsh", session },
      precomputedPiMessages: {
        messages: conversion.messages,
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
    const stats = await getDshLogStats(record.logPath);
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
    return (await this.findRecord(sessionId))?.logPath ?? null;
  }

  async getSessionFileStats(
    sessionId: string,
  ): Promise<{ mtime: number; size: number } | null> {
    const record = await this.findRecord(sessionId, true);
    return record ? getDshLogStats(record.logPath) : null;
  }

  async listSessionFiles(_sessionDir: string): Promise<SessionFileEntry[]> {
    const records = await this.scopedRecords(true);
    const files: SessionFileEntry[] = [];
    for (const record of records) {
      const stats = await getDshLogStats(record.logPath);
      if (!stats) continue;
      files.push({
        sessionId: record.sessionId,
        filePath: record.logPath,
        mtime: stats.mtime,
        size: stats.size,
      });
    }
    return files;
  }

  getIndexScopeKey(): string {
    return `dsh::${this.sessionsDir}::${this.projectPath ?? "*"}::v1`;
  }

  private contextWindowFor(
    facts: DshLogFacts,
  ): DshSessionReaderOptions["getContextWindow"] {
    // dsh records the exact route window in `request/context`; prefer it over
    // Yep's model catalog, which does not know DeepSeek Harness routes.
    if (facts.contextWindow) {
      const window = facts.contextWindow;
      return () => window;
    }
    return this.getContextWindow;
  }

  private async summaryFor(
    record: DshSessionRecord,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const transcript = await readDshTranscript(record, {
      deferMedia: true,
      deferThinking: true,
    });
    if (!transcript) return null;
    const derived = derivePiSession(transcript.session, {
      getContextWindow: this.contextWindowFor(transcript.facts),
    });
    // A blank session (header and seed only) is not a conversation yet.
    if (derived.messageCount === 0) return null;
    return this.buildSummary(
      record,
      projectId,
      transcript.session,
      transcript.facts,
      derived,
    );
  }

  private buildSummary(
    record: DshSessionRecord,
    projectId: UrlProjectId,
    session: PiSessionContent,
    facts: DshLogFacts,
    derived: ReturnType<typeof derivePiSession>,
  ): SessionSummary {
    const promptTitle = sanitizePublicUserPrompt(derived.titleText).trim();
    const fullTitle = facts.title || promptTitle || null;
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
      createdAt: new Date(record.createdAtMs).toISOString(),
      updatedAt,
      messageCount: derived.messageCount,
      userQuestions: derived.userQuestions,
      ownership: { owner: "none" },
      provider: "dsh",
      model: derived.model,
      reasoningEffort: derived.reasoningEffort,
      contextUsage: derived.contextUsage,
      cumulativeUsage: derived.cumulativeUsage,
      compactCount: derived.compactEvents?.length ?? 0,
      compactEvents: derived.compactEvents,
      // An open turn is still running in dsh; do not report it interrupted.
      lastTurnStatus:
        facts.activity.turn === "in-flight"
          ? undefined
          : derived.lastTurnStatus,
      lastErrorMessage: derived.lastErrorMessage,
    };
  }

  private async records(force = false): Promise<DshSessionRecord[]> {
    if (
      !force &&
      this.catalog &&
      Date.now() - this.catalog.at < CATALOG_CACHE_TTL_MS
    ) {
      return this.catalog.records;
    }
    const records = await listDshSessionRecords({
      sessionsDir: this.sessionsDir,
    });
    this.catalog = { records, at: Date.now() };
    return records;
  }

  private async scopedRecords(force = false): Promise<DshSessionRecord[]> {
    const records = await this.records(force);
    if (!this.projectPath) return records;
    return records.filter(
      (record) => canonicalizeProjectPath(record.cwd) === this.projectPath,
    );
  }

  private async findRecord(
    sessionId: string,
    force = false,
  ): Promise<DshSessionRecord | null> {
    const match = (records: DshSessionRecord[]) =>
      records.find((record) => record.sessionId === sessionId) ?? null;
    const found = match(await this.scopedRecords(force));
    if (found || force) return found;
    // A session dsh created a moment ago may postdate the cached catalog.
    return match(await this.scopedRecords(true));
  }
}
