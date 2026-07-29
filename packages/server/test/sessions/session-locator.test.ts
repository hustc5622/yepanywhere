import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionArchiveService } from "../../src/archive/SessionArchiveService.js";
import type { BridgeController } from "../../src/bridge-common/types.js";
import type { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { invalidateCodexSessionManifest } from "../../src/sessions/codex-session-manifest.js";
import type { GeminiSessionReader } from "../../src/sessions/gemini-reader.js";
import {
  type SessionLocatorDeps,
  locateSession,
} from "../../src/sessions/session-locator.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project } from "../../src/supervisor/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function createProject(overrides: Partial<Project> = {}): Project {
  const path = overrides.path ?? "/Users/someone/work/alpha";
  return {
    id: encodeProjectId(path),
    path,
    name: "alpha",
    sessionCount: 0,
    sessionDir: "/nonexistent",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
    ...overrides,
  };
}

/** Deps with every lookup switched off, so each test opts into exactly one. */
function baseDeps(
  overrides: Partial<SessionLocatorDeps> = {},
): SessionLocatorDeps {
  return {
    scanner: {
      listProjects: vi.fn(async () => []),
    } as unknown as ProjectScanner,
    readerFactory: vi.fn(
      () =>
        ({
          getSessionSummary: vi.fn(async () => null),
        }) as unknown as ISessionReader,
    ),
    ...overrides,
  };
}

function bridge(
  sessions: Array<{ id: string; projectPath: string }>,
): BridgeController {
  return {
    listSessions: vi.fn(async () =>
      sessions.map((session) => ({
        ...session,
        projectId: encodeProjectId(session.projectPath),
        projectName: "alpha",
        title: null,
        fullTitle: null,
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
        messageCount: 1,
      })),
    ),
  } as unknown as BridgeController;
}

interface TestSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): void };
  close(): void;
}

async function createOpenCodeDb(
  rows: Array<{ id: string; directory: string }>,
): Promise<string | null> {
  const specifier: string = "node:sqlite";
  const sqlite = await import(specifier)
    .then(
      (mod) =>
        (
          mod as {
            DatabaseSync?: new (path: string) => TestSqliteDatabase;
          }
        ).DatabaseSync ?? null,
    )
    .catch(() => null);
  if (!sqlite) return null;

  const dbPath = join(await tempDir("opencode-db"), "opencode.db");
  const db = new sqlite(dbPath);
  try {
    db.exec("CREATE TABLE session (id text PRIMARY KEY, directory text)");
    const insert = db.prepare(
      "INSERT INTO session (id, directory) VALUES (?, ?)",
    );
    for (const row of rows) insert.run(row.id, row.directory);
  } finally {
    db.close();
  }
  return dbPath;
}

async function createCodexSessionsDir(
  entries: Array<{ id: string; cwd: string }>,
): Promise<string> {
  const sessionsDir = await tempDir("codex-sessions");
  const dateDir = join(sessionsDir, "2026", "07", "28");
  await mkdir(dateDir, { recursive: true });
  for (const entry of entries) {
    const meta = JSON.stringify({
      type: "session_meta",
      payload: {
        id: entry.id,
        cwd: entry.cwd,
        timestamp: "2026-07-28T00:00:00.000Z",
      },
    });
    await writeFile(join(dateDir, `rollout-${entry.id}.jsonl`), `${meta}\n`);
  }
  // The manifest is memoized per directory with a TTL; a fresh temp dir would
  // otherwise inherit nothing, but be explicit so ordering never bites.
  invalidateCodexSessionManifest(sessionsDir);
  return sessionsDir;
}

describe("locateSession", () => {
  it("returns null when no provider claims the session", async () => {
    await expect(locateSession(baseDeps(), "ses_missing")).resolves.toBeNull();
  });

  it("rejects ids that could escape into the filesystem", async () => {
    const scanner = { listProjects: vi.fn(async () => []) };
    const deps = baseDeps({ scanner: scanner as unknown as ProjectScanner });

    for (const unsafe of ["../../etc/passwd", "a/b", "", ".", "..", "a b"]) {
      await expect(locateSession(deps, unsafe)).resolves.toBeNull();
    }
    // Rejected before any lookup runs.
    expect(scanner.listProjects).not.toHaveBeenCalled();
  });

  it("resolves via the archive manifest, and reports it as archived", async () => {
    const deps = baseDeps({
      sessionArchiveService: {
        getArchivedSession: vi.fn((id: string) =>
          id === "ses_archived"
            ? {
                sessionId: id,
                provider: "codex" as const,
                projectId: encodeProjectId("/Users/someone/work/cold"),
                projectPath: "/Users/someone/work/cold",
              }
            : undefined,
        ),
      } as unknown as SessionArchiveService,
    });

    await expect(locateSession(deps, "ses_archived")).resolves.toMatchObject({
      sessionId: "ses_archived",
      provider: "codex",
      projectPath: "/Users/someone/work/cold",
      source: "archive",
      archived: true,
    });
  });

  it("resolves via a bridge sidecar and labels the provider by controller", async () => {
    const deps = baseDeps({
      opencodeBridgeService: bridge([
        { id: "ses_live", projectPath: "/Users/someone/work/live" },
      ]),
    });

    await expect(locateSession(deps, "ses_live")).resolves.toMatchObject({
      provider: "opencode",
      projectPath: "/Users/someone/work/live",
      source: "bridge",
      archived: false,
    });
  });

  it("keeps looking when a bridge sidecar is unreachable", async () => {
    const dbPath = await createOpenCodeDb([
      { id: "ses_db", directory: "/Users/someone/work/db" },
    ]);
    if (!dbPath) return;

    const deps = baseDeps({
      codexBridgeService: {
        listSessions: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      } as unknown as BridgeController,
      opencodeDbPath: dbPath,
    });

    await expect(locateSession(deps, "ses_db")).resolves.toMatchObject({
      source: "opencode-db",
      projectPath: "/Users/someone/work/db",
    });
  });

  it("resolves via the codex manifest without a project scope", async () => {
    const id = randomUUID();
    const deps = baseDeps({
      codexSessionsDir: await createCodexSessionsDir([
        { id, cwd: "/Users/someone/work/codex-proj" },
      ]),
    });

    await expect(locateSession(deps, id)).resolves.toMatchObject({
      provider: "codex",
      projectPath: "/Users/someone/work/codex-proj",
      projectName: "codex-proj",
      source: "codex-manifest",
    });
  });

  it("resolves via the global opencode sqlite row", async () => {
    const dbPath = await createOpenCodeDb([
      { id: "ses_a", directory: "/Users/someone/work/one" },
      { id: "ses_b", directory: "/Users/someone/work/two" },
    ]);
    if (!dbPath) return;

    const deps = baseDeps({ opencodeDbPath: dbPath });

    await expect(locateSession(deps, "ses_b")).resolves.toMatchObject({
      provider: "opencode",
      projectId: encodeProjectId("/Users/someone/work/two"),
      projectPath: "/Users/someone/work/two",
      source: "opencode-db",
    });
  });

  it("ignores opencode rows with a blank directory", async () => {
    const dbPath = await createOpenCodeDb([
      { id: "ses_blank", directory: "  " },
    ]);
    if (!dbPath) return;

    await expect(
      locateSession(baseDeps({ opencodeDbPath: dbPath }), "ses_blank"),
    ).resolves.toBeNull();
  });

  it("survives a missing opencode database", async () => {
    const deps = baseDeps({ opencodeDbPath: "/nonexistent/opencode.db" });
    await expect(locateSession(deps, "ses_x")).resolves.toBeNull();
  });

  it("resolves a claude session by stat-ing the project session dirs", async () => {
    const sessionDir = await tempDir("claude-sessions");
    await writeFile(join(sessionDir, "ses_claude.jsonl"), "{}\n");

    const project = createProject({
      path: "/Users/someone/work/claude-proj",
      sessionDir,
    });
    const readerFactory = vi.fn(
      () =>
        ({
          getSessionSummary: vi.fn(async () => null),
        }) as unknown as ISessionReader,
    );
    const deps = baseDeps({
      scanner: {
        listProjects: vi.fn(async () => [project]),
      } as unknown as ProjectScanner,
      readerFactory,
    });

    await expect(locateSession(deps, "ses_claude")).resolves.toMatchObject({
      provider: "claude",
      projectPath: "/Users/someone/work/claude-proj",
      source: "claude-file",
    });
    // The stat answered it, so no session was parsed.
    expect(readerFactory).not.toHaveBeenCalled();
  });

  it("finds claude sessions in merged cross-machine dirs", async () => {
    const mergedDir = await tempDir("claude-merged");
    await writeFile(join(mergedDir, "ses_merged.jsonl"), "{}\n");

    const deps = baseDeps({
      scanner: {
        listProjects: vi.fn(async () => [
          createProject({ mergedSessionDirs: [mergedDir] }),
        ]),
      } as unknown as ProjectScanner,
    });

    await expect(locateSession(deps, "ses_merged")).resolves.toMatchObject({
      source: "claude-file",
    });
  });

  it("falls back to the provider reader scan for id-less layouts", async () => {
    const project = createProject({
      path: "/Users/someone/work/gemini-proj",
      provider: "gemini",
    });
    // Gemini has no id-keyed index on disk, so only the reader can answer.
    const geminiReaderFactory = vi.fn(
      () =>
        ({
          getSessionSummary: vi.fn(async (id: string) =>
            id === "ses_gem" ? { id, provider: "gemini" } : null,
          ),
        }) as unknown as GeminiSessionReader,
    );
    const deps = baseDeps({
      scanner: {
        listProjects: vi.fn(async () => [project]),
      } as unknown as ProjectScanner,
      geminiSessionsDir: "/tmp/gemini",
      geminiReaderFactory,
    });

    await expect(locateSession(deps, "ses_gem")).resolves.toMatchObject({
      provider: "gemini",
      projectPath: "/Users/someone/work/gemini-proj",
      source: "provider-scan",
    });
    expect(geminiReaderFactory).toHaveBeenCalledWith(
      "/Users/someone/work/gemini-proj",
    );
  });

  it("prefers the archive manifest over the live provider sources", async () => {
    const dbPath = await createOpenCodeDb([
      { id: "ses_dup", directory: "/Users/someone/work/live" },
    ]);
    if (!dbPath) return;

    const deps = baseDeps({
      opencodeDbPath: dbPath,
      sessionArchiveService: {
        getArchivedSession: vi.fn(() => ({
          sessionId: "ses_dup",
          provider: "opencode" as const,
          projectId: encodeProjectId("/Users/someone/work/cold"),
          projectPath: "/Users/someone/work/cold",
        })),
      } as unknown as SessionArchiveService,
    });

    await expect(locateSession(deps, "ses_dup")).resolves.toMatchObject({
      source: "archive",
      projectPath: "/Users/someone/work/cold",
    });
  });

  it("follows a bootstrap id alias and echoes the requested id", async () => {
    const dbPath = await createOpenCodeDb([
      { id: "ses_durable", directory: "/Users/someone/work/aliased" },
    ]);
    if (!dbPath) return;

    const deps = baseDeps({
      opencodeDbPath: dbPath,
      sessionMetadataService: {
        getCanonicalSessionId: vi.fn((id: string) =>
          id === "ses_bootstrap" ? "ses_durable" : id,
        ),
        getProvider: vi.fn(() => undefined),
      } as unknown as SessionMetadataService,
    });

    await expect(locateSession(deps, "ses_bootstrap")).resolves.toMatchObject({
      sessionId: "ses_durable",
      requestedSessionId: "ses_bootstrap",
      projectPath: "/Users/someone/work/aliased",
    });
  });

  it("canonicalizes the project path before encoding the id", async () => {
    const dbPath = await createOpenCodeDb([
      { id: "ses_win", directory: "c:\\Users\\someone\\work\\win" },
    ]);
    if (!dbPath) return;

    await expect(
      locateSession(baseDeps({ opencodeDbPath: dbPath }), "ses_win"),
    ).resolves.toMatchObject({
      projectPath: "C:/Users/someone/work/win",
      projectId: encodeProjectId("C:/Users/someone/work/win"),
    });
  });

  it("does not scan projects when a cheap lookup already answered", async () => {
    const listProjects = vi.fn(async () => [] as Project[]);
    const dbPath = await createOpenCodeDb([
      { id: "ses_cheap", directory: "/Users/someone/work/cheap" },
    ]);
    if (!dbPath) return;

    await locateSession(
      baseDeps({
        opencodeDbPath: dbPath,
        scanner: { listProjects } as unknown as ProjectScanner,
      }),
      "ses_cheap",
    );

    expect(listProjects).not.toHaveBeenCalled();
  });

  it("passes the metadata provider hint into the fallback scan", async () => {
    const getSessionSummary = vi.fn(async () => null);
    const deps = baseDeps({
      scanner: {
        listProjects: vi.fn(async () => [createProject()]),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(
        () => ({ getSessionSummary }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getCanonicalSessionId: vi.fn((id: string) => id),
        getProvider: vi.fn(() => "kimi"),
        getProjectLocation: vi.fn(() => undefined),
      } as unknown as SessionMetadataService,
    });

    await locateSession(deps, "ses_hint");

    expect(deps.sessionMetadataService?.getProvider).toHaveBeenCalledWith(
      "ses_hint",
    );
  });
});

describe("locateSession via recorded metadata", () => {
  function metadataDeps(
    projectPath: string | undefined,
    provider: string | undefined,
    overrides: Partial<SessionLocatorDeps> = {},
  ): SessionLocatorDeps {
    return baseDeps({
      sessionMetadataService: {
        getCanonicalSessionId: vi.fn((id: string) => id),
        getProvider: vi.fn(() => provider),
        getProjectLocation: vi.fn(() =>
          projectPath
            ? { projectId: encodeProjectId(projectPath), projectPath }
            : undefined,
        ),
      } as unknown as SessionMetadataService,
      ...overrides,
    });
  }

  it("resolves without touching any provider reader", async () => {
    const projectPath = await tempDir("recorded-project");
    const readerFactory = vi.fn(
      () =>
        ({
          getSessionSummary: vi.fn(async () => null),
        }) as unknown as ISessionReader,
    );

    await expect(
      locateSession(
        metadataDeps(projectPath, "kimi", { readerFactory }),
        "ses_rec",
      ),
    ).resolves.toMatchObject({
      provider: "kimi",
      projectPath,
      projectId: encodeProjectId(projectPath),
      source: "metadata",
    });
    expect(readerFactory).not.toHaveBeenCalled();
  });

  it("ignores a recorded project whose directory no longer exists", async () => {
    const deps = metadataDeps("/nonexistent/moved-away", "kimi");
    await expect(locateSession(deps, "ses_stale")).resolves.toBeNull();
  });

  it("ignores a recorded project with no recorded provider", async () => {
    const projectPath = await tempDir("recorded-no-provider");
    await expect(
      locateSession(metadataDeps(projectPath, undefined), "ses_noprov"),
    ).resolves.toBeNull();
  });

  it("lets an authoritative provider source win over a stale recording", async () => {
    const recordedPath = await tempDir("recorded-old");
    const dbPath = await createOpenCodeDb([
      { id: "ses_moved", directory: "/Users/someone/work/actual" },
    ]);
    if (!dbPath) return;

    await expect(
      locateSession(
        metadataDeps(recordedPath, "opencode", { opencodeDbPath: dbPath }),
        "ses_moved",
      ),
    ).resolves.toMatchObject({
      source: "opencode-db",
      projectPath: "/Users/someone/work/actual",
    });
  });
});

describe("locateSession project id shape", () => {
  it("returns an id that round-trips to the project path", async () => {
    const dbPath = await createOpenCodeDb([
      { id: "ses_rt", directory: "/Users/someone/work/round trip" },
    ]);
    if (!dbPath) return;

    const location = await locateSession(
      baseDeps({ opencodeDbPath: dbPath }),
      "ses_rt",
    );

    expect(location).not.toBeNull();
    expect(
      Buffer.from(location?.projectId as UrlProjectId, "base64url").toString(
        "utf-8",
      ),
    ).toBe("/Users/someone/work/round trip");
  });
});
