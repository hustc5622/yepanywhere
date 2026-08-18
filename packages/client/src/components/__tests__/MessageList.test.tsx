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

describe("MessageList selection-safe pagination", () => {
  /** Make the RTL container behave like the scrollable `.session-messages`. */
  function makeScrollable(container: HTMLElement, scrollHeight: number) {
    const state = { scrollHeight };
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => state.scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      get: () => 600,
    });
    return state;
  }

  function selectTextOf(element: Element) {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

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
    window.getSelection()?.removeAllRanges();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("auto-loads older messages near the top when nothing is selected", () => {
    const onLoadOlderMessages = vi.fn();
    const { container } = render(
      <MessageList
        messages={[]}
        preprocessedItems={[assistantTextItem("a1", "2024-01-01T00:00:00Z")]}
        hasOlderMessages
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    );
    makeScrollable(container, 5000);
    container.scrollTop = 50;
    fireEvent.scroll(container);
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
  });

  it("defers the auto-load while a text selection is in progress", () => {
    const onLoadOlderMessages = vi.fn();
    const { container } = render(
      <MessageList
        messages={[]}
        preprocessedItems={[
          assistantTextItem("a1", "2024-01-01T00:00:00Z", "selectable text"),
        ]}
        hasOlderMessages
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    );
    makeScrollable(container, 5000);

    // Mouse is held down inside the transcript: a drag-selection is underway.
    fireEvent.pointerDown(container, { pointerType: "mouse", button: 0 });
    selectTextOf(screen.getByTestId("render-item-a1"));
    container.scrollTop = 50;
    fireEvent.scroll(container);
    expect(onLoadOlderMessages).not.toHaveBeenCalled();

    // Releasing the mouse with the selection still active must not load either.
    fireEvent.pointerUp(document);
    expect(onLoadOlderMessages).not.toHaveBeenCalled();

    // Clearing the selection releases the deferred load.
    window.getSelection()?.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
  });

  it("keeps the turn DOM node when older messages are prepended into it", () => {
    const windowedItems = [
      assistantTextItem("a3", "2024-01-01T00:00:03Z"),
      assistantTextItem("a4", "2024-01-01T00:00:04Z"),
    ];
    const { container, rerender } = render(
      <MessageList
        messages={[]}
        preprocessedItems={windowedItems}
        hasOlderMessages
        transcriptKey="session-1"
      />,
    );
    const turnBefore = screen
      .getByTestId("render-item-a3")
      .closest(".assistant-turn");
    const textNodeBefore = screen.getByTestId("render-item-a3");
    expect(turnBefore).not.toBeNull();

    rerender(
      <MessageList
        messages={[]}
        preprocessedItems={[
          assistantTextItem("a0", "2024-01-01T00:00:00Z"),
          userPromptItem("u1"),
          assistantTextItem("a1", "2024-01-01T00:00:01Z"),
          ...windowedItems,
        ]}
        hasOlderMessages
        transcriptKey="session-1"
      />,
    );

    const turnAfter = screen
      .getByTestId("render-item-a3")
      .closest(".assistant-turn");
    // Same DOM element instance => React reused the subtree, so an in-progress
    // selection anchored inside it survives the prepend.
    expect(turnAfter).toBe(turnBefore);
    expect(screen.getByTestId("render-item-a3")).toBe(textNodeBefore);
    // a1 joined the turn the user was reading; a0 is an additional older turn.
    expect(container.querySelectorAll(".assistant-turn")).toHaveLength(2);
    expect(turnAfter?.contains(screen.getByTestId("render-item-a1"))).toBe(
      true,
    );
  });

  it("stays out of virtualized mode while a selection is live", () => {
    const shortItems = Array.from({ length: 20 }, (_, i) =>
      assistantTextItem(`a${i}`, "2024-01-01T00:00:00Z"),
    );
    const { container, rerender } = render(
      <MessageList
        messages={[]}
        preprocessedItems={shortItems}
        transcriptKey="session-1"
      />,
    );
    // Non-virtualized to start: every item is mounted.
    expect(screen.queryAllByTestId(/^render-item-/)).toHaveLength(20);
    selectTextOf(screen.getByTestId("render-item-a5"));
    fireEvent(document, new Event("selectionchange"));
    const turnBefore = screen
      .getByTestId("render-item-a5")
      .closest(".assistant-turn");

    // A load-older round pushes the transcript past the virtualization
    // threshold. Switching modes now would remount every row.
    rerender(
      <MessageList
        messages={[]}
        preprocessedItems={[
          ...Array.from({ length: 200 }, (_, i) => userPromptItem(`u${i}`)),
          ...shortItems,
        ]}
        transcriptKey="session-1"
      />,
    );
    expect(container.querySelectorAll("[data-index]")).toHaveLength(0);
    expect(
      screen.getByTestId("render-item-a5").closest(".assistant-turn"),
    ).toBe(turnBefore);

    // Once the selection is gone, virtualization engages as before.
    window.getSelection()?.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    rerender(
      <MessageList
        messages={[]}
        preprocessedItems={[
          ...Array.from({ length: 200 }, (_, i) => userPromptItem(`u${i}`)),
          ...shortItems,
        ]}
        transcriptKey="session-1"
      />,
    );
    expect(screen.queryAllByTestId(/^render-item-/).length).toBeLessThan(220);
  });

  it("resets turn identity when the transcript changes", () => {
    const { rerender } = render(
      <MessageList
        messages={[]}
        preprocessedItems={[
          assistantTextItem("a1", "2024-01-01T00:00:01Z"),
          assistantTextItem("a2", "2024-01-01T00:00:02Z"),
        ]}
        transcriptKey="session-1"
      />,
    );
    const turnBefore = screen
      .getByTestId("render-item-a1")
      .closest(".assistant-turn");

    // Another session can reuse provider-scoped item ids. Without the reset, a2
    // would inherit the previous session's `turn-a1` key and reuse its DOM.
    rerender(
      <MessageList
        messages={[]}
        preprocessedItems={[assistantTextItem("a2", "2024-01-01T00:00:02Z")]}
        transcriptKey="session-2"
      />,
    );
    expect(
      screen.getByTestId("render-item-a2").closest(".assistant-turn"),
    ).not.toBe(turnBefore);
  });

  it("compensates the scroll position by the prepended height", async () => {
    const onLoadOlderMessages = vi.fn().mockResolvedValue(undefined);
    const windowedItems = [assistantTextItem("a3", "2024-01-01T00:00:03Z")];
    const { container, rerender } = render(
      <MessageList
        messages={[]}
        preprocessedItems={windowedItems}
        hasOlderMessages
        onLoadOlderMessages={onLoadOlderMessages}
        transcriptKey="session-1"
      />,
    );
    const scroll = makeScrollable(container, 5000);
    container.scrollTop = 120;

    // jsdom has no layout, so give the anchor row a position to be measured at.
    const anchorRow = screen
      .getByTestId("render-item-a3")
      .closest(".assistant-turn") as HTMLElement;
    const offsets = { top: 4000 };
    Object.defineProperty(anchorRow, "offsetTop", {
      configurable: true,
      get: () => offsets.top,
    });
    Object.defineProperty(anchorRow, "offsetHeight", {
      configurable: true,
      get: () => 1000,
    });

    fireEvent.click(screen.getByRole("button", { name: /load older/i }));
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);

    // The prepended chunk lands later: the content is taller and the anchor row
    // has moved down by exactly the prepended height.
    scroll.scrollHeight = 25000;
    offsets.top = 24000;
    rerender(
      <MessageList
        messages={[]}
        preprocessedItems={[
          assistantTextItem("a1", "2024-01-01T00:00:01Z"),
          userPromptItem("u1"),
          ...windowedItems,
        ]}
        hasOlderMessages
        onLoadOlderMessages={onLoadOlderMessages}
        transcriptKey="session-1"
      />,
    );

    // 120 + (24000 - 4000): the reading position stays on the same content.
    expect(container.scrollTop).toBe(20120);
  });

  it("does not double-correct when the browser already anchored the scroll", () => {
    const onLoadOlderMessages = vi.fn().mockResolvedValue(undefined);
    const windowedItems = [assistantTextItem("a3", "2024-01-01T00:00:03Z")];
    const { container, rerender } = render(
      <MessageList
        messages={[]}
        preprocessedItems={windowedItems}
        hasOlderMessages
        onLoadOlderMessages={onLoadOlderMessages}
        transcriptKey="session-1"
      />,
    );
    const scroll = makeScrollable(container, 5000);
    container.scrollTop = 120;

    const anchorRow = screen
      .getByTestId("render-item-a3")
      .closest(".assistant-turn") as HTMLElement;
    const offsets = { top: 4000 };
    Object.defineProperty(anchorRow, "offsetTop", {
      configurable: true,
      get: () => offsets.top,
    });
    Object.defineProperty(anchorRow, "offsetHeight", {
      configurable: true,
      get: () => 1000,
    });

    fireEvent.click(screen.getByRole("button", { name: /load older/i }));

    // Chrome's native scroll anchoring keeps the row in place on its own.
    scroll.scrollHeight = 25000;
    offsets.top = 24000;
    container.scrollTop = 20120;
    rerender(
      <MessageList
        messages={[]}
        preprocessedItems={[
          assistantTextItem("a1", "2024-01-01T00:00:01Z"),
          userPromptItem("u1"),
          ...windowedItems,
        ]}
        hasOlderMessages
        onLoadOlderMessages={onLoadOlderMessages}
        transcriptKey="session-1"
      />,
    );

    // Correcting again would land at ~40000 and skip past the read content.
    expect(container.scrollTop).toBe(20120);
  });
});
