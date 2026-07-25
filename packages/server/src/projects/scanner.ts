import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  DEFAULT_PROVIDER,
  type ProviderName,
  type RemoteExecutorConfig,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { ProjectMetadataService } from "../metadata/index.js";
import {
  isLocalPathWithin,
  tryMapLocalPathToRemote,
  tryMapRemotePathToLocal,
} from "../sdk/remote-path-mapping.js";
import type { Project } from "../supervisor/types.js";
import type { EventBus, FileChangeEvent } from "../watcher/index.js";
import { CODEX_SESSIONS_DIR, CodexSessionScanner } from "./codex-scanner.js";
import { GEMINI_TMP_DIR, GeminiSessionScanner } from "./gemini-scanner.js";
import { KIMI_SESSIONS_DIR, KimiSessionScanner } from "./kimi-scanner.js";
import {
  OPENCODE_DB_PATH,
  OpenCodeSessionScanner,
} from "./opencode-scanner.js";
import {
  CLAUDE_PROJECTS_DIR,
  canonicalizeProjectPath,
  decodeProjectId,
  encodeProjectId,
  isAbsolutePath,
  normalizeProjectPathForDedup,
  readCwdFromSessionFile,
} from "./paths.js";

export interface ScannerOptions {
  projectsDir?: string; // override for testing
  codexSessionsDir?: string; // override for testing
  geminiSessionsDir?: string; // override for testing
  kimiSessionsDir?: string; // override for testing
  codexScanner?: CodexSessionScanner | null; // shared provider scanner
  geminiScanner?: GeminiSessionScanner | null; // shared provider scanner
  opencodeScanner?: OpenCodeSessionScanner | null; // shared provider scanner
  kimiScanner?: KimiSessionScanner | null; // shared provider scanner
  enableCodex?: boolean; // whether to include Codex projects (default: true)
  enableGemini?: boolean; // whether to include Gemini projects (default: true)
  enableOpenCode?: boolean; // whether to include OpenCode projects (default: true)
  enableKimi?: boolean; // whether to include Kimi projects (default: true)
  projectMetadataService?: ProjectMetadataService; // for persisting added projects
  /** Remote Claude executors whose shared stores should also be scanned. */
  remoteExecutors?: RemoteExecutorConfig[];
  /** Optional EventBus for watcher-driven cache invalidation */
  eventBus?: EventBus;
  /** Project snapshot TTL in milliseconds (default: 5000) */
  cacheTtlMs?: number;
}

interface ProjectSnapshot {
  projects: Project[];
  byId: Map<string, Project>;
  bySessionDirSuffix: Map<string, Project>;
  timestamp: number;
}

interface ClaudeSessionSource {
  projectsDir: string;
  executor?: RemoteExecutorConfig;
}

export class ProjectScanner {
  private projectsDir: string;
  private remoteExecutors: RemoteExecutorConfig[];
  private codexScanner: CodexSessionScanner | null;
  private geminiScanner: GeminiSessionScanner | null;
  private opencodeScanner: OpenCodeSessionScanner | null;
  private kimiScanner: KimiSessionScanner | null;
  private enableCodex: boolean;
  private enableGemini: boolean;
  private enableOpenCode: boolean;
  private enableKimi: boolean;
  private projectMetadataService: ProjectMetadataService | null;
  private cacheTtlMs: number;
  private cacheDirty = true;
  private cacheGeneration = 0;
  private snapshot: ProjectSnapshot | null = null;
  private inFlightScan: Promise<ProjectSnapshot> | null = null;
  private inFlightScanGeneration: number | null = null;
  private unsubscribeEventBus: (() => void) | null = null;

  constructor(options: ScannerOptions = {}) {
    this.projectsDir = options.projectsDir ?? CLAUDE_PROJECTS_DIR;
    this.remoteExecutors = [...(options.remoteExecutors ?? [])];
    this.enableCodex = options.enableCodex ?? true;
    this.enableGemini = options.enableGemini ?? true;
    this.enableOpenCode = options.enableOpenCode ?? true;
    this.enableKimi = options.enableKimi ?? true;
    this.codexScanner = this.enableCodex
      ? (options.codexScanner ??
        new CodexSessionScanner({
          sessionsDir: options.codexSessionsDir ?? CODEX_SESSIONS_DIR,
        }))
      : null;
    this.geminiScanner = this.enableGemini
      ? (options.geminiScanner ??
        new GeminiSessionScanner({
          sessionsDir: options.geminiSessionsDir ?? GEMINI_TMP_DIR,
        }))
      : null;
    this.opencodeScanner = this.enableOpenCode
      ? (options.opencodeScanner ?? new OpenCodeSessionScanner())
      : null;
    this.kimiScanner = this.enableKimi
      ? (options.kimiScanner ??
        new KimiSessionScanner({
          sessionsDir: options.kimiSessionsDir ?? KIMI_SESSIONS_DIR,
        }))
      : null;
    this.projectMetadataService = options.projectMetadataService ?? null;
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 5000);

    if (options.eventBus) {
      this.unsubscribeEventBus = options.eventBus.subscribe((event) => {
        if (event.type === "file-change") {
          this.handleFileChange(event);
          return;
        }
        if (
          event.type === "session-updated" &&
          event.trigger === "opencode-db-reconcile"
        ) {
          // OpenCode stores all projects in one SQLite database. A reconcile
          // event may be the first evidence of a project created by an
          // external CLI, so invalidate both cache layers before title/event
          // consumers resolve the encoded project ID.
          this.invalidateCache();
          this.opencodeScanner?.invalidateCache();
        }
      });
    }
  }

  /**
   * Set the project metadata service (for late initialization).
   */
  setProjectMetadataService(service: ProjectMetadataService): void {
    this.projectMetadataService = service;
    this.invalidateCache();
  }

  setRemoteExecutors(executors: RemoteExecutorConfig[]): void {
    this.remoteExecutors = executors.map((executor) => ({
      ...executor,
      sessionStorage: executor.sessionStorage
        ? { ...executor.sessionStorage }
        : undefined,
    }));
    this.invalidateCache();
  }

  private getClaudeSessionSources(): ClaudeSessionSource[] {
    const sources: ClaudeSessionSource[] = [];
    const seen = new Set<string>();

    // Prefer authoritative shared stores over a stale compatibility replica
    // when both still contain the same session.
    for (const executor of this.remoteExecutors) {
      const projectsDir = executor.sessionStorage?.localProjectsDir;
      if (executor.sessionStorage?.mode !== "shared" || !projectsDir) continue;
      if (seen.has(projectsDir)) continue;
      seen.add(projectsDir);
      sources.push({ projectsDir, executor });
    }

    if (!seen.has(this.projectsDir)) {
      sources.push({ projectsDir: this.projectsDir });
    } else {
      // If the environment override points at the same shared store, retain
      // its executor mapping instead of adding an un-mapped duplicate source.
      const source = sources.find(
        (candidate) => candidate.projectsDir === this.projectsDir,
      );
      if (!source) sources.push({ projectsDir: this.projectsDir });
    }
    return sources;
  }

  /** Map a semantic cwd according to the physical session source that owns it. */
  mapSessionCwdToLocal(cwd: string, sessionDir: string): string {
    const sources = this.getClaudeSessionSources()
      .filter((source) => isLocalPathWithin(sessionDir, source.projectsDir))
      .sort((a, b) => b.projectsDir.length - a.projectsDir.length);
    const executor = sources[0]?.executor;
    return executor ? (tryMapRemotePathToLocal(cwd, executor) ?? cwd) : cwd;
  }

  private getClaudeSessionDirForProject(projectPath: string): string {
    const candidates = this.remoteExecutors
      .filter(
        (executor) =>
          executor.sessionStorage?.mode === "shared" &&
          executor.sessionStorage.localProjectsDir,
      )
      .map((executor) => ({
        executor,
        remoteCwd: tryMapLocalPathToRemote(projectPath, executor),
      }))
      .filter(
        (
          candidate,
        ): candidate is {
          executor: RemoteExecutorConfig;
          remoteCwd: string;
        } => Boolean(candidate.remoteCwd),
      )
      .sort(
        (a, b) => b.executor.localRoot.length - a.executor.localRoot.length,
      );

    const selected = candidates[0];
    const projectsDir = selected?.executor.sessionStorage?.localProjectsDir;
    if (selected && projectsDir) {
      return join(projectsDir, selected.remoteCwd.replace(/[/\\:]/g, "-"));
    }
    return join(this.projectsDir, projectPath.replace(/[/\\:]/g, "-"));
  }

  async listProjects(): Promise<Project[]> {
    const snapshot = await this.getSnapshot();
    return snapshot.projects.map((project) => this.cloneProject(project));
  }

  /**
   * Mark the project snapshot stale so next read triggers a rescan.
   */
  invalidateCache(): void {
    this.cacheDirty = true;
    this.cacheGeneration += 1;
  }

  private async getSnapshot(forceRefresh = false): Promise<ProjectSnapshot> {
    const now = Date.now();
    const isFresh =
      this.snapshot &&
      !this.cacheDirty &&
      now - this.snapshot.timestamp < this.cacheTtlMs;

    if (!forceRefresh && isFresh && this.snapshot) {
      return this.snapshot;
    }

    if (this.inFlightScan) {
      if (this.inFlightScanGeneration === this.cacheGeneration) {
        return this.inFlightScan;
      }
      // The active scan started before the latest watcher event. Wait for it
      // to settle, then perform a fresh scan instead of letting a stale result
      // clear the dirty flag or leak to the caller.
      await this.inFlightScan;
      return this.getSnapshot(forceRefresh);
    }

    const scanGeneration = this.cacheGeneration;
    const scanPromise = this.scanProjects()
      .then((projects) => {
        const snapshot = this.buildSnapshot(projects);
        this.snapshot = snapshot;
        this.cacheDirty = this.cacheGeneration !== scanGeneration;
        return snapshot;
      })
      .finally(() => {
        if (this.inFlightScan === scanPromise) {
          this.inFlightScan = null;
          this.inFlightScanGeneration = null;
        }
      });

    this.inFlightScan = scanPromise;
    this.inFlightScanGeneration = scanGeneration;
    return scanPromise;
  }

  private buildSnapshot(projects: Project[]): ProjectSnapshot {
    const byId = new Map<string, Project>();
    const bySessionDirSuffix = new Map<string, Project>();

    for (const project of projects) {
      byId.set(project.id, project);

      const primarySuffix = this.normalizeDirSuffix(
        this.sessionDirToSuffix(project.sessionDir),
      );
      if (primarySuffix) {
        bySessionDirSuffix.set(primarySuffix, project);
      }

      for (const mergedDir of project.mergedSessionDirs ?? []) {
        const mergedSuffix = this.normalizeDirSuffix(
          this.sessionDirToSuffix(mergedDir),
        );
        if (mergedSuffix) {
          bySessionDirSuffix.set(mergedSuffix, project);
        }
      }
    }

    return {
      projects,
      byId,
      bySessionDirSuffix,
      timestamp: Date.now(),
    };
  }

  private sessionDirToSuffix(sessionDir: string): string {
    // Claude session dirs can live under the default replica or a configured
    // shared projects root. Codex/Gemini paths are left untouched.
    const source = this.getClaudeSessionSources()
      .filter((candidate) =>
        isLocalPathWithin(sessionDir, candidate.projectsDir),
      )
      .sort((a, b) => b.projectsDir.length - a.projectsDir.length)[0];
    const relative = source
      ? sessionDir.slice(source.projectsDir.length)
      : sessionDir;
    return relative.replace(/^[\\/]+/, "");
  }

  private normalizeDirSuffix(value: string): string {
    return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  }

  private cloneProject(project: Project): Project {
    return {
      ...project,
      isRemoteProject: this.isRemoteProjectPath(project.path),
      mergedSessionDirs: project.mergedSessionDirs
        ? [...project.mergedSessionDirs]
        : undefined,
      hasCodexSessions: project.hasCodexSessions,
      hasGeminiSessions: project.hasGeminiSessions,
      hasOpenCodeSessions: project.hasOpenCodeSessions,
    };
  }

  /**
   * Remote Claude projects are working copies kept in the conventional
   * `projects` directory below a configured executor's shared local root.
   * Derive this from settings so the UI never needs a machine-specific path.
   */
  private isRemoteProjectPath(projectPath: string): boolean {
    return this.remoteExecutors.some((executor) =>
      isLocalPathWithin(projectPath, join(executor.localRoot, "projects")),
    );
  }

  private handleFileChange(event: FileChangeEvent): void {
    if (event.fileType !== "session" && event.fileType !== "agent-session") {
      return;
    }

    // Any session file delta can affect project existence/count/lastActivity.
    this.invalidateCache();
    if (event.provider === "codex") {
      this.codexScanner?.invalidateCache();
    } else if (event.provider === "gemini") {
      this.geminiScanner?.invalidateCache();
    } else if (event.provider === "opencode") {
      this.opencodeScanner?.invalidateCache();
    } else if (event.provider === "kimi") {
      this.kimiScanner?.invalidateCache();
    }
  }

  private async scanProjects(): Promise<Project[]> {
    const projects: Project[] = [];
    const seenPaths = new Set<string>();
    // Map from normalized path to project index for cross-machine dedup
    const normalizedIndex = new Map<string, number>();

    // Helper to add a Claude project, merging cross-machine duplicates
    const addOrMerge = (
      rawProjectPath: string,
      sessionDir: string,
      sessionCount: number,
      lastActivity: string | null,
    ) => {
      const projectPath = canonicalizeProjectPath(rawProjectPath);
      if (seenPaths.has(projectPath)) return; // exact path duplicate
      seenPaths.add(projectPath);

      const normalized = normalizeProjectPathForDedup(projectPath);
      const existingIdx = normalizedIndex.get(normalized);

      if (existingIdx !== undefined) {
        // Cross-machine duplicate — merge into existing project
        const existing = projects[existingIdx];
        if (!existing) return;
        existing.sessionCount += sessionCount;
        if (!existing.mergedSessionDirs) {
          existing.mergedSessionDirs = [];
        }
        existing.mergedSessionDirs.push(sessionDir);
        if (
          lastActivity &&
          (!existing.lastActivity || lastActivity > existing.lastActivity)
        ) {
          existing.lastActivity = lastActivity;
        }

        // Prefer the local path for session creation.
        // Remote executor sessions (rsynced) may store a foreign cwd
        // (e.g., /Users/... on a Linux host). Swap to the local path
        // so new sessions can actually spawn in an existing directory.
        const localHome = homedir();
        const localHomePrefix = `${localHome}/`;
        const localHomePrefixWin = `${localHome}\\`;
        const existingIsLocal =
          existing.path.startsWith(localHomePrefix) ||
          existing.path.startsWith(localHomePrefixWin);
        const newIsLocal =
          projectPath.startsWith(localHomePrefix) ||
          projectPath.startsWith(localHomePrefixWin);
        if (!existingIsLocal && newIsLocal) {
          existing.path = projectPath;
          existing.id = encodeProjectId(projectPath);
          existing.name = basename(projectPath);
        }
      } else {
        normalizedIndex.set(normalized, projects.length);
        projects.push({
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: basename(projectPath),
          sessionCount,
          sessionDir,
          hasCodexSessions: false,
          hasGeminiSessions: false,
          hasOpenCodeSessions: false,
          activeOwnedCount: 0, // populated by route
          activeExternalCount: 0, // populated by route
          lastActivity,
          provider: "claude",
        });
      }
    };

    for (const source of this.getClaudeSessionSources()) {
      // Claude projects roots can have two structures:
      // 1. Projects directly as -home-user-project/
      // 2. Projects under hostname/ as hostname/-home-user-project/
      let dirs: string[] = [];
      try {
        await access(source.projectsDir);
        const entries = await readdir(source.projectsDir, {
          withFileTypes: true,
        });
        dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        continue;
      }

      for (const dir of dirs) {
        const dirPath = join(source.projectsDir, dir);

        // On Unix/macOS: /home/user/project → -home-user-project.
        // On Windows: C:\Users\name\project → c--Users-name-project.
        if (dir.startsWith("-") || /^[a-zA-Z]--/.test(dir)) {
          const info = await this.getProjectDirInfo(dirPath, source);
          if (info) {
            addOrMerge(
              info.projectPath,
              dirPath,
              info.sessionCount,
              info.lastActivity,
            );
          }
          continue;
        }

        // Otherwise, treat it as a hostname directory.
        let projectDirs: string[];
        try {
          const subEntries = await readdir(dirPath, { withFileTypes: true });
          projectDirs = subEntries
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
        } catch {
          continue;
        }

        for (const projectDir of projectDirs) {
          const projectDirPath = join(dirPath, projectDir);
          const info = await this.getProjectDirInfo(projectDirPath, source);
          if (!info) continue;
          addOrMerge(
            info.projectPath,
            projectDirPath,
            info.sessionCount,
            info.lastActivity,
          );
        }
      }
    }

    // Merge Codex projects if enabled
    if (this.codexScanner) {
      const codexProjects = await this.codexScanner.listProjects();
      for (const codexProject of codexProjects) {
        const projectPath = canonicalizeProjectPath(codexProject.path);
        const existing = projects.find(
          (project) => canonicalizeProjectPath(project.path) === projectPath,
        );
        if (existing) {
          existing.hasCodexSessions = true;
          existing.sessionCount += codexProject.sessionCount;
          if (
            codexProject.lastActivity &&
            (!existing.lastActivity ||
              codexProject.lastActivity > existing.lastActivity)
          ) {
            existing.lastActivity = codexProject.lastActivity;
          }
          continue;
        }
        seenPaths.add(projectPath);
        projects.push({
          ...codexProject,
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: basename(projectPath),
          hasCodexSessions: true,
          hasGeminiSessions: false,
          hasOpenCodeSessions: false,
        });
      }
    }

    // Merge Gemini projects if enabled
    if (this.geminiScanner) {
      // Register known paths for hash resolution before scanning
      await this.geminiScanner.registerKnownPaths(Array.from(seenPaths));

      const geminiProjects = await this.geminiScanner.listProjects();
      for (const geminiProject of geminiProjects) {
        const projectPath = canonicalizeProjectPath(geminiProject.path);
        const existing = projects.find(
          (project) => canonicalizeProjectPath(project.path) === projectPath,
        );
        if (existing) {
          existing.hasGeminiSessions = true;
          existing.sessionCount += geminiProject.sessionCount;
          if (
            geminiProject.lastActivity &&
            (!existing.lastActivity ||
              geminiProject.lastActivity > existing.lastActivity)
          ) {
            existing.lastActivity = geminiProject.lastActivity;
          }
          continue;
        }
        seenPaths.add(projectPath);
        projects.push({
          ...geminiProject,
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: basename(projectPath),
          hasCodexSessions: false,
          hasGeminiSessions: true,
          hasOpenCodeSessions: false,
        });
      }
    }

    // Merge OpenCode projects if enabled
    if (this.opencodeScanner) {
      const openCodeProjects = await this.opencodeScanner.listProjects();
      for (const openCodeProject of openCodeProjects) {
        const projectPath = canonicalizeProjectPath(openCodeProject.path);
        const existing = projects.find(
          (project) => canonicalizeProjectPath(project.path) === projectPath,
        );
        if (existing) {
          existing.hasOpenCodeSessions = true;
          existing.sessionCount += openCodeProject.sessionCount;
          if (
            openCodeProject.lastActivity &&
            (!existing.lastActivity ||
              openCodeProject.lastActivity > existing.lastActivity)
          ) {
            existing.lastActivity = openCodeProject.lastActivity;
          }
          continue;
        }
        seenPaths.add(projectPath);
        projects.push({
          ...openCodeProject,
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: basename(projectPath),
          hasCodexSessions: false,
          hasGeminiSessions: false,
          hasOpenCodeSessions: true,
        });
      }
    }

    // Merge Kimi projects if enabled
    if (this.kimiScanner) {
      const kimiProjects = await this.kimiScanner.listProjects();
      for (const kimiProject of kimiProjects) {
        const projectPath = canonicalizeProjectPath(kimiProject.path);
        const existing = projects.find(
          (project) => canonicalizeProjectPath(project.path) === projectPath,
        );
        if (existing) {
          existing.hasKimiSessions = true;
          existing.sessionCount += kimiProject.sessionCount;
          if (
            kimiProject.lastActivity &&
            (!existing.lastActivity ||
              kimiProject.lastActivity > existing.lastActivity)
          ) {
            existing.lastActivity = kimiProject.lastActivity;
          }
          continue;
        }
        seenPaths.add(projectPath);
        projects.push({
          ...kimiProject,
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: basename(projectPath),
          hasCodexSessions: false,
          hasGeminiSessions: false,
          hasOpenCodeSessions: false,
          hasKimiSessions: true,
        });
      }
    }

    // Merge manually added projects (from ProjectMetadataService)
    if (this.projectMetadataService) {
      const addedProjects = this.projectMetadataService.getAllProjects();
      for (const metadata of Object.values(addedProjects)) {
        const projectPath = canonicalizeProjectPath(metadata.path);
        // Skip if we've already seen this path from another source
        if (seenPaths.has(projectPath)) continue;

        // Verify the directory still exists
        try {
          const stats = await stat(projectPath);
          if (!stats.isDirectory()) continue;
        } catch {
          // Directory no longer exists, skip it
          continue;
        }

        seenPaths.add(projectPath);
        projects.push({
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: basename(projectPath),
          sessionCount: 0,
          sessionDir: this.getClaudeSessionDirForProject(projectPath),
          hasCodexSessions: false,
          hasGeminiSessions: false,
          hasOpenCodeSessions: false,
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: metadata.addedAt,
          provider: "claude",
        });
      }
    }

    // Fallback: if no projects were found from any source, include the user's
    // home directory so sessions can always be created even if detection is broken
    if (projects.length === 0) {
      const home = homedir();
      projects.push({
        id: encodeProjectId(home),
        path: home,
        name: basename(home) || "Home",
        sessionCount: 0,
        sessionDir: this.getClaudeSessionDirForProject(home),
        hasCodexSessions: false,
        hasGeminiSessions: false,
        hasOpenCodeSessions: false,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "claude",
      });
    }

    return projects;
  }

  async getProject(projectId: string): Promise<Project | null> {
    const snapshot = await this.getSnapshot();
    const project = snapshot.byId.get(projectId);
    return project ? this.cloneProject(project) : null;
  }

  /**
   * Get a project by ID, or create a virtual project entry if the path exists on disk
   * but hasn't been used with Claude yet.
   *
   * This allows starting sessions in new directories without requiring prior Claude usage.
   */
  async getOrCreateProject(
    projectId: string,
    preferredProvider?: "claude" | "codex" | "gemini" | "opencode",
  ): Promise<Project | null> {
    let resolvedProjectId = projectId;

    // First check if project already exists
    const existing = await this.getProject(resolvedProjectId);
    if (existing) return existing;

    // Decode the projectId to get the path
    let projectPath: string;
    try {
      projectPath = decodeProjectId(resolvedProjectId as UrlProjectId);
    } catch {
      return null;
    }

    const canonicalProjectPath = canonicalizeProjectPath(projectPath);
    if (canonicalProjectPath !== projectPath) {
      const canonicalId = encodeProjectId(canonicalProjectPath);
      const canonicalProject = await this.getProject(canonicalId);
      if (canonicalProject) {
        return canonicalProject;
      }
      projectPath = canonicalProjectPath;
      resolvedProjectId = canonicalId;
    }

    // Validate path is absolute
    if (!isAbsolutePath(projectPath)) {
      return null;
    }

    // Check if the directory exists on disk
    try {
      const stats = await stat(projectPath);
      if (!stats.isDirectory()) {
        return null;
      }
    } catch {
      return null;
    }

    // Determine provider: use preferred if specified, otherwise check for Codex/Gemini sessions
    let provider: ProviderName = preferredProvider ?? DEFAULT_PROVIDER;
    if (!preferredProvider) {
      // Check if Codex sessions exist for this path
      if (this.codexScanner) {
        const codexSessions =
          await this.codexScanner.getSessionsForProject(projectPath);
        if (codexSessions.length > 0) {
          provider = "codex";
        }
      }

      // Check if Gemini sessions exist for this path (only if no Codex sessions)
      if (provider === "claude" && this.geminiScanner) {
        const geminiSessions =
          await this.geminiScanner.getSessionsForProject(projectPath);
        if (geminiSessions.length > 0) {
          provider = "gemini";
        }
      }

      // Check if OpenCode sessions exist for this path (only if no Codex/Gemini sessions)
      if (provider === "claude" && this.opencodeScanner) {
        const openCodeSessions =
          await this.opencodeScanner.getSessionsForProject(projectPath);
        if (openCodeSessions.length > 0) {
          provider = "opencode";
        }
      }

      // Check if Kimi sessions exist (only if no Codex/Gemini/OpenCode sessions)
      if (provider === "claude" && this.kimiScanner) {
        const kimiSessions =
          await this.kimiScanner.getSessionsForProject(projectPath);
        if (kimiSessions.length > 0) {
          provider = "kimi";
        }
      }
    }

    // Create a virtual project entry
    // The session directory will be created by the SDK when the first session starts
    // Determine the session directory based on provider
    let sessionDir: string;
    if (provider === "codex") {
      sessionDir = CODEX_SESSIONS_DIR;
    } else if (provider === "gemini") {
      sessionDir = GEMINI_TMP_DIR;
    } else if (provider === "opencode") {
      sessionDir = OPENCODE_DB_PATH;
    } else if (provider === "kimi") {
      sessionDir = KIMI_SESSIONS_DIR;
    } else {
      sessionDir = this.getClaudeSessionDirForProject(projectPath);
    }

    return this.cloneProject({
      id: resolvedProjectId as UrlProjectId,
      path: projectPath,
      name: basename(projectPath),
      sessionCount: 0,
      sessionDir,
      hasCodexSessions: provider === "codex",
      hasGeminiSessions: provider === "gemini",
      hasOpenCodeSessions: provider === "opencode",
      hasKimiSessions: provider === "kimi",
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider,
    });
  }

  /**
   * Find a project by matching the session directory suffix.
   *
   * This is used by ExternalSessionTracker which extracts the directory-based
   * project identifier from file paths (e.g., "-home-user-project" or
   * "hostname/-home-user-project") rather than the base64url-encoded projectId.
   */
  async getProjectBySessionDirSuffix(
    dirSuffix: string,
  ): Promise<Project | null> {
    const snapshot = await this.getSnapshot();
    const normalizedSuffix = this.normalizeDirSuffix(dirSuffix);
    const project = snapshot.bySessionDirSuffix.get(normalizedSuffix);
    return project ? this.cloneProject(project) : null;
  }

  dispose(): void {
    this.unsubscribeEventBus?.();
    this.unsubscribeEventBus = null;
  }

  /**
   * Get project info from a session directory in a single readdir pass.
   * Uses directory mtime as a cheap proxy for lastActivity (one stat
   * on the dir itself instead of stat-ing every session file).
   */
  private async getProjectDirInfo(
    projectDirPath: string,
    source: ClaudeSessionSource,
  ): Promise<{
    projectPath: string;
    sessionCount: number;
    lastActivity: string | null;
  } | null> {
    try {
      const files = await readdir(projectDirPath);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      if (jsonlFiles.length === 0) return null;

      // Count non-agent sessions
      const sessionCount = jsonlFiles.filter(
        (f) => !f.startsWith("agent-"),
      ).length;

      // Sort jsonl files by mtime descending. The newest file carries the
      // most recent `cwd` the SDK wrote — older jsonls may still record the
      // project's original location from before the user moved it on disk.
      // Reading any older one would let a stale path leak into the project
      // snapshot's id/path fields. Stat-ing N files is cheap (≈50µs each).
      const withMtime: Array<{ file: string; mtime: number }> = [];
      for (const file of jsonlFiles) {
        try {
          const s = await stat(join(projectDirPath, file));
          withMtime.push({ file, mtime: s.mtimeMs });
        } catch {
          // Skip files we can't stat (deleted between readdir and stat)
        }
      }
      withMtime.sort((a, b) => b.mtime - a.mtime);
      const lastActivity = withMtime[0]
        ? new Date(withMtime[0].mtime).toISOString()
        : null;

      for (const { file } of withMtime) {
        const filePath = join(projectDirPath, file);
        const cwd = await readCwdFromSessionFile(filePath);
        if (cwd) {
          const projectPath = source.executor
            ? (tryMapRemotePathToLocal(cwd, source.executor) ?? cwd)
            : cwd;
          return { projectPath, sessionCount, lastActivity };
        }
      }

      return null;
    } catch {
      return null;
    }
  }
}

// Singleton for convenience
export const projectScanner = new ProjectScanner();
