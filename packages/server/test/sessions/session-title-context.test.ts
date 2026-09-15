import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { invalidateCodexSessionManifest } from "../../src/sessions/codex-session-manifest.js";
import { extractSessionTitleTranscript } from "../../src/sessions/session-message-text.js";
import { loadSessionTitleContext } from "../../src/sessions/session-title-context.js";
import type { LoadedSession } from "../../src/sessions/types.js";
import type { Message } from "../../src/supervisor/types.js";

const projectId = "project-1" as UrlProjectId;
const user = (id: string, text: string): Message => ({
  id,
  type: "user",
  content: text,
});

function page(
  messages: Message[],
  cursor?: string,
  revision = "revision-1",
): LoadedSession {
  return {
    summary: {
      id: "session-1",
      projectId,
      title: "继续吧",
      fullTitle: "继续吧",
      provider: "codex",
      createdAt: "2026-09-15T00:00:00Z",
      updatedAt: "2026-09-15T01:00:00Z",
      messageCount: messages.length,
      ownership: { owner: "none" },
    },
    data: { provider: "codex", session: { entries: [] } },
    projectedMessages: messages,
    historySource: "codex-rollout",
    pagination: {
      hasOlderMessages: Boolean(cursor),
      truncatedBeforeMessageId: cursor,
      totalMessageCount: 10,
      returnedMessageCount: messages.length,
      totalCompactions: 0,
      rolloutRevision: revision,
    },
  };
}

describe("loadSessionTitleContext", () => {
  it("restores the original request and chronological turns across all pages", async () => {
    const original = user("original", "建立通用失败证据采集与展示机制");
    const middle = user("middle", "继续吧");
    const latest = user("latest", "继续吧");
    const getSession = vi
      .fn()
      .mockResolvedValueOnce(page([middle, latest], "cursor-middle"))
      .mockResolvedValueOnce(page([original, middle], "cursor-original"))
      .mockResolvedValueOnce(page([original]));

    const session = await loadSessionTitleContext(
      { getSession },
      "session-1",
      projectId,
    );

    expect(session?.messages.map((message) => message.id)).toEqual([
      "original",
      "middle",
      "latest",
    ]);
    expect(session?.messageCount).toBe(3);
    expect(getSession).toHaveBeenNthCalledWith(
      2,
      "session-1",
      projectId,
      undefined,
      {
        includeOrphans: false,
        beforeMessageId: "cursor-middle",
        rolloutRevision: "revision-1",
      },
    );
    expect(getSession).toHaveBeenCalledTimes(3);
    if (!session) throw new Error("Expected session");
    expect(
      extractSessionTitleTranscript(session).map((entry) => entry.text),
    ).toEqual([original.content, "继续吧", "继续吧"]);
  });

  it("keeps non-paginated providers on a single read", async () => {
    const loaded = page([user("first", "原始需求")]);
    loaded.pagination = undefined;
    const getSession = vi.fn().mockResolvedValue(loaded);
    expect(
      (await loadSessionTitleContext({ getSession }, "session-1", projectId))
        ?.messages,
    ).toHaveLength(1);
    expect(getSession).toHaveBeenCalledOnce();
  });

  it("returns null only when the initial session is missing", async () => {
    const getSession = vi.fn().mockResolvedValue(null);
    expect(
      await loadSessionTitleContext({ getSession }, "session-1", projectId),
    ).toBeNull();
  });

  it("includes inherited fork history from the preferred reader", async () => {
    const getSession = vi.fn();
    const preferred = {
      getSession: vi
        .fn()
        .mockResolvedValueOnce(page([user("child", "继续吧")], "native-cursor"))
        .mockResolvedValueOnce(
          page([user("parent", "原始需求：通用断言展示")]),
        ),
    };
    const session = await loadSessionTitleContext(
      { getSession },
      "session-1",
      projectId,
      preferred,
    );
    expect(session?.messages.map((message) => message.id)).toEqual([
      "parent",
      "child",
    ]);
    expect(getSession).not.toHaveBeenCalled();
    expect(preferred.getSession).toHaveBeenCalledTimes(2);
  });

  it("falls back only when the preferred source cannot serve the first page", async () => {
    const getSession = vi
      .fn()
      .mockResolvedValue(page([user("first", "旧版完整历史")]));
    const preferred = { getSession: vi.fn().mockResolvedValue(null) };
    const session = await loadSessionTitleContext(
      { getSession },
      "session-1",
      projectId,
      preferred,
    );
    expect(session?.messages).toHaveLength(1);
    expect(getSession).toHaveBeenCalledOnce();
    expect(preferred.getSession).toHaveBeenCalledOnce();
  });

  it("does not substitute local fork history if a later native page is unavailable", async () => {
    const getSession = vi.fn();
    const preferred = {
      getSession: vi
        .fn()
        .mockResolvedValueOnce(page([user("child", "继续吧")], "native-cursor"))
        .mockResolvedValueOnce(null),
    };
    await expect(
      loadSessionTitleContext(
        { getSession },
        "session-1",
        projectId,
        preferred,
      ),
    ).rejects.toThrow("history disappeared");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("rejects a suffix-only paginated fork when native history is unavailable", async () => {
    const loaded = page([user("child", "继续吧")]);
    loaded.data = {
      provider: "codex",
      session: {
        entries: [
          {
            type: "session_meta",
            timestamp: "2026-09-15T00:00:00Z",
            payload: {
              id: "session-1",
              cwd: "/test/project",
              forked_from_id: "parent-session",
              forked_from_ordinal_exclusive: 385,
            },
          },
        ],
      },
    };
    const getSession = vi.fn().mockResolvedValue(loaded);
    await expect(
      loadSessionTitleContext({ getSession }, "session-1", projectId),
    ).rejects.toThrow("inherited Codex fork messages");
  });

  it.each(["missing cursor", "repeated cursor", "missing page"])(
    "rejects incomplete history with %s instead of returning the tail",
    async (scenario) => {
      const tail = page([user("latest", "打 tag")], "cursor");
      if (scenario === "missing cursor" && tail.pagination) {
        tail.pagination.truncatedBeforeMessageId = undefined;
      }
      const getSession = vi.fn().mockResolvedValue(tail);
      if (scenario === "missing page")
        getSession.mockResolvedValueOnce(tail).mockResolvedValueOnce(null);
      await expect(
        loadSessionTitleContext({ getSession }, "session-1", projectId),
      ).rejects.toThrow(/history/);
      expect(getSession.mock.calls.length).toBeLessThanOrEqual(2);
    },
  );

  it("restarts a changed snapshot without retaining messages from the stale tail", async () => {
    const getSession = vi
      .fn()
      .mockResolvedValueOnce(page([user("stale", "旧分支")], "cursor"))
      .mockRejectedValueOnce(new Error("ROLLOUT_CURSOR_STALE"))
      .mockResolvedValueOnce(
        page([user("latest", "新进度")], "new-cursor", "revision-2"),
      )
      .mockResolvedValueOnce(
        page([user("first", "原始需求")], undefined, "revision-2"),
      );
    const session = await loadSessionTitleContext(
      { getSession },
      "session-1",
      projectId,
    );
    expect(session?.messages.map((message) => message.id)).toEqual([
      "first",
      "latest",
    ]);
  });

  it("stops after bounded retries when the rollout keeps changing", async () => {
    const getSession = vi
      .fn()
      .mockRejectedValue(new Error("ROLLOUT_CHANGED_DURING_SCAN"));
    await expect(
      loadSessionTitleContext({ getSession }, "session-1", projectId),
    ).rejects.toThrow("ROLLOUT_CHANGED_DURING_SCAN");
    expect(getSession).toHaveBeenCalledTimes(3);
  });

  it("loads a real Codex rollout beyond the default page, including a long first request", async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), "title-history-"));
    try {
      const sessionId = randomUUID();
      const timestamp = "2026-09-15T00:00:00Z";
      const original = `最初的需求：${"通用失败证据采集与展示。".repeat(500)}不得逐个 Case 适配`;
      const messages = Array.from({ length: 260 }, (_, index) => ({
        type: "response_item",
        timestamp,
        payload: {
          type: "message",
          role: index % 2 === 0 ? "user" : "assistant",
          content: [
            {
              type: index % 2 === 0 ? "input_text" : "output_text",
              text: index === 0 ? original : `进度 ${index}`,
            },
          ],
        },
      }));
      await writeFile(
        join(sessionsDir, `rollout-${sessionId}.jsonl`),
        [
          {
            type: "session_meta",
            timestamp,
            payload: { id: sessionId, timestamp, cwd: "/test/project" },
          },
          ...messages,
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );
      const reader = new CodexSessionReader({ sessionsDir });
      const getSession = vi.spyOn(reader, "getSession");
      const session = await loadSessionTitleContext(
        reader,
        sessionId,
        projectId,
      );
      if (!session) throw new Error("Expected session");
      const transcript = extractSessionTitleTranscript(session);
      expect(getSession.mock.calls.length).toBeGreaterThan(1);
      expect(transcript).toHaveLength(260);
      expect(transcript[0]).toEqual({ kind: "user", text: original });
      expect(transcript.at(-1)?.text).toBe("进度 259");
    } finally {
      invalidateCodexSessionManifest(sessionsDir);
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });
});
