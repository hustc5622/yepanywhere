import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  StreamingMarkdownProvider,
  useStreamingMarkdownContext,
} from "../StreamingMarkdownContext";

describe("StreamingMarkdownContext", () => {
  it("routes by message identity across interleaved main and child output", () => {
    const { result } = renderHook(() => useStreamingMarkdownContext(), {
      wrapper: StreamingMarkdownProvider,
    });
    const handlers = () => ({
      onAugment: vi.fn(),
      onPending: vi.fn(),
      onStreamEnd: vi.fn(),
      captureHtml: vi.fn(() => "<p>main</p>"),
    });
    const main = handlers();
    const child = handlers();
    act(() => {
      result.current?.registerStreamingHandler(main, "main");
      result.current?.setCurrentMessageId("main");
      const unregister = result.current?.registerStreamingHandler(
        child,
        "child",
      );
      result.current?.dispatchAugment({
        blockIndex: 0,
        type: "paragraph",
        html: "<p>main</p>",
      });
      result.current?.dispatchPending({ html: "Main tail" });
      result.current?.dispatchAugment({
        messageId: "child",
        blockIndex: 0,
        type: "paragraph",
        html: "<p>child</p>",
      });
      unregister?.();
      result.current?.dispatchStreamEnd();
    });
    expect(main.onAugment).toHaveBeenCalledTimes(1);
    expect(main.onPending).toHaveBeenCalledWith({ html: "Main tail" });
    expect(main.onStreamEnd).toHaveBeenCalledTimes(1);
    expect(child.onAugment).toHaveBeenCalledTimes(1);
    expect(child.onPending).not.toHaveBeenCalled();
    expect(child.onStreamEnd).not.toHaveBeenCalled();
    expect(result.current?.captureStreamingHtml()).toBe("<p>main</p>");
  });
});
