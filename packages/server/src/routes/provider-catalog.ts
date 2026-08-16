import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import type { KimiSessionScanner } from "../projects/kimi-scanner.js";
import type { OpenCodeSessionScanner } from "../projects/opencode-scanner.js";
import { canonicalizeProjectPath } from "../projects/paths.js";
import type { PiSessionScanner } from "../projects/pi-scanner.js";
import type { ZCodeSessionScanner } from "../projects/zcode-scanner.js";
import type { Project } from "../supervisor/types.js";

export interface ProviderCatalogDeps {
  codexScanner?: CodexSessionScanner;
  geminiScanner?: GeminiSessionScanner;
  opencodeScanner?: OpenCodeSessionScanner;
  piScanner?: PiSessionScanner;
  kimiScanner?: KimiSessionScanner;
  zcodeScanner?: ZCodeSessionScanner;
  projects?: Project[];
}

export interface ProviderProjectCatalog {
  codexPaths: Set<string>;
  geminiPaths: Set<string>;
  opencodePaths: Set<string>;
  piPaths: Set<string>;
  kimiPaths: Set<string>;
  zcodePaths: Set<string>;
  geminiHashToCwd?: Promise<Map<string, string>>;
}

/**
 * Build a per-request catalog of project paths that have non-Claude provider
 * sessions. This avoids re-running scanner filters for each project in route
 * loops.
 */
export async function buildProviderProjectCatalog(
  deps: ProviderCatalogDeps,
): Promise<ProviderProjectCatalog> {
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
    const opencodePaths = new Set(
      deps.projects
        .filter(
          (project) =>
            project.hasOpenCodeSessions === true ||
            project.provider === "opencode",
        )
        .map((project) => canonicalizeProjectPath(project.path)),
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

    const needsCodexScan = deps.projects.some(
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
    const needsOpenCodeScan = deps.projects.some(
      (project) =>
        project.provider !== "opencode" &&
        project.hasOpenCodeSessions === undefined,
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
      !needsOpenCodeScan &&
      !needsPiScan &&
      !needsKimiScan &&
      !needsZCodeScan
    ) {
      return {
        codexPaths,
        geminiPaths,
        opencodePaths,
        piPaths,
        kimiPaths,
        zcodePaths,
        geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
      };
    }

    const [
      codexProjects,
      geminiProjects,
      openCodeProjects,
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
      needsOpenCodeScan
        ? (deps.opencodeScanner?.listProjects() ?? Promise.resolve([]))
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
    for (const project of openCodeProjects) {
      opencodePaths.add(canonicalizeProjectPath(project.path));
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
      opencodePaths,
      piPaths,
      kimiPaths,
      zcodePaths,
      geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
    };
  }

  const [
    codexProjects,
    geminiProjects,
    openCodeProjects,
    piProjects,
    kimiProjects,
    zcodeProjects,
  ] = await Promise.all([
    deps.codexScanner?.listProjects() ?? Promise.resolve([]),
    deps.geminiScanner?.listProjects() ?? Promise.resolve([]),
    deps.opencodeScanner?.listProjects() ?? Promise.resolve([]),
    deps.piScanner?.listProjects() ?? Promise.resolve([]),
    deps.kimiScanner?.listProjects() ?? Promise.resolve([]),
    deps.zcodeScanner?.listProjects() ?? Promise.resolve([]),
  ]);

  return {
    codexPaths: new Set(
      codexProjects.map((project) => canonicalizeProjectPath(project.path)),
    ),
    geminiPaths: new Set(
      geminiProjects
        .map((project) => canonicalizeProjectPath(project.path))
        .filter((path) => !path.startsWith("gemini:")),
    ),
    opencodePaths: new Set(
      openCodeProjects.map((project) => canonicalizeProjectPath(project.path)),
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
  };
}
