import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import { MessageActions } from "../MessageActions";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
const originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "execCommand",
);
const originalSecureContextDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "isSecureContext",
);

function selectTextInElement(element: HTMLElement, selectedText: string): void {
  const textNode = Array.from(element.childNodes).find(
    (node) => node.nodeType === Node.TEXT_NODE,
  );
  if (!textNode) throw new Error("No text node found");

  const text = textNode.textContent ?? "";
  const start = text.indexOf(selectedText);
  if (start === -1) throw new Error(`Text not found: ${selectedText}`);

  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, start + selectedText.length);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function renderWithI18n(ui: ReactNode) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

describe("MessageActions", () => {
  let writeText: ReturnType<typeof vi.fn>;
  let execCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.setItem(UI_KEYS.locale, "en");
    writeText = vi.fn().mockResolvedValue(undefined);
    execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    cleanup();
    document.querySelector("[data-yep-clipboard-fallback]")?.remove();

    if (originalClipboardDescriptor) {
      Object.defineProperty(
        navigator,
        "clipboard",
        originalClipboardDescriptor,
      );
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
    if (originalExecCommandDescriptor) {
      Object.defineProperty(
        document,
        "execCommand",
        originalExecCommandDescriptor,
      );
    } else {
      Reflect.deleteProperty(document, "execCommand");
    }
    if (originalSecureContextDescriptor) {
      Object.defineProperty(
        window,
        "isSecureContext",
        originalSecureContextDescriptor,
      );
    } else {
      Reflect.deleteProperty(window, "isSecureContext");
    }

    vi.restoreAllMocks();
  });

  it("copies active text selection instead of the whole message", async () => {
    renderWithI18n(
      <div className="assistant-turn">
        <p>alpha beta gamma</p>
        <MessageActions copyText="alpha beta gamma" />
      </div>,
    );

    selectTextInElement(screen.getByText("alpha beta gamma"), "beta");
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("beta");
    });
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("uses the synchronous fallback directly in an insecure context", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    execCommand.mockImplementation(() => {
      const textarea = document.querySelector(
        "textarea[data-yep-clipboard-fallback]",
      ) as HTMLTextAreaElement | null;
      expect(textarea?.value).toBe("plain HTTP reply");
      return true;
    });

    renderWithI18n(<MessageActions copyText="plain HTTP reply" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

    expect(await screen.findByRole("button", { name: "Copied!" })).toBeTruthy();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(writeText).not.toHaveBeenCalled();
    expect(
      document.querySelector("textarea[data-yep-clipboard-fallback]"),
    ).toBeNull();
  });

  it("falls back when the Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });

    renderWithI18n(<MessageActions copyText="fallback reply" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

    expect(await screen.findByRole("button", { name: "Copied!" })).toBeTruthy();
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls back when the Clipboard API rejects the write", async () => {
    writeText.mockRejectedValueOnce(
      new DOMException("Clipboard permission denied", "NotAllowedError"),
    );

    renderWithI18n(<MessageActions copyText="permission fallback" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

    expect(await screen.findByRole("button", { name: "Copied!" })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("permission fallback");
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("shows failure feedback when every copy mechanism fails", async () => {
    writeText.mockRejectedValueOnce(
      new DOMException("Clipboard permission denied", "NotAllowedError"),
    );
    execCommand.mockReturnValue(false);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    renderWithI18n(<MessageActions copyText="uncopyable reply" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

    expect(
      await screen.findByRole("button", { name: "Copy failed" }),
    ).toBeTruthy();
    expect(consoleError).toHaveBeenCalled();
    expect(
      document.querySelector("textarea[data-yep-clipboard-fallback]"),
    ).toBeNull();
  });

  it("renders compact context usage when provided", () => {
    const { container } = renderWithI18n(
      <MessageActions
        timestamp="2026-01-01T12:34:00.000Z"
        contextBefore={{
          inputTokens: 10_000,
          percentage: 4,
          contextWindow: 258_000,
        }}
      />,
    );

    const context = container.querySelector(".message-actions-context");
    const time = container.querySelector(".message-actions-time");

    expect(context?.textContent).toBe("10.0K");
    expect(context?.getAttribute("title")).toBe("10,000 context tokens");
    expect(time).not.toBeNull();
  });
});
