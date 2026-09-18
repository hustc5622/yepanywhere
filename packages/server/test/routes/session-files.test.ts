import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionFileActivityIndex } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import { registerSessionDisplayRoutes } from "../../src/routes/session-display.js";
import type { LoadedSession } from "../../src/sessions/types.js";
import type {
  Message,
  Project,
  SessionSummary,
} from "../../src/supervisor/types.js";

const SESSION_ID = "session-files-fixture";

let workdir: string;

/**
 * The session edits `tracked.txt` twice and only reads `docs/unchanged.md`.
 * Nothing here involves git: the worktree is a plain directory.
 */
function messages(): Message[] {
  return [
    {
      uuid: "user-0",
      type: "user",
      message: { role: "user", content: "change it" },
      timestamp: "2026-09-01T00:00:00.000Z",
    },
    {
      uuid: "assistant-0",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "edit-1",
            name: "Edit",
            input: {
              file_path: join(workdir, "tracked.txt"),
              old_string: "two\n",
              new_string: "two changed\nthree\n",
            },
          },
          {
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: { file_path: "docs/unchanged.md" },
          },
        ],
      },
      timestamp: "2026-09-01T00:00:01.000Z",
    },
    {
      uuid: "assistant-1",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "edit-2",
            name: "Edit",
            input: {
              file_path: "tracked.txt",
              old_string: "three\n",
              new_string: "three\nfour\n",
            },
          },
        ],
      },
      timestamp: "2026-09-01T00:00:02.000Z",
    },
  ] as unknown as Message[];
}

function createApp() {
  const projectId = encodeProjectId(workdir);
  const project = (): Project => ({
    id: projectId,
    path: workdir,
    name: "session-files-project",
    sessionCount: 1,
    sessionDir: join(workdir, ".sessions"),
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  });
  const summary = (): SessionSummary => ({
    id: SESSION_ID,
    projectId,
    title: "Files fixture",
    fullTitle: "Files fixture",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:03.000Z",
    messageCount: 3,
    ownership: { owner: "none" },
    provider: "codex",
  });
  const reader = {
    getSession: vi.fn(
      async (): Promise<LoadedSession> => ({
        summary: summary(),
        data: { provider: "codex", session: { entries: [] } },
        projectedMessages: structuredClone(messages()),
      }),
    ),
    getSessionSummary: vi.fn(async () => summary()),
    getSessionFileStats: vi.fn(async () => ({ mtime: 1, size: 3 })),
  };
  const app = new Hono();
  registerSessionDisplayRoutes(app, {
    scanner: { getOrCreateProject: vi.fn(async () => project()) },
    providerResolution: { readerFactory: () => reader as never },
  });
  return { app, projectId };
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "yep-session-files-"));
  // Final worktree state after both edits.
  await writeFile(
    join(workdir, "tracked.txt"),
    "one\ntwo changed\nthree\nfour\n",
  );
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("session file index routes", () => {
  it("counts line deltas from the session's own edit calls", async () => {
    const { app, projectId } = createApp();
    const response = await app.request(
      `/projects/${projectId}/sessions/${SESSION_ID}/files`,
    );
    expect(response.status).toBe(200);
    const index = (await response.json()) as SessionFileActivityIndex;

    // The absolute and relative spellings of the same file collapse into one
    // entry, and both edits are counted.
    const tracked = index.files.find((file) => file.path === "tracked.txt");
    expect(tracked).toMatchObject({
      kind: "modified",
      edits: 2,
      additions: 3,
      deletions: 1,
    });

    const readOnly = index.files.find(
      (file) => file.path === "docs/unchanged.md",
    );
    expect(readOnly?.kind).toBe("read");
    expect(readOnly?.additions).toBeUndefined();
  });

  it("diffs the file against the session-reconstructed baseline", async () => {
    const { app, projectId } = createApp();
    const response = await app.request(
      `/projects/${projectId}/sessions/${SESSION_ID}/files/diff`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "tracked.txt" }),
      },
    );
    expect(response.status).toBe(200);
    const diff = (await response.json()) as {
      path: string;
      exact: boolean;
      diffHtml: string;
      structuredPatch: Array<{ lines: string[] }>;
    };
    expect(diff.path).toBe("tracked.txt");
    expect(diff.exact).toBe(true);
    const lines = diff.structuredPatch.flatMap((hunk) => hunk.lines);
    expect(lines).toContain("-two");
    expect(lines).toContain("+two changed");
    expect(lines).toContain("+four");
  });

  it("404s for a file the session never edited", async () => {
    const { app, projectId } = createApp();
    const response = await app.request(
      `/projects/${projectId}/sessions/${SESSION_ID}/files/diff`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "docs/unchanged.md" }),
      },
    );
    expect(response.status).toBe(404);
  });

  it("rejects paths that escape the project", async () => {
    const { app, projectId } = createApp();
    for (const path of ["/etc/passwd", "../outside.txt", ""]) {
      const response = await app.request(
        `/projects/${projectId}/sessions/${SESSION_ID}/files/diff`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        },
      );
      expect(response.status).toBe(400);
    }
  });
});
