import type { CodexSessionCatalog } from "../codex-history/CodexSessionCatalog.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import type { KimiSessionScanner } from "../projects/kimi-scanner.js";
import { canonicalizeProjectPath } from "../projects/paths.js";
import type { PiSessionScanner } from "../projects/pi-scanner.js";
import type { ZCodeSessionScanner } from "../projects/zcode-scanner.js";
import type { Project } from "../supervisor/types.js";
import type { SessionSummary } from "../supervisor/types.js";

export interface ProviderCatalogDeps {
  codexScanner?: CodexSessionScanner;
  geminiScanner?: GeminiSessionScanner;
  piScanner?: PiSessionScanner;
  kimiScanner?: KimiSessionScanner;
  zcodeScanner?: ZCodeSessionScanner;
  projects?: Project[];
  codexSessionCatalog?: CodexSessionCatalog;
}

export interface ProviderProjectCatalog {
  codexPaths: Set<string>;
  geminiPaths: Set<string>;
  piPaths: Set<string>;
  kimiPaths: Set<string>;
  zcodePaths: Set<string>;
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
    const kimiPaths = new Set(
      deps.projects
        .filter(
          (project) =>
            project.hasKimiSessions === true || project.provider === "kimi",
        )
        .map((project) => canonicalizeProjectPath(project.path)),
    );
    const piPaths = new Set(
      deps.projects
        .filter(
          (project) =>
            project.hasPiSessions === true || project.provider === "pi",
        )
        .map((project) => canonicalizeProjectPath(project.path)),
    );
    const zcodePaths = new Set(
      deps.projects
        .filter(
          (project) =>
            project.hasZCodeSessions === true || project.provider === "zcode",
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
    const needsKimiScan = deps.projects.some(
      (project) =>
        project.provider !== "kimi" && project.hasKimiSessions === undefined,
    );
    const needsPiScan = deps.projects.some(
      (project) =>
        project.provider !== "pi" && project.hasPiSessions === undefined,
    );
    const needsZCodeScan = deps.projects.some(
      (project) =>
        project.provider !== "zcode" && project.hasZCodeSessions === undefined,
    );

    if (
      !needsCodexScan &&
      !needsGeminiScan &&
      !needsPiScan &&
      !needsKimiScan &&
      !needsZCodeScan
    ) {
      return {
        codexPaths,
        geminiPaths,
        piPaths,
        kimiPaths,
        zcodePaths,
        geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
        codexSessionsByPath: codexCatalog?.byProjectPath,
        codexUnknownMessageCountIds: codexCatalog?.unknownMessageCountIds,
      };
    }

    const [
      codexProjects,
      geminiProjects,
      piProjects,
      kimiProjects,
      zcodeProjects,
    ] = await Promise.all([
      needsCodexScan
        ? (deps.codexScanner?.listProjects() ?? Promise.resolve([]))
        : Promise.resolve([]),
      needsGeminiScan
        ? (deps.geminiScanner?.listProjects() ?? Promise.resolve([]))
        : Promise.resolve([]),
      needsPiScan
        ? (deps.piScanner?.listProjects() ?? Promise.resolve([]))
        : Promise.resolve([]),
      needsKimiScan
        ? (deps.kimiScanner?.listProjects() ?? Promise.resolve([]))
        : Promise.resolve([]),
      needsZCodeScan
        ? (deps.zcodeScanner?.listProjects() ?? Promise.resolve([]))
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
    for (const project of kimiProjects) {
      kimiPaths.add(canonicalizeProjectPath(project.path));
    }
    for (const project of zcodeProjects) {
      zcodePaths.add(canonicalizeProjectPath(project.path));
    }

    return {
      codexPaths,
      geminiPaths,
      piPaths,
      kimiPaths,
      zcodePaths,
      geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
      codexSessionsByPath: codexCatalog?.byProjectPath,
      codexUnknownMessageCountIds: codexCatalog?.unknownMessageCountIds,
    };
  }

  const [
    codexProjects,
    geminiProjects,
    piProjects,
    kimiProjects,
    zcodeProjects,
  ] = await Promise.all([
    codexCatalog
      ? Promise.resolve([])
      : (deps.codexScanner?.listProjects() ?? Promise.resolve([])),
    deps.geminiScanner?.listProjects() ?? Promise.resolve([]),
    deps.piScanner?.listProjects() ?? Promise.resolve([]),
    deps.kimiScanner?.listProjects() ?? Promise.resolve([]),
    deps.zcodeScanner?.listProjects() ?? Promise.resolve([]),
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
    kimiPaths: new Set(
      kimiProjects.map((project) => canonicalizeProjectPath(project.path)),
    ),
    zcodePaths: new Set(
      zcodeProjects.map((project) => canonicalizeProjectPath(project.path)),
    ),
    geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
    codexSessionsByPath: codexCatalog?.byProjectPath,
    codexUnknownMessageCountIds: codexCatalog?.unknownMessageCountIds,
  };
}
