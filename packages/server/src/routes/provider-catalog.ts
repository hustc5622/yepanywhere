import type { CodexSessionCatalog } from "../codex-history/CodexSessionCatalog.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { CursorSessionScanner } from "../projects/cursor-scanner.js";
import type { DshSessionScanner } from "../projects/dsh-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import type { McodeSessionScanner } from "../projects/mcode-scanner.js";
import { canonicalizeProjectPath } from "../projects/paths.js";
import type { PiSessionScanner } from "../projects/pi-scanner.js";
import type { Project } from "../supervisor/types.js";
import type { SessionSummary } from "../supervisor/types.js";

export interface ProviderCatalogDeps {
  codexScanner?: CodexSessionScanner;
  geminiScanner?: GeminiSessionScanner;
  piScanner?: PiSessionScanner;
  cursorScanner?: CursorSessionScanner;
  mcodeScanner?: McodeSessionScanner;
  dshScanner?: DshSessionScanner;
  projects?: Project[];
  codexSessionCatalog?: CodexSessionCatalog;
}

export interface ProviderProjectCatalog {
  codexPaths: Set<string>;
  geminiPaths: Set<string>;
  piPaths: Set<string>;
  cursorPaths: Set<string>;
  mcodePaths?: Set<string>;
  dshPaths?: Set<string>;
  geminiHashToCwd?: Promise<Map<string, string>>;
  codexSessionsByPath?: Map<string, SessionSummary[]>;
  codexUnknownMessageCountIds?: ReadonlySet<string>;
}

/**
 * Build a per-request catalog of project paths that have non-Claude provider
 * sessions. This avoids re-running scanner filters for each project in route
 * loops.
 */
export async function buildProviderProjectCatalog(
  deps: ProviderCatalogDeps,
): Promise<ProviderProjectCatalog> {
  const [base, mcodePaths, dshPaths] = await Promise.all([
    buildBaseProviderProjectCatalog(deps),
    buildMcodeProjectPaths(deps),
    buildDshProjectPaths(deps),
  ]);
  return { ...base, mcodePaths, dshPaths };
}

/** Read-only DeepSeek Harness paths; empty when the provider is disabled. */
async function buildDshProjectPaths(
  deps: ProviderCatalogDeps,
): Promise<Set<string>> {
  const paths = new Set<string>();
  if (!deps.dshScanner) return paths;
  for (const project of deps.projects ?? []) {
    if (project.hasDshSessions === true || project.provider === "dsh") {
      paths.add(canonicalizeProjectPath(project.path));
    }
  }
  const needsScan =
    !deps.projects ||
    deps.projects.some(
      (project) =>
        project.provider !== "dsh" && project.hasDshSessions === undefined,
    );
  if (needsScan) {
    for (const project of await deps.dshScanner.listProjects()) {
      paths.add(canonicalizeProjectPath(project.path));
    }
  }
  return paths;
}

/** MiniMax Code paths: project flags first, then the (cached) catalog scan. */
async function buildMcodeProjectPaths(
  deps: ProviderCatalogDeps,
): Promise<Set<string>> {
  const paths = new Set(
    (deps.projects ?? [])
      .filter(
        (project) =>
          project.hasMcodeSessions === true || project.provider === "mcode",
      )
      .map((project) => canonicalizeProjectPath(project.path)),
  );
  const needsScan =
    !deps.projects ||
    deps.projects.some(
      (project) =>
        project.provider !== "mcode" && project.hasMcodeSessions === undefined,
    );
  if (needsScan && deps.mcodeScanner) {
    for (const project of await deps.mcodeScanner.listProjects()) {
      paths.add(canonicalizeProjectPath(project.path));
    }
  }
  return paths;
}

async function buildBaseProviderProjectCatalog(
  deps: ProviderCatalogDeps,
): Promise<ProviderProjectCatalog> {
  const codexCatalog = await deps.codexSessionCatalog?.getSnapshot();
  if (deps.projects) {
    const codexPaths = new Set(
      deps.projects
        .filter(
          (project) =>
            project.hasCodexSessions === true ||
            project.provider === "codex" ||
            project.provider === "codex-oss",
        )
        .map((project) => canonicalizeProjectPath(project.path)),
    );
    for (const path of codexCatalog?.byProjectPath.keys() ?? []) {
      codexPaths.add(path);
    }
    const geminiPaths = new Set(
      deps.projects
        .filter(
          (project) =>
            project.hasGeminiSessions === true ||
            project.provider === "gemini" ||
            project.provider === "gemini-acp",
        )
        .map((project) => canonicalizeProjectPath(project.path))
        .filter((path) => !path.startsWith("gemini:")),
    );
    const piPaths = new Set(
      deps.projects
        .filter(
          (project) =>
            project.hasPiSessions === true || project.provider === "pi",
        )
        .map((project) => canonicalizeProjectPath(project.path)),
    );
    const cursorPaths = new Set(
      deps.projects
        .filter(
          (project) =>
            project.hasCursorSessions === true || project.provider === "cursor",
        )
        .map((project) => canonicalizeProjectPath(project.path)),
    );

    const needsCodexScan =
      !codexCatalog &&
      deps.projects.some(
        (project) =>
          project.provider !== "codex" &&
          project.provider !== "codex-oss" &&
          project.hasCodexSessions === undefined,
      );
    const needsGeminiScan = deps.projects.some(
      (project) =>
        project.provider !== "gemini" &&
        project.provider !== "gemini-acp" &&
        project.hasGeminiSessions === undefined,
    );
    const needsPiScan = deps.projects.some(
      (project) =>
        project.provider !== "pi" && project.hasPiSessions === undefined,
    );
    const needsCursorScan = deps.projects.some(
      (project) =>
        project.provider !== "cursor" &&
        project.hasCursorSessions === undefined,
    );

    if (
      !needsCodexScan &&
      !needsGeminiScan &&
      !needsPiScan &&
      !needsCursorScan
    ) {
      return {
        codexPaths,
        geminiPaths,
        piPaths,
        cursorPaths,
        geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
        codexSessionsByPath: codexCatalog?.byProjectPath,
        codexUnknownMessageCountIds: codexCatalog?.unknownMessageCountIds,
      };
    }

    const [codexProjects, geminiProjects, piProjects, cursorProjects] =
      await Promise.all([
        needsCodexScan
          ? (deps.codexScanner?.listProjects() ?? Promise.resolve([]))
          : Promise.resolve([]),
        needsGeminiScan
          ? (deps.geminiScanner?.listProjects() ?? Promise.resolve([]))
          : Promise.resolve([]),
        needsPiScan
          ? (deps.piScanner?.listProjects() ?? Promise.resolve([]))
          : Promise.resolve([]),
        needsCursorScan
          ? (deps.cursorScanner?.listProjects() ?? Promise.resolve([]))
          : Promise.resolve([]),
      ]);

    for (const project of codexProjects) {
      codexPaths.add(canonicalizeProjectPath(project.path));
    }
    for (const project of geminiProjects) {
      const path = canonicalizeProjectPath(project.path);
      if (!path.startsWith("gemini:")) {
        geminiPaths.add(path);
      }
    }
    for (const project of piProjects) {
      piPaths.add(canonicalizeProjectPath(project.path));
    }
    for (const project of cursorProjects) {
      cursorPaths.add(canonicalizeProjectPath(project.path));
    }

    return {
      codexPaths,
      geminiPaths,
      piPaths,
      cursorPaths,
      geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
      codexSessionsByPath: codexCatalog?.byProjectPath,
      codexUnknownMessageCountIds: codexCatalog?.unknownMessageCountIds,
    };
  }

  const [codexProjects, geminiProjects, piProjects, cursorProjects] =
    await Promise.all([
      codexCatalog
        ? Promise.resolve([])
        : (deps.codexScanner?.listProjects() ?? Promise.resolve([])),
      deps.geminiScanner?.listProjects() ?? Promise.resolve([]),
      deps.piScanner?.listProjects() ?? Promise.resolve([]),
      deps.cursorScanner?.listProjects() ?? Promise.resolve([]),
    ]);

  return {
    codexPaths: new Set([
      ...codexProjects.map((project) => canonicalizeProjectPath(project.path)),
      ...(codexCatalog?.byProjectPath.keys() ?? []),
    ]),
    geminiPaths: new Set(
      geminiProjects
        .map((project) => canonicalizeProjectPath(project.path))
        .filter((path) => !path.startsWith("gemini:")),
    ),
    piPaths: new Set(
      piProjects.map((project) => canonicalizeProjectPath(project.path)),
    ),
    cursorPaths: new Set(
      cursorProjects.map((project) => canonicalizeProjectPath(project.path)),
    ),
    geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
    codexSessionsByPath: codexCatalog?.byProjectPath,
    codexUnknownMessageCountIds: codexCatalog?.unknownMessageCountIds,
  };
}
