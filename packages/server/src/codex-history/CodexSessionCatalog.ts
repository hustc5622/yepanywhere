import { stat } from "node:fs/promises";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { canonicalizeProjectPath, encodeProjectId } from "../projects/paths.js";
import type { Thread } from "../sdk/providers/codex-protocol/generated/v2/Thread.js";
import { getCodexSessionManifest } from "../sessions/codex-session-manifest.js";
import type { SessionSummary } from "../supervisor/types.js";
import type { CodexHistoryClient } from "./CodexHistoryClient.js";

const PAGE_SIZE = 100;
const DEFAULT_TTL_MS = 2_000;
const PATH_VALIDATION_CONCURRENCY = 64;
export const CODEX_USER_VISIBLE_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
] as const;

interface CatalogRow {
  summary: SessionSummary;
  projectPath: string;
}

export interface CodexSessionCatalogSnapshot {
  sessions: SessionSummary[];
  byProjectPath: Map<string, SessionSummary[]>;
  /** Public app-server metadata does not expose an exact transcript count. */
  unknownMessageCountIds: ReadonlySet<string>;
  createdAt: number;
}

export interface CodexSessionCatalogOptions {
  client: Pick<CodexHistoryClient, "listThreads">;
  ttlMs?: number;
  now?: () => number;
  source?: "auto" | "manifest" | "app-server";
  sessionsDir?: string;
}

/** Provider-wide state-DB-first Codex list snapshot shared by every project. */
export class CodexSessionCatalog {
  private snapshot: CodexSessionCatalogSnapshot | null = null;
  private inFlight: Promise<CodexSessionCatalogSnapshot | null> | null = null;
  private reconcileInFlight: Promise<void> | null = null;
  /** Manifest-confirmed rows absent from the latest state-DB snapshot. */
  private manifestOnlyRows = new Map<string, CatalogRow>();
  private readonly stateDbIdsBySnapshot = new WeakMap<
    CodexSessionCatalogSnapshot,
    ReadonlySet<string>
  >();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly source: "auto" | "manifest" | "app-server";

  constructor(private readonly options: CodexSessionCatalogOptions) {
    this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
    this.now = options.now ?? Date.now;
    this.source =
      options.source ?? resolveListSource(process.env.YEP_CODEX_LIST_SOURCE);
  }

  async getSnapshot(): Promise<CodexSessionCatalogSnapshot | null> {
    if (this.source === "manifest") return null;
    if (this.snapshot && this.now() - this.snapshot.createdAt < this.ttlMs) {
      return this.snapshot;
    }
    if (this.inFlight) return this.inFlight;
    const request = this.loadSnapshot()
      .then((snapshot) => {
        if (snapshot) {
          this.snapshot = snapshot;
          this.reconcileInBackground(snapshot);
        }
        return snapshot ?? this.snapshot;
      })
      .catch(async () =>
        this.options.sessionsDir
          ? ((await this.loadManifestSnapshot()) ?? this.snapshot)
          : this.snapshot,
      )
      .finally(() => {
        if (this.inFlight === request) this.inFlight = null;
      });
    this.inFlight = request;
    return request;
  }

  async getSessionSummary(
    sessionId: string,
    projectPath?: string,
  ): Promise<SessionSummary | null> {
    const snapshot = await this.getSnapshot();
    if (!snapshot) return null;
    if (projectPath) {
      return (
        snapshot.byProjectPath
          .get(canonicalizeProjectPath(projectPath))
          ?.find((session) => session.id === sessionId) ?? null
      );
    }
    return (
      snapshot.sessions.find((session) => session.id === sessionId) ?? null
    );
  }

  invalidate(): void {
    if (this.snapshot) this.snapshot.createdAt = 0;
  }

  invalidateSession(sessionId: string): void {
    // Keep the manifest overlay in lockstep with the visible snapshot. A
    // deleted manifest-only row must not be reintroduced by composeSnapshot.
    this.manifestOnlyRows.delete(sessionId);
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const sessions = snapshot.sessions.filter(
      (session) => session.id !== sessionId,
    );
    const byProjectPath = new Map<string, SessionSummary[]>();
    for (const [path, rows] of snapshot.byProjectPath) {
      const retained = rows.filter((session) => session.id !== sessionId);
      if (retained.length > 0) byProjectPath.set(path, retained);
    }
    this.snapshot = {
      sessions,
      byProjectPath,
      unknownMessageCountIds: new Set(sessions.map((session) => session.id)),
      createdAt: 0,
    };
  }

  private async loadSnapshot(): Promise<CodexSessionCatalogSnapshot | null> {
    const threads: Thread[] = [];
    let cursor: string | null | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await this.options.client.listThreads({
        cursor,
        limit: PAGE_SIZE,
        sortKey: "updated_at",
        sortDirection: "desc",
        modelProviders: [],
        sourceKinds: [...CODEX_USER_VISIBLE_SOURCE_KINDS],
        archived: false,
        useStateDbOnly: true,
      });
      threads.push(...page.data);
      cursor = page.nextCursor;
      if (cursor && !seenCursors.add(cursor)) return null;
    } while (cursor);
    if (threads.length === 0) {
      return this.options.sessionsDir ? this.loadManifestSnapshot() : null;
    }

    const valid = await validateThreadPaths(threads);
    const rows = valid
      .filter((thread) => !thread.parentThreadId)
      .map((thread) => ({ thread, summary: threadSummary(thread) }))
      .sort(
        (left, right) =>
          new Date(right.summary.updatedAt).getTime() -
          new Date(left.summary.updatedAt).getTime(),
      );
    return this.composeSnapshot(
      rows.map(({ thread, summary }) => ({
        summary,
        projectPath: canonicalizeProjectPath(thread.cwd),
      })),
      this.manifestOnlyRows,
    );
  }

  private reconcileInBackground(snapshot: CodexSessionCatalogSnapshot): void {
    if (!this.options.sessionsDir || this.reconcileInFlight) return;
    const reconcile = this.reconcileWithManifest(snapshot)
      .catch(() => {})
      .finally(() => {
        if (this.reconcileInFlight === reconcile) this.reconcileInFlight = null;
      });
    this.reconcileInFlight = reconcile;
  }

  private async reconcileWithManifest(
    snapshot: CodexSessionCatalogSnapshot,
  ): Promise<void> {
    const sessionsDir = this.options.sessionsDir;
    if (!sessionsDir) return;
    const manifest = await getCodexSessionManifest(sessionsDir);
    const stateDbIds = this.stateDbIdsBySnapshot.get(snapshot) ?? new Set();
    const projectPathById = new Map<string, string>();
    for (const [projectPath, rows] of snapshot.byProjectPath) {
      for (const row of rows) projectPathById.set(row.id, projectPath);
    }
    const manifestOnlyRows = new Map<string, CatalogRow>();
    for (const entry of manifest.sessions) {
      if (entry.isSubagent || stateDbIds.has(entry.id)) continue;
      const projectPath = canonicalizeProjectPath(entry.cwd);
      manifestOnlyRows.set(entry.id, {
        projectPath,
        summary: {
          id: entry.id,
          projectId: encodeProjectId(projectPath) as UrlProjectId,
          title: null,
          fullTitle: null,
          createdAt: entry.timestamp,
          updatedAt: new Date(entry.mtime).toISOString(),
          messageCount: 0,
          ownership: { owner: "none" },
          provider: "codex",
          parentSessionId: entry.parentThreadId,
        },
      });
    }
    if (this.snapshot !== snapshot) return;
    this.manifestOnlyRows = manifestOnlyRows;
    const stateDbRows = snapshot.sessions
      .filter((session) => stateDbIds.has(session.id))
      .map((summary) => ({
        summary,
        projectPath: projectPathById.get(summary.id) ?? "",
      }))
      .filter((row) => row.projectPath.length > 0);
    this.snapshot = this.composeSnapshot(stateDbRows, manifestOnlyRows);
  }

  private async loadManifestSnapshot(): Promise<CodexSessionCatalogSnapshot | null> {
    const sessionsDir = this.options.sessionsDir;
    if (!sessionsDir) return null;
    const manifest = await getCodexSessionManifest(sessionsDir);
    const sessions = manifest.sessions
      .filter((entry) => !entry.isSubagent)
      .map((entry): SessionSummary => {
        const projectPath = canonicalizeProjectPath(entry.cwd);
        return {
          id: entry.id,
          projectId: encodeProjectId(projectPath) as UrlProjectId,
          title: null,
          fullTitle: null,
          createdAt: entry.timestamp,
          updatedAt: new Date(entry.mtime).toISOString(),
          messageCount: 0,
          ownership: { owner: "none" },
          provider: "codex",
          parentSessionId: entry.parentThreadId,
        };
      })
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() -
          new Date(left.updatedAt).getTime(),
      );
    if (sessions.length === 0) return null;
    const manifestRows = new Map<string, CatalogRow>();
    for (const session of sessions) {
      const cwd = manifest.byId.get(session.id)?.cwd;
      if (!cwd) continue;
      const projectPath = canonicalizeProjectPath(cwd);
      manifestRows.set(session.id, { summary: session, projectPath });
    }
    this.manifestOnlyRows = manifestRows;
    return this.composeSnapshot([], manifestRows);
  }

  private composeSnapshot(
    stateDbRows: CatalogRow[],
    manifestOnlyRows: ReadonlyMap<string, CatalogRow>,
  ): CodexSessionCatalogSnapshot {
    const byId = new Map<string, CatalogRow>();
    for (const row of stateDbRows) byId.set(row.summary.id, row);
    for (const [id, row] of manifestOnlyRows) {
      if (!byId.has(id)) byId.set(id, row);
    }
    const rows = Array.from(byId.values()).sort(
      (left, right) =>
        new Date(right.summary.updatedAt).getTime() -
        new Date(left.summary.updatedAt).getTime(),
    );
    const sessions = rows.map((row) => row.summary);
    const byProjectPath = new Map<string, SessionSummary[]>();
    for (const row of rows) {
      if (!row.projectPath) continue;
      const projectRows = byProjectPath.get(row.projectPath);
      if (projectRows) projectRows.push(row.summary);
      else byProjectPath.set(row.projectPath, [row.summary]);
    }
    const snapshot = {
      sessions,
      byProjectPath,
      unknownMessageCountIds: new Set(sessions.map((session) => session.id)),
      createdAt: this.now(),
    };
    this.stateDbIdsBySnapshot.set(
      snapshot,
      new Set(stateDbRows.map((row) => row.summary.id)),
    );
    return snapshot;
  }
}

async function validateThreadPaths(threads: Thread[]): Promise<Thread[]> {
  const valid: Thread[] = [];
  let index = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(PATH_VALIDATION_CONCURRENCY, threads.length) },
      async () => {
        while (index < threads.length) {
          const current = threads[index++];
          if (!current?.path) continue;
          const metadata = await stat(current.path).catch(() => null);
          if (metadata?.isFile()) valid.push(current);
        }
      },
    ),
  );
  return valid;
}

function threadSummary(thread: Thread): SessionSummary {
  const projectPath = canonicalizeProjectPath(thread.cwd);
  const title = thread.name?.trim() || thread.preview.trim() || null;
  return {
    id: thread.id,
    projectId: encodeProjectId(projectPath) as UrlProjectId,
    title,
    fullTitle: title,
    createdAt: new Date(thread.createdAt * 1_000).toISOString(),
    updatedAt: new Date(thread.updatedAt * 1_000).toISOString(),
    // Public Thread metadata has no total count; a non-empty preview proves at
    // least one visible user message without scanning history.
    messageCount: title ? 1 : 0,
    ownership: { owner: "none" },
    provider: ["ollama", "lmstudio", "local"].includes(
      thread.modelProvider.toLowerCase(),
    )
      ? "codex-oss"
      : "codex",
    forkParentSessionId: thread.forkedFromId ?? undefined,
    codexModelProvider: thread.modelProvider,
    cliVersion: thread.cliVersion,
    source: typeof thread.source === "string" ? thread.source : undefined,
  };
}

function resolveListSource(
  value: string | undefined,
): "auto" | "manifest" | "app-server" {
  return value === "manifest" || value === "app-server" ? value : "auto";
}
