import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import { usePendingMessages } from "../usePendingMessages";

function userMessage(content: string, tempId?: string): Message {
  return {
    type: "user",
    message: { role: "user", content },
    ...(tempId ? { tempId } : {}),
  } as Message;
}

describe("usePendingMessages", () => {
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
