import { describe, expect, it, vi } from "vitest";
import {
  type CodexEventEnvelope,
  type CodexEventStore,
  overlayCanonicalCodexSessionMessages,
  selectCodexEventSource,
} from "../../src/codex-events/index.js";
import type { Message } from "../../src/supervisor/types.js";
import { testEvent } from "./helpers.js";

describe("canonical Codex persisted session projection", () => {
  it("enriches the matching legacy row with the live-equivalent native item", () => {
    const legacy: Message[] = [
      {
        uuid: "legacy-agent",
        type: "assistant",
        timestamp: "2026-08-08T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello from Codex" }],
        },
      },
    ];
    const events = [
      testEvent(
        1,
        "item/completed",
        {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "agent-1",
            type: "agentMessage",
            text: "hello from Codex",
            phase: "final_answer",
          },
        },
        { receivedAtMs: Date.parse("2026-08-08T00:00:01.000Z") },
      ),
    ];

    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      legacy,
      events,
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      uuid: "legacy-agent",
      codexCanonicalRefresh: true,
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      codexEventSequence: 1,
      codexThreadItemLifecycle: "completed",
      codexRawReasoningAllowed: false,
      codexThreadItem: {
        id: "agent-1",
        type: "agentMessage",
        text: "hello from Codex",
        phase: "final_answer",
      },
    });
  });

  it("attaches only unexpired, source-matched generated artifact manifests", () => {
    const events = [
      testEvent(1, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "file-1",
          type: "fileChange",
          status: "completed",
          changes: [{ path: "report.txt", kind: { type: "add" } }],
        },
      }),
    ];
    const artifact = {
      schemaVersion: 1 as const,
      id: "ga_0123456789abcdef0123456789abcdef",
      managedRef: "upload:12345678-1234-1234-1234-123456789abc",
      fileName: "report.txt",
      kind: "text" as const,
      mimeType: "text/plain",
      sizeBytes: 12,
      sha256: `sha256:${"a".repeat(64)}`,
      source: {
        provider: "codex" as const,
        type: "file_change" as const,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "file-1",
      },
      retention: {
        policy: "temporary" as const,
        expiresAt: "2026-08-09T00:00:00.000Z",
      },
      downloadUrl: `/api/projects/project-1/sessions/session-1/generated-artifact/ga_0123456789abcdef0123456789abcdef/${"a".repeat(64)}/report.txt`,
    };

    const liveEquivalent = overlayCanonicalCodexSessionMessages(
      "session-1",
      [],
      events,
      {
        generatedArtifacts: [
          artifact,
          {
            ...artifact,
            id: "ga_ffffffffffffffffffffffffffffffff",
            source: { ...artifact.source, itemId: "other-item" },
            downloadUrl: `/api/projects/project-1/sessions/session-1/generated-artifact/ga_ffffffffffffffffffffffffffffffff/${"a".repeat(64)}/report.txt`,
          },
        ],
        nowMs: Date.parse("2026-08-08T00:00:00.000Z"),
      },
    );
    expect(liveEquivalent.messages[0]?.codexGeneratedArtifacts).toEqual([
      artifact,
    ]);

    const expired = overlayCanonicalCodexSessionMessages(
      "session-1",
      [],
      events,
      {
        generatedArtifacts: [artifact],
        nowMs: Date.parse("2026-08-09T00:00:00.000Z"),
      },
    );
    expect(expired.messages[0]?.codexGeneratedArtifacts).toBeUndefined();
  });

  it("omits raw reasoning, commands, artifact paths, diffs, and generated prompts", () => {
    const events = [
      testEvent(1, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "reasoning-1",
          type: "reasoning",
          summary: ["Safe summary"],
          content: ["private chain of thought"],
        },
      }),
      testEvent(2, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "cat /Users/example/.env && echo sk-private-token-value",
          cwd: "/Users/example/private-project",
          scriptPath: "/Users/example/plugin/run.sh",
          aggregatedOutput: "PASSWORD=do-not-show",
          status: "completed",
          exitCode: 0,
        },
      }),
      testEvent(3, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "change-1",
          type: "fileChange",
          status: "completed",
          changes: [
            {
              path: "/Users/example/private-project/.env",
              kind: "update",
              diff: "+API_KEY=do-not-show",
            },
          ],
        },
      }),
      testEvent(4, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "image-1",
          type: "imageGeneration",
          status: "completed",
          revisedPrompt: "private prompt",
          savedPath: "/Users/example/secret.png",
          result: "private image bytes",
        },
      }),
    ];

    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      [],
      events,
    );
    const serialized = JSON.stringify(result.messages);

    expect(serialized).toContain("Safe summary");
    expect(serialized).toContain("[command hidden in persisted refresh]");
    expect(serialized).toContain("[path hidden]");
    expect(serialized).not.toContain("private chain of thought");
    expect(serialized).not.toContain("/Users/example");
    expect(serialized).not.toContain("sk-private-token-value");
    expect(serialized).not.toContain("PASSWORD=do-not-show");
    expect(serialized).not.toContain("API_KEY=do-not-show");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private image bytes");
  });

  it("rebuilds safe unknown, retry, and resolved interaction semantics", () => {
    const request = {
      ...testEvent(
        1,
        "item/tool/requestUserInput",
        {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "question-1",
          questions: [{ id: "password", prompt: "Never echo this" }],
        },
        { direction: "server_request", eventId: "request-event" },
      ),
      requestId: "request-1",
      correlationId: "server-request:request-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "question-1",
    } satisfies CodexEventEnvelope;
    const response = {
      ...testEvent(
        2,
        "item/tool/requestUserInput",
        { result: { answers: { password: "do-not-show" } } },
        { direction: "client_response", eventId: "response-event" },
      ),
      phase: "resolved" as const,
      requestId: "request-1",
      correlationId: "server-request:request-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "question-1",
    } satisfies CodexEventEnvelope;
    const retry = {
      ...testEvent(
        3,
        "turn/start",
        {
          retryStatus: {
            state: "queued",
            category: "overloaded",
            retryable: true,
            attempt: 1,
            nextAttempt: 2,
            maxAttempts: 4,
            retryInMs: 250,
          },
        },
        { direction: "client_response", eventId: "retry-event" },
      ),
      phase: "observed" as const,
      requestId: 7,
      correlationId: "client-retry:7:1",
    } satisfies CodexEventEnvelope;
    const unknown = testEvent(
      4,
      "future/privateEvent",
      { path: "/Users/example/private", token: "do-not-show" },
      { eventId: "unknown-event" },
    );

    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      [],
      [request, response, retry, unknown],
    );
    const retryMessage = result.messages.find(
      (message) => message.warningKind === "codex_app_server_overloaded",
    );
    const interactionMessage = result.messages.find(
      (message) => message.warningKind === "codex_interaction",
    );
    const unknownMessage = result.messages.find(
      (message) => message.warningKind === "unknown_codex_notification",
    );

    expect(retryMessage?.codexRetryStatus).toEqual({
      state: "queued",
      category: "overloaded",
      retryable: true,
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 4,
      retryInMs: 250,
    });
    expect(interactionMessage?.codexInteraction).toEqual({
      method: "item/tool/requestUserInput",
      status: "resolved",
      requestId: "request-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "question-1",
      sequence: 1,
      resolvedSequence: 2,
    });
    expect(unknownMessage).toMatchObject({
      codexEventMethod: "future/privateEvent",
      warningKind: "unknown_codex_notification",
    });
    const serialized = JSON.stringify(result.messages);
    expect(serialized).not.toContain("Never echo this");
    expect(serialized).not.toContain("do-not-show");
    expect(serialized).not.toContain("/Users/example/private");
  });

  it("selects one provider-first journal and never merges bridge sequences", async () => {
    const providerEvents = [testEvent(1, "warning", { message: "provider" })];
    const bridgeEvents = [testEvent(1, "warning", { message: "bridge" })];
    const provider = fixedStore(providerEvents);
    const bridge = fixedStore(bridgeEvents);

    const selected = await selectCodexEventSource(
      [
        { id: "provider", createStore: () => provider.store },
        { id: "bridge", createStore: () => bridge.store },
      ],
      "session-1",
    );

    expect(selected).toEqual({
      sourceId: "provider",
      events: providerEvents,
    });
    expect(provider.replay).toHaveBeenCalledOnce();
    expect(bridge.replay).not.toHaveBeenCalled();
  });

  it("preserves the legacy fallback when no canonical journal exists", () => {
    const legacy: Message[] = [
      {
        uuid: "legacy-only",
        type: "assistant",
        message: { role: "assistant", content: "legacy" },
      },
    ];

    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      legacy,
      [],
    );

    expect(result.messages).toEqual(legacy);
    expect(result.projectedMessageCount).toBe(0);
  });

  it("fails closed instead of projecting a mixed-session journal", () => {
    expect(() =>
      overlayCanonicalCodexSessionMessages(
        "session-1",
        [],
        [
          testEvent(
            1,
            "item/completed",
            {
              threadId: "thread-other",
              turnId: "turn-other",
              item: {
                id: "agent-other",
                type: "agentMessage",
                text: "must not cross sessions",
              },
            },
            { sessionId: "session-2" },
          ),
        ],
      ),
    ).toThrow("cannot mix session journals");
  });
});

function fixedStore(events: CodexEventEnvelope[]): {
  store: CodexEventStore;
  replay: ReturnType<typeof vi.fn>;
} {
  const replay = vi.fn(async () => structuredClone(events));
  return {
    replay,
    store: {
      append: vi.fn(),
      appendMany: vi.fn(),
      replay,
      latestSequence: vi.fn(async () => events.at(-1)?.sequence ?? 0),
    } as unknown as CodexEventStore,
  };
}
