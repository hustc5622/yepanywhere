import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import { FileViewer } from "../FileViewer";

const { getFile } = vi.hoisted(() => ({
  getFile: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getFile,
    getFileRawUrl: vi.fn(() => "/api/projects/project-1/files/raw"),
  },
}));

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

function renderViewer() {
  return render(
    <I18nProvider>
      <FileViewer projectId="project-1" filePath="docs/notes.md" />
    </I18nProvider>,
  );
}

describe("FileViewer", () => {
  let execCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.setItem(UI_KEYS.locale, "en");
    getFile.mockReset();
    getFile.mockResolvedValue({
      metadata: {
        path: "docs/notes.md",
        absolutePath: "/workspace/docs/notes.md",
        size: 12,
        mimeType: "text/markdown",
        isText: true,
      },
      content: "hello world\n",
      rawUrl: "/api/projects/project-1/files/raw",
    });
    execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
  });

  afterEach(() => {
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

  it("separates the filename from its directory and metadata", async () => {
    renderViewer();

    expect(await screen.findByText("12 B • 2 lines")).toBeTruthy();
    expect(screen.getByText("docs")).toBeTruthy();
    expect(screen.getByText("notes.md")).toBeTruthy();
  });

  it("offers independent actions for copying the title and full text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });

    renderViewer();

    const copyTitle = await screen.findByRole("button", {
      name: "Copy title",
    });
    const copyFullText = screen.getByRole("button", {
      name: "Copy full text",
    });

    fireEvent.click(copyTitle);
    expect(
      await screen.findByRole("button", { name: "Title copied!" }),
    ).toBeTruthy();
    expect(writeText).toHaveBeenNthCalledWith(1, "notes.md");
    expect(copyFullText.getAttribute("aria-label")).toBe("Copy full text");

    fireEvent.click(copyFullText);
    expect(
      await screen.findByRole("button", { name: "Full text copied!" }),
    ).toBeTruthy();
    expect(writeText).toHaveBeenNthCalledWith(2, "hello world\n");
    expect(screen.getByRole("button", { name: "Title copied!" })).toBeTruthy();
  });

  it("copies through the synchronous fallback in an insecure context", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    execCommand.mockImplementation(() => {
      const textarea = document.querySelector(
        "textarea[data-yep-clipboard-fallback]",
      ) as HTMLTextAreaElement | null;
      expect(textarea?.value).toBe("hello world\n");
      return true;
    });

    renderViewer();
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy full text" }),
    );

    expect(
      await screen.findByRole("button", { name: "Full text copied!" }),
    ).toBeTruthy();
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("shows feedback when both clipboard mechanisms fail", async () => {
    const writeText = vi
      .fn()
      .mockRejectedValue(
        new DOMException("Permission denied", "NotAllowedError"),
      );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    execCommand.mockReturnValue(false);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    renderViewer();
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy full text" }),
    );

    expect(
      await screen.findByRole("button", { name: "Failed to copy full text" }),
    ).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("hello world\n");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(consoleError).toHaveBeenCalled();
  });
});
