import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileViewport } from "../useMobileViewport";

describe("useMobileViewport", () => {
  let viewport: EventTarget & {
    height: number;
    offsetTop: number;
    scale: number;
  };
  beforeEach(() => {
    viewport = Object.assign(new EventTarget(), {
      height: 800,
      offsetTop: 0,
      scale: 1,
    });
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("scrollTo", vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("tracks keyboard opening, viewport panning and closing for the entire shell", () => {
    renderHook(() => useMobileViewport(true));
    const root = document.documentElement;
    expect(root.classList.contains("mobile-navigation-viewport")).toBe(true);
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("800px");
    act(() => {
      viewport.height = 420;
      viewport.dispatchEvent(new Event("resize"));
      viewport.offsetTop = 18;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("420px");
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("18px");
    act(() => {
      viewport.height = 800;
      viewport.offsetTop = 0;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("800px");
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("0px");
  });

  it("resets outer document scroll without changing a nested scroll position", () => {
    const inner = document.createElement("div");
    document.body.append(inner);
    inner.scrollTop = 150;
    renderHook(() => useMobileViewport(true));
    vi.stubGlobal("scrollY", 18);
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(inner.scrollTop).toBe(150);
    inner.remove();
  });

  it("releases the lock and listeners when switching to desktop", () => {
    const { rerender } = renderHook(({ mobile }) => useMobileViewport(mobile), {
      initialProps: { mobile: true },
    });
    rerender({ mobile: false });
    act(() => viewport.dispatchEvent(new Event("resize")));
    expect(
      document.documentElement.classList.contains("mobile-navigation-viewport"),
    ).toBe(false);
    expect(
      document.documentElement.style.getPropertyValue("--app-viewport-height"),
    ).toBe("");
  });

  it("uses the resized window without VisualViewport and ignores pinch reflow", () => {
    const { unmount } = renderHook(() => useMobileViewport(true));
    act(() => {
      viewport.scale = 2;
      viewport.height = 200;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(
      document.documentElement.style.getPropertyValue("--app-viewport-height"),
    ).toBe("800px");
    unmount();
    vi.stubGlobal("visualViewport", undefined);
    vi.stubGlobal("innerHeight", 430);
    renderHook(() => useMobileViewport(true));
    expect(
      document.documentElement.style.getPropertyValue("--app-viewport-height"),
    ).toBe("430px");
  });
});
