import { describe, expect, it, vi } from "vitest";
import {
  type CodexEventEnvelope,
  type CodexEventStore,
  CodexProjectionCache,
  assessCanonicalOverlayViability,
  overlayCanonicalCodexSessionMessages,
  selectCodexEventSource,
  selectCodexEventSourceWithCache,
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

  it("keeps item identity matches stable when earlier synthetic rows are inserted", () => {
    const legacy: Message[] = [
      {
        id: "legacy-target",
        uuid: "legacy-target",
        type: "assistant",
        itemId: "target",
        timestamp: new Date(10_000).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "legacy target" }],
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
            id: "unmatched",
            type: "agentMessage",
            text: "unmatched",
          },
        },
        { eventId: "unmatched-event" },
      ),
      testEvent(
        2,
        "item/completed",
        {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "target",
            type: "agentMessage",
            text: "canonical target",
          },
        },
        { eventId: "target-event" },
      ),
    ];

    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      legacy,
      events,
    );

    expect(result.messages).toHaveLength(2);
    expect(
      result.messages.find((message) => message.uuid === "legacy-target")
        ?.codexThreadItem,
    ).toMatchObject({ id: "target" });
    expect(
      result.messages.find((message) => message.uuid !== "legacy-target")
        ?.codexThreadItem,
    ).toMatchObject({ id: "unmatched" });
  });

  it("windows candidate construction to the recent event tail", () => {
    const events = Array.from({ length: 5 }, (_, index) =>
      testEvent(
        index + 1,
        "item/completed",
        {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: `item-${index + 1}`,
            type: "agentMessage",
            text: `answer-${index + 1}`,
          },
        },
        { eventId: `event-${index + 1}` },
      ),
    );

    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      [],
      events,
      { maxCandidateCount: 2 },
    );

    expect(
      result.messages.map((message) => message.codexEventSequence),
    ).toEqual([4, 5]);
  });

  it("keeps current thread goal state outside the recent item window", () => {
    const events = [
      testEvent(1, "thread/goal/updated", {
        threadId: "thread-1",
        goal: {
          threadId: "thread-1",
          objective: "Ship safely",
          status: "active",
          tokenBudget: 10_000,
          tokensUsed: 100,
          timeUsedSeconds: 2,
          createdAt: 1,
          updatedAt: 2,
        },
      }),
      testEvent(2, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "older", type: "agentMessage", text: "older" },
      }),
      testEvent(3, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "latest", type: "agentMessage", text: "latest" },
      }),
    ];

    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      [],
      events,
      { maxCandidateCount: 1 },
    );

    expect(
      result.messages.some(
        (message) => message.codexThreadItem?.type === "threadGoal",
      ),
    ).toBe(true);
    expect(
      result.messages.some(
        (message) => message.codexThreadItem?.id === "latest",
      ),
    ).toBe(true);
  });

  it("keeps an old item whose lifecycle was touched inside the recent window", () => {
    const events = [
      testEvent(1, "item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "active-item", type: "agentMessage", text: "" },
      }),
      testEvent(2, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "older-item", type: "agentMessage", text: "older" },
      }),
      testEvent(3, "item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "active-item",
        delta: "recent text",
      }),
    ];

    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      [],
      events,
      { maxCandidateCount: 1 },
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.codexThreadItem).toMatchObject({
      id: "active-item",
    });
    expect(JSON.stringify(result.messages[0])).toContain("recent text");
  });

  it("keeps an old interaction request resolved inside the recent window", () => {
    const request = {
      ...testEvent(
        1,
        "item/tool/requestUserInput",
        { threadId: "thread-1", turnId: "turn-1", itemId: "question-1" },
        { direction: "server_request", eventId: "request-event" },
      ),
      requestId: "request-1",
      correlationId: "server-request:request-1",
    } satisfies CodexEventEnvelope;
    const olderItem = testEvent(2, "item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "older-item", type: "agentMessage", text: "older" },
    });
    const response = {
      ...testEvent(
        3,
        "item/tool/requestUserInput",
        { result: { answers: {} } },
        { direction: "client_response", eventId: "response-event" },
      ),
      phase: "resolved" as const,
      requestId: "request-1",
      correlationId: "server-request:request-1",
    } satisfies CodexEventEnvelope;

    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      [],
      [request, olderItem, response],
      { maxCandidateCount: 1 },
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      warningKind: "codex_interaction",
      codexInteraction: { status: "resolved", resolvedSequence: 3 },
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

  it("rebuilds provider retries and keeps their cause after retries are exhausted", () => {
    const retry = testEvent(
      1,
      "error",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: true,
        error: {
          code: "CODEX_OVERLOADED",
          category: "overloaded",
          retryable: true,
          message: "server overloaded",
          publicMessage:
            "Codex is busy and cannot process the request right now.",
          nextAction: "Try again shortly.",
        },
      },
      { receivedAtMs: 1_000 },
    );
    const exhausted = testEvent(
      2,
      "error",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: {
          code: "CODEX_UNKNOWN",
          category: "unknown",
          retryable: false,
          message: "unknown Codex error",
          publicMessage:
            "Codex encountered an unclassified error before the task completed.",
          nextAction:
            "Try again; if the problem persists, inspect diagnostics in Yep.",
        },
      },
      { receivedAtMs: 2_000 },
    );

    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      [],
      [retry, exhausted],
    );

    expect(result.messages).toEqual([
      expect.objectContaining({
        type: "system",
        subtype: "warning",
        content:
          "Codex is busy and cannot process the request right now. Codex is retrying automatically; keep this turn running.",
        warningKind: "codex_provider_retry",
        willRetry: true,
        codexEventSequence: 1,
        codexError: expect.objectContaining({
          code: "CODEX_OVERLOADED",
          category: "overloaded",
        }),
      }),
      expect.objectContaining({
        type: "error",
        error: "Codex is busy and cannot process the request right now.",
        willRetry: false,
        codexRetryExhausted: true,
        codexEventSequence: 2,
        codexError: expect.objectContaining({
          code: "CODEX_OVERLOADED",
          category: "overloaded",
        }),
      }),
    ]);
  });

  it("does not leave stale failed turn health after a later successful turn", () => {
    const failed = testEvent(1, "error", {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: {
        message: "server overloaded",
        codexErrorInfo: "serverOverloaded",
      },
    });
    const failedCompletion = testEvent(2, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "failed", error: null, items: [] },
    });
    const successfulCompletion = testEvent(3, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "completed", error: null, items: [] },
    });

    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      [],
      [failed, failedCompletion, successfulCompletion],
    );

    expect(result.turnHealth).toEqual({ lastTurnStatus: "completed" });
    expect(result.messages).toEqual([
      expect.objectContaining({
        type: "error",
        codexError: expect.objectContaining({ code: "CODEX_OVERLOADED" }),
      }),
    ]);
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

  it("returns a complete replay on warm cache hits and invalidates changed prefixes", async () => {
    const original = testEvent(1, "warning", { message: "original" });
    const replacement = testEvent(
      1,
      "warning",
      { message: "replacement" },
      { eventId: "replacement-event" },
    );
    let replayed = [original];
    const store = {
      replay: vi.fn(async () => structuredClone(replayed)),
    } as unknown as CodexEventStore;
    const sources = [{ id: "provider", createStore: () => store }];
    const cache = new CodexProjectionCache();

    const cold = await selectCodexEventSourceWithCache(
      sources,
      "session-1",
      cache,
    );
    expect(cold).toMatchObject({ warm: false, events: [original] });
    if (!cold) throw new Error("missing cold source");
    cache.apply(cold.sourceId, "session-1", cold.events);

    const warm = await selectCodexEventSourceWithCache(
      sources,
      "session-1",
      cache,
    );
    expect(warm).toMatchObject({ warm: true, events: [original] });

    replayed = [replacement];
    const rotated = await selectCodexEventSourceWithCache(
      sources,
      "session-1",
      cache,
    );
    expect(rotated).toMatchObject({ warm: false, events: [replacement] });
    expect(cache.getLastSequence("provider", "session-1")).toBe(0);
  });

  it("keeps a warm projection when the replay contains deduplicated rows", async () => {
    const accepted = testEvent(
      1,
      "warning",
      { message: "accepted" },
      { eventId: "accepted-event", dedupeKey: "same-notification" },
    );
    const duplicate = testEvent(
      2,
      "warning",
      { message: "duplicate" },
      { eventId: "duplicate-event", dedupeKey: "same-notification" },
    );
    const store = fixedStore([accepted, duplicate]);
    const sources = [{ id: "provider", createStore: () => store.store }];
    const cache = new CodexProjectionCache();
    cache.apply("provider", "session-1", [accepted, duplicate]);

    const selected = await selectCodexEventSourceWithCache(
      sources,
      "session-1",
      cache,
    );

    expect(selected).toMatchObject({
      warm: true,
      events: [accepted, duplicate],
    });
    expect(cache.getLastSequence("provider", "session-1")).toBe(2);
  });

  it("evicts least-recently-used projections at the event-count waterline", () => {
    const cache = new CodexProjectionCache({
      maxEntries: 4,
      maxTotalEvents: 1,
    });
    cache.apply("provider", "session-1", [
      testEvent(1, "warning", { message: "first" }),
    ]);
    cache.apply("provider", "session-2", [
      testEvent(
        1,
        "warning",
        { message: "second" },
        { sessionId: "session-2" },
      ),
    ]);

    expect(cache.size).toBe(1);
    expect(cache.getLastSequence("provider", "session-1")).toBe(0);
    expect(cache.getLastSequence("provider", "session-2")).toBe(1);
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

  it("projects thread/goal/updated as a threadGoal native item", () => {
    const events = [
      testEvent(1, "thread/goal/updated", {
        threadId: "thread-1",
        turnId: "turn-1",
        goal: {
          threadId: "thread-1",
          objective: "Ship the feature",
          status: "active",
          tokenBudget: 100000,
          tokensUsed: 500,
          timeUsedSeconds: 30,
          createdAt: 1000,
          updatedAt: 2000,
        },
      }),
    ];

    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      [],
      events,
    );

    const goalMessage = result.messages.find(
      (m) =>
        (m as { codexThreadItem?: { type?: string } }).codexThreadItem?.type ===
        "threadGoal",
    );
    expect(goalMessage).toBeDefined();
    expect(goalMessage?.codexThreadItem).toMatchObject({
      type: "threadGoal",
      objective: "Ship the feature",
      status: "active",
      tokensUsed: 500,
      timeUsedSeconds: 30,
    });
  });

  it("does not project goal after thread/goal/cleared", () => {
    const events = [
      testEvent(1, "thread/goal/updated", {
        threadId: "thread-1",
        turnId: "turn-1",
        goal: {
          threadId: "thread-1",
          objective: "Ship the feature",
          status: "active",
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1000,
          updatedAt: 2000,
        },
      }),
      testEvent(2, "thread/goal/cleared", {
        threadId: "thread-1",
      }),
    ];

    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      [],
      events,
    );

    const goalMessage = result.messages.find(
      (m) =>
        (m as { codexThreadItem?: { type?: string } }).codexThreadItem?.type ===
        "threadGoal",
    );
    expect(goalMessage).toBeUndefined();
  });

  it("projects turn/plan/updated as a turnPlan checklist native item", () => {
    const events = [
      testEvent(1, "turn/plan/updated", {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: "Breaking down the work",
        plan: [
          { step: "Read the file", status: "completed" },
          { step: "Write tests", status: "inProgress" },
          { step: "Run tests", status: "pending" },
        ],
      }),
      testEvent(2, "turn/diff/updated", {
        threadId: "thread-1",
        turnId: "turn-1",
        diff: "later activity",
      }),
    ];

    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      [],
      events,
    );

    const planMessage = result.messages.find(
      (m) =>
        (m as { codexThreadItem?: { type?: string } }).codexThreadItem?.type ===
        "turnPlan",
    );
    expect(planMessage).toBeDefined();
    expect(planMessage?.codexEventSequence).toBe(1);
    expect(planMessage?.codexThreadItem).toMatchObject({
      type: "turnPlan",
      explanation: "Breaking down the work",
      steps: [
        { step: "Read the file", status: "completed" },
        { step: "Write tests", status: "inProgress" },
        { step: "Run tests", status: "pending" },
      ],
    });
  });

  it("attaches turnPlan state to the existing live UpdatePlan row", () => {
    const legacy: Message[] = [
      {
        uuid: "codex-plan-turn-1",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "codex-plan-turn-1",
              name: "UpdatePlan",
              input: {
                plan: [{ step: "Read", status: "completed" }],
              },
            },
          ],
        },
      },
    ];
    const events = [
      testEvent(1, "turn/plan/updated", {
        threadId: "thread-1",
        turnId: "turn-1",
        plan: [{ step: "Read", status: "completed" }],
      }),
    ];

    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      legacy,
      events,
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      uuid: "codex-plan-turn-1",
      codexThreadItem: { type: "turnPlan" },
      codexEventSequence: 1,
    });
  });

  it("does not project turnPlan when plan steps are empty", () => {
    const events = [
      testEvent(1, "turn/plan/updated", {
        threadId: "thread-1",
        turnId: "turn-1",
        plan: [],
      }),
    ];

    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      [],
      events,
    );

    const planMessage = result.messages.find(
      (m) =>
        (m as { codexThreadItem?: { type?: string } }).codexThreadItem?.type ===
        "turnPlan",
    );
    expect(planMessage).toBeUndefined();
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

/**
 * The event ceiling is a *work* bound, not a history bound.
 *
 * Measured on a production journal (144,029 events for one session, 10,494
 * legacy rows): the overlay is linear at 35-47 us/event with no knee, a windowed
 * request costs 139 ms, and an unwindowed one costs 6.8 s. The projection cache
 * does not close that gap because it memoizes the reduce, not the candidate
 * build and legacy matching (warm 6.7 s vs cold 7.0 s).
 *
 * So the ceiling has to apply to the unwindowed regime only. Checking it against
 * total history, as it originally did, permanently disabled the canonical view
 * for exactly the long sessions whose windowed requests are cheap.
 */
describe("canonical Codex overlay viability", () => {
  const legacy: Message[] = [
    {
      uuid: "legacy-1",
      type: "assistant",
      message: { role: "assistant", content: "hello" },
    },
  ];

  function events(count: number): CodexEventEnvelope[] {
    return Array.from({ length: count }, (_, index) =>
      testEvent(
        index + 1,
        "item/completed",
        {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: `item-${index + 1}`,
            type: "agentMessage",
            text: `answer-${index + 1}`,
          },
        },
        { eventId: `event-${index + 1}` },
      ),
    );
  }

  it("rejects an unwindowed request above the ceiling", () => {
    expect(
      assessCanonicalOverlayViability({ eventCount: 11, maxEvents: 10 }),
    ).toEqual({
      viable: false,
      reason: "event_limit",
      eventCount: 11,
      maxEvents: 10,
    });
  });

  it("accepts a windowed request above the ceiling", () => {
    // The whole point: the window bounds the work, so history size stops
    // mattering.
    expect(
      assessCanonicalOverlayViability({
        eventCount: 1_000_000,
        maxEvents: 10,
        maxCandidateCount: 50,
      }),
    ).toEqual({ viable: true });
  });

  it("accepts an unwindowed request at the ceiling", () => {
    expect(
      assessCanonicalOverlayViability({ eventCount: 10, maxEvents: 10 }),
    ).toEqual({ viable: true });
  });

  it("rejects a nonsensical ceiling instead of silently ignoring it", () => {
    expect(() =>
      assessCanonicalOverlayViability({ eventCount: 1, maxEvents: 0 }),
    ).toThrow(/maxEvents must be positive/);
  });

  it("still throws from the overlay when a caller skips the pre-check", () => {
    expect(() =>
      overlayCanonicalCodexSessionMessages("session-1", legacy, events(4), {
        maxEvents: 3,
      }),
    ).toThrow(/event limit exceeded/);
  });

  it("overlays a journal above the ceiling when the request is windowed", () => {
    // Before this, the same call threw and the session fell back to legacy
    // normalization on every single request.
    const result = overlayCanonicalCodexSessionMessages(
      "session-1",
      legacy,
      events(4),
      { maxEvents: 3, maxCandidateCount: 2 },
    );

    expect(result.eventCount).toBe(4);
    // Only the recent tail is projected, which is what bounds the work.
    expect(result.projectedMessageCount).toBe(2);
    expect(
      result.messages.map((message) => message.codexEventSequence),
    ).toEqual([undefined, 3, 4]);
  });
});

describe("canonical Codex projection cache retention", () => {
  it("keeps a single projection that exceeds the event waterline on its own", () => {
    // Regression: evictIfNeeded used to take the only key in the map and delete
    // it, leaving an empty cache. Every later request then paid a full cold
    // projection -- measured 8 s on the real 144k-event session, with
    // `cache.size === 0` after each apply.
    const cache = new CodexProjectionCache({ maxTotalEvents: 1 });

    cache.apply("provider", "session-1", [
      testEvent(1, "warning", { message: "first" }),
      testEvent(2, "warning", { message: "second" }),
      testEvent(3, "warning", { message: "third" }),
    ]);

    expect(cache.size).toBe(1);
    expect(cache.getLastSequence("provider", "session-1")).toBe(3);
  });

  it("still evicts other sessions to respect the waterline", () => {
    const cache = new CodexProjectionCache({ maxTotalEvents: 1 });
    cache.apply("provider", "session-1", [
      testEvent(1, "warning", { message: "first" }),
    ]);
    cache.apply("provider", "session-2", [
      testEvent(1, "warning", { message: "second" }, { sessionId: "session-2" }),
    ]);

    expect(cache.size).toBe(1);
    expect(cache.getLastSequence("provider", "session-1")).toBe(0);
    expect(cache.getLastSequence("provider", "session-2")).toBe(1);
  });
});
