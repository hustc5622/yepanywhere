import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ProviderInfo } from "@yep-anywhere/shared";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ServerSettings, api } from "../../api/client";
import { ToastProvider } from "../../contexts/ToastContext";
import { I18nProvider } from "../../i18n";
import { setCurrentInstallId } from "../../lib/storageKeys";
import { NewSessionForm } from "../NewSessionForm";

const oldId = "custom_provider:appintheloop/MiniMax-M3-Pro";
const newId = "custom_provider:appintheloop/MiniMax-M78";
const mcode: ProviderInfo = {
  name: "mcode",
  displayName: "MiniMax Code",
  installed: true,
  authenticated: true,
  enabled: true,
  supportsPermissionMode: true,
  permissionModes: ["default", "plan", "auto", "bypassPermissions"],
  supportsThinkingToggle: false,
  models: [{ id: oldId, name: "MiniMax-M3-Pro" }],
};
vi.mock("../../hooks/useProviders", async (original) => ({
  ...(await original<typeof import("../../hooks/useProviders")>()),
  useProviders: () => ({
    providers: [mcode],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("../VoiceInputButton", () => ({ VoiceInputButton: () => null }));

function renderForm() {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <ToastProvider>
          <NewSessionForm projectId="mcode-model-test" />
        </ToastProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}
let scope = 0;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setCurrentInstallId(`mcode-catalog-${++scope}`);
  vi.spyOn(api, "getServerSettings").mockResolvedValue({
    settings: {
      newSessionDefaults: {
        provider: "mcode",
        model: oldId,
        permissionMode: "default",
      },
    } as ServerSettings,
  });
  vi.spyOn(api, "startSession").mockResolvedValue({
    sessionId: "test",
    processId: "test",
    permissionMode: "default",
    modeVersion: 0,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MiniMax Code model refresh", () => {
  it("replaces a nonempty stale list and submits an available model after the refresh", async () => {
    let finish!: (value: { provider: ProviderInfo }) => void;
    const result = new Promise<{ provider: ProviderInfo }>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(api, "getProvider").mockReturnValue(result);
    renderForm();
    await screen.findByRole("button", { name: "MiniMax-M3-Pro" });
    expect(api.getProvider).toHaveBeenCalledWith("mcode", { fresh: true });
    await act(async () => {
      finish({
        provider: { ...mcode, models: [{ id: newId, name: "MiniMax-M78" }] },
      });
      await result;
    });
    const modelButton = await screen.findByRole("button", {
      name: "MiniMax-M78",
    });
    fireEvent.click(modelButton);
    expect(screen.queryByRole("button", { name: "MiniMax-M3-Pro" })).toBeNull();
    fireEvent.click(modelButton);
    const composer = screen.getByRole("textbox");
    composer.textContent = "use the current model";
    fireEvent.input(composer);
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(api.startSession).toHaveBeenCalledWith(
        "mcode-model-test",
        "use the current model",
        expect.objectContaining({ provider: "mcode", model: newId }),
      ),
    );
  });

  it("preserves the current list if refreshing fails", async () => {
    vi.spyOn(api, "getProvider").mockRejectedValue(
      new Error("temporarily unavailable"),
    );
    renderForm();
    await screen.findByRole("button", { name: "MiniMax-M3-Pro" });
    await waitFor(() => expect(api.getProvider).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "MiniMax-M78" })).toBeNull();
  });
});
