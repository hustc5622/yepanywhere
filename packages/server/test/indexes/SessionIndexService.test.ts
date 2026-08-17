import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionIndexService } from "../../src/indexes/SessionIndexService.js";
import { KimiSessionReader } from "../../src/sessions/kimi-reader.js";
import { SessionReader } from "../../src/sessions/reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { SessionSummary } from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/EventBus.js";

describe("SessionIndexService", () => {
  let testDir: string;
  let dataDir: string;
  let projectsDir: string;
  let sessionDir: string;
  let service: SessionIndexService;
  let reader: SessionReader;
  let projectId: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `claude-index-test-${randomUUID()}`);
    dataDir = join(testDir, "indexes");
    projectsDir = join(testDir, "projects");
    sessionDir = join(projectsDir, "test-project");

    await mkdir(dataDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    service = new SessionIndexService({ dataDir, projectsDir });
    await service.initialize();

    reader = new SessionReader({ sessionDir });
    projectId = toUrlProjectId("/test/project");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function createSession(
    sessionId: string,
    content: string,
  ): Promise<void> {
    const jsonl = JSON.stringify({
      type: "user",
      message: { content },
      uuid: `msg-${sessionId}`,
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), `${jsonl}\n`);
  }

  describe("initialization", () => {
    it("creates data directory on initialize", async () => {
      const newDataDir = join(testDir, "new-indexes");
      const newService = new SessionIndexService({
        dataDir: newDataDir,
        projectsDir,
      });

      await newService.initialize();

      const stats = await stat(newDataDir);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  describe("cache hit", () => {
    it("returns cached data when mtime/size match", async () => {
      await createSession("session-1", "Hello world");

      // First call - populates cache
      const sessions1 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions1).toHaveLength(1);
      expect(sessions1[0]?.id).toBe("session-1");

      // Second call - should use cache (same mtime/size)
      const sessions2 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions2).toHaveLength(1);
      expect(sessions2[0]?.id).toBe("session-1");
    });

    it("caches user questions extracted from raw session files", async () => {
      const lines = [
        {
          type: "user",
          message: { content: "# AGENTS.md instructions\nignore setup" },
          uuid: "setup",
          parentUuid: null,
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          type: "user",
          message: { content: "What is 2+2?" },
          uuid: "question-1",
          parentUuid: "setup",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
        {
          type: "assistant",
          message: { content: "4" },
          uuid: "answer-1",
          parentUuid: "question-1",
          timestamp: "2026-01-01T00:00:02.000Z",
        },
        {
          type: "user",
          message: { content: "And what about 3+3?" },
          uuid: "question-2",
          parentUuid: "answer-1",
          timestamp: "2026-01-01T00:00:03.000Z",
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "tool-1" }],
          },
          uuid: "tool-result",
          parentUuid: "question-2",
          timestamp: "2026-01-01T00:00:04.000Z",
        },
      ];
      await writeFile(
        join(sessionDir, "session-questions.jsonl"),
        `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      );

      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );

      expect(sessions[0]?.userQuestions).toEqual([
        {
          id: "question-1",
          text: "What is 2+2?",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
        {
          id: "question-2",
          text: "And what about 3+3?",
          timestamp: "2026-01-01T00:00:03.000Z",
        },
      ]);
    });
  });

  describe("cache miss", () => {
    it("re-parses file when mtime changes", async () => {
      await createSession("session-1", "Original content");

      // First call
      const sessions1 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions1[0]?.title).toBe("Original content");

      // Wait a bit and modify the file
      await new Promise((resolve) => setTimeout(resolve, 10));

      const newJsonl = JSON.stringify({
        type: "user",
        message: { content: "Updated content" },
        uuid: "msg-updated",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(sessionDir, "session-1.jsonl"), `${newJsonl}\n`);

      // Second call - should detect change and re-parse
      const sessions2 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions2[0]?.title).toBe("Updated content");
    });

    it("re-parses file when size changes", async () => {
      // Create session with proper DAG structure
      const userJsonl = JSON.stringify({
        type: "user",
        message: { content: "Short" },
        uuid: "msg-1",
        parentUuid: null,
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(sessionDir, "session-1.jsonl"), `${userJsonl}\n`);

      // First call
      const sessions1 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions1[0]?.messageCount).toBe(1);

      // Append to file (changes size) - properly linked to parent
      const additionalJsonl = JSON.stringify({
        type: "assistant",
        message: { content: "Response" },
        uuid: "msg-2",
        parentUuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      const filePath = join(sessionDir, "session-1.jsonl");
      const existing = await readFile(filePath, "utf-8");
      await writeFile(filePath, `${existing}${additionalJsonl}\n`);

      // Second call - should detect size change
      const sessions2 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions2[0]?.messageCount).toBe(2);
    });
  });

  describe("new files", () => {
    it("adds new sessions to index", async () => {
      await createSession("session-1", "First session");

      const sessions1 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions1).toHaveLength(1);

      // Add a new session
      await createSession("session-2", "Second session");

      const sessions2 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions2).toHaveLength(2);
      expect(sessions2.map((s) => s.id).sort()).toEqual([
        "session-1",
        "session-2",
      ]);
    });
  });

  describe("deleted files", () => {
    it("removes deleted sessions from cache", async () => {
      await createSession("session-1", "First session");
      await createSession("session-2", "Second session");

      const sessions1 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions1).toHaveLength(2);

      // Delete session-2
      await rm(join(sessionDir, "session-2.jsonl"));

      const sessions2 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions2).toHaveLength(1);
      expect(sessions2[0]?.id).toBe("session-1");
    });
  });

  describe("corrupt index", () => {
    it("gracefully handles malformed index file", async () => {
      await createSession("session-1", "Test content");

      // Write corrupt index
      const indexPath = service.getIndexPath(sessionDir);
      await mkdir(join(testDir, "indexes"), { recursive: true });
      await writeFile(indexPath, "not valid json{{{");

      // Should still work - starts fresh
      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.title).toBe("Test content");
    });

    it("handles index with wrong version", async () => {
      await createSession("session-1", "Test content");

      const indexPath = service.getIndexPath(sessionDir);
      await mkdir(join(testDir, "indexes"), { recursive: true });
      await writeFile(
        indexPath,
        JSON.stringify({
          version: 999,
          projectId,
          sessions: {},
        }),
      );

      // Should start fresh due to version mismatch
      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions).toHaveLength(1);
    });
  });

  describe("index file location", () => {
    it("encodes sessionDir path correctly", () => {
      const nestedSessionDir = join(projectsDir, "host", "nested", "path");
      const indexPath = service.getIndexPath(nestedSessionDir);

      // Should encode slashes as %2F
      expect(indexPath).toContain("%2F");
      expect(indexPath).toContain("host%2Fnested%2Fpath.json");
    });
  });

  describe("concurrent operations", () => {
    it("handles multiple concurrent cache updates", async () => {
      // Create multiple sessions
      await Promise.all([
        createSession("session-1", "Content 1"),
        createSession("session-2", "Content 2"),
        createSession("session-3", "Content 3"),
      ]);

      // Make concurrent requests
      const [result1, result2, result3] = await Promise.all([
        service.getSessionsWithCache(sessionDir, projectId, reader),
        service.getSessionsWithCache(sessionDir, projectId, reader),
        service.getSessionsWithCache(sessionDir, projectId, reader),
      ]);

      // All should return same data
      expect(result1.length).toBe(3);
      expect(result2.length).toBe(3);
      expect(result3.length).toBe(3);
      expect(service.getDebugStats().requests).toBe(1);
    });
  });

  describe("fast path", () => {
    it("serves cached summaries between validations and refreshes on invalidation", async () => {
      const fastService = new SessionIndexService({
        dataDir,
        projectsDir,
        fullValidationIntervalMs: 60000,
      });
      await fastService.initialize();

      await createSession("session-1", "Original content");

      const first = await fastService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(first[0]?.title).toBe("Original content");

      // Update file content without invalidating.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const updatedJsonl = JSON.stringify({
        type: "user",
        message: { content: "Updated content" },
        uuid: "msg-updated",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(sessionDir, "session-1.jsonl"), `${updatedJsonl}\n`);

      // Fast path should still serve cached summary until invalidated.
      const second = await fastService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(second[0]?.title).toBe("Original content");

      fastService.invalidateSession(sessionDir, "session-1");
      const third = await fastService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(third[0]?.title).toBe("Updated content");
    });

    it("serves stale summaries immediately while refreshing in the background", async () => {
      const fastService = new SessionIndexService({
        dataDir,
        projectsDir,
        fullValidationIntervalMs: 1,
      });
      await fastService.initialize();

      await createSession("session-1", "Original content");
      const first = await fastService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(first[0]?.title).toBe("Original content");

      await new Promise((resolve) => setTimeout(resolve, 10));
      const updatedJsonl = JSON.stringify({
        type: "user",
        message: { content: "Updated content with a different length" },
        uuid: "msg-updated",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(sessionDir, "session-1.jsonl"), `${updatedJsonl}\n`);

      const stale = await fastService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
        { allowStale: true },
      );
      expect(stale[0]?.title).toBe("Original content");

      // A normal read joins the background validation started above. Polling
      // with allowStale would start another refresh after the first completes,
      // leaving an index write racing with test cleanup.
      const refreshed = await fastService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(refreshed[0]?.title).toBe(
        "Updated content with a different length",
      );
    });
  });

  describe("invalidation", () => {
    it("invalidateSession removes session from memory cache", async () => {
      await createSession("session-1", "Original");

      // Populate cache
      await service.getSessionsWithCache(sessionDir, projectId, reader);

      // Invalidate
      service.invalidateSession(sessionDir, "session-1");

      // Update file content
      const newJsonl = JSON.stringify({
        type: "user",
        message: { content: "Updated" },
        uuid: "msg-new",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(sessionDir, "session-1.jsonl"), `${newJsonl}\n`);

      // Should re-parse due to invalidation
      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions[0]?.title).toBe("Updated");
    });

    it("clearCache removes all cached data for directory", async () => {
      await createSession("session-1", "Test");

      // Populate cache
      await service.getSessionsWithCache(sessionDir, projectId, reader);

      // Clear cache
      service.clearCache(sessionDir);

      // Next call should rebuild from disk
      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions).toHaveLength(1);
    });

    it.each(["codex", "kimi"] as const)(
      "invalidates loaded %s scopes on file-change events",
      async (provider) => {
        const eventBus = new EventBus();
        const providerService = new SessionIndexService({
          dataDir,
          projectsDir,
          eventBus,
          fullValidationIntervalMs: 60000,
        });
        await providerService.initialize();

        const providerSessionDir = join(testDir, `${provider}-sessions`);
        await mkdir(providerSessionDir, { recursive: true });
        const providerFile = join(providerSessionDir, "session-1.jsonl");
        await writeFile(providerFile, "Original title\n");

        const providerReader: ISessionReader = {
          getIndexScopeKey: (sessionDir) =>
            `${provider}::${sessionDir}::/tmp/project`,
          listSessionFiles: async (sessionDir) => [
            {
              sessionId: "session-1",
              filePath: join(sessionDir, "session-1.jsonl"),
            },
          ],
          getSessionSummary: async (
            sessionId: string,
            projectId: string,
          ): Promise<SessionSummary> => {
            const title = (await readFile(providerFile, "utf-8")).trim();
            const stats = await stat(providerFile);
            return {
              id: sessionId,
              projectId,
              title,
              fullTitle: title,
              createdAt: new Date(stats.mtimeMs).toISOString(),
              updatedAt: new Date(stats.mtimeMs).toISOString(),
              messageCount: 1,
              ownership: { owner: "none" },
              provider,
            };
          },
          getAgentMappings: async () => [],
          getAgentSession: async () => null,
        };

        const first = await providerService.getSessionsWithCache(
          providerSessionDir,
          projectId,
          providerReader,
        );
        expect(first[0]?.title).toBe("Original title");

        await writeFile(providerFile, "Updated title\n");

        // Without an invalidation event, fast path keeps serving stale data.
        const stale = await providerService.getSessionsWithCache(
          providerSessionDir,
          projectId,
          providerReader,
        );
        expect(stale[0]?.title).toBe("Original title");

        eventBus.emit({
          type: "file-change",
          provider,
          path: providerFile,
          relativePath: "workspace/session-1/agents/main/wire.jsonl",
          changeType: "modify",
          timestamp: new Date().toISOString(),
          fileType: "session",
        });

        const refreshed = await providerService.getSessionsWithCache(
          providerSessionDir,
          projectId,
          providerReader,
        );
        expect(refreshed[0]?.title).toBe("Updated title");
      },
    );

    it("refreshes Kimi metadata when only state.json changes", async () => {
      const eventBus = new EventBus();
      const kimiService = new SessionIndexService({
        dataDir,
        projectsDir,
        eventBus,
        fullValidationIntervalMs: 60000,
      });
      await kimiService.initialize();

      const projectPath = "/test/project";
      const kimiSessionsDir = join(testDir, "kimi-state-sessions");
      const kimiSessionDir = join(kimiSessionsDir, "wd_test", "session_state");
      const statePath = join(kimiSessionDir, "state.json");
      const wirePath = join(kimiSessionDir, "agents", "main", "wire.jsonl");
      const timestamp = Date.now();
      const writeState = (title: string) =>
        writeFile(
          statePath,
          JSON.stringify({
            version: 2,
            cwd: projectPath,
            title,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        );

      await mkdir(join(kimiSessionDir, "agents", "main"), {
        recursive: true,
      });
      await writeState("Old title");
      await writeFile(
        wirePath,
        `${JSON.stringify({
          type: "turn.prompt",
          input: [{ type: "text", text: "hello" }],
          origin: { kind: "user" },
          time: timestamp,
        })}\n`,
      );

      const kimiReader = new KimiSessionReader({
        sessionsDir: kimiSessionsDir,
        projectPath,
      });
      const first = await kimiService.getSessionsWithCache(
        kimiSessionsDir,
        projectId,
        kimiReader,
      );
      expect(first[0]?.title).toBe("Old title");

      await writeState("New title");
      const future = new Date(Date.now() + 5000);
      await utimes(statePath, future, future);
      kimiReader.invalidateCache();
      eventBus.emit({
        type: "file-change",
        provider: "kimi",
        path: statePath,
        relativePath: "wd_test/session_state/state.json",
        changeType: "modify",
        timestamp: new Date().toISOString(),
        fileType: "session",
      });

      const refreshed = await kimiService.getSessionsWithCache(
        kimiSessionsDir,
        projectId,
        kimiReader,
      );
      expect(refreshed[0]?.title).toBe("New title");

      const cachedSummary = await kimiService.getSessionSummaryWithCache(
        kimiSessionsDir,
        projectId,
        "session_state",
        kimiReader,
      );
      expect(cachedSummary?.title).toBe("New title");

      await writeState("Hot title");
      const later = new Date(Date.now() + 10000);
      await utimes(statePath, later, later);
      kimiReader.invalidateCache();

      const refreshedSummary = await kimiService.getSessionSummaryWithCache(
        kimiSessionsDir,
        projectId,
        "session_state",
        kimiReader,
      );
      expect(refreshedSummary?.title).toBe("Hot title");
      kimiService.dispose();
    });
  });

  describe("getSessionSummaryWithCache", () => {
    it("returns the full summary and serves it from cache on repeat calls", async () => {
      await createSession("session-1", "Cached summary");

      const parseSpy = vi.spyOn(reader, "getSessionSummary");

      const first = await service.getSessionSummaryWithCache(
        sessionDir,
        projectId,
        "session-1",
        reader,
      );
      expect(first?.id).toBe("session-1");
      expect(first?.title).toBe("Cached summary");
      expect(parseSpy).toHaveBeenCalledTimes(1);

      // Same mtime/size -> cache hit, reader is not asked to parse again.
      const second = await service.getSessionSummaryWithCache(
        sessionDir,
        projectId,
        "session-1",
        reader,
      );
      expect(second?.id).toBe("session-1");
      expect(parseSpy).toHaveBeenCalledTimes(1);
    });

    it("re-parses when the file mtime/size changes", async () => {
      await createSession("session-1", "Original");
      await service.getSessionSummaryWithCache(
        sessionDir,
        projectId,
        "session-1",
        reader,
      );

      const updatedJsonl = JSON.stringify({
        type: "user",
        message: { content: "Updated body that changes size" },
        uuid: "msg-updated",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(sessionDir, "session-1.jsonl"), `${updatedJsonl}\n`);

      const parseSpy = vi.spyOn(reader, "getSessionSummary");
      const refreshed = await service.getSessionSummaryWithCache(
        sessionDir,
        projectId,
        "session-1",
        reader,
      );
      expect(refreshed?.title).toBe("Updated body that changes size");
      expect(parseSpy).toHaveBeenCalledTimes(1);
    });

    it("returns null for a session that does not exist", async () => {
      const result = await service.getSessionSummaryWithCache(
        sessionDir,
        projectId,
        "missing",
        reader,
      );
      expect(result).toBeNull();
    });

    it("falls back to the reader when the file is not under sessionDir", async () => {
      const summary: SessionSummary = {
        id: "session-elsewhere",
        projectId: projectId as ReturnType<typeof toUrlProjectId>,
        title: "Resolved via reader fallback",
        fullTitle: "Resolved via reader fallback",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        ownership: { owner: "none" },
        provider: "claude",
      };
      // No file at sessionDir/session-elsewhere.jsonl and no getSessionFilePath,
      // so the stat probe fails; the reader must still resolve the summary.
      const fallbackReader = {
        getSessionSummary: vi.fn(async () => summary),
      } as unknown as ISessionReader;

      const result = await service.getSessionSummaryWithCache(
        sessionDir,
        projectId,
        "session-elsewhere",
        fallbackReader,
      );
      expect(result?.title).toBe("Resolved via reader fallback");
      expect(vi.mocked(fallbackReader.getSessionSummary)).toHaveBeenCalledWith(
        "session-elsewhere",
        projectId,
      );
    });

    it("deduplicates concurrent lookups for the same session", async () => {
      await createSession("session-1", "Concurrent");
      const parseSpy = vi.spyOn(reader, "getSessionSummary");

      const [a, b] = await Promise.all([
        service.getSessionSummaryWithCache(
          sessionDir,
          projectId,
          "session-1",
          reader,
        ),
        service.getSessionSummaryWithCache(
          sessionDir,
          projectId,
          "session-1",
          reader,
        ),
      ]);

      expect(a?.id).toBe("session-1");
      expect(b?.id).toBe("session-1");
      expect(parseSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("sorting", () => {
    it("returns sessions sorted by updatedAt descending", async () => {
      // Create sessions with different timestamps
      await createSession("session-old", "Old session");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await createSession("session-new", "New session");

      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );

      // Newest should be first
      expect(sessions[0]?.id).toBe("session-new");
      expect(sessions[1]?.id).toBe("session-old");
    });
  });

  describe("agent files", () => {
    it("excludes agent-* files from session list", async () => {
      await createSession("session-1", "Regular session");

      // Create an agent file
      const agentJsonl = JSON.stringify({
        type: "user",
        message: { content: "Agent content" },
        uuid: "msg-agent",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(sessionDir, "agent-12345.jsonl"), `${agentJsonl}\n`);

      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );

      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("session-1");
    });
  });

  describe("persistence", () => {
    it("persists index to disk and reloads", async () => {
      await createSession("session-1", "Persistent session");

      // First service instance
      await service.getSessionsWithCache(sessionDir, projectId, reader);

      // Create new service instance (simulates server restart)
      const newService = new SessionIndexService({ dataDir, projectsDir });
      await newService.initialize();

      // Should load cached data from disk
      const sessions = await newService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.title).toBe("Persistent session");
    });

    it("persists provider creation metadata to disk and reloads", async () => {
      const metadataSessionDir = join(projectsDir, "metadata-session");
      await mkdir(metadataSessionDir, { recursive: true });
      const filePath = join(metadataSessionDir, "session-1.jsonl");
      await writeFile(filePath, "{}\n");

      const metadataReader: ISessionReader = {
        listSessions: async () => [],
        listSessionFiles: async () => [{ sessionId: "session-1", filePath }],
        getSessionSummary: async (
          sessionId: string,
          projectId: string,
        ): Promise<SessionSummary> => {
          const stats = await stat(filePath);
          return {
            id: sessionId,
            projectId,
            title: "Persistent metadata",
            fullTitle: "Persistent metadata",
            createdAt: new Date(stats.mtimeMs).toISOString(),
            updatedAt: new Date(stats.mtimeMs).toISOString(),
            messageCount: 1,
            ownership: { owner: "none" },
            provider: "codex",
            originator: "Codex Desktop",
            source: "appServer",
            createdBy: "yep",
          };
        },
        getSession: async () => null,
        getSessionSummaryIfChanged: async () => null,
        getAgentMappings: async () => [],
        getAgentSession: async () => null,
      };

      await service.getSessionsWithCache(
        metadataSessionDir,
        projectId,
        metadataReader,
      );

      const newService = new SessionIndexService({ dataDir, projectsDir });
      await newService.initialize();
      const sessions = await newService.getSessionsWithCache(
        metadataSessionDir,
        projectId,
        metadataReader,
      );

      expect(sessions[0]).toMatchObject({
        originator: "Codex Desktop",
        source: "appServer",
        createdBy: "yep",
      });
    });

    it("writes compact JSON index files", async () => {
      await createSession("session-1", "Compact session");

      await service.getSessionsWithCache(sessionDir, projectId, reader);

      const content = await readFile(service.getIndexPath(sessionDir), "utf-8");
      expect(content).toBe(JSON.stringify(JSON.parse(content)));
    });

    it("writes index atomically without leftover temp files", async () => {
      await createSession("session-1", "Atomic session");

      await service.getSessionsWithCache(sessionDir, projectId, reader);

      const files = await readdir(dataDir);
      const tempFiles = files.filter((file) => file.includes(".tmp-"));
      expect(tempFiles).toHaveLength(0);
    });

    it("cleans stale lock directories before writing", async () => {
      const lockService = new SessionIndexService({
        dataDir,
        projectsDir,
        writeLockTimeoutMs: 500,
        writeLockStaleMs: 50,
      });
      await lockService.initialize();
      await createSession("session-1", "Lock session");

      const indexPath = lockService.getIndexPath(sessionDir);
      const lockPath = `${indexPath}.lock`;
      await mkdir(dirname(indexPath), { recursive: true });
      await mkdir(lockPath, { recursive: true });
      const staleTime = new Date(Date.now() - 1000);
      await utimes(lockPath, staleTime, staleTime);

      const sessions = await lockService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions).toHaveLength(1);

      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("full validation stats", () => {
    it("stats every session file when file count exceeds the concurrency window", async () => {
      const manySessionDir = join(projectsDir, "many-sessions");
      await mkdir(manySessionDir, { recursive: true });

      const sessionCount = 520;
      const sessionFiles = Array.from({ length: sessionCount }, (_, index) => {
        const sessionId = `session-${index.toString().padStart(3, "0")}`;
        return {
          sessionId,
          filePath: join(manySessionDir, `${sessionId}.jsonl`),
        };
      });
      await Promise.all(
        sessionFiles.map((file) => writeFile(file.filePath, "{}\n")),
      );

      const manyReader: ISessionReader = {
        listSessions: async () => [],
        listSessionFiles: async () => sessionFiles,
        getSessionSummary: async (
          sessionId: string,
          projectId: string,
        ): Promise<SessionSummary> => ({
          id: sessionId,
          projectId,
          title: sessionId,
          fullTitle: sessionId,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 1,
          ownership: { owner: "none" },
          provider: "claude",
        }),
        getSession: async () => null,
        getSessionSummaryIfChanged: async () => null,
        getAgentMappings: async () => [],
        getAgentSession: async () => null,
      };

      const sessions = await service.getSessionsWithCache(
        manySessionDir,
        projectId,
        manyReader,
      );

      expect(sessions).toHaveLength(sessionCount);
      expect(service.getDebugStats().statCalls).toBe(sessionCount);
    });

    it("reuses reader-provided file stats during full validation", async () => {
      const statlessSessionDir = join(projectsDir, "statless-sessions");
      await mkdir(statlessSessionDir, { recursive: true });

      const sessionFiles = [
        {
          sessionId: "session-1",
          filePath: join(statlessSessionDir, "session-1.jsonl"),
          mtime: 1000,
          size: 10,
        },
        {
          sessionId: "session-2",
          filePath: join(statlessSessionDir, "session-2.jsonl"),
          mtime: 2000,
          size: 20,
        },
      ];

      const statlessReader: ISessionReader = {
        listSessions: async () => [],
        listSessionFiles: async () => sessionFiles,
        getSessionSummary: async (
          sessionId: string,
          projectId: string,
        ): Promise<SessionSummary> => ({
          id: sessionId,
          projectId,
          title: sessionId,
          fullTitle: sessionId,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 1,
          ownership: { owner: "none" },
          provider: "codex",
        }),
        getSession: async () => null,
        getSessionSummaryIfChanged: async () => null,
        getAgentMappings: async () => [],
        getAgentSession: async () => null,
      };

      const sessions = await service.getSessionsWithCache(
        statlessSessionDir,
        projectId,
        statlessReader,
      );

      expect(sessions).toHaveLength(2);
      expect(service.getDebugStats().statCalls).toBe(0);
    });
  });
});

describe("SessionIndexService full-validation throttling", () => {
  let testDir: string;
  let dataDir: string;
  let projectsDir: string;
  let sessionDir: string;
  let projectId: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `index-throttle-${randomUUID()}`);
    dataDir = join(testDir, "indexes");
    projectsDir = join(testDir, "projects");
    sessionDir = join(testDir, "opencode-sessions");
    await mkdir(dataDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    projectId = toUrlProjectId("/test/project");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /**
   * Reader standing in for a provider whose scopes share one backing store, and
   * which counts how often the service asks it to enumerate that store.
   */
  function countingReader(scope: string, onList?: () => Promise<void>) {
    let listCalls = 0;
    const reader: ISessionReader = {
      getIndexScopeKey: (dir) => `opencode::${dir}::${scope}`,
      listSessionFiles: async (dir) => {
        listCalls += 1;
        await onList?.();
        return [
          { sessionId: "session-1", filePath: join(dir, "session-1.jsonl") },
        ];
      },
      getSessionSummary: async (
        sessionId: string,
        pid: string,
      ): Promise<SessionSummary> => ({
        id: sessionId,
        projectId: pid,
        title: "t",
        fullTitle: "t",
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
        messageCount: 1,
        ownership: { owner: "none" },
        provider: "opencode",
      }),
      getAgentMappings: async () => [],
      getAgentSession: async () => null,
    };
    return {
      reader,
      // A method, not a getter: spreading this object would snapshot a getter's
      // value and silently freeze the counter at 0.
      listCalls: () => listCalls,
    };
  }

  function emitOpencodeChange(bus: EventBus): void {
    bus.emit({
      type: "file-change",
      provider: "opencode",
      path: join(sessionDir, "session-1.jsonl"),
      relativePath: "session-1.jsonl",
      changeType: "modify",
      timestamp: new Date().toISOString(),
      fileType: "session",
    });
  }

  it("collapses a burst of dirty-directory events into one full validation", async () => {
    const eventBus = new EventBus();
    const service = new SessionIndexService({
      dataDir,
      projectsDir,
      eventBus,
      fullValidationIntervalMs: 60_000,
      fullValidationMinIntervalMs: 60_000,
    });
    await service.initialize();
    const probe = countingReader("/p1");
    const reader = probe.reader;

    // Prime the index; this is the one legitimate full pass.
    await service.getSessionsWithCache(sessionDir, projectId, reader);
    const primed = probe.listCalls();
    // Guard against a vacuous assertion: the priming pass must have scanned.
    expect(primed).toBeGreaterThan(0);

    // A watcher storm: every event marks the scope dirty.
    for (let i = 0; i < 20; i++) {
      emitOpencodeChange(eventBus);
      await service.getSessionsWithCache(sessionDir, projectId, reader);
    }

    // Inside the minimum interval none of those may trigger a re-scan.
    expect(probe.listCalls()).toBe(primed);
  });

  it("still reconciles once the minimum interval has passed", async () => {
    const eventBus = new EventBus();
    const service = new SessionIndexService({
      dataDir,
      projectsDir,
      eventBus,
      fullValidationIntervalMs: 60_000,
      fullValidationMinIntervalMs: 20,
    });
    await service.initialize();
    const probe = countingReader("/p2");
    const reader = probe.reader;

    await service.getSessionsWithCache(sessionDir, projectId, reader);
    const primed = probe.listCalls();

    emitOpencodeChange(eventBus);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await service.getSessionsWithCache(sessionDir, projectId, reader);

    expect(probe.listCalls()).toBeGreaterThan(primed);
  });

  it("keeps every dirty event actionable when throttling is disabled", async () => {
    // The service default is 0 so existing embedders keep the old behaviour;
    // only the config layer opts into a floor.
    const eventBus = new EventBus();
    const service = new SessionIndexService({
      dataDir,
      projectsDir,
      eventBus,
      fullValidationIntervalMs: 60_000,
    });
    await service.initialize();
    const probe = countingReader("/p3");
    const reader = probe.reader;

    await service.getSessionsWithCache(sessionDir, projectId, reader);
    const primed = probe.listCalls();

    emitOpencodeChange(eventBus);
    await service.getSessionsWithCache(sessionDir, projectId, reader);

    expect(probe.listCalls()).toBeGreaterThan(primed);
  });

  it("runs full validations one at a time", async () => {
    const service = new SessionIndexService({
      dataDir,
      projectsDir,
      fullValidationIntervalMs: 0,
      maxConcurrentFullValidations: 1,
    });
    await service.initialize();

    let concurrent = 0;
    let peak = 0;
    const hold = async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 25));
      concurrent -= 1;
    };

    // Distinct scopes sharing one store, exactly the OpenCode shape.
    const readers = ["/a", "/b", "/c", "/d"].map(
      (scope) => countingReader(scope, hold).reader,
    );

    await Promise.all(
      readers.map((reader) =>
        service.getSessionsWithCache(sessionDir, projectId, reader),
      ),
    );

    expect(peak).toBe(1);
  });
});
