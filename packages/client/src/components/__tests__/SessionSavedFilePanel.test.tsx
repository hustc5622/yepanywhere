import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { SessionFileActivity } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import { SessionSavedFilePanel } from "../SessionSavedFilePanel";

vi.mock("../../api/client", () => ({
  api: { getSessionSavedFile: vi.fn(), getSessionFileDiff: vi.fn() },
}));
vi.mock("../ui/DetailPanel", () => ({
  DetailPanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
const file: SessionFileActivity = {
  path: "report.md",
  outsideProject: false,
  kind: "modified",
  source: "snapshot",
  confidence: "high",
  tools: [],
  count: 2,
  messageId: "u",
  savedVersions: [
    {
      recordId: "new",
      timestamp: "2026-09-20T12:00:00Z",
      kind: "modified",
      complete: true,
    },
    {
      recordId: "old",
      timestamp: "2026-09-20T11:00:00Z",
      kind: "added",
      complete: false,
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem(UI_KEYS.locale, "en");
});
afterEach(cleanup);

describe("SessionSavedFilePanel", () => {
  it("loads selected saved versions and diff with the branch, keeping current-file access explicit", async () => {
    vi.mocked(api.getSessionSavedFile).mockImplementation(
      async (_p, _s, options) => ({
        path: file.path,
        recordId: options.recordId,
        content: `saved ${options.recordId}`,
        binary: false,
        bytes: 10,
        deleted: false,
        complete: true,
      }),
    );
    vi.mocked(api.getSessionFileDiff).mockResolvedValue({
      path: file.path,
      exact: false,
      diffHtml: "<pre>execution diff</pre>",
      structuredPatch: [],
    });
    const current = vi.fn();
    render(
      <I18nProvider>
        <SessionSavedFilePanel
          projectId="p"
          sessionId="s"
          branchId="branch"
          file={file}
          onClose={vi.fn()}
          onOpenCurrent={current}
        />
      </I18nProvider>,
    );
    expect(await screen.findByText("saved new")).toBeDefined();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Saved session version" }),
      { target: { value: "old" } },
    );
    expect(await screen.findByText("saved old")).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Changes in this execution" }),
    );
    expect(await screen.findByText("execution diff")).toBeDefined();
    expect(api.getSessionFileDiff).toHaveBeenCalledWith(
      "p",
      "s",
      expect.objectContaining({
        recordId: "old",
        branchId: "branch",
        path: "report.md",
      }),
    );
    expect(current).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Current workspace file" }),
    );
    expect(current).toHaveBeenCalledOnce();
  });

  it("renders saved markdown and makes deleted-file preimages explicit", async () => {
    vi.mocked(api.getSessionSavedFile).mockResolvedValue({
      path: file.path,
      recordId: "new",
      content: "# Saved heading",
      renderedMarkdownHtml: "<h1>Saved heading</h1>",
      binary: false,
      bytes: 15,
      deleted: true,
      complete: true,
    });
    render(
      <I18nProvider>
        <SessionSavedFilePanel
          projectId="p"
          sessionId="s"
          file={file}
          onClose={vi.fn()}
          onOpenCurrent={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Saved heading" }),
    ).toBeDefined();
    expect(
      screen.getByText(/Showing the saved version before deletion/),
    ).toBeDefined();
  });

  it("does not fall back to current content when a saved version fails to load", async () => {
    vi.mocked(api.getSessionSavedFile).mockRejectedValue(
      new Error("missing record"),
    );
    const current = vi.fn();
    render(
      <I18nProvider>
        <SessionSavedFilePanel
          projectId="p"
          sessionId="s"
          file={file}
          onClose={vi.fn()}
          onOpenCurrent={current}
        />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(current).not.toHaveBeenCalled();
  });
});
