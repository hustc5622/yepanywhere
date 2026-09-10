import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPage } from "../TerminalPage";

const mocks = vi.hoisted(() => ({
  fit: vi.fn(),
  refresh: vi.fn(),
  resize: vi.fn(),
  options: { fontFamily: "fallback" },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = mocks.options;
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    refresh = mocks.refresh;
    onData() {
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = mocks.fit;
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("../../hooks/useRemoteTerminal", () => ({
  useRemoteTerminal: () => ({
    state: "connected",
    sendInput: vi.fn(),
    sendResize: mocks.resize,
  }),
}));
vi.mock("../../layouts", () => ({
  useNavigationLayout: () => ({ isWideScreen: false, openSidebar: vi.fn() }),
}));
vi.mock("../../components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ terminalId: "test" }),
  useSearchParams: () => [new URLSearchParams()],
}));

describe("TerminalPage viewport and font loading", () => {
  let viewport: EventTarget & { height: number; offsetTop: number };
  let loadFont: ReturnType<typeof vi.fn>;
  let resolveFont: (fonts: FontFace[]) => void;
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.options.fontFamily = "fallback";
    viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    loadFont = vi.fn(
      () =>
        new Promise<FontFace[]>((resolve) => {
          resolveFont = resolve;
        }),
    );
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: loadFont },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return {
          top: this.classList.contains("terminal-page-wrapper") ? 24 : 0,
          bottom: 780,
        } as DOMRect;
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
    else Reflect.deleteProperty(document, "fonts");
  });

  it("fits above the keyboard and restores height when it closes", () => {
    const { container } = render(<TerminalPage />);
    const page = container.firstElementChild as HTMLElement;
    act(() => vi.advanceTimersByTime(20));
    expect(page.style.getPropertyValue("--terminal-available-height")).toBe(
      "756px",
    );
    act(() => {
      viewport.height = 420;
      viewport.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(20);
    });
    expect(page.style.getPropertyValue("--terminal-available-height")).toBe(
      "396px",
    );
    act(() => {
      viewport.height = 800;
      viewport.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(20);
    });
    expect(page.style.getPropertyValue("--terminal-available-height")).toBe(
      "756px",
    );
    expect(mocks.resize).toHaveBeenCalled();
  });

  it("remeasures and redraws after the bundled Nerd Font loads", async () => {
    render(<TerminalPage />);
    expect(mocks.options.fontFamily).toBe("fallback");
    await act(async () => resolveFont([{} as FontFace]));
    expect(mocks.options.fontFamily).toBe('"Yep Terminal", monospace');
    expect(mocks.fit).toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("does not touch a disposed terminal when font loading finishes", async () => {
    const { unmount } = render(<TerminalPage />);
    unmount();
    await act(async () => resolveFont([{} as FontFace]));
    expect(mocks.options.fontFamily).toBe("fallback");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
