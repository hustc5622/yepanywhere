import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  type SessionsDeps,
  createSessionsRoutes,
} from "../../src/routes/sessions.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";

/**
 * The File row in "copy session info" is the only reason this route exists:
 * an agent on another machine cannot open a UI link, and the client cannot
 * derive the path because each provider has its own layout.
 */
describe("GET /projects/:projectId/sessions/:sessionId/source-file", () => {
  let testDir: string;
  let project: Project;

  const readerWith = (path: string | null): ISessionReader =>
    ({
      getSessionSummary: vi.fn(
        async (): Promise<SessionSummary | null> => null,
      ),
      getSession: vi.fn(async () => null),
      getSessionSummaryIfChanged: vi.fn(async () => null),
      getAgentMappings: vi.fn(async () => []),
      getAgentSession: vi.fn(async () => null),
      listSessions: vi.fn(async () => []),
      getSessionFilePath: vi.fn(async () => path),
    }) as unknown as ISessionReader;

  const makeRoutes = (
    reader: ISessionReader,
    deps: Partial<SessionsDeps> = {},
  ) =>
    createSessionsRoutes({
      supervisor: {} as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async (id: string) =>
          id === project.id ? project : null,
        ),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: () => reader,
      ...deps,
    });

  const requestPath = (projectId: string, sessionId: string) =>
    `/projects/${projectId}/sessions/${sessionId}/source-file`;

  beforeEach(async () => {
    testDir = join(tmpdir(), `source-file-route-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    const projectPath = "/test/source-file";
    project = {
      id: encodeProjectId(projectPath),
      path: projectPath,
      name: "source-file",
      sessionDir: join(testDir, "claude"),
      provider: "pi",
      sessionCount: 1,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it("returns the path the owning reader reports", async () => {
    const path = join(testDir, "2026-05-01T10-00-00_abc.jsonl");
    await writeFile(path, "{}\n");
    const routes = makeRoutes(readerWith(path));

    const response = await routes.request(requestPath(project.id, "abc"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ path });
  });

  it("falls back to the Claude <dir>/<id>.jsonl layout", async () => {
    await mkdir(project.sessionDir, { recursive: true });
    const path = join(project.sessionDir, "abc.jsonl");
    await writeFile(path, "{}\n");
    const routes = makeRoutes(readerWith(null));

    const response = await routes.request(requestPath(project.id, "abc"));
    await expect(response.json()).resolves.toEqual({ path });
  });

  it("reports null rather than a path that does not exist", async () => {
    // The reader cannot name the file and no convention matches: printing
    // `<dir>/<id>.jsonl` anyway would send the receiving agent to a missing file.
    const routes = makeRoutes(readerWith(null));

    const response = await routes.request(requestPath(project.id, "abc"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ path: null });
  });

  it("marks the file as living on a remote executor", async () => {
    const localRoot = join(testDir, "UTM");
    const path = join(localRoot, "claude/projects/-x/abc.jsonl");
    const routes = makeRoutes(readerWith(path), {
      serverSettingsService: {
        getSetting: (key: string) =>
          key === "remoteExecutors"
            ? [
                {
                  host: "192.168.64.4",
                  localRoot,
                  remoteRoot: "/mnt/utm",
                },
              ]
            : undefined,
      } as unknown as SessionsDeps["serverSettingsService"],
    });

    const response = await routes.request(requestPath(project.id, "abc"));
    await expect(response.json()).resolves.toEqual({
      path,
      remoteHost: "192.168.64.4",
    });
  });

  it("rejects a session id that could escape the session directory", async () => {
    const routes = makeRoutes(readerWith("/tmp/s.jsonl"));
    const response = await routes.request(
      requestPath(project.id, encodeURIComponent("../etc/passwd")),
    );
    expect(response.status).toBe(400);
  });
});
