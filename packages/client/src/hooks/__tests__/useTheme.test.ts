import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("mobile shell theme synchronization", () => {
  const originalParent = Object.getOwnPropertyDescriptor(window, "parent");
  let postMessage: ReturnType<typeof vi.fn>;
  let mediaQuery: MediaQueryList & { matches: boolean };
  let changeListener: (() => void) | undefined;

  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.dataset.mobileShell = "true";
    postMessage = vi.fn();
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: { postMessage },
    });

    mediaQuery = {
      matches: true,
      media: "(prefers-color-scheme: light)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_type, listener) => {
        changeListener = listener as () => void;
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => mediaQuery),
    );
  });

  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.mobileShell;
    if (originalParent) {
      Object.defineProperty(window, "parent", originalParent);
    } else {
      Reflect.deleteProperty(window, "parent");
    }
    vi.unstubAllGlobals();
  });

  it("posts an explicitly selected dark theme during startup", async () => {
    localStorage.setItem("yep-anywhere-theme", "verydark");
    const { initializeTheme } = await import("../useTheme");

    initializeTheme();

    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: "yep-anywhere:mobile-shell-theme",
        theme: "verydark",
        resolvedTheme: "dark",
      },
      "*",
    );
  });

  it("updates an automatic theme when the system appearance changes", async () => {
    localStorage.setItem("yep-anywhere-theme", "auto");
    const { initializeTheme } = await import("../useTheme");

    initializeTheme();
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: "yep-anywhere:mobile-shell-theme",
        theme: "auto",
        resolvedTheme: "light",
      },
      "*",
    );

    mediaQuery.matches = false;
    changeListener?.();

    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: "yep-anywhere:mobile-shell-theme",
        theme: "auto",
        resolvedTheme: "dark",
      },
      "*",
    );
  });
});
