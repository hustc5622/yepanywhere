import type { ProviderName, UrlProjectId } from "@yep-anywhere/shared";
import type { ISessionIndexService } from "../indexes/types.js";
import { canonicalizeProjectPath } from "../projects/paths.js";
import type { Project, SessionSummary } from "../supervisor/types.js";
import { CodexSessionReader } from "./codex-reader.js";
import {
  CURSOR_ACP_SESSIONS_DIR,
  CursorSessionReader,
} from "./cursor-reader.js";
import type { DshSessionReader } from "./dsh-reader.js";
import { DSH_SESSIONS_DIR } from "./dsh-store.js";
import { collapseEditForkFamilies } from "./edit-fork-families.js";
import { GeminiSessionReader } from "./gemini-reader.js";
import { KimiSessionReader } from "./kimi-reader.js";
import { McodeSessionReader } from "./mcode-reader.js";
import { MCODE_SESSIONS_DIR } from "./mcode-store.js";
import { PI_SESSIONS_DIR } from "./pi-files.js";
import { PiSessionReader } from "./pi-reader.js";
import {
  type ProviderGroup,
  normalizeProviderGroup,
} from "./provider-groups.js";
import { ClaudeSessionReader } from "./reader.js";
import type { ISessionReader } from "./types.js";

export interface ProviderProjectCatalog {
  codexPaths: Set<string>;
  geminiPaths: Set<string>;
  piPaths: Set<string>;
  kimiPaths: Set<string>;
  cursorPaths: Set<string>;
  /** Optional so older catalog builders/tests remain valid. */
  mcodePaths?: Set<string>;
  /** Projects with read-only DeepSeek Harness sessions. */
  dshPaths?: Set<string>;
  geminiHashToCwd?: Promise<Map<string, string>>;
  codexSessionsByPath?: Map<string, SessionSummary[]>;
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
  cursorSessionsDir?: string;
  cursorReaderFactory?: (projectPath: string) => CursorSessionReader;
  mcodeSessionsDir?: string;
  mcodeReaderFactory?: (projectPath: string) => McodeSessionReader;
  /**
   * Read-only DeepSeek Harness reader. Absent when the provider is disabled;
   * unlike other providers there is no fallback reader.
   */
  dshReaderFactory?: (projectPath: string) => DshSessionReader;
  allowStaleSessionCache?: boolean;
  /** Yep sidecar lineage used when a stable provider API cannot persist it. */
  sessionMetadataService?: {
    getForkParentSessionId?: (sessionId: string) => string | undefined;
    getForkFamilyTitle?: (
      sessionId: string,
    ) => { title?: string; fullTitle?: string } | undefined;
  };
}

export interface SessionSource {
  provider: ProviderName;
  reader: ISessionReader;
  sessionDir: string;
  kind:
    | "primary"
    | "codex"
    | "gemini"
    | "pi"
    | "kimi"
    | "cursor"
    | "mcode"
    | "dsh";
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

function mayHaveCursorSessions(
  project: Project,
  catalog?: ProviderProjectCatalog,
): boolean {
  if (catalog) {
    return catalog.cursorPaths.has(canonicalizeProjectPath(project.path));
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

function mayHaveMcodeSessions(
  project: Project,
  catalog?: ProviderProjectCatalog,
): boolean {
  if (catalog) {
    return (
      catalog.mcodePaths?.has(canonicalizeProjectPath(project.path)) ?? false
    );
  }
  // Without a catalog, any non-mcode project may also hold MiniMax Code
  // sessions; the reader filters by cwd, so a miss only costs one query.
  return normalizeProviderGroup(project.provider) !== null;
}

function mayHaveDshSessions(
  project: Project,
  catalog?: ProviderProjectCatalog,
): boolean {
  if (catalog?.dshPaths) {
    return catalog.dshPaths.has(canonicalizeProjectPath(project.path));
  }
  // The reader filters by cwd, so a miss only costs one cached directory scan.
  return normalizeProviderGroup(project.provider) !== null;
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
  if (mayHaveCursorSessions(project, catalog)) {
    pushGroup("cursor");
  }
  if (mayHaveMcodeSessions(project, catalog)) {
    pushGroup("mcode");
  }
  if (mayHaveDshSessions(project, catalog)) {
    pushGroup("dsh");
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
    case "cursor":
      return createCursorSource(project, deps);
    case "mcode":
      return createMcodeSource(project, deps);
    case "dsh":
      return createDshSource(project, deps);
  }
}

function createDshSource(
  project: Project,
  deps: ProviderResolutionDeps,
): SessionSource | null {
  const reader = deps.dshReaderFactory?.(project.path);
  if (!reader) return null;
  return {
    provider: "dsh",
    reader,
    sessionDir: DSH_SESSIONS_DIR,
    kind: "dsh",
  };
}

function createMcodeSource(
  project: Project,
  deps: ProviderResolutionDeps,
): SessionSource {
  const sessionsDir = deps.mcodeSessionsDir ?? MCODE_SESSIONS_DIR;
  const reader =
    deps.mcodeReaderFactory?.(project.path) ??
    new McodeSessionReader({ sessionsDir, projectPath: project.path });
  return {
    provider: "mcode",
    reader,
    sessionDir: sessionsDir,
    kind: "mcode",
  };
}

function createCursorSource(
  project: Project,
  deps: ProviderResolutionDeps,
): SessionSource {
  const sessionsDir = deps.cursorSessionsDir ?? CURSOR_ACP_SESSIONS_DIR;
  const reader =
    deps.cursorReaderFactory?.(project.path) ??
    new CursorSessionReader({
      sessionsDir,
      projectPath: project.path,
    });
  return {
    provider: "cursor",
    reader,
    sessionDir: sessionsDir,
    kind: "cursor",
  };
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
  catalog?: ProviderProjectCatalog,
): Promise<SessionSummary[]> {
  if (source.kind === "codex" && catalog?.codexSessionsByPath) {
    return collapseEditForkFamilies(
      applyForkLineageMetadata(
        catalog.codexSessionsByPath.get(
          canonicalizeProjectPath(project.path),
        ) ?? [],
        deps,
      ),
    );
  }
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
    const forkParentSessionId =
      session.forkParentSessionId ??
      metadata.getForkParentSessionId?.(session.id);
    const familyTitle = metadata.getForkFamilyTitle?.(session.id);
    if (!forkParentSessionId && !familyTitle) return session;
    return {
      ...session,
      ...(forkParentSessionId ? { forkParentSessionId } : {}),
      ...(familyTitle?.title ? { title: familyTitle.title } : {}),
      ...(familyTitle?.fullTitle
        ? { fullTitle: familyTitle.fullTitle }
        : familyTitle?.title
          ? { fullTitle: familyTitle.title }
          : {}),
    };
  });
}

export async function listSessionsAcrossProviders(
  project: Project,
  deps: ProviderResolutionDeps,
  catalog?: ProviderProjectCatalog,
  additionalSessions: readonly SessionSummary[] = [],
): Promise<SessionSummary[]> {
  const sessions: SessionSummary[] = [];
  const seenSessionIds = new Set<string>();

  for (const source of getSessionSources(project, deps, undefined, catalog)) {
    const sourceSessions = await listSessionsForSource(
      project,
      source,
      deps,
      catalog,
    );
    for (const session of sourceSessions) {
      if (seenSessionIds.has(session.id)) continue;
      seenSessionIds.add(session.id);
      sessions.push(session);
    }
  }

  // Bridge rows arrive independently of the persisted catalog. Collapse only
  // after merging them, retaining hidden member ids for later live updates.
  for (const session of additionalSessions) {
    if (seenSessionIds.has(session.id)) continue;
    seenSessionIds.add(session.id);
    sessions.push(session);
  }
  sessions.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return collapseEditForkFamilies(applyForkLineageMetadata(sessions, deps));
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
  preferredProvider?: ProviderName,
): SessionSource[] {
  return getSessionSources(project, deps, preferredProvider, catalog);
}
