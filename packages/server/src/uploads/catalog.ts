import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type UploadCatalogEntry,
  type UploadListResponse,
  type UploadSessionListResponse,
  type UploadSessionRef,
  type UploadSessionSummary,
  type UploadSource,
  type UploadTotals,
  generatedArtifactDownloadUrl,
  isSafeManagedUploadFileName,
  isSafeUploadSessionId,
  isUrlProjectId,
  managedUploadRef,
  parseManagedUploadRef,
} from "@yep-anywhere/shared";
import {
  GENERATED_ARTIFACT_REGISTRY_DIR_NAME,
  GENERATED_ARTIFACT_STORAGE_MARKER,
  RETENTION_DIR_NAME,
  UPLOADS_DIR,
  UploadManager,
  isGeneratedArtifactStorageFilename,
  mimeTypeForUploadFileName,
} from "./manager.js";

/**
 * Append-only record of which session sent which upload. Appends of single
 * short lines are atomic, so the web process and an external agent runtime
 * can both record without coordinating.
 */
const USAGE_LOG_NAME = ".usage.jsonl";
const FULL_SCAN_TTL_MS = 5_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface UploadCatalogFilter {
  projectId?: string;
  sessionId?: string;
  source?: UploadSource;
  /** Case-insensitive substring of the original file name. */
  query?: string;
}

export interface UploadPage {
  limit?: number;
  cursor?: string | null;
}

export type UploadRemoveResult =
  | { status: "removed"; entry: UploadCatalogEntry }
  | { status: "not_found" }
  | { status: "needs_confirmation"; entry: UploadCatalogEntry };

interface UsageIndex {
  /** Uploads stored before this time were never tracked. */
  trackedSinceMs: number | null;
  byRef: Map<string, UploadSessionRef[]>;
}

interface ScannedUpload {
  entry: Omit<UploadCatalogEntry, "usedBy">;
  mtimeMs: number;
}

export interface UploadCatalogOptions {
  uploadsDir?: string;
  uploadManager?: UploadManager;
}

/**
 * The uploads directory is the catalog: listing scans it, so files written by
 * any process (browser uploads, Feishu media, generated artifacts) appear
 * without a separate index that could drift from disk.
 */
export class UploadCatalog {
  private readonly uploadsDir: string;
  private readonly uploadManager: UploadManager;
  /** A page load lists both files and sessions; share one directory walk. */
  private fullScan: { at: number; result: Promise<ScannedUpload[]> } | null =
    null;

  constructor(options: UploadCatalogOptions = {}) {
    this.uploadsDir = options.uploadsDir ?? UPLOADS_DIR;
    this.uploadManager =
      options.uploadManager ??
      new UploadManager({ uploadsDir: this.uploadsDir });
  }

  /** Record that `target` sent these uploads. */
  async recordUse(
    refs: readonly string[],
    target: UploadSessionRef,
    nowMs = Date.now(),
  ): Promise<void> {
    const unique = [...new Set(refs)].filter(
      (ref) => parseManagedUploadRef(ref) !== null,
    );
    if (unique.length === 0) return;
    await mkdir(this.uploadsDir, { recursive: true, mode: 0o700 });
    const logPath = join(this.uploadsDir, USAGE_LOG_NAME);
    try {
      const handle = await open(logPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ since: nowMs })}\n`);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await appendFile(
      logPath,
      unique
        .map(
          (ref) =>
            `${JSON.stringify({
              ref,
              projectId: target.projectId,
              sessionId: target.sessionId,
              at: nowMs,
            })}\n`,
        )
        .join(""),
      { mode: 0o600 },
    );
  }

  async list(
    filter: UploadCatalogFilter = {},
    page: UploadPage = {},
  ): Promise<UploadListResponse> {
    const entries = (await this.entries(filter)).sort(
      (left, right) =>
        right.uploadedAt.localeCompare(left.uploadedAt) ||
        left.ref.localeCompare(right.ref),
    );
    const { items, nextCursor } = paginate(entries, page);
    return { entries: items, nextCursor, totals: totalsOf(entries) };
  }

  async listSessions(
    filter: Omit<UploadCatalogFilter, "sessionId"> = {},
    page: UploadPage = {},
  ): Promise<UploadSessionListResponse> {
    const entries = await this.entries(filter);
    const bySession = new Map<string, UploadSessionSummary>();
    for (const entry of entries) {
      const key = `${entry.projectId}/${entry.sessionId}`;
      const summary = bySession.get(key) ?? {
        projectId: entry.projectId,
        sessionId: entry.sessionId,
        count: 0,
        bytes: 0,
        lastUploadedAt: entry.uploadedAt,
      };
      summary.count += 1;
      summary.bytes += entry.size;
      if (entry.uploadedAt > summary.lastUploadedAt) {
        summary.lastUploadedAt = entry.uploadedAt;
      }
      bySession.set(key, summary);
    }
    const sessions = [...bySession.values()].sort(
      (left, right) =>
        right.lastUploadedAt.localeCompare(left.lastUploadedAt) ||
        left.sessionId.localeCompare(right.sessionId),
    );
    const { items, nextCursor } = paginate(sessions, page);
    return { sessions: items, nextCursor, totals: totalsOf(entries) };
  }

  async get(ref: string): Promise<UploadCatalogEntry | null> {
    const location = parseManagedUploadRef(ref);
    if (!location || !isUrlProjectId(location.projectId)) return null;
    const scanned = await this.scanSession(
      location.projectId,
      location.sessionId,
    );
    const found = scanned.find((upload) => upload.entry.ref === ref);
    if (!found) return null;
    return withUsage(found, await this.readUsage());
  }

  /** Delete one stored file; a file some session sent needs confirmation. */
  async remove(
    ref: string,
    options: { confirmed?: boolean } = {},
  ): Promise<UploadRemoveResult> {
    const entry = await this.get(ref);
    if (!entry) return { status: "not_found" };
    if (entry.usedBy.length > 0 && !options.confirmed) {
      return { status: "needs_confirmation", entry };
    }
    this.fullScan = null;
    const scope = { projectId: entry.projectId, sessionId: entry.sessionId };
    if (entry.source === "generated") {
      const cleaned = await this.uploadManager.cleanupTaskAttachments({
        ...scope,
        taskId: `generated-${entry.id}`,
      });
      if (cleaned.removed) return { status: "removed", entry };
    }
    await this.uploadManager.discardTaskAttachments(scope, [entry.id]);
    return { status: "removed", entry };
  }

  private async entries(
    filter: UploadCatalogFilter,
  ): Promise<UploadCatalogEntry[]> {
    const [scanned, usage] = await Promise.all([
      this.scan(filter),
      this.readUsage(),
    ]);
    const query = filter.query?.trim().toLowerCase();
    return scanned
      .filter(
        ({ entry }) =>
          (!filter.source || entry.source === filter.source) &&
          (!query || entry.originalName.toLowerCase().includes(query)),
      )
      .map((upload) => withUsage(upload, usage));
  }

  private scan(filter: UploadCatalogFilter): Promise<ScannedUpload[]> {
    if (filter.projectId) return this.scanDirectories(filter);
    const now = Date.now();
    if (!this.fullScan || now - this.fullScan.at > FULL_SCAN_TTL_MS) {
      const result = this.scanDirectories({});
      this.fullScan = { at: now, result };
      result.catch(() => {
        if (this.fullScan?.result === result) this.fullScan = null;
      });
    }
    return this.fullScan.result;
  }

  private async scanDirectories(
    filter: UploadCatalogFilter,
  ): Promise<ScannedUpload[]> {
    const projectIds = filter.projectId
      ? [filter.projectId]
      : await listDirectories(this.uploadsDir, isUrlProjectId);
    const results = await Promise.all(
      projectIds.map(async (projectId) => {
        if (!isUrlProjectId(projectId)) return [];
        const sessionIds = filter.sessionId
          ? [filter.sessionId]
          : await listDirectories(
              join(this.uploadsDir, projectId),
              isSafeUploadSessionId,
            );
        const sessions = await Promise.all(
          sessionIds.map((sessionId) =>
            isSafeUploadSessionId(sessionId)
              ? this.scanSession(projectId, sessionId)
              : [],
          ),
        );
        return sessions.flat();
      }),
    );
    return results.flat();
  }

  private async scanSession(
    projectId: string,
    sessionId: string,
  ): Promise<ScannedUpload[]> {
    const dir = join(this.uploadsDir, projectId, sessionId);
    const dirStats = await lstat(dir).catch(() => null);
    if (!dirStats?.isDirectory() || dirStats.isSymbolicLink()) return [];
    const [names, feishuIds, generated] = await Promise.all([
      readdir(dir, { withFileTypes: true }).then((entries) =>
        entries
          .filter(
            (entry) =>
              entry.isFile() && isSafeManagedUploadFileName(entry.name),
          )
          .map((entry) => entry.name),
      ),
      readFeishuAttachmentIds(dir),
      readGeneratedArtifacts(dir),
    ]);
    const uploads = await Promise.all(
      names.map(async (name): Promise<ScannedUpload | null> => {
        const stats = await lstat(join(dir, name)).catch(() => null);
        if (!stats?.isFile()) return null;
        const id = name.slice(0, 36);
        const storedName = name.slice(37);
        const isGenerated = isGeneratedArtifactStorageFilename(name);
        const artifact = isGenerated ? generated.get(id) : undefined;
        const ref = managedUploadRef({ projectId, sessionId, fileName: name });
        const source: UploadSource = isGenerated
          ? "generated"
          : feishuIds.has(id)
            ? "feishu"
            : "web";
        return {
          mtimeMs: stats.mtimeMs,
          entry: {
            ref,
            id,
            projectId,
            sessionId,
            name,
            originalName:
              artifact?.fileName ??
              (isGenerated
                ? storedName.slice(GENERATED_ARTIFACT_STORAGE_MARKER.length)
                : storedName),
            size: stats.size,
            mimeType:
              artifact?.mimeType ??
              mimeTypeForUploadFileName(name).split(";")[0] ??
              "application/octet-stream",
            uploadedAt: new Date(stats.mtimeMs).toISOString(),
            source,
            ...(isGenerated
              ? artifact
                ? {
                    downloadUrl: generatedArtifactDownloadUrl({
                      projectId,
                      sessionId,
                      ...artifact,
                    }),
                  }
                : {}
              : { downloadUrl: ref }),
          },
        };
      }),
    );
    return uploads.filter((upload) => upload !== null);
  }

  private async readUsage(): Promise<UsageIndex> {
    const text = await readFile(
      join(this.uploadsDir, USAGE_LOG_NAME),
      "utf8",
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const usage: UsageIndex = { trackedSinceMs: null, byRef: new Map() };
    for (const line of text.split("\n")) {
      if (!line) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof record.since === "number") {
        usage.trackedSinceMs ??= record.since;
        continue;
      }
      const { ref, projectId, sessionId } = record;
      if (
        typeof ref !== "string" ||
        typeof projectId !== "string" ||
        typeof sessionId !== "string"
      ) {
        continue;
      }
      const sessions = usage.byRef.get(ref) ?? [];
      if (
        !sessions.some(
          (session) =>
            session.projectId === projectId && session.sessionId === sessionId,
        )
      ) {
        sessions.push({ projectId, sessionId });
      }
      usage.byRef.set(ref, sessions);
    }
    return usage;
  }
}

function withUsage(
  { entry, mtimeMs }: ScannedUpload,
  usage: UsageIndex,
): UploadCatalogEntry {
  const usedBy = [...(usage.byRef.get(entry.ref) ?? [])];
  // Channel media and generated output belong to the turn that stored them;
  // untracked older uploads are assumed sent by their own session.
  const ownerUsed =
    entry.source !== "web" ||
    usage.trackedSinceMs === null ||
    mtimeMs < usage.trackedSinceMs;
  if (
    ownerUsed &&
    !usedBy.some(
      (session) =>
        session.projectId === entry.projectId &&
        session.sessionId === entry.sessionId,
    )
  ) {
    usedBy.unshift({ projectId: entry.projectId, sessionId: entry.sessionId });
  }
  return { ...entry, usedBy };
}

async function listDirectories(
  dir: string,
  accept: (name: string) => boolean,
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isDirectory() && accept(entry.name))
    .map((entry) => entry.name);
}

/** Attachment IDs a Feishu task stored; generated tasks are excluded. */
async function readFeishuAttachmentIds(dir: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const retentionDir = join(dir, RETENTION_DIR_NAME);
  const names = await readdir(retentionDir).catch(() => []);
  await Promise.all(
    names
      .filter(
        (name) => name.endsWith(".json") && !name.startsWith("generated-"),
      )
      .map(async (name) => {
        const record = await readJson(join(retentionDir, name));
        const attachmentIds = record?.attachmentIds;
        if (!Array.isArray(attachmentIds)) return;
        for (const id of attachmentIds) {
          if (typeof id === "string") ids.add(id);
        }
      }),
  );
  return ids;
}

interface GeneratedArtifactSummary {
  artifactId: string;
  sha256: string;
  fileName: string;
  mimeType: string;
}

/** Registered artifacts keyed by the attachment ID of their stored copy. */
async function readGeneratedArtifacts(
  dir: string,
): Promise<Map<string, GeneratedArtifactSummary>> {
  const artifacts = new Map<string, GeneratedArtifactSummary>();
  const registryDir = join(dir, GENERATED_ARTIFACT_REGISTRY_DIR_NAME);
  const names = await readdir(registryDir).catch(() => []);
  await Promise.all(
    names
      .filter((name) => /^ga_[a-f0-9]{32}\.json$/.test(name))
      .map(async (name) => {
        const record = await readJson(join(registryDir, name));
        const { artifactId, managedRef, sha256, fileName, mimeType } =
          record ?? {};
        if (
          typeof artifactId !== "string" ||
          typeof managedRef !== "string" ||
          !managedRef.startsWith("upload:") ||
          typeof sha256 !== "string" ||
          typeof fileName !== "string" ||
          typeof mimeType !== "string"
        ) {
          return;
        }
        artifacts.set(managedRef.slice("upload:".length), {
          artifactId,
          sha256,
          fileName,
          mimeType,
        });
      }),
  );
  return artifacts;
}

async function readJson(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function totalsOf(entries: readonly UploadCatalogEntry[]): UploadTotals {
  return {
    count: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
  };
}

function paginate<T>(
  items: readonly T[],
  page: UploadPage,
): { items: T[]; nextCursor: string | null } {
  const limit = Math.min(
    Math.max(1, Math.trunc(page.limit ?? DEFAULT_PAGE_SIZE)),
    MAX_PAGE_SIZE,
  );
  const offset = Math.max(0, Number.parseInt(page.cursor ?? "0", 10) || 0);
  const next = offset + limit;
  return {
    items: items.slice(offset, next),
    nextCursor: next < items.length ? String(next) : null,
  };
}
