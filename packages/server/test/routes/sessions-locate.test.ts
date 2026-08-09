import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  type SessionsDeps,
  createSessionsRoutes,
} from "../../src/routes/sessions.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project } from "../../src/supervisor/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function createProject(sessionDir: string): Project {
  const path = "/Users/someone/work/alpha";
  return {
    id: encodeProjectId(path),
    path,
    name: "alpha",
    sessionCount: 1,
    sessionDir,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

function createRoutes(overrides: Partial<SessionsDeps>) {
  return createSessionsRoutes({
    supervisor: {} as SessionsDeps["supervisor"],
    scanner: {
      listProjects: vi.fn(async () => []),
    } as unknown as SessionsDeps["scanner"],
    readerFactory: vi.fn(() => ({}) as unknown as ISessionReader),
    ...overrides,
  });
}

describe("GET /sessions/:sessionId/locate", () => {
  it("resolves a bare session id to its project", async () => {
    const sessionDir = join(tmpdir(), `locate-route-${randomUUID()}`);
    await mkdir(sessionDir, { recursive: true });
    tempDirs.push(sessionDir);
    await writeFile(join(sessionDir, "ses_here.jsonl"), "{}\n");

    const project = createProject(sessionDir);
    const routes = createRoutes({
      scanner: {
        listProjects: vi.fn(async () => [project]),
      } as unknown as SessionsDeps["scanner"],
    });

    const response = await routes.request("/sessions/ses_here/locate");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session: {
        sessionId: "ses_here",
        requestedSessionId: "ses_here",
        provider: "claude",
        projectId: project.id,
        projectPath: project.path,
        projectName: "alpha",
        source: "claude-file",
        archived: false,
      },
    });
  });

  it("returns 404 when nothing claims the session", async () => {
    const response = await createRoutes({}).request(
      "/sessions/ses_missing/locate",
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Session not found",
    });
  });

  it("resolves an opaque Feishu card reference through the durable inbox", async () => {
    const sessionDir = join(tmpdir(), `locate-route-${randomUUID()}`);
    await mkdir(sessionDir, { recursive: true });
    tempDirs.push(sessionDir);
    await writeFile(join(sessionDir, "ses_from_feishu.jsonl"), "{}\n");
    const project = createProject(sessionDir);
    const turnReference = "feishu-0123456789abcdef0123456789abcdef";
    const routes = createRoutes({
      feishuInbox: {
        findByTempId: vi.fn(() => ({ sessionId: "ses_from_feishu" })),
      } as unknown as SessionsDeps["feishuInbox"],
      scanner: {
        listProjects: vi.fn(async () => [project]),
      } as unknown as SessionsDeps["scanner"],
    });

    const response = await routes.request(`/sessions/${turnReference}/locate`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      session: {
        sessionId: "ses_from_feishu",
        requestedSessionId: turnReference,
        projectId: project.id,
      },
    });
  });

  it("does not scan providers for an unknown opaque Feishu reference", async () => {
    const listProjects = vi.fn(async () => []);
    const routes = createRoutes({
      feishuInbox: {
        findByTempId: vi.fn(() => undefined),
      } as unknown as SessionsDeps["feishuInbox"],
      scanner: { listProjects } as unknown as SessionsDeps["scanner"],
    });

    const response = await routes.request(
      "/sessions/feishu-ffffffffffffffffffffffffffffffff/locate",
    );

    expect(response.status).toBe(404);
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("returns 404 rather than touching disk for unsafe ids", async () => {
    const listProjects = vi.fn(async () => []);
    const routes = createRoutes({
      scanner: { listProjects } as unknown as SessionsDeps["scanner"],
    });

    const response = await routes.request(
      `/sessions/${encodeURIComponent("../../etc/passwd")}/locate`,
    );

    expect(response.status).toBe(404);
    expect(listProjects).not.toHaveBeenCalled();
  });
});
