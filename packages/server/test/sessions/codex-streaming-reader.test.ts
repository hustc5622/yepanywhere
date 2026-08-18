import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { invalidateCodexSessionManifest } from "../../src/sessions/codex-session-manifest.js";
import { normalizeSession } from "../../src/sessions/normalization.js";

const projectId = "streaming-project" as UrlProjectId;

function meta(sessionId: string): Record<string, unknown> {
  return {
    type: "session_meta",
    timestamp: "2026-08-18T00:00:00.000Z",
    payload: {
      id: sessionId,
      cwd: "/tmp/streaming-project",
      timestamp: "2026-08-18T00:00:00.000Z",
      model_provider: "openai",
    },
  };
}

function message(
  role: "user" | "assistant",
  text: string,
  second: number,
): Record<string, unknown> {
  return {
    type: "response_item",
    timestamp: new Date(Date.UTC(2026, 7, 18, 0, 0, second)).toISOString(),
    payload: {
      type: "message",
      role,
      content: [
        {
          type: role === "user" ? "input_text" : "output_text",
          text,
        },
      ],
    },
  };
}

describe("Codex streaming reader windows", () => {
  let sessionsDir: string;
  let sessionId: string;

  beforeEach(async () => {
    sessionId = randomUUID();
    sessionsDir = join(tmpdir(), `codex-streaming-reader-${randomUUID()}`);
    await mkdir(sessionsDir, { recursive: true });
    const entries = [meta(sessionId)];
    for (let turn = 0; turn < 12; turn += 1) {
      entries.push(
        message("user", `prompt ${turn}`, turn * 2 + 1),
        message("assistant", `reply ${turn}`, turn * 2 + 2),
      );
    }
    await writeFile(
      join(sessionsDir, `rollout-${sessionId}.jsonl`),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
  });

  afterEach(async () => {
    invalidateCodexSessionManifest(sessionsDir);
    await rm(sessionsDir, { recursive: true, force: true });
  });

  it("applies the message cap before normalization and preserves total count", async () => {
    const reader = new CodexSessionReader({ sessionsDir });
    const loaded = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
    });
    expect(loaded?.paginationApplied).toBe(true);

    const session = loaded ? normalizeSession(loaded) : null;
    expect(session?.messages.map((item) => item.message?.content)).toEqual([
      [{ type: "text", text: "reply 9" }],
      [{ type: "text", text: "prompt 10" }],
      [{ type: "text", text: "reply 10" }],
      [{ type: "text", text: "prompt 11" }],
      [{ type: "text", text: "reply 11" }],
    ]);
    expect(loaded?.pagination).toMatchObject({
      totalMessageCount: 24,
      returnedMessageCount: 5,
      hasOlderMessages: true,
      hasNewerMessages: false,
    });
    expect(loaded?.pagination?.rolloutRevision).toBeTruthy();
  });

  it("rejects a cursor from a replaced rollout revision", async () => {
    const reader = new CodexSessionReader({ sessionsDir });
    const first = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
    });
    const rolloutPath = join(sessionsDir, `rollout-${sessionId}.jsonl`);
    await writeFile(
      rolloutPath,
      `${JSON.stringify(message("assistant", "new tail", 99))}\n`,
      { encoding: "utf8", flag: "a" },
    );

    await expect(
      reader.getSession(sessionId, projectId, undefined, {
        maxMessages: 5,
        beforeMessageId: first?.pagination?.truncatedBeforeMessageId,
        rolloutRevision: first?.pagination?.rolloutRevision,
      }),
    ).rejects.toThrow("ROLLOUT_CURSOR_STALE");
  });

  it("uses byte-anchored cursors for older and centered windows", async () => {
    const reader = new CodexSessionReader({ sessionsDir });
    const first = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
    });
    const firstMessages = first ? normalizeSession(first).messages : [];
    const before = first?.pagination?.truncatedBeforeMessageId;
    expect(before).toBeTruthy();

    const older = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
      beforeMessageId: before,
      rolloutRevision: first?.pagination?.rolloutRevision,
    });
    const olderMessages = older ? normalizeSession(older).messages : [];
    expect(olderMessages).toHaveLength(5);
    expect(olderMessages[0]?.message?.content).toEqual([
      { type: "text", text: "prompt 7" },
    ]);
    expect(older?.pagination).toMatchObject({
      hasOlderMessages: true,
      hasNewerMessages: true,
      totalMessageCount: 24,
    });

    const target = firstMessages[2]?.uuid;
    expect(target).toBeTruthy();
    const centered = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
      aroundMessageId: target,
      rolloutRevision: first?.pagination?.rolloutRevision,
    });
    const centeredMessages = centered
      ? normalizeSession(centered).messages
      : [];
    expect(centeredMessages).toHaveLength(5);
    expect(centeredMessages.map((item) => item.uuid)).toContain(target);
    expect(centered?.pagination?.targetMessageFound).toBe(true);
  });

  it("keeps the first messages after an after-window cursor instead of the tail", async () => {
    const reader = new CodexSessionReader({ sessionsDir });
    const first = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
    });
    const revision = first?.pagination?.rolloutRevision;
    const before = first?.pagination?.truncatedBeforeMessageId;
    expect(before).toBeTruthy();

    const older = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 5,
      beforeMessageId: before,
      rolloutRevision: revision,
    });
    expect(older?.pagination?.hasNewerMessages).toBe(true);
    const afterCursor = older?.pagination?.truncatedAfterMessageId;
    expect(afterCursor).toBeTruthy();

    const next = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: 3,
      afterWindowMessageId: afterCursor,
      rolloutRevision: revision,
    });
    const nextMessages = next ? normalizeSession(next).messages : [];
    expect(nextMessages.map((item) => item.message?.content)).toEqual([
      [{ type: "text", text: "reply 9" }],
      [{ type: "text", text: "prompt 10" }],
      [{ type: "text", text: "reply 10" }],
    ]);
    expect(next?.pagination).toMatchObject({
      hasOlderMessages: true,
      hasNewerMessages: true,
      totalMessageCount: 24,
      returnedMessageCount: 3,
    });
  });
});
