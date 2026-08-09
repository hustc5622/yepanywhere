/**
 * Resolve a bare session id back to the project that owns it.
 *
 * Every session read path is keyed by `projectId + sessionId`, but the ids
 * users actually hold — copied from the UI, pasted into an agent running in
 * some unrelated directory, quoted in a bug report — carry no project. This
 * module is the one place that closes that gap.
 *
 * Lookups run cheapest-first. The first five sources answer without parsing a
 * single session file; only the final fallback pays for the full per-project,
 * per-provider reader fan-out.
 */

import { access } from "node:fs/promises";
import type { ProviderName, UrlProjectId } from "@yep-anywhere/shared";
import type { SessionLocation } from "@yep-anywhere/shared";
import type { SessionArchiveService } from "../archive/SessionArchiveService.js";
import type { BridgeController } from "../bridge-common/types.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import {
  canonicalizeProjectPath,
  encodeProjectId,
  getProjectName,
  getSessionFilePath,
} from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { Project } from "../supervisor/types.js";
import type { CodexSessionReader } from "./codex-reader.js";
import { getCodexSessionManifest } from "./codex-session-manifest.js";
import type { GeminiSessionReader } from "./gemini-reader.js";
import type { KimiSessionReader } from "./kimi-reader.js";
import { withOpenCodeDb } from "./opencode-db.js";
import type { OpenCodeSessionReader } from "./opencode-reader.js";
import { findSessionSummaryAcrossProviders } from "./provider-resolution.js";
import type { ISessionReader } from "./types.js";

/**
 * Structural subset of `SessionsDeps`, so the locator can be called from any
 * router without importing the route module (and its dependency graph).
 */
export interface SessionLocatorDeps {
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  sessionMetadataService?: SessionMetadataService;
  sessionArchiveService?: SessionArchiveService;
  codexSessionsDir?: string;
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  geminiScanner?: GeminiSessionScanner;
  geminiSessionsDir?: string;
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  opencodeDbPath?: string;
  opencodeReaderFactory?: (projectPath: string) => OpenCodeSessionReader;
  kimiSessionsDir?: string;
  kimiReaderFactory?: (projectPath: string) => KimiSessionReader;
  codexBridgeService?: BridgeController;
  opencodeBridgeService?: BridgeController;
}

/** Session ids are used to build filesystem paths, so keep them inert. */
export function isLocatableSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId.length <= 200 &&
    /^[A-Za-z0-9._-]+$/.test(sessionId) &&
    sessionId !== "." &&
    sessionId !== ".."
  );
}

function fromProjectPath(projectPath: string): {
  projectId: UrlProjectId;
  projectPath: string;
  projectName: string;
} {
  const canonical = canonicalizeProjectPath(projectPath);
  return {
    projectId: encodeProjectId(canonical),
    projectPath: canonical,
    projectName: getProjectName(canonical),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cold-archive manifest. An in-memory map lookup, and the only source that
 * knows about sessions which have been moved off the hot scan paths — so it
 * has to run before anything that walks the live provider directories.
 */
function locateViaArchive(
  deps: SessionLocatorDeps,
  sessionId: string,
): SessionLocation | null {
  const record = deps.sessionArchiveService?.getArchivedSession(sessionId);
  if (!record) return null;
  return {
    sessionId,
    requestedSessionId: sessionId,
    provider: record.provider,
    projectId: record.projectId,
    projectPath: record.projectPath,
    projectName: getProjectName(record.projectPath),
    source: "archive",
    archived: true,
  };
}

/**
 * Bridge sidecars. `listSessions()` (not `listSessionViews()`) is used because
 * only the former carries `projectPath`.
 */
async function locateViaBridges(
  deps: SessionLocatorDeps,
  sessionId: string,
): Promise<SessionLocation | null> {
  const candidates: Array<[ProviderName, BridgeController | undefined]> = [
    ["codex", deps.codexBridgeService],
    ["opencode", deps.opencodeBridgeService],
  ];

  for (const [provider, controller] of candidates) {
    if (!controller) continue;
    let sessions: Awaited<ReturnType<BridgeController["listSessions"]>>;
    try {
      sessions = await controller.listSessions();
    } catch {
      // A sidecar that is down must not block the remaining lookups.
      continue;
    }
    const match = sessions.find((session) => session.id === sessionId);
    if (!match?.projectPath) continue;
    return {
      sessionId,
      requestedSessionId: sessionId,
      provider,
      ...fromProjectPath(match.projectPath),
      source: "bridge",
      archived: false,
    };
  }

  return null;
}

/**
 * Codex keeps a manifest of every session under `~/.codex/sessions`, indexed
 * by id with a 5s TTL. `CodexSessionReader` builds the same manifest and then
 * discards any entry whose cwd does not match its project — here we keep it.
 */
async function locateViaCodexManifest(
  deps: SessionLocatorDeps,
  sessionId: string,
): Promise<SessionLocation | null> {
  if (!deps.codexSessionsDir) return null;
  try {
    const manifest = await getCodexSessionManifest(deps.codexSessionsDir);
    const entry = manifest.byId.get(sessionId);
    if (!entry?.cwd) return null;
    return {
      sessionId,
      requestedSessionId: sessionId,
      provider: "codex",
      ...fromProjectPath(entry.cwd),
      source: "codex-manifest",
      archived: false,
    };
  } catch {
    return null;
  }
}

/**
 * The OpenCode sqlite database is global and `session.directory` is indexed by
 * primary key, so this is a single-row lookup. `OpenCodeSessionReader` runs the
 * same query with `AND directory = ?` appended, which is precisely why a bare
 * id is otherwise unresolvable for this provider.
 */
async function locateViaOpenCodeDb(
  deps: SessionLocatorDeps,
  sessionId: string,
): Promise<SessionLocation | null> {
  if (!deps.opencodeDbPath) return null;
  const directory = await withOpenCodeDb<string | null>(
    deps.opencodeDbPath,
    null,
    (db) => {
      const row = db
        .prepare("SELECT directory FROM session WHERE id = ?")
        .get(sessionId);
      const value = row?.directory;
      return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : null;
    },
  );
  if (!directory) return null;
  return {
    sessionId,
    requestedSessionId: sessionId,
    provider: "opencode",
    ...fromProjectPath(directory),
    source: "opencode-db",
    archived: false,
  };
}

/**
 * Claude stores sessions as `<sessionDir>/<sessionId>.jsonl`, so a stat per
 * known session directory settles it without reading any file. Cheaper than
 * the reader fan-out, which parses each candidate session.
 */
async function locateViaClaudeFile(
  projects: Project[],
  sessionId: string,
): Promise<SessionLocation | null> {
  for (const project of projects) {
    const dirs = [project.sessionDir, ...(project.mergedSessionDirs ?? [])];
    for (const dir of dirs) {
      if (!dir) continue;
      if (!(await exists(getSessionFilePath(dir, sessionId)))) continue;
      return {
        sessionId,
        requestedSessionId: sessionId,
        provider: "claude",
        ...fromProjectPath(project.path),
        source: "claude-file",
        archived: false,
      };
    }
  }
  return null;
}

/**
 * Project recorded by Yep when it started the session.
 *
 * Deliberately ranked below the provider-authoritative sources: the recorded
 * path goes stale when a project directory is moved, whereas the codex manifest
 * and the opencode row always report the current location. Its job is only to
 * spare the expensive scan below, so an existence check is enough to keep a
 * stale entry from producing a confidently wrong answer.
 */
async function locateViaMetadata(
  deps: SessionLocatorDeps,
  sessionId: string,
): Promise<SessionLocation | null> {
  const recorded = deps.sessionMetadataService?.getProjectLocation(sessionId);
  if (!recorded) return null;
  if (!(await exists(recorded.projectPath))) return null;

  const provider = deps.sessionMetadataService?.getProvider(sessionId);
  if (!provider) return null;

  return {
    sessionId,
    requestedSessionId: sessionId,
    provider: provider as ProviderName,
    ...fromProjectPath(recorded.projectPath),
    source: "metadata",
    archived: false,
  };
}

/**
 * Last resort: ask every provider reader about every project. This is what
 * covers Gemini and Kimi, whose on-disk layouts have no id-keyed index.
 */
async function locateViaProviderScan(
  deps: SessionLocatorDeps,
  projects: Project[],
  sessionId: string,
): Promise<SessionLocation | null> {
  const preferredProvider =
    deps.sessionMetadataService?.getProvider(sessionId) ?? undefined;
  const resolutionDeps = {
    readerFactory: deps.readerFactory,
    sessionMetadataService: deps.sessionMetadataService,
    codexSessionsDir: deps.codexSessionsDir,
    codexReaderFactory: deps.codexReaderFactory,
    geminiSessionsDir: deps.geminiSessionsDir,
    geminiReaderFactory: deps.geminiReaderFactory,
    geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
    opencodeDbPath: deps.opencodeDbPath,
    opencodeReaderFactory: deps.opencodeReaderFactory,
    kimiSessionsDir: deps.kimiSessionsDir,
    kimiReaderFactory: deps.kimiReaderFactory,
  };

  for (const project of projects) {
    const resolved = await findSessionSummaryAcrossProviders(
      project,
      sessionId,
      project.id,
      resolutionDeps,
      preferredProvider,
    );
    if (!resolved) continue;
    return {
      sessionId,
      requestedSessionId: sessionId,
      provider: resolved.summary.provider ?? resolved.source.provider,
      ...fromProjectPath(project.path),
      source: "provider-scan",
      archived: false,
    };
  }

  return null;
}

/**
 * Resolve `sessionId` to its owning project, or null when no provider claims
 * it. Aliased ids (provider bootstrap id -> durable id) are followed, and the
 * result reports both the canonical and the requested id.
 */
export async function locateSession(
  deps: SessionLocatorDeps,
  requestedSessionId: string,
): Promise<SessionLocation | null> {
  if (!isLocatableSessionId(requestedSessionId)) return null;

  const sessionId =
    deps.sessionMetadataService?.getCanonicalSessionId(requestedSessionId) ??
    requestedSessionId;

  const withRequestedId = (
    location: SessionLocation | null,
  ): SessionLocation | null =>
    location ? { ...location, requestedSessionId } : null;

  const archived = locateViaArchive(deps, sessionId);
  if (archived) return withRequestedId(archived);

  const bridged = await locateViaBridges(deps, sessionId);
  if (bridged) return withRequestedId(bridged);

  const codex = await locateViaCodexManifest(deps, sessionId);
  if (codex) return withRequestedId(codex);

  const opencode = await locateViaOpenCodeDb(deps, sessionId);
  if (opencode) return withRequestedId(opencode);

  const projects = await deps.scanner.listProjects();

  const claude = await locateViaClaudeFile(projects, sessionId);
  if (claude) return withRequestedId(claude);

  const recorded = await locateViaMetadata(deps, sessionId);
  if (recorded) return withRequestedId(recorded);

  return withRequestedId(
    await locateViaProviderScan(deps, projects, sessionId),
  );
}
