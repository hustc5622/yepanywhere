import type { CodexSessionEntry } from "@yep-anywhere/shared";
import { parseKimiWireJsonl, parsePiSessionJsonl } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  isSessionInspectorOnlyItem,
  preprocessMessages,
} from "../../../client/src/lib/preprocessMessages.ts";
import type { Message as ClientMessage } from "../../../client/src/types.ts";
import type { RenderItem } from "../../../client/src/types/renderItems.ts";
import {
  buildSessionDisplayProjection,
  decodeSessionDisplayDetailRef,
  selectSessionDisplayToolMessages,
} from "../../src/sessions/display-projection.js";
import {
  convertCodexEntries,
  convertKimiMessages,
  convertPiSession,
} from "../../src/sessions/normalization.js";
import type { Message } from "../../src/supervisor/types.js";

function visibleOracle(messages: readonly Message[]): RenderItem[] {
  return preprocessMessages(messages as ClientMessage[]).filter(
    (item) => !isSessionInspectorOnlyItem(item),
  );
}

function projectedText(messages: readonly Message[]): string[] {
  const projection = buildSessionDisplayProjection({
    sessionId: "fixture-session",
    revision: "fixture-revision",
    messages,
    questionCoverage: "complete",
  });
  return projection.page.turns.flatMap((turn) =>
    turn.segments.flatMap((segment) =>
      segment.type === "assistant_text" ? [segment.content] : [],
    ),
  );
}

function expectOracleParity(messages: readonly Message[]): void {
  const oracle = visibleOracle(messages);
  const projection = buildSessionDisplayProjection({
    sessionId: "fixture-session",
    revision: "fixture-revision",
    messages,
    questionCoverage: "complete",
  });
  const oracleTools = oracle.filter((item) => item.type === "tool_call");
  const projectedToolCount = projection.page.turns.reduce(
    (total, turn) =>
      total +
      turn.segments.reduce(
        (turnTotal, segment) =>
          turnTotal +
          (segment.type === "tool_group"
            ? segment.count
            : segment.type === "action_required" && segment.detailRef
              ? 1
              : 0),
        0,
      ),
    0,
  );
  const oracleFailed = oracleTools.filter(
    (item) => item.status === "error" || item.status === "aborted",
  ).length;
  const projectedFailed = projection.page.turns.reduce(
    (total, turn) =>
      total +
      turn.segments.reduce(
        (turnTotal, segment) =>
          turnTotal +
          (segment.type === "tool_group"
            ? segment.failedCount
            : segment.type === "action_required" && segment.status === "failed"
              ? 1
              : 0),
        0,
      ),
    0,
  );
  const oracleQuestionIds = oracle.flatMap((item) =>
    item.type === "user_prompt" ? [item.id] : [],
  );

  expect(projectedText(messages)).toEqual(
    oracle.flatMap((item) => (item.type === "text" ? [item.text] : [])),
  );
  expect(projectedToolCount).toBe(oracleTools.length);
  expect(projectedFailed).toBe(oracleFailed);
  expect(
    projection.questions.questions.map((question) => question.messageId),
  ).toEqual(oracleQuestionIds);
}

describe("session display projection", () => {
  it("removes tool bodies, preserves order, and reports safe aggregates", () => {
    const largeToolResult = `TOOL_RESULT_SECRET:${"x".repeat(550_000)}`;
    const messages: Message[] = [
      {
        uuid: "setup-1",
        type: "user",
        message: {
          role: "user",
          content: "# AGENTS.md instructions\ninternal setup payload",
        },
        timestamp: "2026-09-01T00:00:00.000Z",
      },
      {
        uuid: "user-1",
        type: "user",
        clientUserMessageId: "client-user-1",
        codexCorrelationKey: "codex:user-message:client-user-1",
        parentUuid: "user-parent",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Fix the session display" },
            {
              type: "input_image",
              mime_type: "image/png",
              image_url: "data:image/png;base64,INLINE_IMAGE_SECRET",
            },
          ],
        },
        timestamp: "2026-09-01T00:00:01.000Z",
      },
      {
        uuid: "assistant-progress",
        type: "assistant",
        codexCorrelationKey: "codex:turn-1:agent-message:progress-1",
        codexMessagePhase: "commentary",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect the current flow." },
            {
              type: "tool_use",
              id: "edit-1",
              name: "Edit",
              input: {
                file_path: "/private/project/secret.ts",
                old_string: "old secret",
                new_string: "new secret",
              },
            },
            {
              type: "tool_use",
              id: "check-1",
              name: "Bash",
              input: { command: "pnpm test --filter secret-suite" },
            },
          ],
        },
        timestamp: "2026-09-01T00:00:02.000Z",
      },
      {
        uuid: "edit-result",
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "edit-1",
              content: largeToolResult,
            },
          ],
        },
        timestamp: "2026-09-01T00:00:03.000Z",
      },
      {
        uuid: "check-result",
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "check-1",
              content: "CHECK_RESULT_SECRET",
              is_error: true,
            },
          ],
        },
        timestamp: "2026-09-01T00:00:04.000Z",
      },
      {
        uuid: "assistant-question-prelude",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "One choice remains." },
            {
              type: "tool_use",
              id: "question-1",
              name: "AskUserQuestion",
              input: {
                questions: [
                  {
                    question: "Proceed?",
                    options: [{ label: "Yes", description: "Continue" }],
                  },
                ],
              },
            },
          ],
        },
        timestamp: "2026-09-01T00:00:05.000Z",
      },
      {
        uuid: "question-result",
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "question-1",
              content: '{"answers":{"Proceed?":"Yes"}}',
            },
          ],
        },
        timestamp: "2026-09-01T00:00:06.000Z",
      },
      {
        uuid: "assistant-final",
        type: "assistant",
        codexMessagePhase: "final_answer",
        message: {
          role: "assistant",
          content: "Implemented and verified.",
        },
        timestamp: "2026-09-01T00:00:07.000Z",
      },
    ];
    const before = structuredClone(messages);

    const projection = buildSessionDisplayProjection({
      sessionId: "long-codex-session",
      revision: "revision-1",
      messages,
      questionCoverage: "complete",
    });
    const json = JSON.stringify(projection.page);
    const rawBytes = Buffer.byteLength(JSON.stringify(messages));
    const displayBytes = Buffer.byteLength(json);
    const mainTurn = projection.page.turns.find(
      (turn) => turn.question?.messageId === "user-1",
    );

    expect(messages).toEqual(before);
    expect(displayBytes).toBeLessThan(rawBytes * 0.3);
    expect(json).not.toContain("TOOL_RESULT_SECRET");
    expect(json).not.toContain("CHECK_RESULT_SECRET");
    expect(json).not.toContain("INLINE_IMAGE_SECRET");
    expect(json).not.toContain("/private/project/secret.ts");
    expect(json).not.toContain("old secret");
    expect(mainTurn?.question?.content).toEqual([
      { type: "text", text: "Fix the session display" },
      {
        type: "media",
        kind: "image",
        mimeType: "image/png",
        deferred: true,
      },
    ]);
    expect(mainTurn?.question?.parentMessageId).toBe("user-parent");
    expect(mainTurn?.question).toMatchObject({
      clientUserMessageId: "client-user-1",
      codexCorrelationKey: "codex:user-message:client-user-1",
    });
    expect(mainTurn?.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "assistant_text",
          codexCorrelationKey: "codex:turn-1:agent-message:progress-1",
          phase: "progress",
          content: "I will inspect the current flow.",
        }),
        expect.objectContaining({
          type: "tool_group",
          status: "mixed",
          count: 2,
          failedCount: 1,
          changedFileCount: 1,
          checkCount: 1,
          toolNames: ["Edit", "Bash"],
        }),
        expect.objectContaining({
          type: "action_required",
          action: "question",
          status: "completed",
        }),
        expect.objectContaining({
          type: "assistant_text",
          phase: "final",
          content: "Implemented and verified.",
        }),
      ]),
    );
    expect(projection.questions).toMatchObject({
      coverage: "complete",
      questions: [
        {
          messageId: "user-1",
          turnId: "turn:user-1",
          clientUserMessageId: "client-user-1",
          codexCorrelationKey: "codex:user-message:client-user-1",
          preview: "Fix the session display [image]",
        },
      ],
    });
    expect(projection.detailLocators).toHaveLength(2);
    const firstLocator = projection.detailLocators[0];
    expect(firstLocator).toBeDefined();
    expect(
      decodeSessionDisplayDetailRef(
        "long-codex-session",
        "revision-1",
        firstLocator?.detailRef ?? "",
      ),
    ).toEqual({
      turnId: "turn:user-1",
      kind: "tool_group",
      index: 0,
    });
    expect(
      decodeSessionDisplayDetailRef(
        "long-codex-session",
        "stale-revision",
        firstLocator?.detailRef ?? "",
      ),
    ).toBeNull();
    const selectedDetails = selectSessionDisplayToolMessages(
      messages,
      firstLocator?.toolUseIds ?? [],
    );
    const detailJson = JSON.stringify(selectedDetails);
    expect(detailJson).toContain("TOOL_RESULT_SECRET");
    expect(detailJson).toContain("CHECK_RESULT_SECRET");
    expect(detailJson).not.toContain("Proceed?");
    expect(
      preprocessMessages(selectedDetails as ClientMessage[]).filter(
        (item) => item.type === "tool_call",
      ),
    ).toHaveLength(2);
    expectOracleParity(messages);
  });

  it("deduplicates source-native user rows by stable client identity", () => {
    const projection = buildSessionDisplayProjection({
      sessionId: "duplicate-session",
      revision: "duplicate-revision",
      questionCoverage: "complete",
      messages: [
        {
          uuid: "live-user",
          type: "user",
          clientUserMessageId: "client-duplicate-1",
          codexCorrelationKey: "codex:user-message:client-duplicate-1",
          message: { role: "user", content: "Run once" },
        },
        {
          uuid: "persisted-user",
          type: "user",
          clientUserMessageId: "client-duplicate-1",
          codexCorrelationKey: "codex:user-message:client-duplicate-1",
          message: { role: "user", content: "Run once" },
        },
      ],
    });

    expect(projection.page.turns).toHaveLength(1);
    expect(projection.questions.questions).toHaveLength(1);
  });

  it("keeps pending actions and visible provider notices out of success groups", () => {
    const messages: Message[] = [
      {
        uuid: "user-1",
        type: "user",
        message: { role: "user", content: "Continue the task" },
      },
      {
        uuid: "running-tool",
        type: "assistant",
        orphanedToolUseIds: ["running-1"],
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "running-1",
              name: "Bash",
              input: { command: "sleep 10" },
            },
          ],
        },
      },
      {
        uuid: "warning-1",
        type: "system",
        subtype: "warning",
        content: "Provider is retrying",
      },
      {
        uuid: "plan-1",
        type: "system",
        subtype: "codex_native_item",
        codexThreadItemLifecycle: "completed",
        codexThreadItem: { type: "plan", text: "1. Inspect\n2. Fix" },
      },
      {
        uuid: "goal-1",
        type: "kimi_goal",
        goal: { status: "active", objective: "Finish the task" },
      },
    ];

    const projection = buildSessionDisplayProjection({
      sessionId: "active-session",
      revision: "revision-1",
      messages,
      questionCoverage: "partial",
      pendingInputRequest: {
        id: "approval-1",
        sessionId: "active-session",
        type: "tool-approval",
        prompt: "Approve Bash",
        toolName: "Bash",
        timestamp: "2026-09-01T00:00:08.000Z",
      },
    });
    const segments = projection.page.turns[0]?.segments ?? [];

    expect(segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_group",
          status: "running",
          count: 1,
        }),
        expect.objectContaining({ type: "notice", kind: "warning" }),
        expect.objectContaining({ type: "notice", kind: "plan" }),
        expect.objectContaining({ type: "notice", kind: "goal" }),
        expect.objectContaining({
          type: "action_required",
          action: "approval",
          status: "running",
        }),
      ]),
    );
  });

  it("matches the renderer's adjacent silent Codex Wait collapse", () => {
    const messages: Message[] = [
      {
        uuid: "user-1",
        type: "user",
        message: { role: "user", content: "Wait for the command" },
      },
      {
        uuid: "waits",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "wait-1",
              name: "Wait",
              input: { cell_id: "cell-1" },
            },
            {
              type: "tool_use",
              id: "wait-2",
              name: "Wait",
              input: { cell_id: "cell-1" },
            },
          ],
        },
      },
      {
        uuid: "final",
        type: "assistant",
        message: { role: "assistant", content: "Still running." },
      },
    ];

    const projection = buildSessionDisplayProjection({
      sessionId: "wait-session",
      revision: "revision-1",
      messages,
      questionCoverage: "complete",
      toolsMayBeActive: true,
    });
    const group = projection.page.turns[0]?.segments.find(
      (segment) => segment.type === "tool_group",
    );

    expect(group).toMatchObject({ count: 1, status: "running" });
    expect(projection.detailLocators[0]?.toolUseIds).toEqual([
      "wait-1",
      "wait-2",
    ]);
    expectOracleParity(messages);
  });

  it("marks only the open active tail after the latest readable output", () => {
    const openMessages: Message[] = [
      {
        uuid: "user-1",
        type: "user",
        message: { role: "user", content: "Run the checks" },
      },
      {
        uuid: "progress-1",
        type: "assistant",
        codexMessagePhase: "commentary",
        message: { role: "assistant", content: "Starting the checks." },
      },
      {
        uuid: "tool-1",
        type: "assistant",
        orphanedToolUseIds: ["bash-1"],
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "bash-1",
              name: "Bash",
              input: { command: "pnpm test" },
            },
          ],
        },
      },
      {
        uuid: "warning-1",
        type: "system",
        subtype: "warning",
        content: "Provider is retrying",
      },
    ];
    const open = buildSessionDisplayProjection({
      sessionId: "active-session",
      revision: "revision-1",
      messages: openMessages,
      questionCoverage: "partial",
      toolsMayBeActive: true,
    });
    const openGroup = open.page.turns[0]?.segments.find(
      (segment) => segment.type === "tool_group",
    );
    expect(openGroup).toMatchObject({ liveTail: true });

    const closed = buildSessionDisplayProjection({
      sessionId: "active-session",
      revision: "revision-2",
      messages: [
        ...openMessages,
        {
          uuid: "progress-2",
          type: "assistant",
          codexMessagePhase: "commentary",
          message: { role: "assistant", content: "Checks completed." },
        },
      ],
      questionCoverage: "partial",
      toolsMayBeActive: true,
    });
    const closedGroup = closed.page.turns[0]?.segments.find(
      (segment) => segment.type === "tool_group",
    );
    expect(closedGroup).not.toHaveProperty("liveTail");
  });

  it("matches the existing renderer oracle for Codex, Pi, and Kimi normalization", () => {
    const codexEntries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-09-01T01:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect Codex" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-09-01T01:00:01.000Z",
        payload: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Checking Codex." }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-09-01T01:00:02.000Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "codex-tool",
          arguments: '{"cmd":"pnpm test"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2026-09-01T01:00:03.000Z",
        payload: {
          type: "function_call_output",
          call_id: "codex-tool",
          output: "Process exited with code 0",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-09-01T01:00:04.000Z",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Codex done." }],
        },
      },
    ];
    const codexMessages = convertCodexEntries(
      codexEntries,
      "codex-fixture",
      undefined,
      { provider: "codex" },
    );

    const pi = parsePiSessionJsonl(
      [
        {
          type: "session",
          version: 3,
          id: "pi-fixture",
          timestamp: "2026-09-01T02:00:00.000Z",
          cwd: "/fixture",
        },
        {
          type: "message",
          id: "pi-user",
          parentId: null,
          timestamp: "2026-09-01T02:00:01.000Z",
          message: { role: "user", content: "Inspect Pi" },
        },
        {
          type: "message",
          id: "pi-assistant-tool",
          parentId: "pi-user",
          timestamp: "2026-09-01T02:00:02.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Checking Pi." },
              {
                type: "toolCall",
                id: "pi-tool",
                name: "bash",
                arguments: { command: "pnpm test" },
              },
            ],
            stopReason: "toolUse",
          },
        },
        {
          type: "message",
          id: "pi-result",
          parentId: "pi-assistant-tool",
          timestamp: "2026-09-01T02:00:03.000Z",
          message: {
            role: "toolResult",
            toolCallId: "pi-tool",
            toolName: "bash",
            content: [{ type: "text", text: "ok" }],
            isError: false,
          },
        },
        {
          type: "message",
          id: "pi-final",
          parentId: "pi-result",
          timestamp: "2026-09-01T02:00:04.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Pi done." }],
            stopReason: "stop",
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    if (!pi) throw new Error("Pi display fixture did not parse");
    const piMessages = convertPiSession(pi).messages;

    const kimiRecords = parseKimiWireJsonl(
      [
        { type: "metadata", protocol_version: "1.4", created_at: 1 },
        {
          type: "turn.prompt",
          input: [{ type: "text", text: "Inspect Kimi" }],
          time: 1,
        },
        {
          type: "context.append_loop_event",
          event: {
            type: "content.part",
            part: { type: "text", text: "Checking Kimi." },
          },
          time: 2,
        },
        {
          type: "context.append_loop_event",
          event: {
            type: "tool.call",
            toolCallId: "kimi-tool",
            name: "Bash",
            args: { command: "pnpm test" },
          },
          time: 3,
        },
        {
          type: "context.append_loop_event",
          event: {
            type: "tool.result",
            toolCallId: "kimi-tool",
            result: { output: "ok" },
          },
          time: 4,
        },
        {
          type: "context.append_loop_event",
          event: {
            type: "content.part",
            part: { type: "text", text: "Kimi done." },
          },
          time: 5,
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    const kimiMessages = convertKimiMessages({
      sessionId: "kimi-fixture",
      workDir: "/fixture",
      records: kimiRecords,
    });

    expectOracleParity(codexMessages);
    expectOracleParity(piMessages);
    expectOracleParity(kimiMessages);
  });
});
