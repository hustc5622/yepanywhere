import {
  CODEX_THREAD_ITEM_TYPES,
  type CodexThreadItemType,
  type InputRequest,
  type InteractionOperation,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import protocolManifest from "../../../../server/src/sdk/providers/codex-protocol/manifest.json";
import type { Message } from "../../types";
import {
  type CodexThreadItemRecord,
  canResolveInputRequestInteraction,
  getCodexThreadItemPolicy,
  mapInputRequestToInteractionOperation,
  mapInputRequestToInteractionRenderItem,
  mapInteractionOperationToRenderItem,
  mapInteractionResolutionToInputResponse,
  renderCodexThreadItem,
  selectCodexRenderItems,
} from "../codexRenderItems";
import { preprocessMessages } from "../preprocessMessages";

const fixtures = {
  userMessage: {
    type: "userMessage",
    id: "u",
    content: [{ type: "text", text: "hello" }],
  },
  hookPrompt: {
    type: "hookPrompt",
    id: "h",
    fragments: [{ text: "hook", hookRunId: "run" }],
  },
  agentMessage: {
    type: "agentMessage",
    id: "a",
    text: "done",
    phase: "final_answer",
  },
  plan: { type: "plan", id: "p", text: "1. inspect" },
  reasoning: {
    type: "reasoning",
    id: "r",
    summary: ["Checked inputs"],
    content: ["hidden"],
  },
  commandExecution: {
    type: "commandExecution",
    id: "c",
    command: "pnpm test",
    cwd: "/repo",
    status: "completed",
    exitCode: 0,
  },
  fileChange: {
    type: "fileChange",
    id: "f",
    changes: [{ path: "a.ts", kind: "update", diff: "+x" }],
    status: "completed",
  },
  mcpToolCall: {
    type: "mcpToolCall",
    id: "m",
    server: "docs",
    tool: "search",
    status: "completed",
    result: { content: [{ type: "text", text: "found" }] },
  },
  dynamicToolCall: {
    type: "dynamicToolCall",
    id: "d",
    namespace: "host",
    tool: "pick",
    status: "completed",
    contentItems: [{ type: "inputText", text: "ok" }],
  },
  collabAgentToolCall: {
    type: "collabAgentToolCall",
    id: "ca",
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: "root",
    receiverThreadIds: ["child"],
  },
  subAgentActivity: {
    type: "subAgentActivity",
    id: "sa",
    kind: "started",
    agentThreadId: "child",
    agentPath: "/root/child",
  },
  webSearch: { type: "webSearch", id: "w", query: "Codex", results: [] },
  imageView: { type: "imageView", id: "iv", path: "/tmp/image.png" },
  sleep: { type: "sleep", id: "s", durationMs: 500 },
  imageGeneration: {
    type: "imageGeneration",
    id: "ig",
    status: "completed",
    result: "",
    savedPath: "/tmp/generated.png",
  },
  enteredReviewMode: {
    type: "enteredReviewMode",
    id: "re",
    review: "Review changes",
  },
  exitedReviewMode: {
    type: "exitedReviewMode",
    id: "rx",
    review: "No findings",
  },
  contextCompaction: { type: "contextCompaction", id: "cc" },
} satisfies Record<CodexThreadItemType, CodexThreadItemRecord>;

const expectedRenderTypes = {
  userMessage: "user_prompt",
  hookPrompt: "hook",
  agentMessage: "text",
  plan: "plan",
  reasoning: "reasoning",
  commandExecution: "command",
  fileChange: "file_change",
  mcpToolCall: "mcp_tool",
  dynamicToolCall: "dynamic_tool",
  collabAgentToolCall: "subagent",
  subAgentActivity: "subagent",
  webSearch: "web_search",
  imageView: "image",
  sleep: "sleep",
  imageGeneration: "image",
  enteredReviewMode: "review",
  exitedReviewMode: "review",
  contextCompaction: "compaction",
} satisfies Record<CodexThreadItemType, string>;

describe("Codex native render selector", () => {
  it("has a typed renderer projection for all 18 generated ThreadItem variants", () => {
    expect([...CODEX_THREAD_ITEM_TYPES].sort()).toEqual(
      [...protocolManifest.capabilityProfiles.stable.threadItems].sort(),
    );
    expect(Object.keys(fixtures).sort()).toEqual(
      [...CODEX_THREAD_ITEM_TYPES].sort(),
    );
    for (const type of CODEX_THREAD_ITEM_TYPES) {
      expect(getCodexThreadItemPolicy(type)).toBeDefined();
      expect(
        renderCodexThreadItem({
          item: fixtures[type],
          lifecycle: "completed",
          turnId: "turn-1",
        }).type,
      ).toBe(expectedRenderTypes[type]);
    }
  });

  it("uses the same normalization for persisted/live and keeps completed authoritative", () => {
    const started = {
      item: {
        ...fixtures.commandExecution,
        status: "inProgress",
        aggregatedOutput: "partial",
      },
      turnId: "turn-1",
      lifecycle: "started" as const,
      timestamp: "2026-01-01T00:00:02Z",
    };
    const completed = {
      item: {
        ...fixtures.commandExecution,
        status: "completed",
        aggregatedOutput: "done",
      },
      turnId: "turn-1",
      lifecycle: "completed" as const,
      timestamp: "2026-01-01T00:00:01Z",
    };
    const items = selectCodexRenderItems({
      persisted: [completed],
      live: [started],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "command",
      status: "complete",
      output: "done",
    });

    const messages = selectCodexRenderItems({
      persisted: [
        {
          item: { ...fixtures.agentMessage, text: "complete" },
          lifecycle: "completed",
          timestamp: "2026-01-01T00:00:01Z",
        },
      ],
      live: [
        {
          item: { ...fixtures.agentMessage, text: "stale stream" },
          lifecycle: "started",
          timestamp: "2026-01-01T00:00:02Z",
        },
      ],
    });
    expect(messages).toMatchObject([
      { type: "text", text: "complete", isStreaming: false },
    ]);
  });

  it("renders future variants as a safe visible unknown card", () => {
    const sourceMessage: Message = {
      uuid: "future-source",
      type: "assistant",
      codexThreadItem: {
        type: "futureTool",
        id: "future",
        token: "must-not-render",
      },
    };
    expect(
      renderCodexThreadItem({
        item: { type: "futureTool", id: "future", token: "must-not-render" },
        lifecycle: "started",
        sourceMessage,
      }),
    ).toMatchObject({
      type: "unknown",
      sourceMessages: [],
      originalType: "futureTool",
      safeSummary: "Fields: token",
    });
  });

  it("projects only typed managed artifacts and never exposes imageGeneration savedPath", () => {
    const item = renderCodexThreadItem({
      item: fixtures.imageGeneration,
      lifecycle: "completed",
      threadId: "thread-1",
      turnId: "turn-1",
      sourceMessage: {
        uuid: "generated-source",
        type: "system",
        codexGeneratedArtifacts: [
          {
            schemaVersion: 1,
            id: `ga_${"a".repeat(32)}`,
            managedRef: "upload:123e4567-e89b-12d3-a456-426614174000",
            fileName: "generated.png",
            kind: "image",
            mimeType: "image/png",
            sizeBytes: 9,
            sha256: `sha256:${"b".repeat(64)}`,
            source: {
              provider: "codex",
              type: "image_generation",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "ig",
            },
            retention: {
              policy: "temporary",
              expiresAt: "2026-01-02T00:00:00.000Z",
            },
            downloadUrl: `/api/projects/project/sessions/session/generated-artifact/ga_${"a".repeat(32)}/${"b".repeat(64)}/generated.png`,
            previewUrl: `/api/projects/project/sessions/session/generated-artifact/ga_${"a".repeat(32)}/${"b".repeat(64)}/generated.png`,
          },
        ],
      },
    });

    expect(item).toMatchObject({
      type: "image",
      mode: "generation",
      artifacts: [
        {
          fileName: "generated.png",
          managedRef: "upload:123e4567-e89b-12d3-a456-426614174000",
        },
      ],
      redaction: { hiddenFields: ["savedPath"] },
    });
    expect(item).not.toHaveProperty("path");
    expect(JSON.stringify(item)).not.toContain("/tmp/generated.png");
  });

  it("drops raw reasoning from the normal render model without a policy opt-in", () => {
    const sourceMessage: Message = {
      uuid: "raw-reasoning-source",
      type: "assistant",
      codexThreadItem: fixtures.reasoning,
    };
    expect(
      renderCodexThreadItem({
        item: fixtures.reasoning,
        lifecycle: "completed",
        sourceMessage,
      }),
    ).toMatchObject({
      type: "reasoning",
      sourceMessages: [],
      summary: ["Checked inputs"],
      content: [],
      visibility: "summary_only",
      redaction: { level: "partial", hiddenFields: ["content"] },
    });

    expect(
      selectCodexRenderItems({
        persisted: [
          {
            item: fixtures.reasoning,
            lifecycle: "completed",
            sourceMessage,
          },
        ],
        live: [
          {
            item: fixtures.reasoning,
            lifecycle: "started",
            rawReasoningAllowed: true,
            sourceMessage,
          },
        ],
      }),
    ).toMatchObject([
      {
        type: "reasoning",
        sourceMessages: [],
        content: [],
        visibility: "summary_only",
      },
    ]);
  });

  it("keeps subagent prompts, paths, and status messages out of the render model", () => {
    const spawn = renderCodexThreadItem({
      item: {
        ...fixtures.collabAgentToolCall,
        prompt: "private prompt",
        agentsStates: {
          child: { status: "running", message: "private child result" },
        },
      },
      sourceMessage: {
        uuid: "spawn-source",
        type: "system",
        codexThreadItem: fixtures.collabAgentToolCall,
      },
    });
    expect(spawn).toMatchObject({
      type: "subagent",
      sourceMessages: [],
      agentStates: { child: "running" },
      redaction: {
        level: "partial",
        hiddenFields: ["prompt", "agentsStates.message"],
      },
    });
    expect(spawn).not.toHaveProperty("prompt");

    const activity = renderCodexThreadItem({
      item: fixtures.subAgentActivity,
      sourceMessage: {
        uuid: "activity-source",
        type: "system",
        codexThreadItem: fixtures.subAgentActivity,
      },
    });
    expect(activity).toMatchObject({
      type: "subagent",
      sourceMessages: [],
      redaction: { level: "partial", hiddenFields: ["agentPath"] },
    });
    expect(activity).not.toHaveProperty("agentPath");
  });

  it("deduplicates native started/completed messages in the regular transcript pipeline", () => {
    const messages: Message[] = [
      {
        uuid: "started",
        type: "assistant",
        timestamp: "2026-01-01T00:00:00Z",
        codexTurnId: "turn-1",
        codexThreadItemLifecycle: "started",
        codexThreadItem: { ...fixtures.plan, text: "draft" },
      },
      {
        uuid: "completed",
        type: "assistant",
        timestamp: "2026-01-01T00:00:01Z",
        codexTurnId: "turn-1",
        codexThreadItemLifecycle: "completed",
        codexThreadItem: { ...fixtures.plan, text: "final" },
      },
    ];

    expect(preprocessMessages(messages)).toMatchObject([
      { type: "plan", text: "final", status: "complete" },
    ]);
  });
});

describe("InputRequest interaction projection", () => {
  it("renders the broker operation identity, version, and terminal state", () => {
    const operation: InteractionOperation = {
      operationId: "int-terminal",
      provider: "codex",
      requestId: "req-terminal",
      requestMethod: "item/commandExecution/requestApproval",
      sessionId: "thread-1",
      kind: "command_approval",
      state: "expired",
      publicPayload: { prompt: "Allow command?" },
      allowedActors: { mode: "any_member" },
      allowedDecisions: [{ id: "accept" }, { id: "decline" }],
      createdAt: Date.parse("2026-01-01T00:00:00Z"),
      resolution: {
        decision: "timeout",
        resolvedAt: Date.parse("2026-01-01T00:00:30Z"),
      },
      version: 3,
    };

    expect(mapInteractionOperationToRenderItem(operation)).toMatchObject({
      id: "interaction-int-terminal-v3",
      status: "cancelled",
      operation: { operationId: "int-terminal", version: 3, state: "expired" },
      updatedAt: "2026-01-01T00:00:30.000Z",
    });
  });

  it("preserves native approval decisions and CAS identity", () => {
    const request: InputRequest = {
      id: "req-1",
      sessionId: "thread-1",
      type: "tool-approval",
      prompt: "Allow command?",
      toolName: "Bash",
      timestamp: "2026-01-01T00:00:00Z",
      source: "codex-bridge",
      toolInput: {
        approvalKind: "command_execution",
        command: "pnpm test",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        version: 4,
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
    };

    expect(mapInputRequestToInteractionOperation(request)).toMatchObject({
      operationId: "req-1",
      requestMethod: "item/commandExecution/requestApproval",
      kind: "command_approval",
      version: 4,
      publicPayload: {
        command: "pnpm test",
      },
      allowedDecisions: [
        { id: "accept", scope: "once" },
        { id: "acceptForSession", scope: "session" },
        { id: "decline" },
        { id: "cancel" },
      ],
    });
  });

  it("maps active questions to memory-only answer UI and persisted ones to read-only", () => {
    const request: InputRequest = {
      id: "question-1",
      sessionId: "thread-1",
      type: "question",
      prompt: "Token?",
      toolName: "AskUserQuestion",
      timestamp: "2026-01-01T00:00:00Z",
      source: "codex-bridge",
      toolInput: {
        questions: [{ id: "token", question: "Token?", inputType: "password" }],
      },
    };

    const active = mapInputRequestToInteractionOperation(request);
    const persisted = mapInputRequestToInteractionOperation({
      ...request,
      source: "persisted",
    });
    expect(active.publicPayload.questions?.[0]).toMatchObject({
      id: "token",
      type: "secret",
    });
    expect(active.allowedDecisions.map((decision) => decision.id)).toEqual([
      "submit",
      "cancel",
    ]);
    expect(persisted.allowedDecisions).toEqual([]);
  });

  it("builds a canonical timeline item and uses safe Codex fallbacks", () => {
    const request: InputRequest = {
      id: "file-1",
      sessionId: "thread-1",
      type: "tool-approval",
      prompt: "Allow file changes?",
      toolName: "Edit",
      timestamp: "2026-01-01T00:00:00Z",
      source: "codex-bridge",
      toolInput: {
        approvalKind: "file_change",
        grantRoot: "/workspace",
        version: 3,
      },
    };

    const item = mapInputRequestToInteractionRenderItem(request, {
      projectId: "project-1",
    });
    expect(item).toMatchObject({
      type: "interaction",
      id: "interaction-file-1-v3",
      status: "pending",
      operation: {
        provider: "codex",
        projectId: "project-1",
        kind: "file_approval",
        allowedDecisions: [
          { id: "accept" },
          { id: "acceptForSession" },
          { id: "decline" },
        ],
      },
    });
    // A raw SSE compatibility projection has no broker CAS identity and must
    // stay on the legacy footer path until the authoritative refresh arrives.
    expect(canResolveInputRequestInteraction(request, item.operation)).toBe(
      false,
    );
    const brokerRequest = {
      ...request,
      interaction: {
        ...item.operation,
        operationId: "int-file-1",
        version: 0,
      },
    };
    expect(
      canResolveInputRequestInteraction(
        brokerRequest,
        brokerRequest.interaction,
      ),
    ).toBe(true);
  });

  it("maps CAS-checked decisions and only forwards declared answer fields", () => {
    const request: InputRequest = {
      id: "question-2",
      sessionId: "thread-1",
      type: "question",
      prompt: "Credentials",
      toolName: "AskUserQuestion",
      timestamp: "2026-01-01T00:00:00Z",
      source: "codex-bridge",
      toolInput: {
        version: 8,
        questions: [
          {
            id: "environment",
            question: "Environment?",
            options: [{ label: "Production", value: "prod" }],
          },
          {
            id: "token",
            question: "Token?",
            inputType: "password",
          },
        ],
      },
    };
    const operation = mapInputRequestToInteractionOperation(request);
    expect(operation.publicPayload.questions?.[0]?.options?.[0]).toEqual({
      label: "Production",
      value: "prod",
      description: undefined,
    });

    expect(
      mapInteractionResolutionToInputResponse(operation, {
        operationId: "question-2",
        version: 8,
        decisionId: "submit",
        value: {
          answers: {
            environment: "prod",
            token: "secret-value",
            unexpected: "must-not-forward",
          },
        },
      }),
    ).toEqual({
      response: "approve",
      answers: { environment: "prod", token: "secret-value" },
    });
    expect(() =>
      mapInteractionResolutionToInputResponse(operation, {
        operationId: "question-2",
        version: 7,
        decisionId: "submit",
      }),
    ).toThrow("Interaction operation is stale");
  });

  it("maps native approve, persistent, and deny decisions to the input API", () => {
    const operation = mapInputRequestToInteractionOperation({
      id: "command-2",
      sessionId: "thread-1",
      type: "tool-approval",
      prompt: "Allow command?",
      toolName: "Bash",
      timestamp: "2026-01-01T00:00:00Z",
      source: "codex-bridge",
      toolInput: {
        approvalKind: "command_execution",
        availableDecisions: [
          "accept",
          "acceptForSession",
          { acceptWithExecpolicyAmendment: { command: ["pnpm", "test"] } },
          "decline",
        ],
      },
    });

    for (const [decisionId, response] of [
      ["accept", "approve"],
      ["acceptForSession", "approve_for_session"],
      ["acceptWithExecpolicyAmendment", "approve_always"],
      ["decline", "deny"],
    ] as const) {
      expect(
        mapInteractionResolutionToInputResponse(operation, {
          operationId: operation.operationId,
          version: operation.version,
          decisionId,
        }),
      ).toEqual({ response });
    }
  });

  it("keeps persisted and URL actions on their existing read-only/footer paths", () => {
    const request: InputRequest = {
      id: "mcp-url-1",
      sessionId: "thread-1",
      type: "tool-approval",
      prompt: "Sign in",
      toolName: "MCP",
      timestamp: "2026-01-01T00:00:00Z",
      source: "codex-bridge",
      toolInput: {
        approvalKind: "mcp_url_action",
        actionUrl: "https://example.com/login",
      },
    };
    const active = mapInputRequestToInteractionOperation(request);
    const persisted = mapInputRequestToInteractionOperation(request, {
      readOnly: true,
    });
    expect(canResolveInputRequestInteraction(request, active)).toBe(false);
    expect(persisted.allowedDecisions).toEqual([]);
  });
});
