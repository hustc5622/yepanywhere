import type {
  ProjectGitStatusSummary,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { GitRemoteFetcher } from "../../src/git-remote-fetch.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createProjectsRoutes } from "../../src/routes/projects.js";
import type { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";

function createProject(): Project {
  return {
    id: "proj-1" as UrlProjectId,
    path: "/tmp/project",
    name: "project",
    sessionCount: 1,
    sessionDir: "/tmp/project/.claude-sessions",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

function createSummary(): SessionSummary {
  return {
    id: "sess-1",
    projectId: "proj-1" as UrlProjectId,
    title: "Codex project session",
    fullTitle: "Codex project session",
    createdAt: new Date("2026-03-10T09:45:00.000Z").toISOString(),
    updatedAt: new Date("2026-03-10T09:46:00.000Z").toISOString(),
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "codex",
  };
}

describe("Projects Routes", () => {
  it("includes git status summaries in the project list", async () => {
    const project = createProject();
    const gitStatus: ProjectGitStatusSummary = {
      isGitRepo: true,
      branch: "main",
      head: "abc1234",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      isClean: false,
      stagedCount: 1,
      unstagedCount: 2,
      deletedCount: 0,
      untrackedCount: 3,
      conflictedCount: 0,
      stashCount: 1,
    };
    const gitStatusProvider = vi.fn(async () => gitStatus);

    const routes = createProjectsRoutes({
      scanner: {
        listProjects: vi.fn(async () => [project]),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(() => ({}) as ISessionReader),
      gitStatusProvider,
    });

    const response = await routes.request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("server-timing")).toContain(
      "projectLookup;dur=",
    );
    expect(response.headers.get("server-timing")).toContain("bridgeView;dur=");

    const json = await response.json();
    expect(gitStatusProvider).toHaveBeenCalledWith(project);
    expect(json.projects[0]).toMatchObject({
      id: project.id,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      gitStatus,
    });
  });

  it("fetches git remotes on request and surfaces fetch errors in the list", async () => {
    const project = createProject();
    const runFetch = vi.fn(async () => {
      throw Object.assign(new Error("exit 128"), {
        stderr: "fatal: could not read Username for 'https://example.com'\n",
      });
    });
    const gitRemoteFetcher = new GitRemoteFetcher({
      resolveRepo: async () => ({
        commonDir: "/tmp/project/.git",
        remotes: ["origin"],
      }),
      runFetch,
    });
    const gitStatusProvider = vi.fn(
      async (): Promise<ProjectGitStatusSummary> => ({
        isGitRepo: true,
        branch: "main",
        head: "abc1234",
        upstream: "origin/main",
        ahead: 0,
        behind: 2,
        isClean: true,
        stagedCount: 0,
        unstagedCount: 0,
        deletedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
        stashCount: 0,
      }),
    );
    const routes = createProjectsRoutes({
      scanner: {
        listProjects: vi.fn(async () => [project]),
        getProject: vi.fn(async (id: string) =>
          id === project.id ? project : null,
        ),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(() => ({}) as ISessionReader),
      gitStatusProvider,
      gitRemoteFetcher,
    });

    const response = await routes.request("/git/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectIds: [project.id, "missing"] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [
        {
          projectId: project.id,
          status: "failed",
          error: "fatal: could not read Username for 'https://example.com'",
        },
        { projectId: "missing", status: "not-git" },
      ],
    });
    expect(runFetch).toHaveBeenCalledWith("/tmp/project", null);

    const list = await (await routes.request("/")).json();
    expect(list.projects[0].gitStatus).toMatchObject({
      behind: 2,
      fetchError: "fatal: could not read Username for 'https://example.com'",
    });
  });

  it("rejects malformed git fetch requests", async () => {
    const routes = createProjectsRoutes({
      scanner: {} as unknown as ProjectScanner,
      readerFactory: vi.fn(() => ({}) as ISessionReader),
    });
    const bad = await routes.request("/git/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectIds: "nope" }),
    });
    expect(bad.status).toBe(400);
    const invalidId = await routes.request("/git/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectIds: ["../etc"] }),
    });
    expect(invalidId.status).toBe(400);
  });

  it("lists mixed-provider sessions through the shared provider resolver", async () => {
    const project = createProject();
    const summary = createSummary();
    const claudeReader = {
      listSessions: vi.fn(async () => []),
    } as unknown as ISessionReader;
    const codexReader = {
      listSessions: vi.fn(async () => [summary]),
    } as unknown as ISessionReader;

    const routes = createProjectsRoutes({
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(() => claudeReader),
      codexScanner: {
        listProjects: vi.fn(async () => [{ ...project, provider: "codex" }]),
      } as unknown as NonNullable<
        Parameters<typeof createProjectsRoutes>[0]["codexScanner"]
      >,
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: vi.fn(
        () => codexReader as unknown as CodexSessionReader,
      ),
    });

    const response = await routes.request("/proj-1/sessions");
    expect(response.status).toBe(200);
    expect(response.headers.get("server-timing")).toContain("catalog;dur=");
    expect(response.headers.get("server-timing")).toContain("sessionScan;dur=");

    const json = await response.json();
    expect(json.sessions).toHaveLength(1);
    expect(json.sessions[0]).toMatchObject({
      id: "sess-1",
      title: "Codex project session",
      provider: "codex",
    });
  });

  it("does not re-add an owned edit-fork member hidden by family collapse", async () => {
    const project = createProject();
    const source = createSummary();
    const olderFork: SessionSummary = {
      ...createSummary(),
      id: "sess-fork-a",
      forkParentSessionId: "sess-1",
      updatedAt: new Date("2026-03-10T09:47:00.000Z").toISOString(),
    };
    const newerFork: SessionSummary = {
      ...createSummary(),
      id: "sess-fork-b",
      forkParentSessionId: "sess-1",
      updatedAt: new Date("2026-03-10T09:48:00.000Z").toISOString(),
    };
    const codexReader = {
      listSessions: vi.fn(async () => [source, olderFork, newerFork]),
    } as unknown as ISessionReader;
    const routes = createProjectsRoutes({
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(
        () => ({ listSessions: async () => [] }) as unknown as ISessionReader,
      ),
      codexScanner: {
        listProjects: vi.fn(async () => [{ ...project, provider: "codex" }]),
      } as unknown as NonNullable<
        Parameters<typeof createProjectsRoutes>[0]["codexScanner"]
      >,
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: vi.fn(
        () => codexReader as unknown as CodexSessionReader,
      ),
      // The older fork's process is still alive after the newer edit.
      supervisor: {
        getAllProcesses: () => [
          {
            id: "proc-a",
            sessionId: "sess-fork-a",
            projectId: project.id,
            startedAt: new Date("2026-03-10T09:47:00.000Z"),
            permissionMode: "default",
            modeVersion: 0,
            provider: "codex",
            state: { type: "idle" },
            getPendingInputRequest: () => null,
          },
        ],
      } as unknown as NonNullable<
        Parameters<typeof createProjectsRoutes>[0]["supervisor"]
      >,
    });

    const json = await (await routes.request("/proj-1/sessions")).json();
    expect(json.sessions.map((session: { id: string }) => session.id)).toEqual([
      "sess-fork-b",
    ]);
  });
});
