import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LoadSessionMessages,
  SessionContentIndexService,
} from "../../src/indexes/SessionContentIndexService.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import { SessionReader } from "../../src/sessions/reader.js";

describe("SessionContentIndexService", () => {
  let testDir: string;
  let dataDir: string;
  let projectsDir: string;
  let sessionDir: string;
  let service: SessionContentIndexService;
  let reader: SessionReader;
  let projectId: string;
  let loadMessages: LoadSessionMessages;

  beforeEach(async () => {
    testDir = join(tmpdir(), `content-index-test-${randomUUID()}`);
    dataDir = join(testDir, "content");
    projectsDir = join(testDir, "projects");
    sessionDir = join(projectsDir, "test-project");

    await mkdir(dataDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    service = new SessionContentIndexService({ dataDir, projectsDir });
    await service.initialize();

    reader = new SessionReader({ sessionDir });
    projectId = toUrlProjectId("/test/project");

    loadMessages = async (sessionId, pid, r) => {
      const loaded = await r.getSession(sessionId, pid, undefined, {
        includeOrphans: false,
      });
      if (!loaded) return null;
      const session = normalizeSession(loaded);
      return {
        messages: session.messages,
        title: session.title,
        updatedAt: session.updatedAt,
        provider: session.provider,
      };
    };
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /** Write a minimal two-message Claude session (user + assistant). */
  async function createSession(
    sessionId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    const userEntry = JSON.stringify({
      type: "user",
      uuid: `${sessionId}-u`,
      parentUuid: null,
      message: { role: "user", content: userText },
      timestamp: new Date().toISOString(),
    });
    const assistantEntry = JSON.stringify({
      type: "assistant",
      uuid: `${sessionId}-a`,
      parentUuid: `${sessionId}-u`,
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistantText }],
      },
      timestamp: new Date().toISOString(),
    });
    await writeFile(
      join(sessionDir, `${sessionId}.jsonl`),
      `${userEntry}\n${assistantEntry}\n`,
    );
  }

  it("indexes message content and finds matches with snippets", async () => {
    await createSession(
      "s1",
      "How do I run database migrations?",
      "Use drizzle",
    );

    const index = await service.ensureIndexed(
      sessionDir,
      projectId,
      reader,
      loadMessages,
    );
    const results = service.searchScope(index, "migrations", 3);

    expect(results).toHaveLength(1);
    expect(results[0]?.sessionId).toBe("s1");
    expect(results[0]?.matchCount).toBe(1);
    const match = results[0]?.matches[0];
    expect(match?.messageId).toBe("s1-u");
    expect(
      match?.snippet
        .slice(match.matchStart, match.matchStart + match.matchLength)
        .toLowerCase(),
    ).toBe("migrations");
  });

  it("matches assistant replies as well as user prompts", async () => {
    await createSession("s1", "hello", "The answer involves a unicorn");

    const index = await service.ensureIndexed(
      sessionDir,
      projectId,
      reader,
      loadMessages,
    );
    const results = service.searchScope(index, "unicorn", 3);
    expect(results).toHaveLength(1);
    expect(results[0]?.matches[0]?.messageId).toBe("s1-a");
    expect(results[0]?.matches[0]?.role).toBe("assistant");
  });

  it("returns no results when nothing matches", async () => {
    await createSession("s1", "hello", "world");
    const index = await service.ensureIndexed(
      sessionDir,
      projectId,
      reader,
      loadMessages,
    );
    expect(service.searchScope(index, "nonexistent", 3)).toHaveLength(0);
  });

  it("can restrict content matches to one session", async () => {
    await createSession("s1", "shared search term", "first answer");
    await createSession("s2", "shared search term", "second answer");
    const index = await service.ensureIndexed(
      sessionDir,
      projectId,
      reader,
      loadMessages,
    );

    const results = service.searchScope(index, "shared", 200, "s2");

    expect(results).toHaveLength(1);
    expect(results[0]?.sessionId).toBe("s2");
    expect(results[0]?.matches[0]?.messageId).toBe("s2-u");
  });

  it("re-indexes a session after its file changes (mtime invalidation)", async () => {
    await createSession("s1", "original question", "original answer");
    let index = await service.ensureIndexed(
      sessionDir,
      projectId,
      reader,
      loadMessages,
    );
    expect(service.searchScope(index, "original", 3)).toHaveLength(1);

    // Rewrite with different content and bump mtime to force invalidation.
    await createSession("s1", "updated question", "updated answer");
    const future = new Date(Date.now() + 5000);
    await utimes(join(sessionDir, "s1.jsonl"), future, future);

    index = await service.ensureIndexed(
      sessionDir,
      projectId,
      reader,
      loadMessages,
    );
    expect(service.searchScope(index, "original", 3)).toHaveLength(0);
    expect(service.searchScope(index, "updated", 3)).toHaveLength(1);
  });

  it("drops sessions whose files were deleted", async () => {
    await createSession("s1", "keep me", "answer");
    await createSession("s2", "delete me", "answer");
    let index = await service.ensureIndexed(
      sessionDir,
      projectId,
      reader,
      loadMessages,
    );
    expect(Object.keys(index.sessions)).toHaveLength(2);

    await rm(join(sessionDir, "s2.jsonl"));
    index = await service.ensureIndexed(
      sessionDir,
      projectId,
      reader,
      loadMessages,
    );
    expect(Object.keys(index.sessions)).toContain("s1");
    expect(Object.keys(index.sessions)).not.toContain("s2");
  });

  it("persists the index to disk", async () => {
    await createSession("s1", "persisted content", "answer");
    await service.ensureIndexed(sessionDir, projectId, reader, loadMessages);

    const indexPath = service.getIndexPath(sessionDir, reader);
    const stats = await stat(indexPath);
    expect(stats.isFile()).toBe(true);
  });
});
