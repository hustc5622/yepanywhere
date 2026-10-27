import "fake-indexeddb/auto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ProviderInfo, UploadedFile } from "@yep-anywhere/shared";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type ServerSettings, api } from "../../api/client";
import { ToastProvider } from "../../contexts/ToastContext";
import { useProviders } from "../../hooks/useProviders";
import { useServerSettings } from "../../hooks/useServerSettings";
import { I18nProvider } from "../../i18n";
import { draftFileStore } from "../../lib/draftFileStore";
import { NewSessionForm } from "../NewSessionForm";

const { upload } = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("../../hooks/useConnection", () => ({
  useConnection: () => ({ upload, fetchBlob: vi.fn() }),
}));
vi.mock("../../hooks/useProviders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useProviders")>()),
  useProviders: vi.fn(),
}));
vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: vi.fn(),
}));
vi.mock("../VoiceInputButton", () => ({ VoiceInputButton: () => null }));

const provider: ProviderInfo = {
  name: "claude",
  displayName: "Claude",
  installed: true,
  authenticated: true,
  enabled: true,
  supportsPermissionMode: false,
  supportsThinkingToggle: false,
};
const KEY = `${location.host}:new-session:test-project`;

beforeEach(() => {
  localStorage.clear();
  upload.mockReset();
  upload.mockImplementation(
    async (_p: string, _s: string, file: File): Promise<UploadedFile> => ({
      id: crypto.randomUUID(),
      name: `x_${file.name}`,
      originalName: file.name,
      mimeType: file.type,
      size: file.size,
      path: `/tmp/${file.name}`,
    }),
  );
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => `blob:${crypto.randomUUID()}`);
      static revokeObjectURL = vi.fn();
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.mocked(useProviders).mockReturnValue({
    providers: [provider],
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  vi.mocked(useServerSettings).mockReturnValue({
    settings: { newSessionDefaults: { provider: "claude" } } as ServerSettings,
    isLoading: false,
    error: null,
    updateSetting: vi.fn(),
    refetch: vi.fn(),
  });
  vi.spyOn(api, "createSession").mockResolvedValue({
    sessionId: "test-session",
    processId: "test-process",
    permissionMode: "default",
    modeVersion: 0,
  });
  vi.spyOn(api, "queueMessage").mockResolvedValue({ queued: true });
});

afterEach(async () => {
  cleanup();
  await draftFileStore.remove(KEY);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderForm() {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <ToastProvider>
          <NewSessionForm projectId="test-project" />
        </ToastProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

it("restores pending files after a reload and sends them with the draft", async () => {
  localStorage.setItem("draft-new-session-test-project", "see @[shot.png]");
  await draftFileStore.save(KEY, [
    { id: "f1", file: new File(["pixels"], "shot.png", { type: "image/png" }) },
  ]);
  renderForm();
  const composer = screen.getByRole("textbox");
  await waitFor(() =>
    expect(composer.querySelectorAll("[data-attachment-id]")).toHaveLength(1),
  );
  const start = screen.getByRole("button", { name: "Start session" });
  await waitFor(() =>
    expect((start as HTMLButtonElement).disabled).toBe(false),
  );
  await act(async () => {
    fireEvent.click(start);
  });
  await waitFor(() => expect(api.queueMessage).toHaveBeenCalled());
  expect(upload.mock.calls.map((call) => (call[2] as File).name)).toEqual([
    "shot.png",
  ]);
  await waitFor(async () => expect(await draftFileStore.load(KEY)).toEqual([]));
});

it("persists newly attached files for the next visit", async () => {
  const view = renderForm();
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!picker) throw new Error("Missing file picker");
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Start session",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true),
  );
  await act(async () => {
    fireEvent.change(picker, {
      target: {
        files: [new File(["%PDF"], "notes.pdf", { type: "application/pdf" })],
      },
    });
  });
  await waitFor(
    async () =>
      expect((await draftFileStore.load(KEY)).map((e) => e.file.name)).toEqual([
        "notes.pdf",
      ]),
    { timeout: 2000 },
  );
  view.unmount();
});
