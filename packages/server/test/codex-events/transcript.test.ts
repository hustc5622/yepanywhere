import { describe, expect, it } from "vitest";
import {
  CODEX_TRANSCRIPT_SCHEMA_NAME,
  buildCanonicalCodexTranscriptFromEvents,
  exportCanonicalCodexTranscriptJson,
  exportCanonicalCodexTranscriptMarkdown,
  stableCodexTranscriptJson,
} from "../../src/codex-events/transcript.js";
import type { CodexEventEnvelope } from "../../src/codex-events/types.js";
import { testEvent } from "./helpers.js";

describe("canonical Codex transcript", () => {
  it("builds a deterministic canonical timeline independent of replay order", () => {
    const events = canonicalFixture();
    const chronological = buildCanonicalCodexTranscriptFromEvents(
      "session-1",
      events,
    );
    const reversed = buildCanonicalCodexTranscriptFromEvents(
      "session-1",
      [...events].reverse(),
    );

    expect(stableCodexTranscriptJson(reversed)).toBe(
      stableCodexTranscriptJson(chronological),
    );
    expect(chronological.schema.name).toBe(CODEX_TRANSCRIPT_SCHEMA_NAME);
    expect(chronological.transcriptId).toMatch(/^transcript:sha256:/);
    expect(chronological.source).toMatchObject({
      kind: "canonical_replay",
      throughSequence: 15,
      eventCount: 15,
      limitations: [],
    });
    expect(chronological.entries.map((entry) => entry.sequence)).toEqual(
      [...chronological.entries]
        .map((entry) => entry.sequence)
        .sort((left, right) => left - right),
    );
    expect(chronological.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "item",
          itemId: "user-1",
          title: "User",
          occurredAt: "1970-01-01T00:00:01.000Z",
        }),
        expect.objectContaining({
          kind: "interaction",
          method: "item/tool/requestUserInput",
          status: "resolved",
        }),
        expect.objectContaining({
          kind: "branch",
          method: "thread/fork",
          status: "created",
        }),
        expect.objectContaining({
          kind: "unknown",
          method: "future/item/delta",
          status: "newer_server",
        }),
        expect.objectContaining({
          kind: "anomaly",
          status: "late_delta",
        }),
      ]),
    );
  });

  it("preserves plaintext secrets, reasoning and artifact locations in exports", () => {
    const transcript = buildCanonicalCodexTranscriptFromEvents(
      "session-1",
      canonicalFixture(),
    );
    const json = exportCanonicalCodexTranscriptJson(transcript);
    const markdown = exportCanonicalCodexTranscriptMarkdown(transcript);
    const combined = `${json.body}\n${markdown.body}`;

    for (const forbidden of [
      "plain-secret-answer",
      "hunter2",
      "sk-1234567890abcdefghijklmnopqrstuvwxyz",
      "/Users/private/work/input.png",
      "https://private.example/audio?token=abc",
      "cmF3LWJpbmFyeS1zZWNyZXQtYnl0ZXM=",
      "internal chain of thought",
      "raw-provider-body",
      "mcp-default-secret",
      "mcp-secret-answer",
      "nested-client-secret",
    ]) {
      expect(combined).toContain(forbidden);
    }
    expect(combined).not.toContain("[REDACTED:");
    expect(combined).not.toContain("[OMITTED:raw-reasoning]");
    expect(combined).not.toContain("opaque_artifact_ref");
    expect(transcript.metadata.redaction).toMatchObject({
      applied: false,
      count: 0,
      opaqueArtifactRefs: 0,
    });

    const parsed = JSON.parse(json.body) as {
      metadata: { output: unknown };
    };
    expect(parsed.metadata.output).toEqual(json.metadata);
    expect(Buffer.byteLength(json.body, "utf8")).toBe(
      json.metadata.emittedBytes,
    );
  });

  it("reports typed content and output truncation while keeping exports valid", () => {
    const events: CodexEventEnvelope[] = [
      testEvent(1, "turn/started", {
        threadId: "thread-limit",
        turn: {
          id: "turn-limit",
          status: "inProgress",
          items: [],
          startedAt: 1,
        },
      }),
    ];
    for (let index = 0; index < 30; index += 1) {
      events.push(
        testEvent(index + 2, "item/completed", {
          threadId: "thread-limit",
          turnId: "turn-limit",
          item: {
            id: `agent-${index.toString().padStart(2, "0")}`,
            type: "agentMessage",
            text: `${index}: ${"x".repeat(600)}`,
            phase: "commentary",
          },
        }),
      );
    }
    const transcript = buildCanonicalCodexTranscriptFromEvents(
      "session-1",
      events,
      { maxStringCharacters: 200 },
    );
    expect(transcript.metadata.truncation).toMatchObject({
      truncated: true,
      counts: { string_length: 30 },
    });
    expect(transcript.metadata.truncation.omittedCharacters).toBeGreaterThan(0);

    const json = exportCanonicalCodexTranscriptJson(transcript, {
      maxBytes: 5_000,
    });
    expect(json.metadata).toMatchObject({
      truncated: true,
      strategy: "canonical-prefix",
    });
    expect(json.metadata.omittedEntries).toBeGreaterThan(0);
    expect(Buffer.byteLength(json.body, "utf8")).toBeLessThanOrEqual(5_000);
    expect(() => JSON.parse(json.body)).not.toThrow();

    const markdown = exportCanonicalCodexTranscriptMarkdown(transcript, {
      maxBytes: 5_000,
    });
    expect(markdown.metadata.truncated).toBe(true);
    expect(markdown.body).toContain("## Transcript truncated");
    expect(Buffer.byteLength(markdown.body, "utf8")).toBeLessThanOrEqual(5_000);
    expect(Buffer.byteLength(markdown.body, "utf8")).toBe(
      markdown.metadata.emittedBytes,
    );
  });

  it("marks projection-only exports as incomplete without inventing time", () => {
    const replay = buildCanonicalCodexTranscriptFromEvents(
      "session-1",
      canonicalFixture(),
    );
    const projectionOnly = buildCanonicalCodexTranscriptFromEvents(
      "session-empty",
      [],
    );

    expect(projectionOnly.source.kind).toBe("canonical_projection");
    expect(projectionOnly.source.limitations).not.toHaveLength(0);
    expect(projectionOnly.entries).toEqual([]);
    expect(projectionOnly.transcriptId).not.toBe(replay.transcriptId);
    expect(stableCodexTranscriptJson(projectionOnly)).not.toContain(
      "generatedAt",
    );
  });
});

function canonicalFixture(): CodexEventEnvelope[] {
  const secretRequest = {
    ...testEvent(
      7,
      "item/tool/requestUserInput",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "question-1",
        isBlocking: true,
        questions: [
          {
            id: "password-question",
            header: "Credential",
            question: "Enter the one-time credential",
            isOther: false,
            isSecret: true,
            options: null,
          },
        ],
      },
      { direction: "server_request" },
    ),
    requestId: 91,
    correlationId: "server-request:91",
  } satisfies CodexEventEnvelope;
  const secretResponse = {
    ...testEvent(
      8,
      "item/tool/requestUserInput",
      {
        result: {
          answers: {
            "password-question": { answers: ["plain-secret-answer"] },
          },
        },
      },
      { direction: "client_response" },
    ),
    requestId: 91,
    correlationId: "server-request:91",
    phase: "resolved" as const,
  } satisfies CodexEventEnvelope;
  const forkRequest = {
    ...testEvent(
      9,
      "thread/fork",
      {
        threadId: "thread-1",
        beforeTurnId: "turn-1",
        path: "/Users/private/.codex/session.jsonl",
      },
      { direction: "client_request" },
    ),
    requestId: 92,
    correlationId: "client-request:92",
  } satisfies CodexEventEnvelope;
  const forkResponse = {
    ...testEvent(
      10,
      "thread/fork",
      { thread: { id: "thread-forked", turns: [] } },
      { direction: "client_response" },
    ),
    requestId: 92,
    correlationId: "client-request:92",
    phase: "resolved" as const,
  } satisfies CodexEventEnvelope;
  const mcpSecretRequest = {
    ...testEvent(
      14,
      "mcpServer/elicitation/request",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        mode: "form",
        serverName: "secrets",
        message: "Enter OTP",
        requestedSchema: {
          type: "object",
          properties: {
            otp: {
              type: "string",
              writeOnly: true,
              default: "mcp-default-secret",
            },
          },
        },
      },
      { direction: "server_request" },
    ),
    requestId: 93,
    correlationId: "server-request:93",
  } satisfies CodexEventEnvelope;
  const mcpSecretResponse = {
    ...testEvent(
      15,
      "mcpServer/elicitation/request",
      {
        result: {
          action: "accept",
          content: { otp: "mcp-secret-answer" },
        },
      },
      { direction: "client_response" },
    ),
    requestId: 93,
    correlationId: "server-request:93",
    phase: "resolved" as const,
  } satisfies CodexEventEnvelope;

  return [
    testEvent(1, "turn/started", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "inProgress",
        items: [],
        startedAt: 1,
      },
    }),
    testEvent(2, "item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "user-1",
        type: "userMessage",
        clientId: "client-1",
        content: [
          {
            type: "text",
            text: "please inspect password=hunter2",
            text_elements: [],
          },
          { type: "localImage", path: "/Users/private/work/input.png" },
          {
            type: "audio",
            url: "https://private.example/audio?token=abc",
          },
        ],
      },
      completedAtMs: 1_100,
    }),
    testEvent(3, "item/reasoning/summaryTextDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reasoning-1",
      summaryIndex: 0,
      delta: "Checked the request",
    }),
    testEvent(4, "item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "reasoning-1",
        type: "reasoning",
        summary: ["Checked the request"],
        content: ["internal chain of thought"],
      },
    }),
    testEvent(5, "item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "agent-1",
        type: "agentMessage",
        phase: "final_answer",
        text: "Done. key sk-1234567890abcdefghijklmnopqrstuvwxyz",
      },
    }),
    testEvent(6, "item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-1",
      delta: "late",
    }),
    secretRequest,
    secretResponse,
    forkRequest,
    forkResponse,
    testEvent(11, "future/item/delta", {
      rawRef: "/private/raw/event.bin",
      data: "data:application/octet-stream;base64,cmF3LWJpbmFyeS1zZWNyZXQtYnl0ZXM=",
      clientSecret: "nested-client-secret",
    }),
    {
      ...testEvent(12, "rawResponse/completed", {
        body: "raw-provider-body",
      }),
      rawRef: "/private/raw/provider-response.json",
    },
    testEvent(13, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [],
        completedAt: 2,
      },
    }),
    mcpSecretRequest,
    mcpSecretResponse,
  ];
}
