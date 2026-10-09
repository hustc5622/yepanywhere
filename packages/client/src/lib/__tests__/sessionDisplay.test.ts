import type { SessionDisplayPage } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  buildSessionDisplayRenderItems,
  mergeSessionInspectorMessages,
  resolveSessionInspectorNavigation,
} from "../sessionDisplay";

describe("buildSessionDisplayRenderItems", () => {
  it("adds the edit switcher when lineage arrives after a cached display snapshot", () => {
    const branches = ["original", "edited"].map((id, index) => ({
      id,
      sessionId: id === "original" ? "root" : "child",
      parentId: "shared",
      prompt: id,
      title: id,
      depth: 2,
      index,
      siblingIndex: index + 1,
      siblingCount: 2,
      isActive: id === "edited",
      provider: "codex" as const,
    }));
    const items = buildSessionDisplayRenderItems(
      {
        sessionId: "child",
        revision: "cached-before-fork",
        turns: [
          {
            id: "turn:edited",
            question: { messageId: "edited", content: "edited" },
            segments: [],
          },
        ],
      },
      {
        projectId: "project",
        formatNotice: () => "notice",
        branchState: {
          sessionId: "child",
          provider: "codex",
          activeBranchId: "edited",
          selectedBranchId: "edited",
          branches,
        },
      },
    );
    expect(items[0]).toMatchObject({
      type: "user_prompt",
      sourceMessages: [
        {
          branch: {
            branchId: "edited",
            siblingCount: 2,
            alternatives: branches,
          },
        },
      ],
    });
  });
  it("maps a timed main-agent wait notice to its native renderer", () => {
    const items = buildSessionDisplayRenderItems(
      {
        sessionId: "parent",
        revision: "r1",
        turns: [
          {
            id: "turn:t1",
            question: null,
            segments: [
              {
                type: "notice",
                id: "wait-row",
                kind: "agent_wait",
                agentWait: {
                  type: "agentWait",
                  id: "wait-call",
                  status: "completed",
                  startedAt: "2026-10-08T01:00:00Z",
                  completedAt: "2026-10-08T01:00:03Z",
                  durationMs: 3000,
                  outcome: "message",
                },
              },
            ],
          },
        ],
      },
      { projectId: "project", formatNotice: () => "notice" },
    );
    expect(items[0]).toMatchObject({
      type: "codex_native_item",
      threadId: "parent",
      turnId: "t1",
      lifecycle: "completed",
      threadItem: { type: "agentWait", id: "wait-call", durationMs: 3000 },
    });
  });
  it("collapses start/completion notices on the display-page path and retains native event ids", () => {
    const items = buildSessionDisplayRenderItems(
      {
        sessionId: "parent",
        revision: "r1",
        turns: [
          {
            id: "turn:parent-1",
            question: null,
            segments: ["started", "completed"].map((kind) => ({
              type: "notice" as const,
              id: `display-${kind}`,
              kind: "subagent" as const,
              subagent: {
                kind,
                eventId: `native-${kind}`,
                agentThreadId: "child",
                agentPath: "/root/reviewer",
              },
            })),
          },
        ],
      },
      { projectId: "project", formatNotice: () => "notice" },
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "display-started",
      threadId: "parent",
      turnId: "parent-1",
      threadItem: { kind: "completed", id: "native-started" },
      subagentActivity: {
        events: [
          {
            id: "display-started",
            nativeId: "native-started",
            kind: "started",
          },
          {
            id: "display-completed",
            nativeId: "native-completed",
            kind: "completed",
          },
        ],
      },
    });
  });

  it("keeps a standalone assignment visible in a child display page", () => {
    const items = buildSessionDisplayRenderItems(
      {
        sessionId: "child",
        revision: "r1",
        turns: [
          {
            id: "turn:child-1",
            question: null,
            segments: [
              {
                type: "notice",
                id: "task-row",
                kind: "inter_agent_message",
                interAgentMessage: {
                  type: "interAgentMessage",
                  id: "task",
                  kind: "task",
                  sender: "/root",
                  recipient: "/root/reviewer",
                  encrypted: true,
                },
              },
            ],
          },
        ],
      },
      { projectId: "project", formatNotice: () => "notice" },
    );
    expect(items[0]).toMatchObject({
      type: "codex_native_item",
      lifecycle: "completed",
      threadId: "child",
      threadItem: { type: "interAgentMessage", kind: "task", encrypted: true },
    });
  });

  it("maps lightweight turns without reconstructing hidden tool messages", () => {
    const page: SessionDisplayPage = {
      sessionId: "session-1",
      revision: "revision-1",
      turns: [
        {
          id: "turn:native-1",
          question: {
            messageId: "user-1",
            parentMessageId: "parent-1",
            content: [
              { type: "text", text: "Inspect this" },
              { type: "media", kind: "image", deferred: true },
            ],
          },
          segments: [
            {
              type: "assistant_text",
              id: "text-1",
              codexCorrelationKey: "codex:native-1:agent-message:text-1",
              phase: "progress",
              content: "Checking.",
            },
            {
              type: "tool_group",
              id: "group-1",
              status: "completed",
              count: 2,
              failedCount: 0,
              toolNames: ["Read", "Bash"],
              detailRef: "detail-1",
            },
            {
              type: "assistant_text",
              id: "text-2",
              phase: "final",
              content: "Done.",
              renderedHtml:
                '<p>See <a href="/api/local-file?path=plan.md">plan</a>.</p>',
            },
          ],
        },
      ],
    };

    const items = buildSessionDisplayRenderItems(page, {
      projectId: "project-1",
      formatNotice: () => "notice",
    });

    expect(items.map((item) => item.type)).toEqual([
      "user_prompt",
      "text",
      "display_tool_group",
      "text",
    ]);
    expect(items[0]).toMatchObject({
      type: "user_prompt",
      sourceMessages: [
        {
          uuid: "user-1",
          parentUuid: "parent-1",
          codexTurnId: "native-1",
          _source: "jsonl",
        },
      ],
    });
    expect(items[1]).toMatchObject({
      type: "text",
      sourceMessages: [
        {
          codexCorrelationKey: "codex:native-1:agent-message:text-1",
        },
      ],
    });
    expect(items[3]).toMatchObject({
      type: "text",
      text: "Done.",
      augmentHtml:
        '<p>See <a href="/api/local-file?path=plan.md">plan</a>.</p>',
    });
    expect(JSON.stringify(items)).not.toContain("tool_result");
    expect(items[2]).toMatchObject({
      type: "display_tool_group",
      projectId: "project-1",
      sessionId: "session-1",
      revision: "revision-1",
      group: { count: 2, detailRef: "detail-1" },
    });

    const withoutHydratedTail = buildSessionDisplayRenderItems(page, {
      projectId: "project-1",
      omitToolGroupDetailRef: "detail-1",
      formatNotice: () => "notice",
    });
    expect(withoutHydratedTail.map((item) => item.type)).toEqual([
      "user_prompt",
      "text",
      "text",
    ]);
  });

  it("renders subagent notices with identity and navigation rather than a bare status", () => {
    const items = buildSessionDisplayRenderItems(
      {
        sessionId: "parent-thread",
        revision: "revision-1",
        turns: [
          {
            id: "turn-1",
            question: null,
            segments: [
              {
                type: "notice",
                id: "activity-1",
                kind: "subagent",
                status: "completed",
                subagent: {
                  kind: "started",
                  agentPath: "/root/reviewer",
                  agentThreadId: "child-thread",
                },
              },
            ],
          },
        ],
      },
      { projectId: "project-1", formatNotice: () => "bare status" },
    );
    expect(items[0]).toMatchObject({
      type: "codex_native_item",
      projectId: "project-1",
      lifecycle: "completed",
      threadItem: {
        type: "subAgentActivity",
        kind: "started",
        agentPath: "/root/reviewer",
        agentThreadId: "child-thread",
      },
    });
  });

  it("maps reasoning segments to collapsed thinking rows with a detail handle", () => {
    const page: SessionDisplayPage = {
      sessionId: "session-2",
      revision: "revision-2",
      turns: [
        {
          id: "turn:pi-1",
          question: { messageId: "user-1", content: "Fix the parser" },
          segments: [
            {
              type: "thinking",
              id: "pi-step-1:0",
              content: "short reasoning",
              detailRef: "thinking-ref-1",
            },
            {
              type: "thinking",
              id: "pi-step-2:0",
              content: "preview only",
              truncated: true,
              detailRef: "thinking-ref-2",
            },
          ],
        },
      ],
    };

    const items = buildSessionDisplayRenderItems(page, {
      projectId: "project-1",
      branchId: "branch-1",
      formatNotice: () => "notice",
    });

    expect(items.map((item) => item.type)).toEqual([
      "user_prompt",
      "thinking",
      "thinking",
    ]);
    expect(items[1]).toMatchObject({
      type: "thinking",
      id: "pi-step-1:0",
      thinking: "short reasoning",
      status: "complete",
      detail: {
        projectId: "project-1",
        sessionId: "session-2",
        revision: "revision-2",
        branchId: "branch-1",
        detailRef: "thinking-ref-1",
        truncated: false,
      },
    });
    expect(items[2]).toMatchObject({
      type: "thinking",
      detail: { detailRef: "thinking-ref-2", truncated: true },
    });
  });
});

describe("mergeSessionInspectorMessages", () => {
  it("keeps the safe index, appends live rows, and removes exact replays", () => {
    const indexed = [{ uuid: "persisted-tool", type: "assistant" as const }];
    const live = [
      { uuid: "persisted-tool", type: "assistant" as const },
      { uuid: "live-tool", type: "assistant" as const },
    ];

    expect(mergeSessionInspectorMessages(indexed, live)).toEqual([
      indexed[0],
      live[1],
    ]);
  });

  it("reconnects a page-leading tool row to the preceding question boundary", () => {
    expect(
      resolveSessionInspectorNavigation([
        {
          uuid: "question-1",
          type: "system",
          inspectorQuestionBoundary: true,
          inspectorNavigationMessageId: "question-1",
        },
        {
          uuid: "tool-on-next-page",
          type: "assistant",
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        uuid: "tool-on-next-page",
        inspectorNavigationMessageId: "question-1",
      }),
    ]);
  });
});
