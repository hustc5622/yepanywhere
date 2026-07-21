import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReportCommentAnchor, ReportDocument } from "@yep-anywhere/shared";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../contexts/ToastContext";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import { ReportsPage } from "../ReportsPage";

const mocks = vi.hoisted(() => ({
  getReports: vi.fn(),
  getReport: vi.fn(),
  createReportComment: vi.fn(),
  updateReportComment: vi.fn(),
  uploadReport: vi.fn(),
  uploadReportImage: vi.fn(),
  loadReportImage: vi.fn(),
  writeClipboardText: vi.fn(),
  isWideScreen: true,
}));

vi.mock("../../api/client", () => ({
  getDesktopAuthToken: () => null,
  api: {
    getReports: mocks.getReports,
    getReport: mocks.getReport,
    createReportComment: mocks.createReportComment,
    updateReportComment: mocks.updateReportComment,
    uploadReport: mocks.uploadReport,
    uploadReportImage: mocks.uploadReportImage,
    loadReportImage: mocks.loadReportImage,
  },
}));

vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: mocks.writeClipboardText,
}));

vi.mock("../../hooks/useHideSplashOnReady", () => ({
  useHideSplashOnReady: () => {},
}));

vi.mock("../../layouts", () => ({
  useNavigationLayout: () => ({
    openSidebar: vi.fn(),
    isWideScreen: mocks.isWideScreen,
    isSidebarCollapsed: false,
    toggleSidebar: vi.fn(),
  }),
}));

const report: ReportDocument = {
  path: "alpha.md",
  absolutePath: "/reports/alpha.md",
  title: "Alpha report",
  kind: "markdown",
  size: 128,
  modifiedAt: "2026-07-20T12:00:00.000Z",
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/reports?path=alpha.md"]}>
      <I18nProvider>
        <ToastProvider>
          <ReportsPage />
        </ToastProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("ReportsPage document panel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(UI_KEYS.locale, "en");
    mocks.isWideScreen = true;
    mocks.getReports.mockReset();
    mocks.getReport.mockReset();
    mocks.createReportComment.mockReset();
    mocks.updateReportComment.mockReset();
    mocks.uploadReport.mockReset();
    mocks.uploadReportImage.mockReset();
    mocks.loadReportImage.mockReset();
    mocks.writeClipboardText.mockReset();
    mocks.writeClipboardText.mockResolvedValue(undefined);
    mocks.getReports.mockResolvedValue({
      rootPath: "/reports",
      documents: [report],
    });
    mocks.getReport.mockResolvedValue({
      metadata: report,
      content: "# Alpha report\n\nReport body",
      renderedHtml: "<h1>Alpha report</h1><p>Report body</p>",
      comments: [],
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("collapses the desktop document panel and persists the preference", async () => {
    const firstRender = renderPage();
    const panel = await screen.findByRole("complementary", {
      name: "Documents",
    });
    await waitFor(() => expect(mocks.getReport).toHaveBeenCalledTimes(1));

    const collapseButton = screen.getByRole("button", {
      name: "Collapse document list",
    });
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(collapseButton);

    const expandButton = screen.getByRole("button", {
      name: "Expand document list",
    });
    const content = firstRender.container.querySelector(
      ".reports-content-inner",
    );
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");
    expect(panel.classList.contains("is-collapsed")).toBe(true);
    expect(content?.classList.contains("documents-collapsed")).toBe(true);
    expect(screen.queryByPlaceholderText("Filter reports...")).toBeNull();
    expect(
      firstRender.container.querySelector(".reports-markdown")?.textContent,
    ).toContain("Report body");
    expect(mocks.getReport).toHaveBeenCalledTimes(1);
    expect(
      window.localStorage.getItem(UI_KEYS.reportsDocumentPanelExpanded),
    ).toBe("false");

    firstRender.unmount();
    const secondRender = renderPage();
    await screen.findByRole("button", { name: "Expand document list" });
    expect(
      secondRender.container
        .querySelector(".reports-content-inner")
        ?.classList.contains("documents-collapsed"),
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Expand document list" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Collapse document list" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      window.localStorage.getItem(UI_KEYS.reportsDocumentPanelExpanded),
    ).toBe("true");
  });

  it("keeps the mobile document selector unchanged", async () => {
    mocks.isWideScreen = false;
    window.localStorage.setItem(UI_KEYS.reportsDocumentPanelExpanded, "false");

    const view = renderPage();

    expect(await screen.findByLabelText("Document")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Expand document list" }),
    ).toBeNull();
    expect(view.container.querySelector("#reports-document-panel")).toBeNull();
    expect(
      view.container
        .querySelector(".reports-content-inner")
        ?.classList.contains("documents-collapsed"),
    ).toBe(false);
  });

  it("creates and edits a comment from selected report text", async () => {
    let savedAnchor: ReportCommentAnchor | null = null;
    mocks.createReportComment.mockImplementation(
      async (path: string, anchor: ReportCommentAnchor, body: string) => {
        savedAnchor = anchor;
        return {
          comment: {
            id: "comment-1",
            reportPath: path,
            anchor,
            body,
            createdAt: "2026-07-21T00:00:00.000Z",
            updatedAt: "2026-07-21T00:00:00.000Z",
          },
        };
      },
    );
    mocks.updateReportComment.mockImplementation(
      async (path: string, id: string, body: string) => {
        if (!savedAnchor) throw new Error("Missing saved anchor");
        return {
          comment: {
            id,
            reportPath: path,
            anchor: savedAnchor,
            body,
            createdAt: "2026-07-21T00:00:00.000Z",
            updatedAt: "2026-07-21T00:05:00.000Z",
          },
        };
      },
    );

    const view = renderPage();
    const body = await screen.findByText("Report body");
    await waitFor(() => expect(mocks.getReport).toHaveBeenCalledTimes(1));

    const range = document.createRange();
    range.selectNodeContents(body);
    Object.defineProperty(range, "getBoundingClientRect", {
      value: () =>
        ({
          top: 100,
          right: 200,
          bottom: 120,
          left: 100,
          width: 100,
          height: 20,
          x: 100,
          y: 100,
          toJSON: () => ({}),
        }) satisfies DOMRect,
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(
      view.container.querySelector(".reports-markdown") as Element,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add comment" }));
    const commentInput = await screen.findByLabelText("Comment");
    fireEvent.change(commentInput, { target: { value: "Check this section" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));

    await waitFor(() =>
      expect(mocks.createReportComment).toHaveBeenCalledWith(
        "alpha.md",
        expect.objectContaining({ exact: "Report body" }),
        "Check this section",
      ),
    );
    const highlight = await waitFor(() => {
      const node = view.container.querySelector<HTMLElement>(
        ".report-comment-highlight",
      );
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });

    fireEvent.click(highlight);
    const editInput = await screen.findByLabelText("Comment");
    expect((editInput as HTMLTextAreaElement).value).toBe("Check this section");
    fireEvent.change(editInput, { target: { value: "Updated comment" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));

    await waitFor(() =>
      expect(mocks.updateReportComment).toHaveBeenCalledWith(
        "alpha.md",
        "comment-1",
        "Updated comment",
      ),
    );
  });

  it("uploads a report image and copies its Markdown reference", async () => {
    mocks.uploadReportImage.mockResolvedValue({
      path: "assets/alpha/image.png",
      markdown: "![chart](assets/alpha/image.png)",
      url: "/api/reports/image?path=alpha.md&image=assets%2Falpha%2Fimage.png",
    });
    const view = renderPage();
    await screen.findByText("Report body");

    const input = view.container.querySelector<HTMLInputElement>(
      'input[accept*=".png"]',
    );
    expect(input).not.toBeNull();
    const image = new File([new Uint8Array([1, 2, 3])], "chart.png", {
      type: "image/png",
    });
    fireEvent.change(input as HTMLInputElement, {
      target: { files: [image] },
    });

    await waitFor(() =>
      expect(mocks.uploadReportImage).toHaveBeenCalledWith("alpha.md", image),
    );
    expect(mocks.writeClipboardText).toHaveBeenCalledWith(
      "![chart](assets/alpha/image.png)",
    );
  });
});
