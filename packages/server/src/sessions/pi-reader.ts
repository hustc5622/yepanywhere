import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  type AgentMapping,
  type PiMessageEntry,
  type PiSessionContent,
  type PiSessionEntry,
  type ProviderName,
  SESSION_TITLE_MAX_LENGTH,
  type SessionBranchState,
  type UrlProjectId,
  type ZCodeStoredMessage,
  getPiMessageText,
  parsePiSessionHeader,
  parsePiSessionJsonl,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { SessionSummary } from "../supervisor/types.js";
import { convertPiSession, derivePiSession } from "./normalization.js";
import {
  PI_SESSIONS_DIR,
  type PiSessionFileRecord,
  invalidatePiSessionFileCatalog,
  listPiSessionFiles,
  readFirstJsonlRecord,
} from "./pi-files.js";
import { sanitizePublicUserPrompt } from "./public-user-prompt.js";
import type { AgentSession as AgentSessionResult } from "./reader.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
  SessionFileEntry,
} from "./types.js";
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

interface ParsedPiSessionCacheEntry {
  sessionId: string;
  content: PiSessionContent;
  mtime: number;
  size: number;
  filePath: string;
  deferMedia: boolean;
  deferThinking: boolean;
}

function isPiMessageEntry(entry: PiSessionEntry): entry is PiMessageEntry {
  return (
    entry.type === "message" &&
    "message" in entry &&
    typeof entry.message === "object" &&
    entry.message !== null &&
    !Array.isArray(entry.message)
  );
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
    return parsePiSessionHeader(await readFirstJsonlRecord(parentSessionPath))
      ?.id;
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
  private readonly parsedCache = new Map<string, ParsedPiSessionCacheEntry>();
  private readonly parsedInFlight = new Map<
    string,
    Promise<PiSessionContent | null>
  >();
  private parsedCacheGeneration = 0;
  private readonly parsedFileGenerations = new Map<string, number>();

  constructor(options: PiSessionReaderOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? PI_SESSIONS_DIR;
    this.projectPath = options.projectPath;
    this.getContextWindow = options.getContextWindow;
  }

  invalidateCache(): void {
    invalidatePiSessionFileCatalog(this.sessionsDir);
    this.cache = null;
    this.parsedCacheGeneration += 1;
    this.parsedFileGenerations.clear();
    this.parsedCache.clear();
    this.parsedInFlight.clear();
  }

  /** Invalidate only the Pi file that changed, preserving other parsed sessions. */
  invalidateFile(filePath: string): void {
    invalidatePiSessionFileCatalog(this.sessionsDir);
    const targetPath = resolve(filePath);
    this.cache = null;
    this.parsedFileGenerations.set(
      targetPath,
      (this.parsedFileGenerations.get(targetPath) ?? 0) + 1,
    );
    for (const [cacheKey, cached] of this.parsedCache) {
      if (resolve(cached.filePath) === targetPath) {
        this.parsedCache.delete(cacheKey);
      }
    }
    for (const cacheKey of this.parsedInFlight.keys()) {
      const [, cachedPath] = cacheKey.split("\u0000");
      if (cachedPath && resolve(cachedPath) === targetPath) {
        this.parsedInFlight.delete(cacheKey);
      }
    }
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
      // Summary derivation never needs inline image bytes. Match the client's
      // normal first-load projection so list/detail requests can share one
      // parsed snapshot and one in-flight read.
      const parsed = await this.getParsedSession(record, { deferMedia: true });
      return parsed
        ? await this.buildSummary(sessionId, projectId, record, parsed)
        : null;
    } catch {
      return null;
    }
  }

  private async buildSummary(
    sessionId: string,
    projectId: UrlProjectId,
    record: PiSessionFileRecord,
    parsed: PiSessionContent,
    derivedOverride?: ReturnType<typeof derivePiSession>,
  ): Promise<SessionSummary | null> {
    const derived =
      derivedOverride ??
      derivePiSession(parsed, {
        getContextWindow: this.getContextWindow,
      });
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
    const deferMedia = options?.deferMedia === true;
    const deferThinking = options?.deferThinking === true;
    const session = await this.getParsedSession(record, {
      deferMedia,
      deferThinking,
    });
    if (!session) return null;
    const conversion = convertPiSession(session, {
      deferMedia,
      deferThinking,
      getContextWindow: this.getContextWindow,
    });
    const summary = await this.buildSummary(
      sessionId,
      projectId,
      record,
      session,
      conversion.derived,
    );
    if (!summary) return null;

    // A normal Pi session has no cross-file branch family. Avoid the branch
    // scan entirely in that common case, while still loading the state for a
    // root session that has forked children.
    const records = await this.scan();
    const branchState = this.hasBranchRelation(record, records)
      ? await this.loadBranchState(
          sessionId,
          options?.branchId,
          records,
          session,
        )
      : undefined;
    return {
      summary,
      data: { provider: "pi", session },
      precomputedPiMessages: {
        messages: conversion.messages,
        deferMedia,
        deferThinking,
      },
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
    scannedRecords?: PiSessionFileRecord[],
    currentSession?: PiSessionContent,
  ): Promise<SessionBranchState | undefined> {
    const records = (scannedRecords ?? (await this.scan())).filter(
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
          const parsed =
            id === currentSessionId && currentSession
              ? currentSession
              : await this.getParsedSession(record, {
                  deferMedia: true,
                });
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

  private hasBranchRelation(
    currentRecord: PiSessionFileRecord,
    records: PiSessionFileRecord[],
  ): boolean {
    if (currentRecord.parentSession) return true;
    const currentPath = resolve(currentRecord.filePath);
    return records.some((record) => {
      if (!record.parentSession) return false;
      const parentPath = isAbsolute(record.parentSession)
        ? resolve(record.parentSession)
        : resolve(dirname(record.filePath), record.parentSession);
      return parentPath === currentPath;
    });
  }

  private async getParsedSession(
    record: PiSessionFileRecord,
    options: { deferMedia?: boolean; deferThinking?: boolean } = {},
  ): Promise<PiSessionContent | null> {
    const deferMedia = options.deferMedia === true;
    const deferThinking = options.deferThinking === true;
    const generation = this.parsedCacheGeneration;
    const resolvedFilePath = resolve(record.filePath);
    const fileGeneration =
      this.parsedFileGenerations.get(resolvedFilePath) ?? 0;
    const cacheKey = [
      record.sessionId,
      record.filePath,
      record.mtime,
      record.size,
      deferMedia ? "media" : "full-media",
      deferThinking ? "thinking" : "full-thinking",
    ].join("\u0000");
    const cached = this.parsedCache.get(cacheKey);
    if (cached) return cached.content;

    const inFlight = this.parsedInFlight.get(cacheKey);
    if (inFlight) return inFlight;

    const pending = readFile(record.filePath, "utf8")
      .then((content) =>
        parsePiSessionJsonl(content, { deferMedia, deferThinking }),
      )
      .then((parsed) => {
        const canCache =
          generation === this.parsedCacheGeneration &&
          fileGeneration ===
            (this.parsedFileGenerations.get(resolvedFilePath) ?? 0);
        if (parsed && canCache) {
          this.parsedCache.set(cacheKey, {
            sessionId: record.sessionId,
            content: parsed,
            mtime: record.mtime,
            size: record.size,
            filePath: record.filePath,
            deferMedia,
            deferThinking,
          });
        } else if (!parsed && canCache) {
          this.parsedCache.delete(cacheKey);
        }
        return parsed;
      })
      .catch(() => null);
    const tracked = pending.finally(() => {
      if (this.parsedInFlight.get(cacheKey) === tracked) {
        this.parsedInFlight.delete(cacheKey);
      }
    });
    this.parsedInFlight.set(cacheKey, tracked);
    return tracked;
  }

  private invalidateParsedCacheForRecords(
    records: PiSessionFileRecord[],
  ): void {
    const currentById = new Map(
      records.map((record) => [record.sessionId, record]),
    );
    let invalidated = false;
    for (const [cacheKey, cached] of this.parsedCache) {
      const record = currentById.get(cached.sessionId);
      if (
        !record ||
        record.filePath !== cached.filePath ||
        record.mtime !== cached.mtime ||
        record.size !== cached.size
      ) {
        this.parsedCache.delete(cacheKey);
        invalidated = true;
      }
    }
    if (invalidated) this.parsedCacheGeneration += 1;
  }

  private async scan(
    forceLocal = false,
    forceCatalog = false,
  ): Promise<PiSessionFileRecord[]> {
    if (!forceLocal && this.cache && Date.now() - this.cache.at < 5_000) {
      return this.cache.records;
    }
    const records = await listPiSessionFiles(this.sessionsDir, {
      force: forceCatalog,
    });
    this.cache = { records, at: Date.now() };
    this.invalidateParsedCacheForRecords(records);
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
      (await this.scan(true, true)).find(
        (candidate) => candidate.sessionId === sessionId,
      ) ?? null
    );
  }
}
