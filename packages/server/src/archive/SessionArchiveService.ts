import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ProviderName, UrlProjectId } from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import { isRetiredProviderName } from "../sdk/providers/policy.js";
import { normalizeProviderGroup } from "../sessions/provider-groups.js";
import { withWritableSqliteDatabase } from "../sqlite/query.js";
import type { Project, SessionSummary } from "../supervisor/types.js";

export type ArchiveProvider = "claude" | "codex" | "pi" | "kimi" | "zcode";
type PersistedArchiveProvider = ArchiveProvider | "opencode";
export type ArchiveReason = "manual" | "auto";

export interface ArchivedFileRecord {
  kind: "session" | "agent-session" | "agent-meta";
  originalPath: string;
  archivePath: string;
  size: number;
  mtimeMs: number;
}

export interface ArchivedSessionRecord {
  sessionId: string;
  provider: ArchiveProvider;
  projectId: UrlProjectId;
  projectPath: string;
  title?: string | null;
  fullTitle?: string | null;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  storagePath?: string;
  archivedAt: string;
  reason: ArchiveReason;
  files: ArchivedFileRecord[];
}

type PersistedArchivedSessionRecord = Omit<
  ArchivedSessionRecord,
  "provider"
> & {
  provider: PersistedArchiveProvider;
};

interface ArchiveManifest {
  version: 1;
  sessions: Record<string, PersistedArchivedSessionRecord>;
}

function isLiveArchivedSessionRecord(
  record: PersistedArchivedSessionRecord,
): record is ArchivedSessionRecord {
  return !isRetiredProviderName(record.provider);
}

export interface SessionArchiveServiceOptions {
  dataDir: string;
}

export interface ArchiveSessionParams {
  sessionId: string;
  provider: ProviderName | string | undefined;
  project: Project;
  summary?: SessionSummary | null;
  sessionFilePath: string;
  reason: ArchiveReason;
}

export interface RestoreSessionResult {
  record: ArchivedSessionRecord;
}

export class ArchiveError extends Error {
  constructor(
    public readonly code:
      | "unsupported_provider"
      | "session_not_found"
      | "already_archived"
      | "not_archived"
      | "restore_conflict"
      | "archive_failed"
      | "restore_failed",
    message: string,
  ) {
    super(message);
    this.name = "ArchiveError";
  }
}

const MANIFEST_VERSION = 1;
const BEIJING_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class SessionArchiveService {
  private archiveDir: string;
  private manifestPath: string;
  private manifest: ArchiveManifest = {
    version: MANIFEST_VERSION,
    sessions: {},
  };
  private savePromise: Promise<void> | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private schedulerRunner: (() => Promise<void>) | null = null;

  constructor(options: SessionArchiveServiceOptions) {
    this.archiveDir = join(options.dataDir, "archive");
    this.manifestPath = join(this.archiveDir, "manifest.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.archiveDir, { recursive: true });
    try {
      const raw = await readFile(this.manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as ArchiveManifest;
      if (parsed.version === MANIFEST_VERSION && parsed.sessions) {
        this.manifest = parsed;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        getLogger().warn(
          { err: error },
          "[SessionArchiveService] Failed to load archive manifest, starting fresh",
        );
      }
      this.manifest = { version: MANIFEST_VERSION, sessions: {} };
    }
  }

  getArchiveDir(): string {
    return this.archiveDir;
  }

  listArchivedSessions(): ArchivedSessionRecord[] {
    return Object.values(this.manifest.sessions)
      .filter(isLiveArchivedSessionRecord)
      .sort(
        (a, b) =>
          new Date(b.archivedAt).getTime() - new Date(a.archivedAt).getTime(),
      );
  }

  getArchivedSession(sessionId: string): ArchivedSessionRecord | undefined {
    const record = this.manifest.sessions[sessionId];
    return record && isLiveArchivedSessionRecord(record) ? record : undefined;
  }

  isArchived(sessionId: string): boolean {
    return Boolean(this.getArchivedSession(sessionId));
  }

  async archiveSession(
    params: ArchiveSessionParams,
  ): Promise<ArchivedSessionRecord> {
    const provider = normalizeArchiveProvider(params.provider);
    if (!provider) {
      throw new ArchiveError(
        "unsupported_provider",
        `Provider ${params.provider ?? "unknown"} cannot be physically archived`,
      );
    }

    const existing = this.manifest.sessions[params.sessionId];
    if (existing) {
      const primaryExists =
        isRetiredProviderName(existing.provider) ||
        isSqliteArchiveProvider(existing.provider) ||
        (await fileExists(existing.files[0]?.archivePath));
      if (primaryExists) {
        throw new ArchiveError(
          "already_archived",
          `Session ${params.sessionId} is already archived`,
        );
      }
      delete this.manifest.sessions[params.sessionId];
    }

    const primaryStats = await stat(params.sessionFilePath).catch(() => null);
    if (!primaryStats || !primaryStats.isFile()) {
      throw new ArchiveError(
        "session_not_found",
        `Session file not found for ${params.sessionId}`,
      );
    }

    const files = await this.collectFilesForArchive(
      params.sessionId,
      provider,
      params.sessionFilePath,
    );
    const record: ArchivedSessionRecord = {
      sessionId: params.sessionId,
      provider,
      projectId: params.project.id,
      projectPath: params.project.path,
      title: params.summary?.title,
      fullTitle: params.summary?.fullTitle,
      createdAt: params.summary?.createdAt,
      updatedAt: params.summary?.updatedAt,
      messageCount: params.summary?.messageCount,
      storagePath: isSqliteArchiveProvider(provider)
        ? params.sessionFilePath
        : undefined,
      archivedAt: new Date().toISOString(),
      reason: params.reason,
      files,
    };

    if (isSqliteArchiveProvider(provider)) {
      await setSqliteSessionArchived({
        dbPath: params.sessionFilePath,
        sessionId: params.sessionId,
        projectPath: params.project.path,
        archivedAtMs: Date.now(),
      });
    } else {
      await moveFiles(files, "to-archive");
    }
    this.manifest.sessions[params.sessionId] = record;
    await this.save();
    return record;
  }

  async restoreSession(sessionId: string): Promise<RestoreSessionResult> {
    const record = this.manifest.sessions[sessionId];
    if (!record) {
      throw new ArchiveError(
        "not_archived",
        `Session ${sessionId} is not physically archived`,
      );
    }
    if (!isLiveArchivedSessionRecord(record)) {
      throw new ArchiveError(
        "unsupported_provider",
        "The archived session belongs to a retired provider",
      );
    }

    if (isSqliteArchiveProvider(record.provider)) {
      if (!record.storagePath) {
        throw new ArchiveError(
          "restore_failed",
          `Cannot restore ${sessionId}; missing provider database path`,
        );
      }
      await setSqliteSessionUnarchived({
        dbPath: record.storagePath,
        sessionId,
        projectPath: record.projectPath,
      });
    } else {
      for (const file of record.files) {
        if (await fileExists(file.originalPath)) {
          throw new ArchiveError(
            "restore_conflict",
            `Cannot restore ${sessionId}; original path already exists: ${file.originalPath}`,
          );
        }
      }

      await moveFiles(record.files, "to-original");
    }

    delete this.manifest.sessions[sessionId];
    await this.save();
    return { record };
  }

  startDailyScheduler(runner: () => Promise<void>): void {
    this.schedulerRunner = runner;
    this.scheduleNextRun();
  }

  stopDailyScheduler(): void {
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    this.schedulerRunner = null;
  }

  private scheduleNextRun(): void {
    if (!this.schedulerRunner) return;
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
    }

    const delayMs = getDelayUntilNextBeijingHour(4);
    this.schedulerTimer = setTimeout(() => {
      void this.runScheduledArchive();
    }, delayMs);
    this.schedulerTimer.unref?.();
  }

  private async runScheduledArchive(): Promise<void> {
    const runner = this.schedulerRunner;
    if (!runner) return;

    try {
      await runner();
    } catch (error) {
      getLogger().warn(
        { err: error },
        "[SessionArchiveService] Scheduled auto-archive failed",
      );
    } finally {
      this.scheduleNextRun();
    }
  }

  private async collectFilesForArchive(
    sessionId: string,
    provider: ArchiveProvider,
    sessionFilePath: string,
  ): Promise<ArchivedFileRecord[]> {
    const archiveSessionDir = join(
      this.archiveDir,
      "sessions",
      provider,
      sanitizePathPart(sessionId),
    );
    const primary = await createArchivedFileRecord(
      "session",
      sessionFilePath,
      join(archiveSessionDir, basename(sessionFilePath)),
    );

    if (isSqliteArchiveProvider(provider)) {
      return [];
    }

    if (provider !== "claude") {
      return [primary];
    }

    const related = await this.collectClaudeAgentFiles(
      sessionId,
      sessionFilePath,
      archiveSessionDir,
    );
    return [primary, ...related];
  }

  private async collectClaudeAgentFiles(
    sessionId: string,
    sessionFilePath: string,
    archiveSessionDir: string,
  ): Promise<ArchivedFileRecord[]> {
    const raw = await readFile(sessionFilePath, "utf-8").catch(() => "");
    const agentIds = extractAgentIds(raw);
    if (agentIds.size === 0) return [];

    const sessionDir = dirname(sessionFilePath);
    const records: ArchivedFileRecord[] = [];
    const seen = new Set<string>();

    for (const agentId of agentIds) {
      const candidates = [
        join(sessionDir, "subagents", `agent-${agentId}.jsonl`),
        join(sessionDir, `agent-${agentId}.jsonl`),
      ];

      for (const candidate of candidates) {
        if (seen.has(candidate)) continue;
        const stats = await stat(candidate).catch(() => null);
        if (!stats?.isFile()) continue;

        seen.add(candidate);
        records.push(
          await createArchivedFileRecord(
            "agent-session",
            candidate,
            join(archiveSessionDir, "agents", basename(candidate)),
          ),
        );

        const metaPath = candidate.replace(/\.jsonl$/, ".meta.json");
        if (!seen.has(metaPath) && (await fileExists(metaPath))) {
          seen.add(metaPath);
          records.push(
            await createArchivedFileRecord(
              "agent-meta",
              metaPath,
              join(archiveSessionDir, "agents", basename(metaPath)),
            ),
          );
        }
      }
    }

    if (records.length > 0) {
      getLogger().info(
        `[SessionArchiveService] Archiving ${records.length} Claude agent file(s) for ${sessionId}`,
      );
    }
    return records;
  }

  private async save(): Promise<void> {
    const previousSave = this.savePromise ?? Promise.resolve();
    const nextSave = previousSave.then(
      () => this.doSave(),
      () => this.doSave(),
    );
    this.savePromise = nextSave;

    try {
      await nextSave;
    } finally {
      if (this.savePromise === nextSave) {
        this.savePromise = null;
      }
    }
  }

  private async doSave(): Promise<void> {
    await mkdir(this.archiveDir, { recursive: true });
    await writeFile(
      this.manifestPath,
      JSON.stringify(this.manifest, null, 2),
      "utf-8",
    );
  }
}

function normalizeArchiveProvider(
  provider: ProviderName | string | undefined,
): ArchiveProvider | null {
  const group = normalizeProviderGroup(provider);
  // Gemini sessions have no archive support.
  return group === "gemini" ? null : group;
}

function isSqliteArchiveProvider(
  provider: PersistedArchiveProvider,
): provider is "zcode" {
  return provider === "zcode";
}

async function setSqliteSessionArchived(params: {
  dbPath: string;
  sessionId: string;
  projectPath: string;
  archivedAtMs: number;
}): Promise<void> {
  const result = await withWritableSqliteDatabase<
    "archived" | "already_archived" | "not_found" | "unavailable"
  >(params.dbPath, "unavailable", (db) => {
    const row = db
      .prepare(
        "SELECT time_archived FROM session WHERE id = ? AND directory = ?",
      )
      .get(params.sessionId, params.projectPath);

    if (!row) return "not_found";
    if (typeof row.time_archived === "number") return "already_archived";

    db.prepare(
      "UPDATE session SET time_archived = ? WHERE id = ? AND directory = ?",
    ).run(params.archivedAtMs, params.sessionId, params.projectPath);
    return "archived";
  });

  if (result === "archived") return;
  if (result === "already_archived") {
    throw new ArchiveError(
      "already_archived",
      `Session ${params.sessionId} is already archived`,
    );
  }
  if (result === "not_found") {
    throw new ArchiveError(
      "session_not_found",
      `SQLite session not found for ${params.sessionId}`,
    );
  }
  throw new ArchiveError(
    "archive_failed",
    "Provider database is not available for archive",
  );
}

async function setSqliteSessionUnarchived(params: {
  dbPath: string;
  sessionId: string;
  projectPath: string;
}): Promise<void> {
  const result = await withWritableSqliteDatabase<
    "restored" | "not_found" | "unavailable"
  >(params.dbPath, "unavailable", (db) => {
    const row = db
      .prepare("SELECT id FROM session WHERE id = ? AND directory = ?")
      .get(params.sessionId, params.projectPath);

    if (!row) return "not_found";

    db.prepare(
      "UPDATE session SET time_archived = NULL WHERE id = ? AND directory = ?",
    ).run(params.sessionId, params.projectPath);
    return "restored";
  });

  if (result === "restored") return;
  if (result === "not_found") {
    throw new ArchiveError(
      "restore_failed",
      `SQLite session not found for ${params.sessionId}`,
    );
  }
  throw new ArchiveError(
    "restore_failed",
    "Provider database is not available for restore",
  );
}

async function createArchivedFileRecord(
  kind: ArchivedFileRecord["kind"],
  originalPath: string,
  archivePath: string,
): Promise<ArchivedFileRecord> {
  const stats = await stat(originalPath);
  return {
    kind,
    originalPath,
    archivePath,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

async function moveFiles(
  files: ArchivedFileRecord[],
  direction: "to-archive" | "to-original",
): Promise<void> {
  const moved: Array<{ from: string; to: string }> = [];
  const destinationConflicts: string[] = [];

  for (const file of files) {
    const destination =
      direction === "to-archive" ? file.archivePath : file.originalPath;
    if (await fileExists(destination)) {
      destinationConflicts.push(destination);
    }
  }
  if (destinationConflicts.length > 0) {
    throw new ArchiveError(
      direction === "to-archive" ? "archive_failed" : "restore_failed",
      `Destination already exists: ${destinationConflicts.join(", ")}`,
    );
  }

  try {
    for (const file of files) {
      const from =
        direction === "to-archive" ? file.originalPath : file.archivePath;
      const to =
        direction === "to-archive" ? file.archivePath : file.originalPath;
      await moveFile(from, to);
      moved.push({ from, to });
    }
  } catch (error) {
    for (const { from, to } of moved.reverse()) {
      await moveFile(to, from).catch(() => {});
    }
    throw new ArchiveError(
      direction === "to-archive" ? "archive_failed" : "restore_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function moveFile(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
    await copyFile(from, to);
    await unlink(from);
  }
}

async function fileExists(filePath: string | undefined): Promise<boolean> {
  if (!filePath) return false;
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function extractAgentIds(rawSessionJsonl: string): Set<string> {
  const ids = new Set<string>();

  for (const match of rawSessionJsonl.matchAll(/"agentId"\s*:\s*"([^"]+)"/g)) {
    if (match[1]) ids.add(match[1]);
  }

  for (const match of rawSessionJsonl.matchAll(
    /agent-([A-Za-z0-9._-]+)\.jsonl/g,
  )) {
    if (match[1]) ids.add(match[1]);
  }

  return ids;
}

export function getDelayUntilNextBeijingHour(
  hour: number,
  now = new Date(),
): number {
  const beijingNow = new Date(now.getTime() + BEIJING_UTC_OFFSET_MS);
  let nextBeijingWallTimeMs = Date.UTC(
    beijingNow.getUTCFullYear(),
    beijingNow.getUTCMonth(),
    beijingNow.getUTCDate(),
    hour,
    0,
    0,
    0,
  );
  let nextUtcMs = nextBeijingWallTimeMs - BEIJING_UTC_OFFSET_MS;

  if (nextUtcMs <= now.getTime()) {
    nextBeijingWallTimeMs += DAY_MS;
    nextUtcMs = nextBeijingWallTimeMs - BEIJING_UTC_OFFSET_MS;
  }

  return Math.max(1, nextUtcMs - now.getTime());
}
