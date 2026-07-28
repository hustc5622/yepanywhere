import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  RenderItemComponent: ({ item }: { item: RenderItem }) => (
    <div data-testid={`render-item-${item.id}`}>
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
