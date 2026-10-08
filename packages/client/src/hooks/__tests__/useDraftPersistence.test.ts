import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftPersistence } from "../useDraftPersistence";

describe("useDraftPersistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("recovers the complete message when an immediate send fails before the debounce", () => {
    localStorage.setItem("draft-a", "older text");
    const { result } = renderHook(() => useDraftPersistence("draft-a"));

    act(() => result.current[1]("latest text @[screenshot.png]"));
    act(() => result.current[2].clearInput());
    expect(result.current[0]).toBe("");
    expect(localStorage.getItem("draft-a")).toBe(
      "latest text @[screenshot.png]",
    );

    act(() => result.current[2].restoreFromStorage());
    expect(result.current[0]).toBe("latest text @[screenshot.png]");
  });

  it("flushes the old draft under its original key while switching sessions", () => {
    localStorage.setItem("draft-b", "session B draft");
    const { result, rerender } = renderHook(
      ({ draftKey }) => useDraftPersistence(draftKey),
      { initialProps: { draftKey: "draft-a" } },
    );

    act(() => result.current[1]("session A draft"));
    rerender({ draftKey: "draft-b" });
    act(() => vi.advanceTimersByTime(500));

    expect(result.current[0]).toBe("session B draft");
    expect(localStorage.getItem("draft-a")).toBe("session A draft");
    expect(localStorage.getItem("draft-b")).toBe("session B draft");

    rerender({ draftKey: "draft-a" });
    expect(result.current[0]).toBe("session A draft");
  });

  it.each(["clearDraft", "restoreFromStorage"] as const)(
    "%s preserves text entered while a send is in flight",
    (settle) => {
      const { result } = renderHook(() => useDraftPersistence("draft-a"));
      act(() => result.current[1]("submitted message"));
      act(() => result.current[2].clearInput());
      act(() => result.current[1]("next draft"));
      act(() => result.current[2][settle]());
      act(() => vi.advanceTimersByTime(500));

      expect(result.current[0]).toBe("next draft");
      expect(localStorage.getItem("draft-a")).toBe("next draft");
    },
  );

  it.each(["clearDraft", "restoreFromStorage"] as const)(
    "%s does not replace the destination session's draft after navigation",
    (settle) => {
      localStorage.setItem("draft-b", "session B draft");
      const { result, rerender } = renderHook(
        ({ draftKey }) => useDraftPersistence(draftKey),
        { initialProps: { draftKey: "draft-a" } },
      );
      act(() => result.current[1]("session A submitted message"));
      act(() => result.current[2].clearInput());
      rerender({ draftKey: "draft-b" });
      act(() => result.current[2][settle]());

      expect(result.current[0]).toBe("session B draft");
      expect(localStorage.getItem("draft-b")).toBe("session B draft");
    },
  );

  it("clears a successful new-session or FAB draft without requiring an optimistic clear", () => {
    const { result } = renderHook(() => useDraftPersistence("draft-a"));
    act(() => result.current[1]("handed off message"));
    act(() => result.current[2].clearDraft());
    act(() => vi.advanceTimersByTime(500));

    expect(result.current[0]).toBe("");
    expect(localStorage.getItem("draft-a")).toBeNull();
  });

  it("removes an accepted optimistic submission from storage", () => {
    const { result } = renderHook(() => useDraftPersistence("draft-a"));
    act(() => result.current[1]("submitted message"));
    act(() => result.current[2].clearInput());
    act(() => result.current[2].clearDraft());

    expect(result.current[0]).toBe("");
    expect(localStorage.getItem("draft-a")).toBeNull();
  });

  it("flushes pending typing on page unload and component unmount", () => {
    const { result, unmount } = renderHook(() =>
      useDraftPersistence("draft-a"),
    );
    act(() => result.current[1]("before reload"));
    act(() => window.dispatchEvent(new Event("beforeunload")));
    expect(localStorage.getItem("draft-a")).toBe("before reload");

    act(() => result.current[1]("before navigation"));
    unmount();
    expect(localStorage.getItem("draft-a")).toBe("before navigation");
  });
});
