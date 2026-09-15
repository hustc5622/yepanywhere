import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import { usePendingMessages } from "../usePendingMessages";
import type { DeferredMessage } from "../useSession";

function userMessage(content: string, tempId?: string): Message {
  return {
    type: "user",
    message: { role: "user", content },
    ...(tempId ? { tempId } : {}),
  } as Message;
}

describe("usePendingMessages", () => {
  it("clears an optimistic message when the server queues it before the HTTP response", () => {
    const messages: Message[] = [];
    const { result, rerender } = renderHook(
      ({ queue }: { queue: DeferredMessage[] }) =>
        usePendingMessages(messages, queue),
      { initialProps: { queue: [] as DeferredMessage[] } },
    );
    let tempId = "";
    act(() => {
      tempId = result.current.addPendingMessage("update the dialog");
    });

    // A queue event is sufficient confirmation; no transcript echo or HTTP
    // completion has arrived to call removePendingMessage yet.
    rerender({
      queue: [
        {
          tempId,
          content: "update the dialog",
          timestamp: new Date().toISOString(),
        },
      ],
    });
    expect(result.current.pendingMessages).toHaveLength(0);

    // Consuming/cancelling the queue and a late HTTP completion cannot bring
    // the optimistic copy back or clear a newer same-text submission.
    rerender({ queue: [] });
    let nextTempId = "";
    act(() => {
      nextTempId = result.current.addPendingMessage("update the dialog");
      result.current.removePendingMessage(tempId);
    });
    expect(
      result.current.pendingMessages.map((message) => message.tempId),
    ).toEqual([nextTempId]);
  });

  it("reconciles a restored queue snapshot by identity, keeping separate same-text submissions", () => {
    const messages: Message[] = [];
    const { result, rerender } = renderHook(
      ({ queue }: { queue: DeferredMessage[] }) =>
        usePendingMessages(messages, queue),
      { initialProps: { queue: [] as DeferredMessage[] } },
    );
    let acceptedTempId = "";
    let pendingTempId = "";
    act(() => {
      acceptedTempId = result.current.addPendingMessage("same prompt");
      pendingTempId = result.current.addPendingMessage("same prompt");
    });

    // Reconnect may restore several queued entries, including legacy entries
    // without IDs. Text alone must not confirm the other local submission.
    const queue = [
      { content: "same prompt", timestamp: new Date().toISOString() },
      {
        tempId: acceptedTempId,
        content: "same prompt",
        timestamp: new Date().toISOString(),
      },
    ];
    rerender({ queue });
    expect(
      result.current.pendingMessages.map((message) => message.tempId),
    ).toEqual([pendingTempId]);
    rerender({ queue: [...queue] });
    expect(
      result.current.pendingMessages.map((message) => message.tempId),
    ).toEqual([pendingTempId]);
  });

  it("does not confirm a repeated prompt from a question already visible before submission", () => {
    const old = { ...userMessage("again"), uuid: "old-question" };
    const { result, rerender } = renderHook(
      ({ messages }) => usePendingMessages(messages),
      { initialProps: { messages: [old] } },
    );
    act(() => {
      result.current.addPendingMessage("again");
    });
    rerender({ messages: [{ ...old }] });
    expect(result.current.pendingMessages).toHaveLength(1);
    rerender({
      messages: [old, { ...userMessage("again"), uuid: "new-question" }],
    });
    expect(result.current.pendingMessages).toHaveLength(0);
  });
  it("adds a pending message and returns its tempId", () => {
    const { result } = renderHook(() => usePendingMessages([]));

    let tempId = "";
    act(() => {
      tempId = result.current.addPendingMessage("hello");
    });

    expect(tempId).toMatch(/^temp-/);
    expect(result.current.pendingMessages).toHaveLength(1);
    expect(result.current.pendingMessages[0]).toMatchObject({
      tempId,
      content: "hello",
    });
  });

  it("removes a pending message by tempId", () => {
    const { result } = renderHook(() => usePendingMessages([]));
    let tempId = "";
    act(() => {
      tempId = result.current.addPendingMessage("hello");
    });
    act(() => {
      result.current.removePendingMessage(tempId);
    });
    expect(result.current.pendingMessages).toHaveLength(0);
  });

  it("updates fields of a pending message", () => {
    const { result } = renderHook(() => usePendingMessages([]));
    let tempId = "";
    act(() => {
      tempId = result.current.addPendingMessage("hello");
    });
    act(() => {
      result.current.updatePendingMessage(tempId, { status: "Uploading..." });
    });
    expect(result.current.pendingMessages[0]?.status).toBe("Uploading...");
  });

  it("reconciles away pending messages once a matching message is confirmed", () => {
    const { result, rerender } = renderHook(
      ({ messages }: { messages: Message[] }) => usePendingMessages(messages),
      { initialProps: { messages: [] as Message[] } },
    );

    act(() => {
      result.current.addPendingMessage("do the thing");
    });
    expect(result.current.pendingMessages).toHaveLength(1);

    // Server confirms the same message content → pending clears.
    rerender({ messages: [userMessage("do the thing")] });
    expect(result.current.pendingMessages).toHaveLength(0);
  });
});
