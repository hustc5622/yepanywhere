import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import type {
  CodexNativeItem,
  DisplayToolGroupItem,
  RenderItem,
} from "../../types/renderItems";
import { preprocessMessages } from "../preprocessMessages";
import { preprocessMessagesCached } from "../preprocessMessagesCache";
import {
  collapseCodexSubagentActivities,
  projectCodexMainTimeline,
} from "../preprocessMessagesSubagents";

function activity(
  id: string,
  kind: string,
  agent = "review",
  turn = "parent-turn-1",
): Message {
  return {
    id,
    type: "system",
    subtype: "codex_native_item",
    codexThreadItem: {
      type: "subAgentActivity",
      id,
      kind,
      agentThreadId: `thread-${agent}`,
      agentPath: `/root/${agent}`,
    },
    codexThreadItemLifecycle: "completed",
    codexTurnId: turn,
  };
}

function communication(id: string, kind: string, agent = "review"): Message {
  return {
    id,
    type: "system",
    subtype: "codex_native_item",
    codexThreadItem: {
      type: "interAgentMessage",
      id,
      kind,
      sender: kind === "result" ? `/root/${agent}` : "/root",
      recipient: kind === "result" ? "/root" : `/root/${agent}`,
      text: `${kind} body`,
      encrypted: false,
    },
    codexThreadItemLifecycle: "completed",
  };
}

function nativeItems(items: RenderItem[]): CodexNativeItem[] {
  return items.filter(
    (item): item is CodexNativeItem => item.type === "codex_native_item",
  );
}

describe("Codex subagent execution cards", () => {
  it("keeps one stable card from start to completion across parent turns and interleaved agents", () => {
    const messages = [
      activity("start-review", "started"),
      activity("start-test", "started", "test"),
      { id: "q2", type: "user", content: "Continue" } as Message,
      activity("end-review", "completed", "review", "parent-turn-2"),
      activity("end-test", "completed", "test", "parent-turn-2"),
    ];
    const items = preprocessMessages(messages);
    expect(items.map((item) => item.id)).toEqual([
      "start-review",
      "start-test",
      "q2",
    ]);
    const cards = nativeItems(items);
    expect(cards.map((item) => item.threadItem.kind)).toEqual([
      "completed",
      "completed",
    ]);
    expect(cards[0]?.sourceMessages.map((message) => message.id)).toEqual([
      "start-review",
      "end-review",
    ]);
    expect(messages[0]?.codexThreadItem).toMatchObject({ kind: "started" });
  });

  it("retains later executions and does not treat ordinary interactions as new starts", () => {
    const cards = nativeItems(
      preprocessMessages([
        activity("start", "started"),
        activity("message", "interacted"),
        activity("end", "completed"),
        activity("next-message", "interacted"),
        activity("next-end", "completed"),
        activity("third-start", "started"),
        activity("third-end", "interrupted"),
      ]),
    );
    expect(cards.map((item) => [item.id, item.threadItem.kind])).toEqual([
      ["start", "completed"],
      ["message", "interacted"],
      ["next-message", "interacted"],
      ["next-end", "completed"],
      ["third-start", "interrupted"],
    ]);
  });

  it("recognizes a followup by its tool call id, while a running followup continues the current round", () => {
    const call = (id: string): Message => ({
      id: `message-${id}`,
      type: "assistant",
      content: [
        {
          type: "tool_use",
          id,
          name: "collaboration.followup_task",
          input: { target: "review", message: "Review again" },
        },
      ],
    });
    const cards = nativeItems(
      preprocessMessages([
        activity("start", "started"),
        activity("end", "completed"),
        call("followup"),
        activity("followup", "interacted"),
        communication("followup-task", "task"),
        call("steer"),
        activity("steer", "interacted"),
        activity("next-end", "completed"),
      ]),
    );
    expect(cards).toHaveLength(3);
    expect(cards[1]).toMatchObject({
      id: "followup",
      threadItem: { kind: "completed" },
      subagentActivity: { entryKind: "followup" },
    });
  });

  it("keeps all assignments and returned results independent for the child detail", () => {
    const items = nativeItems(
      preprocessMessages([
        activity("start", "started"),
        communication("task", "task"),
        activity("end", "completed"),
        communication("result", "result"),
        activity("next-start", "started"),
        communication("late-result", "result"),
      ]),
    );
    expect(items).toHaveLength(5);
    expect(items[0]?.subagentActivity?.task).toBeUndefined();
    expect(items[0]?.subagentActivity?.result).toBeUndefined();
    expect(items[1]?.threadItem).toMatchObject({
      type: "interAgentMessage",
      kind: "task",
    });
    expect(items[2]?.threadItem).toMatchObject({
      type: "interAgentMessage",
      kind: "result",
    });
    expect(items[4]?.threadItem).toMatchObject({
      type: "interAgentMessage",
      id: "late-result",
    });
  });

  it("does not use opaque tool arguments as task text and retains truncated message metadata", () => {
    const encryptedInput: Message = {
      id: "spawn-call",
      type: "assistant",
      content: [
        {
          type: "tool_use",
          id: "start",
          name: "collaboration.spawn_agent",
          input: { message: '{"encrypted_content":"gAAAAA-secret"}' },
        },
      ],
    };
    const result = communication("result", "result");
    result.codexThreadItem = {
      ...(result.codexThreadItem as Record<string, unknown>),
      truncated: true,
    };
    const cards = nativeItems(
      preprocessMessages([
        encryptedInput,
        activity("start", "started"),
        activity("end", "completed"),
        result,
      ]),
    );
    expect(cards[0]?.subagentActivity?.task).toBeUndefined();
    expect(cards[1]?.threadItem).toMatchObject({
      text: "result body",
      encrypted: false,
      truncated: true,
    });
  });

  it("deduplicates page/live replays, remains idempotent, and never regresses a finished round", () => {
    const historical = preprocessMessages([
      activity("start", "started"),
      activity("end", "completed"),
    ]);
    const replayStart = activity("start", "started");
    replayStart.id = "live-start";
    const live = preprocessMessages([
      replayStart,
      activity("end", "completed"),
    ]);
    const combined = collapseCodexSubagentActivities([...historical, ...live]);
    expect(combined).toHaveLength(1);
    expect(nativeItems(combined)[0]?.threadItem.kind).toBe("completed");
    expect(collapseCodexSubagentActivities(combined)).toEqual(combined);
    expect(
      collapseCodexSubagentActivities([
        ...combined,
        ...preprocessMessages([replayStart]),
      ]),
    ).toHaveLength(1);
  });

  it.each(["message", "task", "result"])(
    "deduplicates standalone %s history/live communication and preserves both sources",
    (kind) => {
      const history = communication("mail-1", kind);
      history.id = "history-message";
      const live = { ...history, id: "live-message" };
      const combined = collapseCodexSubagentActivities([
        ...preprocessMessages([history]),
        ...preprocessMessages([live]),
      ]);
      expect(combined).toHaveLength(1);
      expect(combined[0]?.id).toBe("history-message");
      expect(combined[0]?.sourceMessages.map((source) => source.id)).toEqual([
        "history-message",
        "live-message",
      ]);
      expect(collapseCodexSubagentActivities(combined)).toEqual(combined);
    },
  );

  it("scopes communication identity to the receiving thread and turn", () => {
    const original = {
      ...communication("mail-1", "message"),
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
    };
    expect(
      preprocessMessages([
        original,
        { ...original, id: "other-turn", codexTurnId: "turn-2" },
        { ...original, id: "other-thread", codexThreadId: "thread-2" },
      ]),
    ).toHaveLength(3);
  });

  it("keeps an old result replay in its original communication row after another round finishes", () => {
    const original = communication("result-1", "result");
    const historical = preprocessMessages([
      activity("start-1", "started"),
      activity("end-1", "completed"),
      original,
      activity("start-2", "started"),
      activity("end-2", "completed"),
    ]);
    const combined = collapseCodexSubagentActivities([
      ...historical,
      ...preprocessMessages([{ ...original, id: "live-result-1" }]),
    ]);
    const cards = nativeItems(combined);
    expect(cards).toHaveLength(3);
    expect(cards[1]?.threadItem.text).toBe("result body");
    expect(cards[1]?.sourceMessages.at(-1)?.id).toBe("live-result-1");
    expect(cards[2]?.subagentActivity?.result).toBeUndefined();
  });

  it("keeps a first delayed result separate when more than one completed round lacks a result", () => {
    const items = nativeItems(
      preprocessMessages([
        activity("start-1", "started"),
        activity("end-1", "completed"),
        activity("start-2", "started"),
        activity("end-2", "completed"),
        communication("delayed-first-result", "result"),
      ]),
    );
    expect(items).toHaveLength(3);
    expect(items[0]?.subagentActivity?.result).toBeUndefined();
    expect(items[1]?.subagentActivity?.result).toBeUndefined();
    expect(items[2]?.threadItem.type).toBe("interAgentMessage");
  });

  it("recognizes followups on display items whose tools have not been expanded", () => {
    const followup = activity("followup", "interacted");
    followup.codexThreadItem = {
      ...(followup.codexThreadItem as Record<string, unknown>),
      operation: "followup_task",
    };
    const cards = nativeItems(
      preprocessMessages([
        activity("start", "started"),
        activity("end", "completed"),
        followup,
        activity("next-end", "completed"),
      ]),
    );
    expect(cards).toHaveLength(2);
    expect(cards[1]?.id).toBe("followup");
    expect(cards[1]?.threadItem.kind).toBe("completed");
  });

  it("does not move the latest round backwards when a previous round is replayed", () => {
    const original = preprocessMessages([
      activity("start", "started"),
      activity("end", "completed"),
      activity("next-start", "started"),
    ]);
    const combined = collapseCodexSubagentActivities([
      ...original,
      ...preprocessMessages([activity("end", "completed")]),
      ...preprocessMessages([activity("next-end", "completed")]),
    ]);
    expect(nativeItems(combined).map((item) => item.threadItem.kind)).toEqual([
      "completed",
      "completed",
    ]);
  });

  it("joins a paginated terminal event when the older start page arrives", () => {
    const endPage = preprocessMessages([activity("end", "completed")]);
    expect(endPage).toHaveLength(1);
    const mergedPages = collapseCodexSubagentActivities([
      ...preprocessMessages([activity("start", "started")]),
      ...endPage,
    ]);
    expect(mergedPages).toHaveLength(1);
    expect(mergedPages[0]?.id).toBe("start");
  });

  it("does not merge an independently aggregated new round into an unfinished earlier round", () => {
    const combined = collapseCodexSubagentActivities([
      ...preprocessMessages([activity("start", "started")]),
      ...preprocessMessages([
        activity("next-start", "started"),
        activity("next-end", "completed"),
      ]),
    ]);
    expect(combined).toHaveLength(2);
  });

  it("retains aggregated cards while the cached assistant tail streams", () => {
    const messages = [
      activity("start", "started"),
      activity("end", "completed"),
    ];
    const first = preprocessMessagesCached(messages);
    const tail: Message = {
      id: "answer",
      type: "assistant",
      content: "Checking",
      _isStreaming: true,
    };
    const second = preprocessMessagesCached(
      [...messages, tail],
      undefined,
      first.cache,
    );
    const updated = { ...tail, content: "Checking the result" };
    const third = preprocessMessagesCached(
      [...messages, updated],
      undefined,
      second.cache,
    );
    expect(third.renderItems).toEqual(
      preprocessMessages([...messages, updated]),
    );
    expect(nativeItems(third.renderItems)).toHaveLength(1);
  });
});

describe("Codex main timeline presentation", () => {
  function tool(id: string, name: string): Message {
    return {
      id: `tool-message-${id}`,
      type: "assistant",
      content: [{ type: "tool_use", id, name, input: {} }],
    };
  }

  function wait(id: string, status: string): Message {
    return {
      id: `${id}-${status}`,
      type: "system",
      subtype: "codex_native_item",
      codexThreadItem: {
        type: "agentWait",
        id,
        status,
        startedAt: "2026-10-08T01:00:00Z",
        ...(status === "completed"
          ? { completedAt: "2026-10-08T01:00:03Z", durationMs: 3000 }
          : {}),
      },
      codexThreadItemLifecycle: status === "running" ? "started" : "completed",
      codexThreadId: "parent",
      codexTurnId: "turn-1",
    };
  }

  it("shows only the task entry at its dispatch position and keeps communications available to details", () => {
    const raw = preprocessMessages([
      tool("spawn", "collaboration.spawn_agent"),
      {
        id: "progress",
        type: "assistant",
        content: "I am checking the remaining files.",
      },
      activity("spawn", "started"),
      communication("task", "task"),
      tool("send", "collaboration.send_message"),
      activity("send", "interacted"),
      communication("message", "message"),
      activity("end", "completed"),
      communication("result", "result"),
      tool("list", "collaboration.list_agents"),
    ]);
    const main = projectCodexMainTimeline(raw);
    expect(main.map((item) => item.id)).toEqual(["spawn", "progress"]);
    expect(nativeItems(main)[0]?.subagentActivity).toMatchObject({
      entryKind: "spawn",
      orphanTerminal: false,
    });
    expect(nativeItems(main)[0]?.subagentActivity?.task).toBeUndefined();
    expect(nativeItems(main)[0]?.subagentActivity?.result).toBeUndefined();
    expect(
      nativeItems(raw).filter(
        (item) => item.threadItem.type === "interAgentMessage",
      ),
    ).toHaveLength(3);
    expect(
      raw.some(
        (item) =>
          item.type === "tool_call" &&
          item.toolName === "collaboration.send_message",
      ),
    ).toBe(true);
  });

  it("keeps followup entries distinct from ordinary messages and labels orphan terminal records honestly", () => {
    const followup = activity("followup", "interacted");
    followup.codexThreadItem = {
      ...(followup.codexThreadItem as Record<string, unknown>),
      operation: "followup_task",
    };
    const main = projectCodexMainTimeline(
      preprocessMessages([
        activity("spawn", "started"),
        activity("end", "completed"),
        followup,
        activity("send", "interacted"),
        activity("next-end", "completed"),
      ]),
    );
    expect(main.map((item) => item.id)).toEqual(["spawn", "followup"]);
    const orphan = projectCodexMainTimeline(
      preprocessMessages([activity("orphan-end", "completed")]),
    );
    expect(nativeItems(orphan)[0]?.subagentActivity).toMatchObject({
      orphanTerminal: true,
    });
    expect(nativeItems(orphan)[0]?.subagentActivity?.entryKind).toBeUndefined();
  });

  it("updates a wait in place, suppresses its duplicate tool, and preserves command polling", () => {
    const history = preprocessMessages([
      tool("wait-1", "collaboration.wait_agent"),
      wait("wait-1", "running"),
    ]);
    const complete = preprocessMessages([wait("wait-1", "completed")]);
    const main = projectCodexMainTimeline([
      ...history,
      ...complete,
      ...preprocessMessages([
        wait("wait-1", "running"),
        wait("wait-2", "running"),
        tool("exec-wait", "functions.wait"),
      ]),
    ]);
    const waits = nativeItems(main).filter(
      (item) => item.threadItem.type === "agentWait",
    );
    expect(waits).toHaveLength(2);
    expect(waits[0]?.threadItem).toMatchObject({
      status: "completed",
      durationMs: 3000,
    });
    expect(waits[1]?.threadItem.status).toBe("running");
    expect(
      main.filter((item) => item.type === "tool_call").map((item) => item.id),
    ).toEqual(["exec-wait"]);
  });

  it("keeps unsupported task entries and actionable failures", () => {
    const items = preprocessMessages([
      tool("spawn-no-native", "spawn_agent"),
      tool("failed-send", "send_message"),
    ]);
    const failed = items.find((item) => item.id === "failed-send");
    if (failed?.type === "tool_call") failed.status = "error";
    expect(projectCodexMainTimeline(items).map((item) => item.id)).toEqual([
      "spawn-no-native",
      "failed-send",
    ]);
  });

  it("replaces a v1 spawn tool with its native multi-receiver entry at the dispatch position", () => {
    const messages: Message[] = [
      tool("legacy-spawn", "spawn_agent"),
      {
        id: "progress",
        type: "assistant",
        content: "Working on the remaining checks.",
      },
      {
        id: "native-spawn",
        type: "system",
        subtype: "codex_native_item",
        codexThreadItem: {
          type: "collabAgentToolCall",
          id: "legacy-spawn",
          tool: "spawnAgent",
          status: "completed",
          receiverThreadIds: ["child-1", "child-2"],
          agentsStates: {
            "child-1": { status: "running" },
            "child-2": { status: "running" },
          },
        },
        codexThreadItemLifecycle: "completed",
      },
    ];
    const main = projectCodexMainTimeline(preprocessMessages(messages));
    expect(main.map((item) => item.id)).toEqual(["native-spawn", "progress"]);
    expect(main[0]).toMatchObject({
      type: "codex_native_item",
      threadItem: {
        tool: "spawnAgent",
        receiverThreadIds: ["child-1", "child-2"],
      },
    });
    expect(main[0]?.sourceMessages.map((source) => source.id)).toEqual([
      "tool-message-legacy-spawn",
      "native-spawn",
    ]);
  });

  it("does not classify namespaced MCP operations as Codex collaboration", () => {
    const items = preprocessMessages([
      tool("mcp-send", "mcp/foo/send_message"),
      tool("custom-list", "custom.list_agents"),
      tool("exec-wait", "functions.wait"),
    ]);
    expect(projectCodexMainTimeline(items).map((item) => item.id)).toEqual([
      "mcp-send",
      "custom-list",
      "exec-wait",
    ]);
  });

  it("filters projected control steps and marks hydrated groups without mutating accumulated data", () => {
    const group: DisplayToolGroupItem = {
      type: "display_tool_group",
      id: "group",
      projectId: "project",
      sessionId: "parent",
      revision: "r1",
      sourceMessages: [],
      group: {
        type: "tool_group",
        id: "group",
        detailRef: "group",
        status: "completed",
        count: 2,
        failedCount: 0,
        toolNames: ["send_message", "exec"],
        displayMode: "steps",
        steps: ["send_message", "exec"].map((name) => ({
          id: name,
          groupId: "group",
          name,
          summary: name,
          status: "completed",
          preview: "",
          truncated: false,
          version: 1,
        })),
      },
    };
    const main = projectCodexMainTimeline([group]);
    expect(main[0]).toMatchObject({
      mainTimeline: true,
      group: { count: 1, toolNames: ["exec"], steps: [{ name: "exec" }] },
    });
    expect(group.group.type === "tool_group" && group.group.steps).toHaveLength(
      2,
    );
  });

  it("keeps full cached data while the visible main tail omits agent communications", () => {
    const messages = [
      activity("start", "started"),
      communication("message", "message"),
    ];
    const first = preprocessMessagesCached(messages);
    expect(projectCodexMainTimeline(first.renderItems)).toHaveLength(1);
    const streamed: Message = {
      id: "answer",
      type: "assistant",
      content: "Progress",
      _isStreaming: true,
    };
    const second = preprocessMessagesCached(
      [...messages, streamed],
      undefined,
      first.cache,
    );
    expect(
      nativeItems(second.cache.renderItems).some(
        (item) => item.threadItem.type === "interAgentMessage",
      ),
    ).toBe(true);
    expect(projectCodexMainTimeline(second.renderItems)).toHaveLength(2);
  });
});
