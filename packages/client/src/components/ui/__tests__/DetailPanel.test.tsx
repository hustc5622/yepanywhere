import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n";
import { UI_KEYS } from "../../../lib/storageKeys";
import { DetailPanel } from "../DetailPanel";

function stubDesktopViewport(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function createSessionRoot() {
  const root = document.createElement("div");
  root.className = "session-page desktop-layout";
  const mount = document.createElement("div");
  root.appendChild(mount);
  document.body.appendChild(root);
  return { root, mount };
}

function NestedFilePanels({
  onParentClose,
  onFileClose,
}: { onParentClose: () => void; onFileClose: () => void }) {
  const [parentOpen, setParentOpen] = useState(true);
  const [fileOpen, setFileOpen] = useState(false);
  return (
    <I18nProvider>
      {parentOpen && (
        <DetailPanel
          title="Child conversation"
          onClose={() => {
            onParentClose();
            setParentOpen(false);
          }}
        >
          <p>Child transcript and inherited context</p>
          <button type="button" onClick={() => setFileOpen(true)}>
            Open referenced file
          </button>
          {fileOpen && (
            <DetailPanel
              title="source.ts"
              onClose={() => {
                onFileClose();
                setFileOpen(false);
              }}
            >
              Referenced file contents
            </DetailPanel>
          )}
        </DetailPanel>
      )}
    </I18nProvider>
  );
}

describe("DetailPanel", () => {
  beforeEach(() => {
    localStorage.setItem(UI_KEYS.locale, "en");
    localStorage.removeItem(UI_KEYS.detailPanelWidthRatio);
  });

  afterEach(() => {
    cleanup();
    for (const node of document.querySelectorAll(".session-page")) {
      node.remove();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resizes the desktop split and persists the selected ratio", () => {
    stubDesktopViewport(true);
    vi.stubGlobal("innerWidth", 1600);
    vi.stubGlobal("PointerEvent", MouseEvent);
    const { root, mount } = createSessionRoot();

    render(
      <I18nProvider>
        <DetailPanel title="Report" onClose={() => {}}>
          Report content
        </DetailPanel>
      </I18nProvider>,
      { container: mount },
    );

    const host = root.querySelector<HTMLElement>(
      ":scope > .detail-panel-host--docked",
    );
    const resizeHandle = screen.getByRole("separator", {
      name: "Resize detail panel",
    });
    expect(host?.style.getPropertyValue("--detail-panel-width")).toBe("640px");

    fireEvent.pointerDown(resizeHandle, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 960,
    });
    fireEvent.pointerMove(resizeHandle, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 720,
    });
    fireEvent.pointerUp(resizeHandle, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 720,
    });

    expect(host?.style.getPropertyValue("--detail-panel-width")).toBe("880px");
    expect(localStorage.getItem(UI_KEYS.detailPanelWidthRatio)).toBe("0.5500");

    fireEvent.doubleClick(resizeHandle);
    expect(host?.style.getPropertyValue("--detail-panel-width")).toBe("640px");
    expect(localStorage.getItem(UI_KEYS.detailPanelWidthRatio)).toBe("0.4000");
  });

  it("docks beside the session on a desktop viewport", () => {
    stubDesktopViewport(true);
    const { root, mount } = createSessionRoot();
    const onClose = vi.fn();

    render(
      <I18nProvider>
        <DetailPanel title="Report" onClose={onClose}>
          <div>Report content</div>
        </DetailPanel>
      </I18nProvider>,
      { container: mount },
    );

    const host = root.querySelector(":scope > .detail-panel-host--docked");
    expect(host).toBeTruthy();
    expect(
      screen.getByRole("dialog", { name: "Report" }).getAttribute("aria-modal"),
    ).toBeNull();
    expect(document.body.style.overflow).toBe("");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("replaces an existing docked file when another one opens", async () => {
    stubDesktopViewport(true);
    const { root, mount } = createSessionRoot();

    function Harness() {
      const [showFirst, setShowFirst] = useState(true);
      const [showSecond, setShowSecond] = useState(false);
      return (
        <I18nProvider>
          <button type="button" onClick={() => setShowSecond(true)}>
            Open second
          </button>
          {showFirst && (
            <DetailPanel title="First" onClose={() => setShowFirst(false)}>
              First file
            </DetailPanel>
          )}
          {showSecond && (
            <DetailPanel title="Second" onClose={() => setShowSecond(false)}>
              Second file
            </DetailPanel>
          )}
        </I18nProvider>
      );
    }

    render(<Harness />, { container: mount });
    fireEvent.click(screen.getByRole("button", { name: "Open second" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "First" })).toBeNull();
    });
    expect(screen.getByRole("dialog", { name: "Second" })).toBeTruthy();
    expect(
      root.querySelectorAll(":scope > .detail-panel-host--docked"),
    ).toHaveLength(1);
  });

  it("falls back to a dismissible modal outside the desktop layout", () => {
    stubDesktopViewport(false);
    vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const onClose = vi.fn();

    render(
      <I18nProvider>
        <DetailPanel title="Mobile report" onClose={onClose}>
          Report content
        </DetailPanel>
      </I18nProvider>,
    );

    const host = document.querySelector<HTMLElement>(
      ".detail-panel-host--overlay",
    );
    expect(host).toBeTruthy();
    expect(
      screen
        .getByRole("dialog", { name: "Mobile report" })
        .getAttribute("aria-modal"),
    ).toBe("true");

    if (host) fireEvent.click(host);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens a transcript's file above its desktop panel and Escape closes only the file", () => {
    stubDesktopViewport(true);
    vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const { root, mount } = createSessionRoot();
    const onParentClose = vi.fn();
    const onFileClose = vi.fn();
    render(
      <NestedFilePanels
        onParentClose={onParentClose}
        onFileClose={onFileClose}
      />,
      { container: mount },
    );
    const parent = screen.getByRole("dialog", { name: "Child conversation" });
    const transcript = screen.getByText(
      "Child transcript and inherited context",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open referenced file" }),
    );

    const file = screen.getByRole("dialog", { name: "source.ts" });
    expect(
      root.querySelectorAll(":scope > .detail-panel-host--docked"),
    ).toHaveLength(1);
    expect(file.closest(".detail-panel-host--overlay")?.parentElement).toBe(
      document.body,
    );
    expect(screen.getByRole("dialog", { name: "Child conversation" })).toBe(
      parent,
    );
    expect(onParentClose).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onFileClose).toHaveBeenCalledTimes(1);
    expect(onParentClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "source.ts" })).toBeNull();
    expect(screen.getByText("Child transcript and inherited context")).toBe(
      transcript,
    );
    expect(document.body.style.overflow).toBe("");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onParentClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the mobile parent after a nested close button pops only the file history marker", () => {
    stubDesktopViewport(false);
    const back = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => undefined);
    const onParentClose = vi.fn();
    const onFileClose = vi.fn();
    render(
      <NestedFilePanels
        onParentClose={onParentClose}
        onFileClose={onFileClose}
      />,
    );
    const parentMarker = window.history.state;
    fireEvent.click(
      screen.getByRole("button", { name: "Open referenced file" }),
    );
    const file = screen.getByRole("dialog", { name: "source.ts" });
    fireEvent.click(within(file).getByRole("button", { name: "Close" }));
    expect(back).toHaveBeenCalledTimes(1);
    // history.back() resolves after React has unmounted the nested panel and
    // deregistered it from its parent. The marker identity must still protect
    // the parent's popstate listener at this point.
    window.history.replaceState(parentMarker, "");
    fireEvent.popState(window, { state: parentMarker });

    expect(
      screen.getByRole("dialog", { name: "Child conversation" }),
    ).toBeDefined();
    expect(screen.queryByRole("dialog", { name: "source.ts" })).toBeNull();
    expect(onParentClose).not.toHaveBeenCalled();
    expect(onFileClose).toHaveBeenCalledTimes(1);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("handles mobile Back one detail layer at a time", () => {
    stubDesktopViewport(false);
    const back = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => undefined);
    const onParentClose = vi.fn();
    const onFileClose = vi.fn();
    render(
      <NestedFilePanels
        onParentClose={onParentClose}
        onFileClose={onFileClose}
      />,
    );
    const parentMarker = window.history.state;
    fireEvent.click(
      screen.getByRole("button", { name: "Open referenced file" }),
    );

    window.history.replaceState(parentMarker, "");
    fireEvent.popState(window, { state: parentMarker });
    expect(screen.queryByRole("dialog", { name: "source.ts" })).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "Child conversation" }),
    ).toBeDefined();
    expect(onFileClose).toHaveBeenCalledTimes(1);
    expect(onParentClose).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();

    window.history.replaceState(null, "");
    fireEvent.popState(window, { state: null });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onParentClose).toHaveBeenCalledTimes(1);
    expect(document.body.style.overflow).toBe("");
  });
});
