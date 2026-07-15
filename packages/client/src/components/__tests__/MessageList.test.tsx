import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../types";
import type { RenderItem } from "../../types/renderItems";
import { MessageList } from "../MessageList";

vi.mock("../MessageActions", () => ({
  MessageActions: () => null,
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
