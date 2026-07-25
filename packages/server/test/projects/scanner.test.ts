import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSessionScanner } from "../../src/projects/codex-scanner.js";
import type { OpenCodeSessionScanner } from "../../src/projects/opencode-scanner.js";
import { ProjectScanner } from "../../src/projects/scanner.js";
import { encodeProjectId } from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/EventBus.js";

function encodePath(path: string): string {
  return path.replace(/[/\\:]/g, "-");
}

async function createClaudeProject(
  projectsDir: string,
  host: string,
  projectPath: string,
  sessionId: string,
): Promise<string> {
  const encodedPath = encodePath(projectPath);
  const sessionDir = join(projectsDir, host, encodedPath);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `${sessionId}.jsonl`),
    `{"type":"user","cwd":"${projectPath}","message":{"content":"hello"}}\n`,
  );
  return join(host, encodedPath).replace(/\\/g, "/");
}

describe("ProjectScanner missing projectsDir", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("still discovers Codex sessions when ~/.claude/projects is missing", async () => {
    const nonExistentDir = join(
      tmpdir(),
      `project-scanner-missing-${randomUUID()}`,
    );
    // Don't create it — it should not exist

    const codexDir = join(tmpdir(), `codex-sessions-${randomUUID()}`);
    tempDirs.push(codexDir);
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, "rollout-test.jsonl"),
      `{"type":"session_meta","payload":{"id":"test-session","cwd":"/home/user/codex-project","timestamp":"2025-01-01T00:00:00Z"}}\n`,
    );

    const scanner = new ProjectScanner({
      projectsDir: nonExistentDir,
      codexSessionsDir: codexDir,
      enableCodex: true,
      enableGemini: false,
      enableOpenCode: false,
      enableKimi: false,
    });

    const projects = await scanner.listProjects();
    // Should find at least the Codex session (possibly plus a home fallback)
    const codexProjects = projects.filter((p) => p.provider === "codex");
    expect(codexProjects.length).toBeGreaterThanOrEqual(1);
  });
});

describe("ProjectScanner cache", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("reuses snapshot results until invalidated", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      enableOpenCode: false,
      enableKimi: false,
      cacheTtlMs: 60000,
    });

    const first = await scanner.listProjects();
    expect(first).toHaveLength(1);

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-two",
      "sess-2",
    );

    const cached = await scanner.listProjects();
    expect(cached).toHaveLength(1);

    scanner.invalidateCache();
    const refreshed = await scanner.listProjects();
    expect(refreshed).toHaveLength(2);
  });

  it("coalesces concurrent scans into one in-flight refresh", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      enableOpenCode: false,
      enableKimi: false,
      cacheTtlMs: 0,
    });

    const spy = vi.spyOn(
      scanner as unknown as {
        getProjectDirInfo: (projectDirPath: string) => Promise<unknown>;
      },
      "getProjectDirInfo",
    );

    await Promise.all([
      scanner.listProjects(),
      scanner.listProjects(),
      scanner.listProjects(),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("invalidates snapshot from watcher file-change events", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    const eventBus = new EventBus();

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      enableOpenCode: false,
      enableKimi: false,
      cacheTtlMs: 60000,
      eventBus,
    });

    await scanner.listProjects();

    const secondSuffix = await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-two",
      "sess-2",
    );

    const beforeEvent =
      await scanner.getProjectBySessionDirSuffix(secondSuffix);
    expect(beforeEvent).toBeNull();

    eventBus.emit({
      type: "file-change",
      provider: "claude",
      path: join(projectsDir, secondSuffix, "sess-2.jsonl"),
      relativePath: `${secondSuffix}/sess-2.jsonl`,
      changeType: "create",
      timestamp: new Date().toISOString(),
      fileType: "session",
    });

    const afterEvent = await scanner.getProjectBySessionDirSuffix(secondSuffix);
    expect(afterEvent?.id).toBe(encodeProjectId("/home/user/project-two"));
  });

  it("marks claude projects that also have codex sessions", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    vi.spyOn(CodexSessionScanner.prototype, "listProjects").mockResolvedValue([
      {
        id: encodeProjectId("/home/user/project-one"),
        path: "/home/user/project-one",
        name: "project-one",
        sessionCount: 3,
        sessionDir: "/codex/sessions",
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: "2025-01-01T00:00:00.000Z",
        provider: "codex",
      },
    ]);

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: true,
      enableGemini: false,
      enableOpenCode: false,
      enableKimi: false,
      cacheTtlMs: 60000,
    });

    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.provider).toBe("claude");
    expect(projects[0]).toMatchObject({
      path: "/home/user/project-one",
      hasCodexSessions: true,
    });
  });

  it("invalidates shared codex scanner cache on codex file-change events", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    const eventBus = new EventBus();

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    const codexProject = {
      id: encodeProjectId("/home/user/project-one"),
      path: "/home/user/project-one",
      name: "project-one",
      sessionCount: 1,
      sessionDir: "/codex/sessions",
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: "2025-01-01T00:00:00.000Z",
      provider: "codex" as const,
    };
    let nextProjects: (typeof codexProject)[] = [];
    let cachedProjects: (typeof codexProject)[] | null = null;
    const codexScanner = {
      listProjects: vi.fn(async () => {
        if (cachedProjects) return cachedProjects;
        cachedProjects = [...nextProjects];
        return cachedProjects;
      }),
      invalidateCache: vi.fn(() => {
        cachedProjects = null;
      }),
    } as unknown as CodexSessionScanner;

    const scanner = new ProjectScanner({
      projectsDir,
      codexScanner,
      enableCodex: true,
      enableGemini: false,
      enableOpenCode: false,
      enableKimi: false,
      cacheTtlMs: 60000,
      eventBus,
    });

    const initialProjects = await scanner.listProjects();
    expect(initialProjects[0]).toMatchObject({
      path: "/home/user/project-one",
      hasCodexSessions: false,
    });

    nextProjects = [codexProject];
    eventBus.emit({
      type: "file-change",
      provider: "codex",
      path: "/codex/sessions/2025/01/01/rollout-1.jsonl",
      relativePath: "2025/01/01/rollout-1.jsonl",
      changeType: "create",
      timestamp: new Date().toISOString(),
      fileType: "session",
    });

    const refreshedProjects = await scanner.listProjects();
    expect(codexScanner.invalidateCache).toHaveBeenCalledTimes(1);
    expect(refreshedProjects[0]).toMatchObject({
      path: "/home/user/project-one",
      hasCodexSessions: true,
    });
  });

  it("invalidates OpenCode project caches on database reconcile events", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    const eventBus = new EventBus();
    const projectPath = "/home/user/external-opencode-project";
    const projectId = encodeProjectId(projectPath);
    const opencodeProject = {
      id: projectId,
      path: projectPath,
      name: "external-opencode-project",
      sessionCount: 1,
      sessionDir: "/tmp/opencode.db",
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: "2026-07-15T00:00:00.000Z",
      provider: "opencode" as const,
    };
    let nextProjects: (typeof opencodeProject)[] = [];
    let cachedProjects: (typeof opencodeProject)[] | null = null;
    const opencodeScanner = {
      listProjects: vi.fn(async () => {
        if (cachedProjects) return cachedProjects;
        cachedProjects = [...nextProjects];
        return cachedProjects;
      }),
      invalidateCache: vi.fn(() => {
        cachedProjects = null;
      }),
    } as unknown as OpenCodeSessionScanner;

    const scanner = new ProjectScanner({
      projectsDir,
      opencodeScanner,
      enableCodex: false,
      enableGemini: false,
      enableOpenCode: true,
      cacheTtlMs: 60_000,
      eventBus,
    });

    expect(await scanner.getProject(projectId)).toBeNull();
    nextProjects = [opencodeProject];

    eventBus.emit({
      type: "session-updated",
      trigger: "opencode-db-reconcile",
      sessionId: "ses_external_cli",
      projectId,
      updatedAt: "2026-07-15T00:00:00.000Z",
      timestamp: "2026-07-15T00:00:00.000Z",
    });

    expect(await scanner.getProject(projectId)).toMatchObject({
      path: projectPath,
      provider: "opencode",
    });
    expect(opencodeScanner.invalidateCache).toHaveBeenCalledOnce();
  });
});

describe("ProjectScanner stale-cwd recovery", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("uses cwd from the most recently modified jsonl, ignoring stale ones", async () => {
    // Reproduces the real-world bug: a project moved on disk leaves a
    // session directory with a mix of jsonls — older ones still record the
    // old cwd, newer ones record the new cwd. Scanner must pick the newest
    // jsonl's cwd; otherwise it surfaces a stale projectId/path that crashes
    // spawn() with ENOENT.
    const projectsDir = join(tmpdir(), `scanner-stale-${randomUUID()}`);
    tempDirs.push(projectsDir);

    // The jsonls live in the dir whose name encodes the *new* path,
    // because Claude SDK writes new jsonls there after the move.
    const newPath = "/Users/test/code/myproject";
    const stalePath = "/Users/test/Desktop/myproject";
    const sessionDir = join(projectsDir, encodePath(newPath));
    await mkdir(sessionDir, { recursive: true });

    // Older jsonl records the stale cwd.
    const staleFile = join(sessionDir, "00-old.jsonl");
    await writeFile(
      staleFile,
      `{"type":"user","cwd":"${stalePath}","message":{"content":"old"}}\n`,
    );
    // Backdate it by 1 hour
    const oneHourAgo = new Date(Date.now() - 3_600_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(staleFile, oneHourAgo, oneHourAgo);

    // Newer jsonl records the real cwd.
    const freshFile = join(sessionDir, "99-new.jsonl");
    await writeFile(
      freshFile,
      `{"type":"user","cwd":"${newPath}","message":{"content":"new"}}\n`,
    );

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      enableOpenCode: false,
      enableKimi: false,
    });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      path: newPath,
      id: encodeProjectId(newPath),
    });
  });
});

describe("ProjectScanner shared Claude storage", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("maps a shared JSONL remote cwd to the local project without rewriting it", async () => {
    const localRoot = join(tmpdir(), `scanner-shared-${randomUUID()}`);
    const projectsDir = join(localRoot, "claude", "projects");
    const fallbackDir = join(localRoot, "local-replica");
    const localProject = join(localRoot, "projects", "demo");
    const remoteProject = "/mnt/utm/projects/demo";
    const sessionDir = join(projectsDir, encodePath(remoteProject));
    const sessionFile = join(sessionDir, "shared-session.jsonl");
    tempDirs.push(localRoot);
    await mkdir(sessionDir, { recursive: true });
    await mkdir(localProject, { recursive: true });
    const original = `${JSON.stringify({
      type: "user",
      cwd: remoteProject,
      message: { content: "keep /mnt/utm in the transcript" },
    })}\n`;
    await writeFile(sessionFile, original);

    const scanner = new ProjectScanner({
      projectsDir: fallbackDir,
      remoteExecutors: [
        {
          host: "utm",
          localRoot,
          remoteRoot: "/mnt/utm",
          sessionStorage: {
            mode: "shared",
            localProjectsDir: projectsDir,
            remoteProjectsDir: "/mnt/utm/claude/projects",
          },
        },
      ],
      enableCodex: false,
      enableGemini: false,
      enableOpenCode: false,
      enableKimi: false,
    });

    await expect(scanner.listProjects()).resolves.toEqual([
      expect.objectContaining({
        id: encodeProjectId(localProject),
        path: localProject,
        sessionDir,
        sessionCount: 1,
        isRemoteProject: true,
      }),
    ]);
    await expect(
      import("node:fs/promises").then(({ readFile }) =>
        readFile(sessionFile, "utf8"),
      ),
    ).resolves.toBe(original);
  });

  it("uses the remote cwd encoding for a new virtual shared project", async () => {
    const localRoot = join(tmpdir(), `scanner-shared-${randomUUID()}`);
    const projectsDir = join(localRoot, "claude", "projects");
    const localProject = join(localRoot, "projects", "new demo");
    tempDirs.push(localRoot);
    await mkdir(projectsDir, { recursive: true });
    await mkdir(localProject, { recursive: true });

    const scanner = new ProjectScanner({
      projectsDir: join(localRoot, "local-replica"),
      remoteExecutors: [
        {
          host: "utm",
          localRoot,
          remoteRoot: "/mnt/utm",
          sessionStorage: {
            mode: "shared",
            localProjectsDir: projectsDir,
            remoteProjectsDir: "/mnt/utm/claude/projects",
          },
        },
      ],
      enableCodex: false,
      enableGemini: false,
      enableOpenCode: false,
      enableKimi: false,
    });

    await expect(
      scanner.getOrCreateProject(encodeProjectId(localProject), "claude"),
    ).resolves.toMatchObject({
      path: localProject,
      sessionDir: join(projectsDir, encodePath("/mnt/utm/projects/new demo")),
      isRemoteProject: true,
    });
  });

  it("marks only same-name copies inside the configured remote projects root", async () => {
    const localRoot = join(tmpdir(), `scanner-shared-${randomUUID()}`);
    const remoteCopy = join(localRoot, "projects", "yepanywhere");
    const localCopy = join(localRoot, "work", "yepanywhere");
    tempDirs.push(localRoot);
    await Promise.all([
      mkdir(remoteCopy, { recursive: true }),
      mkdir(localCopy, { recursive: true }),
    ]);

    const scanner = new ProjectScanner({
      projectsDir: join(localRoot, "claude", "projects"),
      remoteExecutors: [
        {
          host: "utm",
          localRoot,
          remoteRoot: "/mnt/utm",
        },
      ],
      enableCodex: false,
      enableGemini: false,
      enableOpenCode: false,
      enableKimi: false,
    });

    await expect(
      scanner.getOrCreateProject(encodeProjectId(remoteCopy), "claude"),
    ).resolves.toMatchObject({
      name: "yepanywhere",
      isRemoteProject: true,
    });
    await expect(
      scanner.getOrCreateProject(encodeProjectId(localCopy), "claude"),
    ).resolves.toMatchObject({
      name: "yepanywhere",
      isRemoteProject: false,
    });
  });
});
