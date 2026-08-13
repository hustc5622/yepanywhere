/**
 * Search route - full-text search across session message content.
 *
 * Scope is global by default, a single project via `?project=`, or a single
 * session via `?project=&session=`.
 * Results are grouped per session, each with snippet matches that the client
 * can deep-link + highlight. Backed by SessionContentIndexService, which caches
 * per-message text and only re-parses files that changed (mtime/size + watcher
 * dirty-tracking), so repeat searches are served from memory.
 */

import { getSessionDisplayTitle } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type {
  LoadSessionMessages,
  ScopeSearchResult,
  SessionContentIndexService,
} from "../indexes/index.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import type { KimiSessionScanner } from "../projects/kimi-scanner.js";
import type { OpenCodeSessionScanner } from "../projects/opencode-scanner.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { CodexSessionReader } from "../sessions/codex-reader.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import type { KimiSessionReader } from "../sessions/kimi-reader.js";
import { normalizeSession } from "../sessions/normalization.js";
import type { OpenCodeSessionReader } from "../sessions/opencode-reader.js";
import { resolveSessionSources } from "../sessions/provider-resolution.js";
import type { ISessionReader } from "../sessions/types.js";
import type { ZCodeSessionReader } from "../sessions/zcode-reader.js";
import type { Project } from "../supervisor/types.js";
import { buildProviderProjectCatalog } from "./provider-catalog.js";

export interface SearchDeps {
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  sessionContentIndexService: SessionContentIndexService;
  sessionMetadataService?: SessionMetadataService;
  codexScanner?: CodexSessionScanner;
  codexSessionsDir?: string;
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  geminiScanner?: GeminiSessionScanner;
  geminiSessionsDir?: string;
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  opencodeScanner?: OpenCodeSessionScanner;
  opencodeDbPath?: string;
  zcodeDbPath?: string;
  opencodeReaderFactory?: (projectPath: string) => OpenCodeSessionReader;
  zcodeReaderFactory?: (projectPath: string) => ZCodeSessionReader;
  kimiScanner?: KimiSessionScanner;
  kimiSessionsDir?: string;
  kimiReaderFactory?: (projectPath: string) => KimiSessionReader;
}

export interface SearchMatch {
  messageId: string;
  role: string;
  snippet: string;
  matchStart: number;
  matchLength: number;
}

export interface SearchResultSession {
  sessionId: string;
  projectId: string;
  projectName: string;
  provider: string;
  title: string;
  customTitle?: string;
  aiTitle?: string;
  updatedAt: string;
  matchCount: number;
  matches: SearchMatch[];
}

export interface SearchResponse {
  query: string;
  results: SearchResultSession[];
  totalSessions: number;
  totalMatches: number;
  searchDurationMs: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MIN_QUERY_LENGTH = 2;
const MATCHES_PER_SESSION = 3;
const MATCHES_FOR_SINGLE_SESSION = 200;

/**
 * Build the loadMessages callback the content index uses on cache miss.
 * Uses the source's reader + shared normalizeSession so emitted message ids
 * match what the client renders (enables deep-linking).
 */
function createLoadMessages(): LoadSessionMessages {
  return async (sessionId, projectId, reader) => {
    const loaded = await reader.getSession(sessionId, projectId, undefined, {
      includeOrphans: false,
    });
    if (!loaded) return null;
    const session = normalizeSession(loaded);
    return {
      messages: session.messages,
      title: session.title,
      updatedAt: session.updatedAt,
      provider: session.provider,
    };
  };
}

export function createSearchRoutes(deps: SearchDeps): Hono {
  const routes = new Hono();
  const loadMessages = createLoadMessages();

  // GET /api/search?q=&project=&session=&limit=
  routes.get("/", async (c) => {
    const start = Date.now();
    const rawQuery = c.req.query("q")?.trim() ?? "";
    const filterProjectId = c.req.query("project");
    const filterSessionId = c.req.query("session")?.trim() || undefined;
    const limitParam = c.req.query("limit");
    const limit = Math.min(
      Math.max(1, Number.parseInt(limitParam || "", 10) || DEFAULT_LIMIT),
      MAX_LIMIT,
    );

    if (rawQuery.length < MIN_QUERY_LENGTH) {
      return c.json(
        {
          query: rawQuery,
          results: [],
          totalSessions: 0,
          totalMatches: 0,
          searchDurationMs: 0,
        } satisfies SearchResponse,
        rawQuery.length === 0 ? 200 : 400,
      );
    }

    const queryLower = rawQuery.toLowerCase();

    const allProjects = await deps.scanner.listProjects();
    const projects = filterProjectId
      ? allProjects.filter((p) => p.id === filterProjectId)
      : allProjects;

    const providerCatalog = await buildProviderProjectCatalog({
      projects: allProjects,
      codexScanner: deps.codexScanner,
      geminiScanner: deps.geminiScanner,
      opencodeScanner: deps.opencodeScanner,
      kimiScanner: deps.kimiScanner,
    });

    const resolutionDeps = {
      readerFactory: deps.readerFactory,
      codexSessionsDir: deps.codexSessionsDir,
      codexReaderFactory: deps.codexReaderFactory,
      geminiSessionsDir: deps.geminiSessionsDir,
      geminiReaderFactory: deps.geminiReaderFactory,
      geminiHashToCwd: providerCatalog.geminiHashToCwd,
      opencodeDbPath: deps.opencodeDbPath,
      opencodeReaderFactory: deps.opencodeReaderFactory,
      kimiSessionsDir: deps.kimiSessionsDir,
      kimiReaderFactory: deps.kimiReaderFactory,
    };

    // sessionId -> result (dedupe across sources/projects; first wins)
    const bySession = new Map<
      string,
      { project: Project; result: ScopeSearchResult }
    >();

    for (const project of projects) {
      const sources = resolveSessionSources(
        project,
        resolutionDeps,
        providerCatalog,
      );

      for (const source of sources) {
        try {
          const index = await deps.sessionContentIndexService.ensureIndexed(
            source.sessionDir,
            project.id,
            source.reader,
            loadMessages,
          );
          const scopeResults = deps.sessionContentIndexService.searchScope(
            index,
            queryLower,
            filterSessionId ? MATCHES_FOR_SINGLE_SESSION : MATCHES_PER_SESSION,
            filterSessionId,
          );
          for (const result of scopeResults) {
            if (bySession.has(result.sessionId)) continue;
            bySession.set(result.sessionId, { project, result });
          }
        } catch {
          // Skip unreadable sources; don't fail the whole search.
        }
      }
    }

    // Build response items, merging custom titles from metadata.
    const items: SearchResultSession[] = [];
    let totalMatches = 0;
    for (const { project, result } of bySession.values()) {
      const metadata = deps.sessionMetadataService?.getMetadata(
        result.sessionId,
      );
      const customTitle = metadata?.customTitle;
      const aiTitle = metadata?.aiTitle;
      totalMatches += result.matchCount;
      items.push({
        sessionId: result.sessionId,
        projectId: project.id,
        projectName: project.name,
        provider: result.provider,
        title: getSessionDisplayTitle({
          customTitle,
          aiTitle,
          title: result.title,
        }),
        customTitle,
        aiTitle,
        updatedAt: result.updatedAt,
        matchCount: result.matchCount,
        matches: result.matches,
      });
    }

    // Rank: title matches first, then more matches, then most recent.
    const titleHit = (item: SearchResultSession): boolean =>
      (item.title?.toLowerCase().includes(queryLower) ?? false) ||
      (item.customTitle?.toLowerCase().includes(queryLower) ?? false) ||
      (item.aiTitle?.toLowerCase().includes(queryLower) ?? false);

    items.sort((a, b) => {
      const at = titleHit(a) ? 1 : 0;
      const bt = titleHit(b) ? 1 : 0;
      if (at !== bt) return bt - at;
      if (a.matchCount !== b.matchCount) return b.matchCount - a.matchCount;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    const totalSessions = items.length;
    const results = items.slice(0, limit);

    return c.json({
      query: rawQuery,
      results,
      totalSessions,
      totalMatches,
      searchDurationMs: Date.now() - start,
    } satisfies SearchResponse);
  });

  return routes;
}
