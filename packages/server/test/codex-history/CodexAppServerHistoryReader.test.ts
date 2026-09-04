import { readFile } from "node:fs/promises";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerHistoryReader,
  decodeCodexAppServerCursor,
  encodeCodexAppServerCursor,
} from "../../src/codex-history/CodexAppServerHistoryReader.js";
import { CodexHistoryClientError } from "../../src/codex-history/types.js";
import type { Thread } from "../../src/sdk/providers/codex-protocol/generated/v2/Thread.js";
import { publicCodexThreadItem } from "../../src/sdk/providers/codex.js";

function thread(historyMode: "legacy" | "paginated" = "paginated"): Thread {
  return {
    id: "0198f000-0000-7000-8000-000000000001",
    extra: null,
    sessionId: "0198f000-0000-7000-8000-000000000001",
    forkedFromId: null,
    parentThreadId: null,
    preview: "First prompt",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    historyMode,
    modelProvider: "openai",
    createdAt: 1_777_000_000,
    updatedAt: 1_777_000_100,
    recencyAt: 1_777_000_100,
    status: { type: "notLoaded" },
    path: "/tmp/project/rollout.jsonl",
    cwd: "/tmp/project",
    cliVersion: "0.149.0",
    source: "cli",
    canAcceptDirectInput: null,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    readThread: vi.fn(async () => ({ thread: thread() })),
    listTurns: vi.fn(async () => ({
      data: [
        {
          id: "turn-1",
          items: [],
          itemsView: "notLoaded" as const,
          status: "completed" as const,
          error: null,
          startedAt: 1_777_000_010,
          completedAt: 1_777_000_020,
          durationMs: 10_000,
        },
      ],
      nextCursor: null,
      backwardsCursor: "turn-head",
    })),
    listItems: vi.fn(async () => ({
      // App-server returns descending item order for this request.
      data: [
        {
          turnId: "turn-1",
          item: {
            type: "commandExecution" as const,
            id: "command-1",
            pluginId: null,
            scriptPath: null,
            command: "pnpm test",
            cwd: "/tmp/project",
            processId: null,
            source: "agent" as const,
            status: "completed" as const,
            commandActions: [],
            aggregatedOutput: "passed",
            exitCode: 0,
            durationMs: 10,
          },
        },
        {
          turnId: "turn-1",
          item: {
            type: "agentMessage" as const,
            id: "agent-1",
            text: "Done",
            phase: "final_answer" as const,
            memoryCitation: null,
          },
        },
        {
          turnId: "turn-1",
          item: {
            type: "userMessage" as const,
            id: "user-1",
            clientId: "client-user-1",
            content: [
              { type: "text" as const, text: "Run tests", text_elements: [] },
            ],
          },
        },
      ],
      nextCursor: "older-items",
      backwardsCursor: "newer-items",
    })),
    getCapability: vi.fn(() => ({
      protocolVersion: "0.149.0",
      schemaHash: "schema",
      supportsThreadListStateDbOnly: false,
      supportsThreadTurnsList: true,
      supportsThreadItemsList: true,
    })),
    ...overrides,
  };
}

describe("CodexAppServerHistoryReader", () => {
  it("honors the rollout kill switch without starting app-server reads", async () => {
    const fake = client();
    const reader = new CodexAppServerHistoryReader({
      client: fake,
      mode: "rollout",
    });

    await expect(
      reader.getSession(
        thread().id,
        "project" as UrlProjectId,
        "/tmp/project",
        undefined,
        {},
      ),
    ).resolves.toEqual({ kind: "fallback", reason: "disabled" });
    expect(fake.readThread).not.toHaveBeenCalled();
  });

  it("hydrates semantic turn pages through per-turn items/list reads", async () => {
    const summaryTurn = {
      id: "turn-semantic",
      items: [
        {
          type: "userMessage" as const,
          id: "summary-user",
          clientId: "semantic-client",
          content: [
            { type: "text" as const, text: "Run checks", text_elements: [] },
          ],
        },
        {
          type: "agentMessage" as const,
          id: "summary-final",
          text: "Checks done",
          phase: "final_answer" as const,
          memoryCitation: null,
        },
      ],
      itemsView: "summary" as const,
      status: "completed" as const,
      error: null,
      startedAt: 1_777_000_010,
      completedAt: 1_777_000_020,
      durationMs: 10_000,
    };
    const listTurns = vi.fn(async () => ({
      data: [summaryTurn],
      nextCursor: "older-turns",
      backwardsCursor: null,
    }));
    const listItems = vi.fn(async () => ({
      data: [
        {
          turnId: "turn-semantic",
          item: summaryTurn.items[0],
        },
        {
          turnId: "turn-semantic",
          item: {
            type: "commandExecution" as const,
            id: "semantic-command",
            pluginId: null,
            scriptPath: null,
            command: "pnpm test",
            cwd: "/tmp/project",
            processId: null,
            source: "agent" as const,
            status: "completed" as const,
            commandActions: [],
            aggregatedOutput: "passed",
            exitCode: 0,
            durationMs: 10,
          },
        },
        {
          turnId: "turn-semantic",
          item: summaryTurn.items[1],
        },
      ],
      nextCursor: null,
      backwardsCursor: null,
    }));
    const fake = client({ listTurns, listItems });
    const reader = new CodexAppServerHistoryReader({ client: fake });

    const result = await reader.getSemanticTurnsPage(
      thread().id,
      "project" as UrlProjectId,
      "/tmp/project",
      { limit: 20, itemsView: "full" },
    );

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.nextCursor).toBe("older-turns");
    expect(result.revision).toBe(`cas1.${thread().updatedAt}.${thread().id}`);
    expect(result.messages.map((message) => message.uuid)).toEqual([
      "summary-user-turn-semantic",
      "semantic-command-turn-semantic",
      "semantic-command-turn-semantic-result",
      "summary-final-turn-semantic",
    ]);
    expect(listTurns).toHaveBeenCalledWith(
      expect.objectContaining({ itemsView: "summary", limit: 20 }),
    );
    expect(listItems).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "turn-semantic",
        sortDirection: "asc",
      }),
    );

    const exact = await reader.getSemanticTurn(
      thread().id,
      "/tmp/project",
      "turn-semantic",
      result.revision,
    );
    expect(exact.kind).toBe("loaded");
    if (exact.kind === "loaded") {
      expect(exact.messages).toHaveLength(4);
    }
  });

  it("completes hosted web search items that carry no structured results", async () => {
    const webSearchTurn = {
      id: "turn-web",
      items: [],
      itemsView: "summary" as const,
      status: "completed" as const,
      error: null,
      startedAt: 1_777_000_010,
      completedAt: 1_777_000_020,
      durationMs: 10_000,
    };
    const fake = client({
      listTurns: vi.fn(async () => ({
        data: [webSearchTurn],
        nextCursor: null,
        backwardsCursor: null,
      })),
      listItems: vi.fn(async () => ({
        data: [
          {
            turnId: "turn-web",
            item: {
              type: "webSearch" as const,
              id: "ws-1",
              query: "",
              action: null,
              results: null,
            },
          },
          {
            turnId: "turn-web",
            item: {
              type: "webSearch" as const,
              id: "ws-2",
              query: "https://example.com/docs",
              action: {
                type: "openPage" as const,
                url: "https://example.com/docs",
              },
              results: null,
            },
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      })),
    });
    const reader = new CodexAppServerHistoryReader({ client: fake });

    const result = await reader.getSemanticTurnsPage(
      thread().id,
      "project" as UrlProjectId,
      "/tmp/project",
      { limit: 20, itemsView: "full" },
    );

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    // The in-flight placeholder stays result-less, the completed hosted call
    // gets a tool_result even though `results` is null.
    expect(result.messages.map((message) => message.uuid)).toEqual([
      "ws-1-turn-web",
      "ws-2-turn-web",
      "ws-2-turn-web-result",
    ]);
    expect(result.messages[2]).toMatchObject({
      toolUseResult: {
        codexActionLabel: "Open page: https://example.com/docs",
      },
    });
  });

  it("hydrates all same-turn user items for the complete question directory", async () => {
    const fake = client({
      listTurns: vi.fn(async () => ({
        data: [
          {
            id: "turn-question",
            items: [
              {
                type: "userMessage" as const,
                id: "question-user",
                clientId: null,
                content: [
                  {
                    type: "text" as const,
                    text: "Question only",
                    text_elements: [],
                  },
                ],
              },
              {
                type: "agentMessage" as const,
                id: "question-final",
                text: "Answer only",
                phase: "final_answer" as const,
                memoryCitation: null,
              },
            ],
            itemsView: "summary" as const,
            status: "completed" as const,
            error: null,
            startedAt: 1_777_000_010,
            completedAt: 1_777_000_020,
            durationMs: 10_000,
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      })),
      listItems: vi.fn(async () => ({
        data: [
          {
            turnId: "turn-question",
            item: {
              type: "userMessage" as const,
              id: "question-user",
              clientId: null,
              content: [
                {
                  type: "text" as const,
                  text: "Question only",
                  text_elements: [],
                },
              ],
            },
          },
          {
            turnId: "turn-question",
            item: {
              type: "commandExecution" as const,
              id: "hidden-command",
              pluginId: null,
              scriptPath: null,
              command: "secret command",
              cwd: "/tmp/project",
              processId: null,
              source: "agent" as const,
              status: "completed" as const,
              commandActions: [],
              aggregatedOutput: "secret output",
              exitCode: 0,
              durationMs: 1,
            },
          },
          {
            turnId: "turn-question",
            item: {
              type: "userMessage" as const,
              id: "steer-user",
              clientId: "steer-client",
              content: [
                {
                  type: "text" as const,
                  text: "Steer question",
                  text_elements: [],
                },
              ],
            },
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      })),
    });
    const reader = new CodexAppServerHistoryReader({ client: fake });

    const result = await reader.getSemanticTurnsPage(
      thread().id,
      "project" as UrlProjectId,
      "/tmp/project",
      { limit: 100, itemsView: "summary" },
    );

    expect(result.kind).toBe("loaded");
    if (result.kind === "loaded") {
      expect(result.messages.map((message) => message.type)).toEqual([
        "user",
        "user",
      ]);
      expect(JSON.stringify(result.messages)).not.toContain("secret command");
      expect(JSON.stringify(result.messages)).not.toContain("secret output");
    }
    expect(fake.listItems).toHaveBeenCalledTimes(1);
  });

  it("keeps inherited fork turns when semantic pages contain local media", async () => {
    const forkedThread = {
      ...thread(),
      forkedFromId: "0198f000-0000-7000-8000-000000000000",
    };
    const listTurns = vi.fn(async () => ({
      data: [
        {
          id: "turn-edited",
          items: [],
          itemsView: "summary" as const,
          status: "completed" as const,
          error: null,
          startedAt: 1_777_000_030,
          completedAt: 1_777_000_040,
          durationMs: 10_000,
        },
        {
          id: "turn-inherited-media",
          items: [],
          itemsView: "summary" as const,
          status: "completed" as const,
          error: null,
          startedAt: 1_777_000_010,
          completedAt: 1_777_000_020,
          durationMs: 10_000,
        },
      ],
      nextCursor: null,
      backwardsCursor: null,
    }));
    const listItems = vi.fn(async ({ turnId }: { turnId: string }) => ({
      data:
        turnId === "turn-edited"
          ? [
              {
                turnId,
                item: {
                  type: "userMessage" as const,
                  id: "edited-user",
                  clientId: "edited-client",
                  content: [
                    {
                      type: "text" as const,
                      text: "Edited question",
                      text_elements: [],
                    },
                  ],
                },
              },
            ]
          : [
              {
                turnId,
                item: {
                  type: "userMessage" as const,
                  id: "inherited-user",
                  clientId: "inherited-client",
                  content: [
                    {
                      type: "text" as const,
                      text: "Question with screenshot",
                      text_elements: [],
                    },
                    {
                      type: "localImage" as const,
                      path: "/tmp/project/screenshot.png",
                    },
                  ],
                },
              },
              {
                turnId,
                item: {
                  type: "imageView" as const,
                  id: "image-view",
                  path: "/tmp/project/screenshot.png",
                },
              },
            ],
      nextCursor: null,
      backwardsCursor: null,
    }));
    const fake = client({
      readThread: vi.fn(async () => ({ thread: forkedThread })),
      listTurns,
      listItems,
    });
    const reader = new CodexAppServerHistoryReader({ client: fake });

    const result = await reader.getSemanticTurnsPage(
      forkedThread.id,
      "project" as UrlProjectId,
      "/tmp/project",
      { limit: 40, itemsView: "full" },
    );

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.messages.map((message) => message.uuid)).toEqual([
      "inherited-user-turn-inherited-media",
      "image-view-turn-inherited-media",
      "image-view-turn-inherited-media-result",
      "edited-user-turn-edited",
    ]);
    expect(result.messages[0]?.message?.content).toEqual([
      { type: "text", text: "Question with screenshot" },
      {
        type: "input_image",
        file_path: "/tmp/project/screenshot.png",
        deferred: true,
      },
    ]);
    expect(result.messages[1]?.message?.content).toEqual([
      {
        type: "tool_use",
        id: "image-view",
        name: "ViewImage",
        input: { path: "/tmp/project/screenshot.png" },
      },
    ]);
    expect(JSON.stringify(result.messages)).not.toContain("data:image");

    const exact = await reader.getSemanticTurn(
      forkedThread.id,
      "/tmp/project",
      "turn-inherited-media",
      result.revision,
    );
    expect(exact.kind).toBe("loaded");
    if (exact.kind === "loaded") {
      expect(exact.messages).toHaveLength(3);
    }
  });

  it("projects hydrated question-page local media as deferred", async () => {
    const localImage = {
      type: "userMessage" as const,
      id: "summary-local-image",
      clientId: "summary-local-client",
      content: [
        {
          type: "text" as const,
          text: "Inspect this image",
          text_elements: [],
        },
        {
          type: "localImage" as const,
          path: "/tmp/project/summary.png",
        },
      ],
    };
    const fake = client({
      listTurns: vi.fn(async () => ({
        data: [
          {
            id: "turn-summary-media",
            items: [localImage],
            itemsView: "summary" as const,
            status: "completed" as const,
            error: null,
            startedAt: 1_777_000_010,
            completedAt: 1_777_000_020,
            durationMs: 10_000,
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      })),
      listItems: vi.fn(async () => ({
        data: [{ turnId: "turn-summary-media", item: localImage }],
        nextCursor: null,
        backwardsCursor: null,
      })),
    });
    const reader = new CodexAppServerHistoryReader({ client: fake });

    const result = await reader.getSemanticTurnsPage(
      thread().id,
      "project" as UrlProjectId,
      "/tmp/project",
      { limit: 40, itemsView: "summary" },
    );

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.messages[0]?.message?.content).toEqual([
      { type: "text", text: "Inspect this image" },
      {
        type: "input_image",
        file_path: "/tmp/project/summary.png",
        deferred: true,
      },
    ]);
    expect(fake.listItems).toHaveBeenCalledTimes(1);
  });

  it("uses an opaque semantic notice for an unknown future ThreadItem", async () => {
    const fake = client({
      listItems: vi.fn(async () => ({
        data: [
          {
            turnId: "turn-1",
            item: {
              type: "futureSecretItem",
              id: "future-secret",
              secret: "must-not-leak",
            },
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      })),
    });
    const reader = new CodexAppServerHistoryReader({ client: fake });

    const result = await reader.getSemanticTurnsPage(
      thread().id,
      "project" as UrlProjectId,
      "/tmp/project",
      { limit: 40, itemsView: "full" },
    );

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.messages).toEqual([
      expect.objectContaining({
        uuid: "future-secret-turn-1",
        type: "system",
        subtype: "codex_native_item",
        codexThreadItem: { type: "futureSecretItem" },
      }),
    ]);
    expect(JSON.stringify(result.messages)).not.toContain("must-not-leak");
  });

  it("builds b1/b2 navigation across a native Codex fork family", async () => {
    const userEntry = (turnId: string, itemId: string, text: string) => ({
      turnId,
      item: {
        type: "userMessage" as const,
        id: itemId,
        clientId: null,
        content: [{ type: "text" as const, text, text_elements: [] }],
      },
    });
    const rootItems = [
      userEntry("turn-a", "user-a", "a"),
      // Multiple steered user messages can share one native turn. The stored
      // target must select b rather than the first post-prefix message x.
      userEntry("turn-steered", "user-x", "x"),
      userEntry("turn-b", "user-b", "b"),
      userEntry("turn-c", "user-c", "c"),
    ];
    const childItems = [
      userEntry("turn-a", "user-a", "a"),
      // Keep the same text as b: retained native identity, not text, proves
      // that this is the replacement rather than copied history.
      userEntry("turn-b2", "user-b2", "b"),
      userEntry("turn-d", "user-d", "d"),
    ];
    const fake = client({
      listItems: vi.fn(async ({ threadId }: { threadId: string }) => ({
        data: threadId === "child" ? childItems : rootItems,
        nextCursor: null,
        backwardsCursor: null,
      })),
    });
    const reader = new CodexAppServerHistoryReader({ client: fake });
    const candidates = [
      {
        id: "root",
        createdAt: "2026-09-01T00:00:00.000Z",
        provider: "codex" as const,
      },
      {
        id: "child",
        forkParentSessionId: "root",
        forkTargetMessageId: "user-b-turn-b",
        createdAt: "2026-09-01T00:01:00.000Z",
        provider: "codex" as const,
      },
    ];

    const state = await reader.getForkBranchState(
      "child",
      candidates,
      "user-b2-turn-b2",
    );

    expect(state).toMatchObject({
      sessionId: "child",
      provider: "codex",
      activeBranchId: "user-d-turn-d",
      selectedBranchId: "user-b2-turn-b2",
    });
    const branches = new Map(
      state?.branches.map((branch) => [branch.id, branch]),
    );
    expect(branches.get("user-b-turn-b")).toMatchObject({
      sessionId: "root",
      parentId: "user-x-turn-steered",
      siblingIndex: 1,
      siblingCount: 2,
      isActive: false,
    });
    expect(branches.get("user-b2-turn-b2")).toMatchObject({
      sessionId: "child",
      parentId: "user-x-turn-steered",
      siblingIndex: 2,
      siblingCount: 2,
      isActive: true,
    });
    expect(branches.get("user-c-turn-c")?.parentId).toBe("user-b-turn-b");
    expect(branches.get("user-d-turn-d")?.parentId).toBe("user-b2-turn-b2");

    const rootState = await reader.getForkBranchState("root", candidates);
    expect(rootState?.activeBranchId).toBe("user-c-turn-c");
    expect(rootState?.branches).toHaveLength(6);
  });

  it("maps a bounded paginated item page without reading the rollout", async () => {
    const fake = client();
    const reader = new CodexAppServerHistoryReader({ client: fake });
    const result = await reader.getSession(
      thread().id,
      "project" as UrlProjectId,
      "/tmp/project",
      undefined,
      { maxMessages: 10, tailCompactions: 2 },
    );

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.session.historySource).toBe("codex-app-server");
    expect(
      result.session.projectedMessages?.map((message) => message.uuid),
    ).toEqual([
      "user-1-turn-1",
      "agent-1-turn-1",
      "command-1-turn-1",
      "command-1-turn-1-result",
    ]);
    expect(
      result.session.projectedMessages?.[2]?.message?.content,
    ).toMatchObject([{ type: "tool_use", id: "command-1", name: "Bash" }]);
    expect(result.session.projectedMessages?.[0]).toMatchObject({
      clientUserMessageId: "client-user-1",
      codexCorrelationKey: "codex:user-message:client-user-1",
    });
    expect(result.session.projectedMessages?.[2]).toMatchObject({
      codexThreadId: thread().id,
      codexTurnId: "turn-1",
      codexThreadItemId: "command-1",
      codexThreadItemLifecycle: "completed",
    });
    expect(result.session.projectedMessages?.[2]).not.toHaveProperty(
      "codexThreadItem",
    );
    expect(
      JSON.stringify(result.session.projectedMessages).match(/passed/g),
    ).toHaveLength(1);
    expect(result.session.pagination?.hasOlderMessages).toBe(true);
    expect(
      decodeCodexAppServerCursor(
        result.session.pagination?.truncatedBeforeMessageId,
      )?.cursor,
    ).toBe("older-items");
    expect(fake.listItems).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: null,
        limit: 5,
        sortDirection: "desc",
      }),
    );
  });

  it.each([
    ["/tmp/project/src/a.ts", "src/a.ts"],
    [
      "/var/folders/aa/private-user/T/run/api_request.py",
      expect.stringMatching(/^\[tmp:[a-f0-9]{16}\]\/api_request\.py$/),
    ],
    [
      "/Users/private-user/Downloads/report.py",
      expect.stringMatching(/^\[home:[a-f0-9]{16}\]\/report\.py$/),
    ],
  ])(
    "projects app-server file paths without losing external filenames: %s",
    async (path, _displayPath) => {
      const fake = client({
        listItems: vi.fn(async () => ({
          data: [
            {
              turnId: "turn-1",
              item: {
                type: "fileChange" as const,
                id: "file-1",
                status: "completed" as const,
                changes: [
                  {
                    path,
                    kind: { type: "update" as const, move_path: null },
                    diff: "@@ -1 +1 @@\n-old\n+new\n",
                  },
                ],
              },
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
        })),
      });
      const reader = new CodexAppServerHistoryReader({ client: fake });
      const result = await reader.getSession(
        thread().id,
        "project" as UrlProjectId,
        "/tmp/project",
        undefined,
        { maxMessages: 10 },
      );

      expect(result.kind).toBe("loaded");
      if (result.kind !== "loaded") return;
      expect(
        result.session.projectedMessages?.[0]?.message?.content,
      ).toMatchObject([
        {
          type: "tool_use",
          id: "file-1",
          name: "Edit",
          input: {
            file_path: path,
            changes: [expect.objectContaining({ path })],
          },
        },
      ]);
      expect(JSON.stringify(result.session.projectedMessages)).toContain(path);
    },
  );

  it("passes only an app-server cursor to an older-page request", async () => {
    const fake = client();
    const reader = new CodexAppServerHistoryReader({ client: fake });
    const cursor = encodeCodexAppServerCursor("opaque-upstream-cursor", {
      direction: "older",
      sessionId: thread().id,
    });

    await reader.getSession(
      thread().id,
      "project" as UrlProjectId,
      "/tmp/project",
      undefined,
      { beforeMessageId: cursor, maxMessages: 10 },
    );

    expect(fake.listItems).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "opaque-upstream-cursor" }),
    );
  });

  it("falls back instead of exceeding maxMessages across failed tool turns", async () => {
    const turns = Array.from({ length: 4 }, (_, index) => ({
      id: `failed-turn-${index}`,
      items: [],
      itemsView: "notLoaded" as const,
      status: "failed" as const,
      error: { message: `provider-${index}` },
      startedAt: 1_777_000_010 + index,
      completedAt: 1_777_000_020 + index,
      durationMs: 10,
    }));
    const fake = client({
      listTurns: vi.fn(async () => ({
        data: turns,
        nextCursor: null,
        backwardsCursor: null,
      })),
      listItems: vi.fn(async (params: { limit?: number | null }) => ({
        data: turns
          .map((turn, index) => ({
            turnId: turn.id,
            item: {
              type: "commandExecution" as const,
              id: `command-${index}`,
              pluginId: null,
              scriptPath: null,
              command: "false",
              cwd: "/tmp/project",
              processId: null,
              source: "agent" as const,
              status: "failed" as const,
              commandActions: [],
              aggregatedOutput: "failed",
              exitCode: 1,
              durationMs: 1,
            },
          }))
          .slice(0, params.limit ?? turns.length),
        nextCursor: "older",
        backwardsCursor: null,
      })),
    });
    const reader = new CodexAppServerHistoryReader({ client: fake });
    const result = await reader.getSession(
      thread().id,
      "project" as UrlProjectId,
      "/tmp/project",
      undefined,
      { maxMessages: 6 },
    );

    expect(result).toMatchObject({
      kind: "fallback",
      reason: "transcript_parity",
    });
    expect(fake.listItems).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3 }),
    );
  });

  it("falls back for legacy history and unsupported query shapes", async () => {
    const legacyClient = client({
      readThread: vi.fn(async () => ({ thread: thread("legacy") })),
    });
    const reader = new CodexAppServerHistoryReader({ client: legacyClient });

    await expect(
      reader.getSession(
        thread().id,
        "project" as UrlProjectId,
        "/tmp/project",
        undefined,
        {},
      ),
    ).resolves.toMatchObject({ kind: "fallback", reason: "legacy_history" });
    await expect(
      reader.getSession(
        thread().id,
        "project" as UrlProjectId,
        "/tmp/project",
        "ordinary-message-id",
        {},
      ),
    ).resolves.toEqual({ kind: "fallback", reason: "unsupported_query" });
  });

  it("returns typed fallback reasons and promotes invalid cursors to stale", async () => {
    const unsupported = client({
      listItems: vi.fn(async () => {
        throw new CodexHistoryClientError("unsupported");
      }),
    });
    const unsupportedReader = new CodexAppServerHistoryReader({
      client: unsupported,
    });
    await expect(
      unsupportedReader.getSession(
        thread().id,
        "project" as UrlProjectId,
        "/tmp/project",
        undefined,
        {},
      ),
    ).resolves.toMatchObject({
      kind: "fallback",
      reason: "unsupported_method",
    });

    const invalidCursor = client({
      listItems: vi.fn(async () => {
        throw new CodexHistoryClientError("invalid_cursor");
      }),
    });
    const invalidReader = new CodexAppServerHistoryReader({
      client: invalidCursor,
    });
    await expect(
      invalidReader.getSession(
        thread().id,
        "project" as UrlProjectId,
        "/tmp/project",
        undefined,
        {
          beforeMessageId: encodeCodexAppServerCursor("stale", {
            direction: "older",
            sessionId: thread().id,
          }),
        },
      ),
    ).rejects.toThrow("ROLLOUT_CURSOR_STALE");
  });

  it("pages first, older, newer, and round-trips without duplicate boundaries", async () => {
    const chronological = Array.from({ length: 9 }, (_, index) => index + 1);
    const fake = client({
      listItems: vi.fn(
        async (params: {
          cursor: string | null;
          limit: number | null;
          sortDirection: "asc" | "desc" | null;
        }) => {
          const ordered =
            params.sortDirection === "asc"
              ? chronological
              : [...chronological].reverse();
          const [cursorKind, cursorValue] = params.cursor?.split(":") ?? [];
          const anchor = cursorValue ? Number(cursorValue) : undefined;
          const anchorIndex =
            anchor === undefined ? -1 : ordered.indexOf(anchor);
          const start =
            anchorIndex < 0
              ? 0
              : anchorIndex + (cursorKind === "after" ? 1 : 0);
          const limit = params.limit ?? ordered.length;
          const ids = ordered.slice(start, start + limit);
          return {
            data: ids.map((id) => ({
              turnId: "turn-1",
              item: {
                type: "userMessage" as const,
                id: `item-${id}`,
                clientId: null,
                content: [
                  {
                    type: "text" as const,
                    text: `message-${id}`,
                    text_elements: [],
                  },
                ],
              },
            })),
            nextCursor:
              start + ids.length < ordered.length
                ? `after:${ids.at(-1)}`
                : null,
            backwardsCursor: ids.length > 0 ? `at:${ids[0]}` : null,
          };
        },
      ),
    });
    const reader = new CodexAppServerHistoryReader({ client: fake });
    const read = (options: {
      beforeMessageId?: string;
      afterWindowMessageId?: string;
    }) =>
      reader.getSession(
        thread().id,
        "project" as UrlProjectId,
        "/tmp/project",
        undefined,
        { ...options, maxMessages: 6 },
      );
    const ids = (result: Awaited<ReturnType<typeof read>>) => {
      expect(result.kind).toBe("loaded");
      return result.kind === "loaded"
        ? result.session.projectedMessages?.map((message) => message.uuid)
        : [];
    };

    const first = await read({});
    expect(ids(first)).toEqual([
      "item-7-turn-1",
      "item-8-turn-1",
      "item-9-turn-1",
    ]);
    expect(first.kind === "loaded" && first.session.pagination).toMatchObject({
      hasOlderMessages: true,
      hasNewerMessages: false,
    });

    const firstOlderCursor =
      first.kind === "loaded"
        ? first.session.pagination?.truncatedBeforeMessageId
        : undefined;
    expect(decodeCodexAppServerCursor(firstOlderCursor)).toMatchObject({
      direction: "older",
      sessionId: thread().id,
    });
    const older = await read({ beforeMessageId: firstOlderCursor });
    expect(ids(older)).toEqual([
      "item-4-turn-1",
      "item-5-turn-1",
      "item-6-turn-1",
    ]);

    const newerCursor =
      older.kind === "loaded"
        ? older.session.pagination?.truncatedAfterMessageId
        : undefined;
    expect(decodeCodexAppServerCursor(newerCursor)).toMatchObject({
      direction: "newer",
      overlapItemId: "item-6",
    });
    const newer = await read({ afterWindowMessageId: newerCursor });
    expect(ids(newer)).toEqual([
      "item-7-turn-1",
      "item-8-turn-1",
      "item-9-turn-1",
    ]);
    expect(new Set([...(ids(older) ?? []), ...(ids(newer) ?? [])]).size).toBe(
      6,
    );

    const roundTripOlderCursor =
      newer.kind === "loaded"
        ? newer.session.pagination?.truncatedBeforeMessageId
        : undefined;
    const roundTrip = await read({ beforeMessageId: roundTripOlderCursor });
    expect(ids(roundTrip)).toEqual(ids(older));
    expect(fake.listItems).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: "at:6",
        limit: 4,
        sortDirection: "asc",
      }),
    );
  });

  it("rejects malformed, wrong-direction, cross-session, and source-changing cursors", async () => {
    const fake = client();
    const reader = new CodexAppServerHistoryReader({ client: fake });
    const newerCursor = encodeCodexAppServerCursor("at:1", {
      direction: "newer",
      sessionId: thread().id,
      overlapItemId: "item-1",
    });
    await expect(
      reader.getSession(
        thread().id,
        "project" as UrlProjectId,
        "/tmp/project",
        undefined,
        { beforeMessageId: newerCursor },
      ),
    ).rejects.toThrow("ROLLOUT_CURSOR_STALE");

    const otherSessionCursor = encodeCodexAppServerCursor("after:1", {
      direction: "older",
      sessionId: "0198f000-0000-7000-8000-000000000099",
    });
    await expect(
      reader.getSession(
        thread().id,
        "project" as UrlProjectId,
        "/tmp/project",
        undefined,
        { beforeMessageId: otherSessionCursor },
      ),
    ).rejects.toThrow("ROLLOUT_CURSOR_STALE");

    await expect(
      reader.getSession(
        thread().id,
        "project" as UrlProjectId,
        "/tmp/project",
        undefined,
        { beforeMessageId: "yep-codex-history-v1.invalid" },
      ),
    ).rejects.toThrow("ROLLOUT_CURSOR_STALE");

    const unavailable = client({
      readThread: vi.fn(async () => {
        throw new CodexHistoryClientError("unavailable");
      }),
    });
    const unavailableReader = new CodexAppServerHistoryReader({
      client: unavailable,
    });
    const olderCursor = encodeCodexAppServerCursor("after:1", {
      direction: "older",
      sessionId: thread().id,
    });
    await expect(
      unavailableReader.getSession(
        thread().id,
        "project" as UrlProjectId,
        "/tmp/project",
        undefined,
        { beforeMessageId: olderCursor },
      ),
    ).rejects.toThrow("ROLLOUT_CURSOR_STALE");
  });

  it("falls back for the golden page when media/artifact parity cannot be preserved", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          "../fixtures/codex-history/thread-items-golden.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      turns: Array<Record<string, unknown>>;
      entries: Array<Record<string, unknown>>;
    };
    const fake = client({
      listTurns: vi.fn(async () => ({
        data: fixture.turns,
        nextCursor: null,
        backwardsCursor: "turn-head",
      })),
      listItems: vi.fn(async () => ({
        data: [...fixture.entries].reverse(),
        nextCursor: null,
        backwardsCursor: "item-head",
      })),
    });
    const reader = new CodexAppServerHistoryReader({ client: fake });
    const result = await reader.getSession(
      thread().id,
      "project" as UrlProjectId,
      "/tmp/project",
      undefined,
      { maxMessages: 100 },
    );

    expect(result).toMatchObject({
      kind: "fallback",
      reason: "transcript_parity",
    });
  });

  it("projects the supported golden fast path once and keeps the page near the old payload size", async () => {
    const largeOutput = "O".repeat(360 * 1024);
    const fake = client({
      listTurns: vi.fn(async () => ({
        data: [
          {
            id: "turn-supported",
            items: [],
            itemsView: "notLoaded" as const,
            status: "failed" as const,
            error: { message: "provider unavailable" },
            startedAt: 1_777_000_010,
            completedAt: 1_777_000_020,
            durationMs: 10_000,
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      })),
      listItems: vi.fn(async () => ({
        data: [
          {
            turnId: "turn-supported",
            item: {
              type: "plan" as const,
              id: "plan-1",
              text: "1. Verify\n2. Finish",
            },
          },
          {
            turnId: "turn-supported",
            item: {
              type: "commandExecution" as const,
              id: "command-large",
              pluginId: null,
              scriptPath: "/private/plugin.js",
              command: "run benchmark",
              cwd: "/private/project",
              processId: null,
              source: "agent" as const,
              status: "completed" as const,
              commandActions: [],
              aggregatedOutput: largeOutput,
              exitCode: 0,
              durationMs: 12,
            },
          },
          {
            turnId: "turn-supported",
            item: {
              type: "reasoning" as const,
              id: "reasoning-1",
              summary: ["safe summary"],
              content: ["raw secret reasoning"],
            },
          },
          {
            turnId: "turn-supported",
            item: {
              type: "userMessage" as const,
              id: "user-media",
              clientId: null,
              content: [
                { type: "text" as const, text: "inspect", text_elements: [] },
                {
                  type: "image" as const,
                  url: "https://media.example/image.png",
                  detail: "high" as const,
                },
                {
                  type: "audio" as const,
                  url: "https://media.example/audio.wav",
                },
              ],
            },
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      })),
    });
    const reader = new CodexAppServerHistoryReader({ client: fake });
    const result = await reader.getSession(
      thread().id,
      "project" as UrlProjectId,
      "/tmp/project",
      undefined,
      { maxMessages: 100 },
    );

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    const messages = result.session.projectedMessages ?? [];
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain("raw secret reasoning");
    expect(serialized.indexOf(largeOutput)).toBe(
      serialized.lastIndexOf(largeOutput),
    );
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(450 * 1024);
    expect(
      messages.find(
        (message) => message.uuid === "command-large-turn-supported",
      ),
    ).not.toHaveProperty("codexThreadItem");
    expect(
      messages.find((message) => message.uuid === "plan-1-turn-supported"),
    ).toMatchObject({
      type: "system",
      subtype: "codex_native_item",
      codexThreadItem: { type: "plan", text: "1. Verify\n2. Finish" },
    });
    expect(
      messages.find(
        (message) => message.uuid === "provider-error-turn-supported",
      ),
    ).toMatchObject({ type: "error", error: "provider unavailable" });
  });

  it("never reports a real base64 imageGeneration as a successful app-server page", async () => {
    const item = {
      type: "imageGeneration" as const,
      id: "image-generation",
      status: "completed",
      revisedPrompt: "one pixel",
      result:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
      transparentBackground: true,
      savedPath: "/private/generated.png",
    };
    const fake = client({
      listItems: vi.fn(async () => ({
        data: [{ turnId: "turn-1", item }],
        nextCursor: null,
        backwardsCursor: null,
      })),
    });
    const reader = new CodexAppServerHistoryReader({ client: fake });
    await expect(
      reader.getSession(
        thread().id,
        "project" as UrlProjectId,
        "/tmp/project",
        undefined,
        {},
      ),
    ).resolves.toMatchObject({
      kind: "fallback",
      reason: "transcript_parity",
    });
    await expect(
      reader.getSession(
        thread().id,
        "project" as UrlProjectId,
        "/tmp/project",
        undefined,
        {
          beforeMessageId: encodeCodexAppServerCursor("older", {
            direction: "older",
            sessionId: thread().id,
          }),
        },
      ),
    ).rejects.toThrow("ROLLOUT_CURSOR_STALE");
  });

  it.each([
    {
      type: "userMessage",
      id: "local-image",
      clientId: null,
      content: [{ type: "localImage", path: "/private/image.png" }],
    },
    {
      type: "userMessage",
      id: "local-audio",
      clientId: null,
      content: [{ type: "localAudio", path: "/private/audio.wav" }],
    },
    {
      type: "functionCallOutput",
      id: "standalone-output",
      name: "private-tool",
      namespace: null,
      output: "hidden output",
    },
    { type: "imageView", id: "image-view", path: "/private/view.png" },
    {
      type: "hookPrompt",
      id: "hook",
      fragments: [{ text: "hidden prompt", hookRunId: "run-1" }],
    },
    { type: "sleep", id: "sleep", durationMs: 100 },
    { type: "enteredReviewMode", id: "review-in", review: "review" },
    { type: "exitedReviewMode", id: "review-out", review: "review" },
  ])("falls back instead of emitting a label-only $type item", async (item) => {
    const fake = client({
      listItems: vi.fn(async () => ({
        data: [{ turnId: "turn-1", item }],
        nextCursor: null,
        backwardsCursor: null,
      })),
    });
    const reader = new CodexAppServerHistoryReader({ client: fake });
    await expect(
      reader.getSession(
        thread().id,
        "project" as UrlProjectId,
        "/tmp/project",
        undefined,
        {},
      ),
    ).resolves.toMatchObject({
      kind: "fallback",
      reason: "transcript_parity",
    });
  });

  it("keeps a source-locked Inspector page readable when it contains local media", async () => {
    const fake = client({
      listItems: vi.fn(async () => ({
        data: [
          {
            turnId: "turn-1",
            item: {
              type: "userMessage" as const,
              id: "question-with-image",
              clientId: "question-with-image-client",
              content: [
                {
                  type: "text" as const,
                  text: "Inspect this screenshot",
                  text_elements: [],
                },
                {
                  type: "localImage" as const,
                  path: "/tmp/project/screenshot.png",
                },
              ],
            },
          },
        ],
        nextCursor: null,
        backwardsCursor: "newer-items",
      })),
    });
    const reader = new CodexAppServerHistoryReader({ client: fake });
    const result = await reader.getSession(
      thread().id,
      "project" as UrlProjectId,
      "/tmp/project",
      undefined,
      {
        beforeMessageId: encodeCodexAppServerCursor("older-items", {
          direction: "older",
          sessionId: thread().id,
        }),
        inspectorProjection: true,
        maxMessages: 10,
      },
    );

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.session.projectedMessages?.[0]?.message?.content).toEqual([
      { type: "text", text: "Inspect this screenshot" },
      {
        type: "input_image",
        file_path: "/tmp/project/screenshot.png",
        deferred: true,
      },
    ]);
  });

  it("keeps a source-locked Inspector page readable when it contains a body-only native item", async () => {
    const fake = client({
      listItems: vi.fn(async () => ({
        data: [
          {
            turnId: "turn-1",
            item: {
              type: "functionCallOutput" as const,
              id: "standalone-output",
              name: "private-tool",
              namespace: null,
              output: [
                {
                  type: "input_text" as const,
                  text: "STANDALONE_OUTPUT_MUST_NOT_LEAK",
                },
              ],
            },
          },
        ],
        nextCursor: null,
        backwardsCursor: "newer-items",
      })),
    });
    const reader = new CodexAppServerHistoryReader({ client: fake });
    const result = await reader.getSession(
      thread().id,
      "project" as UrlProjectId,
      "/tmp/project",
      undefined,
      {
        beforeMessageId: encodeCodexAppServerCursor("older-items", {
          direction: "older",
          sessionId: thread().id,
        }),
        inspectorProjection: true,
        maxMessages: 10,
      },
    );

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.session.projectedMessages).toMatchObject([
      {
        type: "system",
        subtype: "codex_native_item",
        codexThreadItem: { type: "functionCallOutput" },
      },
    ]);
    expect(JSON.stringify(result.session.projectedMessages)).not.toContain(
      "STANDALONE_OUTPUT_MUST_NOT_LEAK",
    );
  });

  it("retains generated path-bearing fields while omitting inline image bodies", () => {
    const items = [
      {
        type: "commandExecution",
        id: "command",
        command: "show files",
        cwd: "/private/cwd",
        scriptPath: "/private/plugin/script.js",
        commandActions: [
          { type: "read", command: "read", name: "x", path: "/private/a" },
          { type: "listFiles", command: "ls", path: "/private/b" },
          { type: "search", command: "rg", query: "x", path: "/private/c" },
        ],
      },
      {
        type: "userMessage",
        id: "user",
        content: [
          { type: "localImage", path: "/private/image" },
          { type: "localAudio", path: "/private/audio" },
          { type: "skill", name: "s", path: "/private/skill" },
          { type: "mention", name: "m", path: "/private/mention" },
          { type: "image", url: "file:///private/remote-image" },
          { type: "audio", url: "file:///private/remote-audio" },
        ],
      },
      {
        type: "fileChange",
        id: "file",
        changes: [{ path: "/private/file", kind: "update", diff: "+safe" }],
      },
      { type: "imageView", id: "view", path: "/private/view" },
      {
        type: "mcpToolCall",
        id: "mcp",
        appContext: { resourceUri: "file:///private/resource" },
        mcpAppResourceUri: "file:///private/deprecated",
      },
      {
        type: "hookPrompt",
        id: "hook",
        fragments: [{ text: "/private/hook", hookRunId: "run" }],
      },
      {
        type: "collabAgentToolCall",
        id: "collab",
        prompt: "inspect /private/collab",
      },
      {
        type: "subAgentActivity",
        id: "subagent",
        agentPath: "/private/subagent",
      },
      {
        type: "imageGeneration",
        id: "generated",
        result: "secret-base64",
        savedPath: "/private/generated",
      },
      {
        type: "reasoning",
        id: "reasoning",
        summary: ["public"],
        content: ["/private/raw-reasoning"],
      },
    ].map((item) => publicCodexThreadItem(item));
    const serialized = JSON.stringify(items);

    expect(serialized).toContain("/private/");
    expect(serialized).not.toContain("secret-base64");
    expect(items[0]).toMatchObject({
      command: "show files",
      cwd: "/private/cwd",
      scriptPath: "/private/plugin/script.js",
      commandActions: [
        expect.objectContaining({ path: "/private/a" }),
        expect.objectContaining({ path: "/private/b" }),
        expect.objectContaining({ path: "/private/c" }),
      ],
    });
  });

  it("uses a typed rollout fallback for an unknown future ThreadItem", async () => {
    const fake = client({
      listItems: vi.fn(async () => ({
        data: [
          {
            turnId: "turn-1",
            item: { type: "futureSecretItem", id: "future-1", secret: "x" },
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      })),
    });
    const reader = new CodexAppServerHistoryReader({ client: fake });
    await expect(
      reader.getSession(
        thread().id,
        "project" as UrlProjectId,
        "/tmp/project",
        undefined,
        {},
      ),
    ).resolves.toMatchObject({
      kind: "fallback",
      reason: "transcript_parity",
    });
  });

  it("falls back when the bounded turns page cannot describe an item turn", async () => {
    const fake = client({
      listItems: vi.fn(async () => ({
        data: [
          {
            turnId: "turn-outside-bounded-page",
            item: {
              type: "agentMessage" as const,
              id: "agent-old",
              text: "old",
              phase: null,
              memoryCitation: null,
            },
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      })),
    });
    const reader = new CodexAppServerHistoryReader({ client: fake });

    await expect(
      reader.getSession(
        thread().id,
        "project" as UrlProjectId,
        "/tmp/project",
        undefined,
        {},
      ),
    ).resolves.toMatchObject({
      kind: "fallback",
      reason: "transcript_parity",
    });
  });
});
