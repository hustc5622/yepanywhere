import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../types";
import type { RenderItem } from "../../types/renderItems";
import { MessageList } from "../MessageList";

vi.mock("../MessageActions", () => ({
  MessageActions: ({
    timestamp,
    timestampIsLastUpdate,
  }: {
    timestamp?: string;
    timestampIsLastUpdate?: boolean;
  }) => (
    <time
      data-testid="message-actions"
      data-last-update={timestampIsLastUpdate ? "true" : "false"}
    >
      {timestamp}
    </time>
  ),
}));

vi.mock("../ProcessingIndicator", () => ({
  ProcessingIndicator: () => null,
}));

vi.mock("../RenderItemComponent", () => ({
  RenderItemComponent: ({
    item,
    thinkingExpanded,
    toggleThinkingExpanded,
  }: {
    item: RenderItem;
    thinkingExpanded: boolean;
    toggleThinkingExpanded: (itemId: string) => void;
  }) =>
    item.type === "thinking" ? (
      <button
        type="button"
        data-testid={`render-item-${item.id}`}
        aria-expanded={thinkingExpanded}
        onClick={() => toggleThinkingExpanded(item.id)}
      >
        {item.id}
      </button>
    ) : (
      <div
        data-testid={`render-item-${item.id}`}
        data-phase={item.type === "text" ? item.phase : undefined}
      >
        {"content" in item ? String(item.content) : item.id}
      </div>
    ),
}));

function userPromptItem(id: string, messageId = id): RenderItem {
  return {
    id,
    type: "user_prompt",
    content: id,
    sourceMessages: [
      {
        uuid: messageId,
        type: "user",
        message: { role: "user", content: id },
      } satisfies Message,
    ],
  };
}

function assistantTextItem(
  id: string,
  timestamp: string,
  text = id,
): RenderItem {
  return {
    id,
    type: "text",
    text,
    sourceMessages: [
      {
        uuid: id,
        type: "assistant",
        timestamp,
        message: { role: "assistant", content: text },
      } satisfies Message,
    ],
  };
}

function assistantThinkingItem(
  id: string,
): Extract<RenderItem, { type: "thinking" }> {
  return {
    id,
    type: "thinking",
    thinking: `Reasoning for ${id}`,
    status: "complete",
    sourceMessages: [
      {
        uuid: id,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: `Reasoning for ${id}` }],
        },
      } satisfies Message,
    ],
  };
}

function assistantToolItem(
  id: string,
  toolName: string,
  answered = false,
): Extract<RenderItem, { type: "tool_call" }> {
  return {
    id,
    type: "tool_call",
    toolName,
    toolInput: {},
    toolResult: answered
      ? {
          content: "User answered the question",
          isError: false,
          structured: {
            questions: [],
            answers: { "question-0": ["Recommended"] },
          },
        }
      : { content: "done", isError: false },
    status: "complete",
    sourceMessages: [
      {
        uuid: id,
        type: "assistant",
        message: { role: "assistant", content: [] },
      } satisfies Message,
    ],
  };
}

function codexNativeTurnPlanItem(id: string): RenderItem {
  return {
    id,
    type: "codex_native_item",
    threadItem: {
      type: "turnPlan",
      steps: [{ step: "Fix duplicate plan", status: "completed" }],
    },
    lifecycle: "completed",
    sourceMessages: [
      {
        id,
        type: "system",
        subtype: "codex_native_item",
        codexThreadItem: { type: "turnPlan" },
      } satisfies Message,
    ],
  };
}

function codexNativeGoalItem(id: string): RenderItem {
  return {
    id,
    type: "codex_native_item",
    threadItem: {
      type: "threadGoal",
      objective: "Persisted current goal",
      status: "active",
    },
    lifecycle: "completed",
    sourceMessages: [
      {
        id,
        type: "system",
        subtype: "codex_native_item",
        codexThreadItem: { type: "threadGoal" },
      } satisfies Message,
    ],
  };
}

function kimiTodoListItem(
  id: string,
  todos?: Array<{ title: string; status: string }>,
): RenderItem {
  return {
    ...assistantToolItem(id, "TodoList"),
    toolInput: todos ? { todos } : {},
  };
}

describe("MessageList target loading", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requests a backend target window once when a deep target is missing", async () => {
    const loadOlderMessages = vi.fn();
    const loadTargetMessage = vi.fn(async () => true);
    const items = [userPromptItem("visible")];

    const { rerender } = render(
      <MessageList
        messages={[]}
        preprocessedItems={items}
        targetMessageId="target-message"
        hasOlderMessages={true}
        loadingOlder={false}
        onLoadOlderMessages={loadOlderMessages}
        loadingTargetMessage={false}
        onLoadTargetMessage={loadTargetMessage}
      />,
    );

    await waitFor(() => expect(loadTargetMessage).toHaveBeenCalledTimes(1));
    expect(loadTargetMessage).toHaveBeenCalledWith("target-message");
    expect(loadOlderMessages).not.toHaveBeenCalled();

    for (let i = 0; i < 7; i++) {
      rerender(
        <MessageList
          messages={[]}
          preprocessedItems={items}
          targetMessageId="target-message"
          hasOlderMessages={true}
          loadingOlder={true}
          onLoadOlderMessages={loadOlderMessages}
          loadingTargetMessage={true}
          onLoadTargetMessage={loadTargetMessage}
        />,
      );
      expect(loadTargetMessage).toHaveBeenCalledTimes(1);

      rerender(
        <MessageList
          messages={[]}
          preprocessedItems={items}
          targetMessageId="target-message"
          hasOlderMessages={true}
          loadingOlder={false}
          onLoadOlderMessages={loadOlderMessages}
          loadingTargetMessage={false}
          onLoadTargetMessage={loadTargetMessage}
        />,
      );
      expect(loadTargetMessage).toHaveBeenCalledTimes(1);
    }

    expect(loadOlderMessages).not.toHaveBeenCalled();
  });

  it("focuses the target once it is loaded", async () => {
    const loadOlderMessages = vi.fn();
    const onTargetFocused = vi.fn();

    render(
      <MessageList
        messages={[]}
        preprocessedItems={[userPromptItem("target item", "target-message")]}
        targetMessageId="target-message"
        hasOlderMessages={true}
        loadingOlder={false}
        onLoadOlderMessages={loadOlderMessages}
        onTargetFocused={onTargetFocused}
      />,
    );

    await waitFor(() => expect(onTargetFocused).toHaveBeenCalledTimes(1));
    expect(loadOlderMessages).not.toHaveBeenCalled();
  });

  it("focuses a branch prompt restored from cross-session navigation state", async () => {
    const onBranchFocused = vi.fn();
    const item = userPromptItem("edited prompt", "msg_edited");
    const source = item.sourceMessages[0];
    if (!source) throw new Error("expected source message");
    source.branch = {
      sessionId: "ses_child",
      branchId: "msg_edited",
      activeBranchId: "msg_edited",
      selectedBranchId: "msg_edited",
      parentId: "msg_before",
      siblingIndex: 2,
      siblingCount: 2,
      alternatives: [],
    };

    render(
      <MessageList
        messages={[]}
        preprocessedItems={[item]}
        focusBranchId="msg_edited"
        onBranchFocused={onBranchFocused}
      />,
    );

    await waitFor(() => expect(onBranchFocused).toHaveBeenCalledTimes(1));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

describe("MessageList inspector state", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the exec trace but hides both plan snapshots from the transcript", () => {
    render(
      <MessageList
        messages={[]}
        preprocessedItems={[
          assistantToolItem("exec-plan", "CodexExec"),
          assistantToolItem("update-plan", "UpdatePlan"),
          codexNativeTurnPlanItem("native-turn-plan"),
        ]}
      />,
    );

    expect(screen.getByTestId("render-item-exec-plan")).not.toBeNull();
    expect(screen.queryByTestId("render-item-update-plan")).toBeNull();
    expect(screen.queryByTestId("render-item-native-turn-plan")).toBeNull();
  });

  it("hides the current Codex goal from the transcript", () => {
    render(
      <MessageList
        messages={[]}
        preprocessedItems={[
          userPromptItem("visible-user-prompt"),
          codexNativeGoalItem("current-thread-goal"),
        ]}
      />,
    );

    expect(
      screen.getByTestId("render-item-visible-user-prompt"),
    ).not.toBeNull();
    expect(screen.queryByTestId("render-item-current-thread-goal")).toBeNull();
  });

  it("hides Kimi TodoList writes but keeps TodoList reads visible", () => {
    render(
      <MessageList
        messages={[]}
        preprocessedItems={[
          kimiTodoListItem("kimi-todo-write", [
            { title: "Fix the renderer", status: "in_progress" },
          ]),
          kimiTodoListItem("kimi-todo-read"),
        ]}
      />,
    );

    expect(screen.queryByTestId("render-item-kimi-todo-write")).toBeNull();
    expect(screen.getByTestId("render-item-kimi-todo-read")).not.toBeNull();
  });
});

describe("MessageList thinking disclosure", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("expands thinking items independently", () => {
    render(
      <MessageList
        messages={[]}
        preprocessedItems={[
          assistantThinkingItem("thinking-one"),
          assistantThinkingItem("thinking-two"),
        ]}
      />,
    );

    const first = screen.getByTestId("render-item-thinking-one");
    const second = screen.getByTestId("render-item-thinking-two");

    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(second.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(second.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(second);
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(second.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(second.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("MessageList active turn timestamp", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the latest activity only on the currently running assistant turn", () => {
    const firstUpdate = "2026-07-27T04:01:00.000Z";
    const secondUpdate = "2026-07-27T04:02:00.000Z";
    const streamActivity = "2026-07-27T04:03:00.000Z";
    const items = [
      userPromptItem("u1"),
      assistantTextItem("a1", firstUpdate),
      assistantTextItem("a2", secondUpdate),
    ];

    const { rerender } = render(
      <MessageList
        messages={[]}
        preprocessedItems={items}
        isProcessing={true}
        lastActivityAt={streamActivity}
      />,
    );

    let timestamp = screen.getByTestId("message-actions");
    expect(timestamp.textContent).toBe(streamActivity);
    expect(timestamp.dataset.lastUpdate).toBe("true");

    rerender(
      <MessageList
        messages={[]}
        preprocessedItems={items}
        isProcessing={true}
      />,
    );
    timestamp = screen.getByTestId("message-actions");
    expect(timestamp.textContent).toBe(secondUpdate);
    expect(timestamp.dataset.lastUpdate).toBe("true");

    rerender(
      <MessageList
        messages={[]}
        preprocessedItems={items}
        isProcessing={false}
        lastActivityAt={streamActivity}
      />,
    );
    timestamp = screen.getByTestId("message-actions");
    expect(timestamp.textContent).toBe(firstUpdate);
    expect(timestamp.dataset.lastUpdate).toBe("false");

    rerender(
      <MessageList
        messages={[]}
        preprocessedItems={items}
        isProcessing={false}
        lastActivityAt={streamActivity}
        latestTurnUsesUpdateTime={true}
      />,
    );
    timestamp = screen.getByTestId("message-actions");
    expect(timestamp.textContent).toBe(streamActivity);
    expect(timestamp.dataset.lastUpdate).toBe("true");

    rerender(
      <MessageList
        messages={[]}
        preprocessedItems={[...items, userPromptItem("u2")]}
        isProcessing={false}
        lastActivityAt={streamActivity}
        latestTurnUsesUpdateTime={true}
      />,
    );
    timestamp = screen.getByTestId("message-actions");
    expect(timestamp.textContent).toBe(firstUpdate);
    expect(timestamp.dataset.lastUpdate).toBe("false");
  });
});

describe("MessageList question continuation", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("labels the checkpoint as progress and shows where execution resumes", () => {
    render(
      <MessageList
        messages={[]}
        preprocessedItems={[
          assistantToolItem("validation", "Bash"),
          assistantTextItem(
            "checkpoint",
            "2026-07-28T13:14:24.000Z",
            "Three checks passed; one needs a decision.",
          ),
          assistantToolItem("decision", "question", true),
          assistantToolItem("probe", "Bash"),
        ]}
      />,
    );

    expect(screen.getByTestId("render-item-checkpoint").dataset.phase).toBe(
      "commentary",
    );
    expect(screen.getByText("Continued after your answer")).toBeDefined();
    expect(document.querySelectorAll(".assistant-turn")).toHaveLength(2);
  });
});

describe("MessageList virtualization", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mounts every row for short sessions (non-virtualized path)", () => {
    const items = Array.from({ length: 5 }, (_, i) => userPromptItem(`u${i}`));
    render(<MessageList messages={[]} preprocessedItems={items} />);
    expect(screen.queryAllByTestId(/^render-item-/)).toHaveLength(5);
  });

  it("mounts only a windowed subset for long sessions", () => {
    const items = Array.from({ length: 150 }, (_, i) =>
      userPromptItem(`u${i}`),
    );
    const { container } = render(
      <MessageList messages={[]} preprocessedItems={items} />,
    );
    // The list container still mounts (component didn't bail/crash)...
    expect(container.querySelector(".message-list")).not.toBeNull();
    // ...but only a windowed subset of the 150 rows is in the DOM.
    // (jsdom reports a 0px viewport, so the exact window size isn't asserted;
    // the guard is that virtualization engaged and did NOT render all 150.)
    expect(screen.queryAllByTestId(/^render-item-/).length).toBeLessThan(150);
  });
});
