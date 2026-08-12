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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionIndexService } from "../../src/indexes/SessionIndexService.js";
import { encodeProjectId } from "../../src/projects/paths.js";
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

  async function createSessionForCwd(
    sessionId: string,
    cwd: string,
    content: string,
  ): Promise<void> {
    const jsonl = JSON.stringify({
      type: "user",
      cwd,
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
    it("keeps separate in-memory indexes for different projectIds sharing one sessionDir", async () => {
      const projectOne = "/Users/test/code/project-one";
      const projectTwo = "/Users/test/code/project-two";
      const projectOneId = encodeProjectId(projectOne);
      const projectTwoId = encodeProjectId(projectTwo);

      await createSessionForCwd("one", projectOne, "Project one");
      await createSessionForCwd("two", projectTwo, "Project two");

      const sessionsOne = await service.getSessionsWithCache(
        sessionDir,
        projectOneId,
        reader,
      );
      expect(sessionsOne.map((session) => session.id)).toEqual(["one"]);

      const sessionsTwo = await service.getSessionsWithCache(
        sessionDir,
        projectTwoId,
        reader,
      );
      expect(sessionsTwo.map((session) => session.id)).toEqual(["two"]);

      const sessionsOneAgain = await service.getSessionsWithCache(
        sessionDir,
        projectOneId,
        reader,
      );
      expect(sessionsOneAgain.map((session) => session.id)).toEqual(["one"]);
    });

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

      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const refreshed = await fastService.getSessionsWithCache(
          sessionDir,
          projectId,
          reader,
          { allowStale: true },
        );
        if (refreshed[0]?.title === "Updated content with a different length") {
          return;
        }
      }

      throw new Error("Background validation did not refresh the stale index");
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

    it("invalidates loaded codex scopes on codex file-change events", async () => {
      const eventBus = new EventBus();
      const codexService = new SessionIndexService({
        dataDir,
        projectsDir,
        eventBus,
        fullValidationIntervalMs: 60000,
      });
      await codexService.initialize();

      const codexSessionDir = join(testDir, "codex-sessions");
      await mkdir(codexSessionDir, { recursive: true });
      const codexFile = join(codexSessionDir, "session-1.jsonl");
      await writeFile(codexFile, "Original title\n");

      const codexReader: ISessionReader = {
        getIndexScopeKey: (sessionDir) => `codex::${sessionDir}::/tmp/project`,
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
          const title = (await readFile(codexFile, "utf-8")).trim();
          const stats = await stat(codexFile);
          return {
            id: sessionId,
            projectId,
            title,
            fullTitle: title,
            createdAt: new Date(stats.mtimeMs).toISOString(),
            updatedAt: new Date(stats.mtimeMs).toISOString(),
            messageCount: 1,
            ownership: { owner: "none" },
            provider: "codex",
          };
        },
        getAgentMappings: async () => [],
        getAgentSession: async () => null,
      };

      const first = await codexService.getSessionsWithCache(
        codexSessionDir,
        projectId,
        codexReader,
      );
      expect(first[0]?.title).toBe("Original title");

      await writeFile(codexFile, "Updated title\n");

      // Without an invalidation event, fast path should keep serving stale data.
      const stale = await codexService.getSessionsWithCache(
        codexSessionDir,
        projectId,
        codexReader,
      );
      expect(stale[0]?.title).toBe("Original title");

      eventBus.emit({
        type: "file-change",
        provider: "codex",
        path: codexFile,
        relativePath: "2025/03/28/session-1.jsonl",
        changeType: "modify",
        timestamp: new Date().toISOString(),
        fileType: "session",
      });

      const refreshed = await codexService.getSessionsWithCache(
        codexSessionDir,
        projectId,
        codexReader,
      );
      expect(refreshed[0]?.title).toBe("Updated title");
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
    it("rebuilds a version 7 index that cached an object session source", async () => {
      const legacySessionDir = join(projectsDir, "legacy-source");
      await mkdir(legacySessionDir, { recursive: true });
      const filePath = join(legacySessionDir, "session-1.jsonl");
      await writeFile(filePath, "{}\n");
      const stats = await stat(filePath);
      const legacyIndex = {
        version: 7,
        projectId,
        sessions: {
          "session-1": {
            title: "Legacy source",
            fullTitle: "Legacy source",
            createdAt: new Date(stats.mtimeMs).toISOString(),
            updatedAt: new Date(stats.mtimeMs).toISOString(),
            messageCount: 1,
            indexedBytes: stats.size,
            fileMtime: stats.mtimeMs,
            provider: "codex",
            source: { subagent: { other: "guardian" } },
          },
        },
      };
      await writeFile(
        service.getIndexPath(legacySessionDir),
        JSON.stringify(legacyIndex),
      );

      let parseCalls = 0;
      const legacyReader: ISessionReader = {
        listSessionFiles: async () => [{ sessionId: "session-1", filePath }],
        getSessionSummary: async (
          sessionId: string,
          projectId: string,
        ): Promise<SessionSummary> => {
          parseCalls += 1;
          return {
            id: sessionId,
            projectId,
            title: "Rebuilt source",
            fullTitle: "Rebuilt source",
            createdAt: new Date(stats.mtimeMs).toISOString(),
            updatedAt: new Date(stats.mtimeMs).toISOString(),
            messageCount: 1,
            ownership: { owner: "none" },
            provider: "codex",
            source: "subagent",
          };
        },
        getAgentMappings: async () => [],
        getAgentSession: async () => null,
      };

      const newService = new SessionIndexService({ dataDir, projectsDir });
      await newService.initialize();
      const sessions = await newService.getSessionsWithCache(
        legacySessionDir,
        projectId,
        legacyReader,
      );

      expect(parseCalls).toBe(1);
      expect(sessions[0]?.source).toBe("subagent");
    });

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
