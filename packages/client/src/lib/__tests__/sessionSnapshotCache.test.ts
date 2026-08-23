import { beforeEach, describe, expect, it } from "vitest";
import type { Message, Session } from "../../types";
import { SessionSnapshotCache } from "../sessionSnapshotCache";

function session(id: string): Session {
  return {
    id,
    projectId: "project" as Session["projectId"],
    title: null,
    fullTitle: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:01.000Z",
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "codex",
  };
}

function message(id: string, content: unknown = id): Message {
  return {
    id,
    type: "assistant",
    message: { role: "assistant", content: content as Message["content"] },
  };
}

function put(
  cache: SessionSnapshotCache,
  sessionId: string,
  writtenAt: number,
  messages = [message(`${sessionId}-message`)],
  historySource = "codex-rollout",
): boolean {
  return cache.put({
    projectId: "project",
    sessionId,
    historySource,
    session: session(sessionId),
    messages,
    revision: `revision-${writtenAt}`,
    writtenAt,
  });
}

describe("SessionSnapshotCache", () => {
  let cache: SessionSnapshotCache;

  beforeEach(() => {
    cache = new SessionSnapshotCache({
      maxEntries: 2,
      maxTotalBytes: 10_000,
      maxEntryBytes: 5_000,
    });
  });

  it("evicts the least recently used entry under the entry cap", () => {
    expect(put(cache, "a", 1)).toBe(true);
    expect(put(cache, "b", 2)).toBe(true);
    expect(cache.get({ projectId: "project", sessionId: "a" })).not.toBeNull();
    expect(put(cache, "c", 3)).toBe(true);

    expect(cache.get({ projectId: "project", sessionId: "a" })).not.toBeNull();
    expect(cache.get({ projectId: "project", sessionId: "b" })).toBeNull();
    expect(cache.get({ projectId: "project", sessionId: "c" })).not.toBeNull();
  });

  it("enforces the single-entry and total byte budgets", () => {
    const smallCache = new SessionSnapshotCache({
      maxEntries: 5,
      maxTotalBytes: 3_000,
      maxEntryBytes: 2_000,
    });
    expect(
      put(smallCache, "too-large", 1, [message("m", "x".repeat(2_000))]),
    ).toBe(false);
    expect(put(smallCache, "a", 2, [message("a", "x".repeat(100))])).toBe(true);
    expect(put(smallCache, "b", 3, [message("b", "x".repeat(100))])).toBe(true);
    expect(smallCache.getDebugStats().totalBytes).toBeLessThanOrEqual(3_000);
    expect(
      put(smallCache, "a", 4, [message("a-large", "x".repeat(2_000))]),
    ).toBe(false);
    expect(smallCache.get({ projectId: "project", sessionId: "a" })).toBeNull();
  });

  it("separates branch/source keys and returns the newest matching source", () => {
    put(cache, "a", 1, undefined, "codex-rollout");
    put(cache, "a", 2, undefined, "codex-app-server");

    expect(
      cache.get({ projectId: "project", sessionId: "a" })?.historySource,
    ).toBe("codex-app-server");
    expect(
      cache.get({
        projectId: "project",
        sessionId: "a",
        historySource: "codex-rollout",
      })?.historySource,
    ).toBe("codex-rollout");
    expect(
      cache.get({ projectId: "project", sessionId: "a", branchId: "other" }),
    ).toBeNull();
  });

  it("drops reasoning and inline media while preserving ordinary message references", () => {
    const ordinary = message("ordinary", "hello");
    const rich = message("rich", [
      { type: "thinking", thinking: "private reasoning" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "secret-bytes",
        },
      },
      { type: "text", text: "visible" },
    ]);
    put(cache, "a", 1, [ordinary, rich]);

    const snapshot = cache.get({ projectId: "project", sessionId: "a" });
    expect(snapshot?.messages[0]).toBe(ordinary);
    expect(snapshot?.messages[1]?.message?.content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png" },
      },
      { type: "text", text: "visible" },
    ]);
  });

  it("does not cache empty unmaterialized snapshots and invalidates by revision", () => {
    expect(put(cache, "empty", 1, [])).toBe(false);
    put(cache, "a", 2);
    expect(
      cache.invalidate({
        projectId: "project",
        sessionId: "a",
        revision: "revision-1",
      }),
    ).toBe(0);
    expect(
      cache.invalidate({
        projectId: "project",
        sessionId: "a",
        revision: "revision-2",
      }),
    ).toBe(1);
  });

  it("budgets a near-limit payload without serialization copies and preserves structural sharing", () => {
    const nearLimit = "x".repeat(5_500_000);
    const largeMessages = [message("large", nearLimit)];
    const largeCache = new SessionSnapshotCache({
      maxEntries: 2,
      maxTotalBytes: 20 * 1024 * 1024,
      maxEntryBytes: 12 * 1024 * 1024,
    });
    const startedAt = performance.now();
    expect(
      largeCache.put({
        projectId: "project",
        sessionId: "large",
        historySource: "codex-app-server",
        session: session("large"),
        messages: largeMessages,
        revision: "large-1",
      }),
    ).toBe(true);
    const durationMs = performance.now() - startedAt;
    const snapshot = largeCache.get({
      projectId: "project",
      sessionId: "large",
    });

    expect(durationMs).toBeLessThan(100);
    expect(snapshot?.messages).toBe(largeMessages);
    expect(snapshot?.messages[0]).toBe(largeMessages[0]);
    expect(snapshot?.estimatedBytes).toBeLessThanOrEqual(12 * 1024 * 1024);

    expect(
      put(largeCache, "second", 2, [message("second", "y".repeat(500_000))]),
    ).toBe(true);
    expect(
      put(largeCache, "third", 3, [message("third", "z".repeat(500_000))]),
    ).toBe(true);
    expect(
      largeCache.get({ projectId: "project", sessionId: "large" }),
    ).toBeNull();
    expect(largeCache.getDebugStats().totalBytes).toBeLessThanOrEqual(
      20 * 1024 * 1024,
    );
  });
});
