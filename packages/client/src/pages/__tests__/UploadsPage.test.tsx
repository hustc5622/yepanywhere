import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { UploadsPage } from "../UploadsPage";

const mocks = vi.hoisted(() => ({
  listUploadSessions: vi.fn(),
  listUploads: vi.fn(),
  deleteUpload: vi.fn(),
  getSessionMetadata: vi.fn(),
  getSessionFileIndex: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock("../../api/client", () => ({ api: mocks }));
vi.mock("../../contexts/ToastContext", () => ({
  useToastContext: () => ({ showToast: mocks.showToast }),
}));
vi.mock("../../hooks/useHideSplashOnReady", () => ({
  useHideSplashOnReady: () => {},
}));
vi.mock("../../layouts", () => ({
  useNavigationLayout: () => ({ openSidebar: vi.fn(), isWideScreen: false }),
}));

const PROJECT = "L1VzZXJzL21lL2FwcA";
const totals = { count: 1, bytes: 2048 };
const entry = {
  ref: `/api/projects/${PROJECT}/sessions/s1/upload/123e4567-e89b-12d3-a456-426614174000_shot.png`,
  id: "123e4567-e89b-12d3-a456-426614174000",
  projectId: PROJECT,
  sessionId: "s1",
  name: "123e4567-e89b-12d3-a456-426614174000_shot.png",
  originalName: "shot.png",
  size: 2048,
  mimeType: "image/png",
  uploadedAt: "2026-11-12T08:00:00.000Z",
  source: "web" as const,
  usedBy: [{ projectId: PROJECT, sessionId: "s1" }],
  downloadUrl: `/api/projects/${PROJECT}/sessions/s1/upload/123e4567-e89b-12d3-a456-426614174000_shot.png`,
};

function renderPage(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>
        <UploadsPage />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("UploadsPage", () => {
  beforeEach(() => {
    localStorage.clear();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getSessionMetadata.mockResolvedValue({
      session: { title: "Fix image copy" },
    });
    mocks.listUploadSessions.mockResolvedValue({
      sessions: [
        {
          projectId: PROJECT,
          sessionId: "s1",
          count: 1,
          bytes: 2048,
          lastUploadedAt: entry.uploadedAt,
        },
      ],
      nextCursor: null,
      totals,
    });
    mocks.listUploads.mockResolvedValue({
      entries: [entry],
      nextCursor: null,
      totals,
    });
    mocks.deleteUpload.mockResolvedValue({ removed: true, entry });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists sessions that stored files and opens one of them", async () => {
    renderPage("/uploads");
    const card = await screen.findByRole("button", {
      name: /Fix image copy/,
    });
    expect(screen.getAllByText("1 files · 2.0 KB")).toHaveLength(2);
    fireEvent.click(card);
    expect(await screen.findByText("shot.png")).toBeDefined();
    expect(mocks.listUploads).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT, sessionId: "s1" }),
    );
  });

  it("confirms before deleting a file a session sent", async () => {
    renderPage(`/uploads?projectId=${PROJECT}&sessionId=s1`);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("1 sessions sent this file"),
    );
    await waitFor(() =>
      expect(mocks.deleteUpload).toHaveBeenCalledWith(entry.ref, true),
    );
    await waitFor(() => expect(screen.queryByText("shot.png")).toBeNull());
  });

  it("deletes an unsent file without asking", async () => {
    mocks.listUploads.mockResolvedValue({
      entries: [{ ...entry, usedBy: [] }],
      nextCursor: null,
      totals,
    });
    renderPage(`/uploads?projectId=${PROJECT}&sessionId=s1`);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(window.confirm).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mocks.deleteUpload).toHaveBeenCalledWith(entry.ref, false),
    );
  });
});
