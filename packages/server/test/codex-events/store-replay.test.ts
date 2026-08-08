import { describe, expect, it } from "vitest";
import {
  InMemoryCodexEventStore,
  createCanonicalCodexSessionState,
  createCodexEventDraft,
  reduceCodexEvents,
  replayCodexSession,
  safeCodexPayload,
} from "../../src/codex-events/index.js";
import { testDraft } from "./helpers.js";

describe("Codex event envelope and store", () => {
  it("extracts correlation identities while retaining only safe payload + raw ref", () => {
    const draft = createCodexEventDraft({
      eventId: "event-1",
      runtime: {
        codexVersion: "0.147.0",
        schemaHash: "sha256:schema",
        profile: "experimental",
        experimentalApi: true,
      },
      sessionId: "session-1",
      method: "item/started",
      direction: "server_notification",
      payload: safeCodexPayload({
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "item-1", clientId: "client-message-1" },
        requestId: 7,
        callId: "call-1",
      }),
      rawRef: "jsonl:42",
      connectionId: "connection-1",
      appServerEmittedAtMs: 100,
      receivedAtMs: 110,
    });

    expect(draft).toMatchObject({
      schema: { name: "yep.codex-event", version: 1 },
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      requestId: 7,
      callId: "call-1",
      clientMessageId: "client-message-1",
      correlationId: "7",
      appServerEmittedAtMs: 100,
      receivedAtMs: 110,
      rawRef: "jsonl:42",
      payload: { safety: "safe" },
    });
    expect(draft).not.toHaveProperty("sequence");
    expect(draft).not.toHaveProperty("persistedAtMs");
  });

  it("assigns per-session sequence and deduplicates idempotently", async () => {
    let now = 5_000;
    const store = new InMemoryCodexEventStore({ now: () => now++ });
    const firstDraft = testDraft(
      "warning",
      { message: "first" },
      { eventId: "event-1", dedupeKey: "operation-1" },
    );
    const first = await store.append(firstDraft);
    const duplicateId = await store.append(firstDraft);
    const duplicateKey = await store.append(
      testDraft(
        "warning",
        { message: "duplicate" },
        { eventId: "event-2", dedupeKey: "operation-1" },
      ),
    );
    const second = await store.append(
      testDraft("warning", { message: "second" }, { eventId: "event-3" }),
    );

    expect(first).toMatchObject({
      inserted: true,
      event: { sequence: 1, persistedAtMs: 5_000 },
    });
    expect(duplicateId).toEqual({ inserted: false, event: first.event });
    expect(duplicateKey).toEqual({ inserted: false, event: first.event });
    expect(second.event.sequence).toBe(2);
    expect(await store.latestSequence("session-1")).toBe(2);
    expect(
      await store.replay({ sessionId: "session-1", afterSequence: 1 }),
    ).toEqual([second.event]);
  });

  it("produces deep-equal live and replay projections", async () => {
    let now = 10_000;
    const store = new InMemoryCodexEventStore({ now: () => now++ });
    const drafts = [
      testDraft("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "hel",
      }),
      testDraft(
        "item/started",
        {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "item-1", type: "agentMessage", text: "" },
          startedAtMs: 10,
        },
        { eventId: "event-started" },
      ),
      testDraft(
        "item/agentMessage/delta",
        {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "lo",
        },
        { eventId: "event-delta-2" },
      ),
      testDraft(
        "item/completed",
        {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "item-1", type: "agentMessage", text: "hello" },
          completedAtMs: 20,
        },
        { eventId: "event-completed" },
      ),
      testDraft(
        "future/notification",
        { threadId: "thread-1", opaque: true },
        { eventId: "event-future" },
      ),
    ];
    const appended = await store.appendMany(drafts);
    const live = reduceCodexEvents(
      createCanonicalCodexSessionState("session-1"),
      appended
        .filter((result) => result.inserted)
        .map((result) => result.event),
    );
    const replayed = await replayCodexSession(store, "session-1");

    expect(replayed).toEqual(live);
    expect(replayed.unknownEvents).toHaveLength(1);
    expect(
      replayed.threads["thread-1"]?.turns["turn-1"]?.items["item-1"],
    ).toMatchObject({
      status: "completed",
      stream: { assistantText: "hello" },
    });
  });
});
