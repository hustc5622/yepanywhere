import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReportDocument } from "@yep-anywhere/shared";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../contexts/ToastContext";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import { ReportsPage } from "../ReportsPage";

const mocks = vi.hoisted(() => ({
  getReports: vi.fn(),
  getReport: vi.fn(),
  uploadReport: vi.fn(),
  isWideScreen: true,
}));

vi.mock("../../api/client", () => ({
  api: {
    getReports: mocks.getReports,
    getReport: mocks.getReport,
    uploadReport: mocks.uploadReport,
  },
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
    mocks.uploadReport.mockReset();
    mocks.getReports.mockResolvedValue({
      rootPath: "/reports",
      documents: [report],
    });
    mocks.getReport.mockResolvedValue({
      metadata: report,
      content: "# Alpha report\n\nReport body",
      renderedHtml: "<h1>Alpha report</h1><p>Report body</p>",
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
});
