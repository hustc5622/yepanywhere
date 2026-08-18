import type { ProviderName, UrlProjectId } from "@yep-anywhere/shared";
import type { ISessionIndexService } from "../indexes/types.js";
import { canonicalizeProjectPath } from "../projects/paths.js";
import type { Project, SessionSummary } from "../supervisor/types.js";
import { CodexSessionReader } from "./codex-reader.js";
import { collapseEditForkFamilies } from "./edit-fork-families.js";
import { GeminiSessionReader } from "./gemini-reader.js";
import { KimiSessionReader } from "./kimi-reader.js";
import { PI_SESSIONS_DIR } from "./pi-files.js";
import { PiSessionReader } from "./pi-reader.js";
import {
  type ProviderGroup,
  normalizeProviderGroup,
} from "./provider-groups.js";
import { ClaudeSessionReader } from "./reader.js";
import type { ISessionReader } from "./types.js";
import { ZCODE_DB_PATH } from "./zcode-db.js";
import { ZCodeSessionReader } from "./zcode-reader.js";

export interface ProviderProjectCatalog {
  codexPaths: Set<string>;
  geminiPaths: Set<string>;
  piPaths: Set<string>;
  kimiPaths: Set<string>;
  zcodePaths: Set<string>;
  geminiHashToCwd?: Promise<Map<string, string>>;
}

export interface ProviderResolutionDeps {
  readerFactory: (project: Project) => ISessionReader;
  sessionIndexService?: ISessionIndexService;
  codexSessionsDir?: string;
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  geminiSessionsDir?: string;
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  geminiHashToCwd?: Promise<Map<string, string>>;
  piSessionsDir?: string;
  piReaderFactory?: (projectPath: string) => PiSessionReader;
  kimiSessionsDir?: string;
  kimiReaderFactory?: (projectPath: string) => KimiSessionReader;
  zcodeDbPath?: string;
  zcodeReaderFactory?: (projectPath: string) => ZCodeSessionReader;
  allowStaleSessionCache?: boolean;
  /** Yep sidecar lineage used when a stable provider API cannot persist it. */
  sessionMetadataService?: {
    getForkParentSessionId?: (sessionId: string) => string | undefined;
  };
}

export interface SessionSource {
  provider: ProviderName;
  reader: ISessionReader;
  sessionDir: string;
  kind: "primary" | "codex" | "gemini" | "pi" | "kimi" | "zcode";
}

export interface ResolvedSessionSummary {
  source: SessionSource;
  summary: SessionSummary;
}

function mayHaveCodexSessions(
  project: Project,
  catalog?: ProviderProjectCatalog,
): boolean {
  if (catalog) {
    return catalog.codexPaths.has(canonicalizeProjectPath(project.path));
  }
  return normalizeProviderGroup(project.provider) === "claude";
}

function mayHaveGeminiSessions(
  project: Project,
  catalog?: ProviderProjectCatalog,
): boolean {
  if (catalog) {
    return catalog.geminiPaths.has(canonicalizeProjectPath(project.path));
  }
  const provider = normalizeProviderGroup(project.provider);
  return provider === "claude" || provider === "codex";
}

function mayHaveKimiSessions(
  project: Project,
  catalog?: ProviderProjectCatalog,
): boolean {
  if (catalog) {
    return catalog.kimiPaths.has(canonicalizeProjectPath(project.path));
  }
  const provider = normalizeProviderGroup(project.provider);
  return (
    provider === "claude" ||
    provider === "codex" ||
    provider === "gemini" ||
    provider === "pi"
  );
}

function mayHavePiSessions(
  project: Project,
  catalog?: ProviderProjectCatalog,
): boolean {
  if (catalog) {
    return catalog.piPaths.has(canonicalizeProjectPath(project.path));
  }
  const provider = normalizeProviderGroup(project.provider);
  return provider === "claude" || provider === "codex" || provider === "gemini";
}

function mayHaveZCodeSessions(
  project: Project,
  catalog?: ProviderProjectCatalog,
): boolean {
  if (catalog) {
    return catalog.zcodePaths.has(canonicalizeProjectPath(project.path));
  }
  const provider = normalizeProviderGroup(project.provider);
  return (
    provider === "claude" ||
    provider === "codex" ||
    provider === "gemini" ||
    provider === "pi" ||
    provider === "kimi"
  );
}

function createClaudeSource(
  project: Project,
  deps: ProviderResolutionDeps,
): SessionSource {
  return {
    provider: project.provider,
    reader: deps.readerFactory(project),
    sessionDir: project.sessionDir,
    kind: "primary",
  };
}

function createCodexSource(
  project: Project,
  deps: ProviderResolutionDeps,
): SessionSource | null {
  const reader =
    deps.codexReaderFactory?.(project.path) ??
    (deps.codexSessionsDir
      ? new CodexSessionReader({
          sessionsDir: deps.codexSessionsDir,
          projectPath: project.path,
        })
      : null);
  if (!reader) return null;
  return {
    provider: "codex",
    reader,
    sessionDir: deps.codexSessionsDir ?? project.sessionDir,
    kind: "codex",
  };
}

function createGeminiSource(
  project: Project,
  deps: ProviderResolutionDeps,
  catalog?: ProviderProjectCatalog,
): SessionSource | null {
  const reader =
    deps.geminiReaderFactory?.(project.path) ??
    (deps.geminiSessionsDir
      ? new GeminiSessionReader({
          sessionsDir: deps.geminiSessionsDir,
          projectPath: project.path,
          hashToCwd: catalog?.geminiHashToCwd ?? deps.geminiHashToCwd,
        })
      : null);
  if (!reader) return null;
  return {
    provider: "gemini",
    reader,
    sessionDir: deps.geminiSessionsDir ?? project.sessionDir,
    kind: "gemini",
  };
}

function createKimiSource(
  project: Project,
  deps: ProviderResolutionDeps,
): SessionSource | null {
  const reader =
    deps.kimiReaderFactory?.(project.path) ??
    (deps.kimiSessionsDir
      ? new KimiSessionReader({
          sessionsDir: deps.kimiSessionsDir,
          projectPath: project.path,
        })
      : null);
  if (!reader) return null;
  return {
    provider: "kimi",
    reader,
    sessionDir: deps.kimiSessionsDir ?? project.sessionDir,
    kind: "kimi",
  };
}

function createPiSource(
  project: Project,
  deps: ProviderResolutionDeps,
): SessionSource {
  const sessionsDir = deps.piSessionsDir ?? PI_SESSIONS_DIR;
  const reader =
    deps.piReaderFactory?.(project.path) ??
    new PiSessionReader({ sessionsDir, projectPath: project.path });
  return {
    provider: "pi",
    reader,
    sessionDir: sessionsDir,
    kind: "pi",
  };
}

function createZCodeSource(
  project: Project,
  deps: ProviderResolutionDeps,
): SessionSource | null {
  const dbPath = deps.zcodeDbPath ?? ZCODE_DB_PATH;
  const reader =
    deps.zcodeReaderFactory?.(project.path) ??
    new ZCodeSessionReader({ dbPath, projectPath: project.path });
  return {
    provider: "zcode",
    reader,
    sessionDir: dbPath,
    kind: "zcode",
  };
}

function buildCandidateGroups(
  project: Project,
  preferredProvider: ProviderName | string | undefined,
  catalog?: ProviderProjectCatalog,
): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  const pushGroup = (group: ProviderGroup | null) => {
    if (!group || groups.includes(group)) return;
    groups.push(group);
  };

  const preferredGroup = normalizeProviderGroup(preferredProvider);
  const projectGroup = normalizeProviderGroup(project.provider);

  pushGroup(preferredGroup);
  pushGroup(projectGroup);

  if (mayHaveCodexSessions(project, catalog)) {
    pushGroup("codex");
  }
  if (mayHaveGeminiSessions(project, catalog)) {
    pushGroup("gemini");
  }
  if (mayHavePiSessions(project, catalog)) {
    pushGroup("pi");
  }
  if (mayHaveKimiSessions(project, catalog)) {
    pushGroup("kimi");
  }
  if (mayHaveZCodeSessions(project, catalog)) {
    pushGroup("zcode");
  }

  return groups;
}

function getSourceForGroup(
  project: Project,
  deps: ProviderResolutionDeps,
  group: ProviderGroup,
  catalog?: ProviderProjectCatalog,
): SessionSource | null {
  switch (group) {
    case "claude":
      return createClaudeSource(project, deps);
    case "pi":
      return createPiSource(project, deps);
    case "codex":
      return createCodexSource(project, deps);
    case "gemini":
      return createGeminiSource(project, deps, catalog);
    case "kimi":
      return createKimiSource(project, deps);
    case "zcode":
      return createZCodeSource(project, deps);
  }
}

function getSessionSources(
  project: Project,
  deps: ProviderResolutionDeps,
  preferredProvider?: ProviderName | string,
  catalog?: ProviderProjectCatalog,
): SessionSource[] {
  const sources: SessionSource[] = [];
  for (const group of buildCandidateGroups(
    project,
    preferredProvider,
    catalog,
  )) {
    const source = getSourceForGroup(project, deps, group, catalog);
    if (!source) continue;
    if (
      sources.some(
        (existing) =>
          existing.kind === source.kind &&
          existing.sessionDir === source.sessionDir,
      )
    ) {
      continue;
    }
    sources.push(source);
  }
  return sources;
}

async function listSessionsForSource(
  project: Project,
  source: SessionSource,
  deps: ProviderResolutionDeps,
): Promise<SessionSummary[]> {
  if (!deps.sessionIndexService) {
    return collapseEditForkFamilies(
      applyForkLineageMetadata(
        await source.reader.listSessions(project.id),
        deps,
      ),
    );
  }

  let sessions = await deps.sessionIndexService.getSessionsWithCache(
    source.sessionDir,
    project.id,
    source.reader,
    { allowStale: deps.allowStaleSessionCache },
  );

  if (
    source.kind === "primary" &&
    normalizeProviderGroup(project.provider) === "claude"
  ) {
    for (const dir of project.mergedSessionDirs ?? []) {
      const mergedReader = new ClaudeSessionReader({ sessionDir: dir });
      const merged = await deps.sessionIndexService.getSessionsWithCache(
        dir,
        project.id,
        mergedReader,
        { allowStale: deps.allowStaleSessionCache },
      );
      sessions = [...sessions, ...merged];
    }
  }

  // Collapse provider edit-fork families (parent + per-edit child sessions)
  // into one list entry. Native rollout lineage wins; the Yep sidecar fills
  // the stable Codex first-prompt fallback where thread/start has no parent.
  return collapseEditForkFamilies(applyForkLineageMetadata(sessions, deps));
}

function applyForkLineageMetadata(
  sessions: SessionSummary[],
  deps: ProviderResolutionDeps,
): SessionSummary[] {
  const metadata = deps.sessionMetadataService;
  if (!metadata) return sessions;
  return sessions.map((session) => {
    if (session.forkParentSessionId) return session;
    const forkParentSessionId = metadata.getForkParentSessionId?.(session.id);
    return forkParentSessionId ? { ...session, forkParentSessionId } : session;
  });
}

export async function listSessionsAcrossProviders(
  project: Project,
  deps: ProviderResolutionDeps,
  catalog?: ProviderProjectCatalog,
): Promise<SessionSummary[]> {
  const sessions: SessionSummary[] = [];
  const seenSessionIds = new Set<string>();

  for (const source of getSessionSources(project, deps, undefined, catalog)) {
    const sourceSessions = await listSessionsForSource(project, source, deps);
    for (const session of sourceSessions) {
      if (seenSessionIds.has(session.id)) continue;
      seenSessionIds.add(session.id);
      sessions.push(session);
    }
  }

  sessions.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return sessions;
}

export async function findSessionSummaryAcrossProviders(
  project: Project,
  sessionId: string,
  projectId: UrlProjectId,
  deps: ProviderResolutionDeps,
  preferredProvider?: ProviderName | string,
): Promise<ResolvedSessionSummary | null> {
  for (const source of getSessionSources(project, deps, preferredProvider)) {
    // Prefer the shared SessionIndex cache (mtime/size validated, and the same
    // persisted index the project list warms) so high-frequency callers like
    // the recents panel don't re-read + fully re-parse each session file. Fall
    // back to the reader directly when no index service is wired up.
    const summary = deps.sessionIndexService
      ? await deps.sessionIndexService.getSessionSummaryWithCache(
          source.sessionDir,
          projectId,
          sessionId,
          source.reader,
        )
      : await source.reader.getSessionSummary(sessionId, projectId);
    if (summary) {
      const [enriched] = applyForkLineageMetadata([summary], deps);
      return { source, summary: enriched ?? summary };
    }
  }

  return null;
}

/**
 * Resolve the de-duplicated provider session sources for a project.
 * Exposed so callers like the search route can iterate each provider's session
 * directory + reader directly (e.g. to build/query a content index per source).
 */
export function resolveSessionSources(
  project: Project,
  deps: ProviderResolutionDeps,
  catalog?: ProviderProjectCatalog,
): SessionSource[] {
  return getSessionSources(project, deps, undefined, catalog);
}
