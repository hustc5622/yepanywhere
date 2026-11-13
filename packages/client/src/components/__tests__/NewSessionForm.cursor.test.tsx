import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  type ModelInfo,
  type ProviderInfo,
  mergeNewSessionDefaults,
} from "@yep-anywhere/shared";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import catalog from "../../../../shared/test/fixtures/cursor-model-catalog.json";
import { type ServerSettings, api } from "../../api/client";
import { ToastProvider } from "../../contexts/ToastContext";
import { I18nProvider } from "../../i18n";
import { setCurrentInstallId } from "../../lib/storageKeys";
import { NewSessionForm } from "../NewSessionForm";

const models: ModelInfo[] = catalog.models.map((model) => ({
  id: model.value === "default" ? "auto" : model.value,
  name: model.name,
  cursorConfigOptions: model.configOptions,
}));
const cursor: ProviderInfo = {
  name: "cursor",
  displayName: "Cursor",
  installed: true,
  authenticated: true,
  enabled: true,
  supportsPermissionMode: true,
  permissionModes: ["default", "plan", "bypassPermissions"],
  supportsThinkingToggle: false,
  models,
};
const providerHolder = vi.hoisted(() => ({
  providers: [] as ProviderInfo[],
}));
vi.mock("../../hooks/useProviders", async (original) => ({
  ...(await original<typeof import("../../hooks/useProviders")>()),
  useProviders: () => ({
    providers: providerHolder.providers,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("../CursorAccountCard", () => ({ CursorAccountCard: () => null }));
vi.mock("../VoiceInputButton", () => ({ VoiceInputButton: () => null }));

function renderForm() {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <ToastProvider>
          <NewSessionForm projectId="cursor-test-project" />
        </ToastProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}
function choose(field: string, value: string) {
  const container = screen.getByRole("heading", { name: field }).parentElement;
  if (!container) throw new Error(`Missing ${field}`);
  fireEvent.click(within(container).getByRole("button"));
  fireEvent.click(screen.getByRole("button", { name: value }));
}
let settings: ServerSettings;
let scope = 0;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  providerHolder.providers = [cursor];
  setCurrentInstallId(`cursor-defaults-${++scope}`);
  settings = {
    newSessionDefaults: {
      provider: "cursor",
      model: "auto",
      permissionMode: "default",
      byProvider: {
        cursor: { model: "auto", permissionMode: "default" },
        codex: { model: "gpt-6-astra", serviceTier: "priority" },
      },
    },
  } as ServerSettings;
  vi.spyOn(api, "getServerSettings").mockImplementation(async () => ({
    settings,
  }));
  vi.spyOn(api, "updateServerSettings").mockImplementation(async (update) => {
    if (!update.newSessionDefaults) throw new Error("Missing defaults");
    settings = {
      ...settings,
      newSessionDefaults: mergeNewSessionDefaults(
        settings.newSessionDefaults,
        update.newSessionDefaults,
      ),
    };
    return { settings };
  });
  vi.spyOn(api, "getProvider").mockResolvedValue({ provider: cursor });
  vi.spyOn(api, "prepareCursorSession").mockResolvedValue({ ok: true });
  vi.spyOn(api, "discardCursorSession").mockResolvedValue({ ok: true });
  vi.spyOn(api, "warmCursorSession").mockResolvedValue({ ok: true });
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

describe("Cursor model options and Set as default", () => {
  it("saves and restores Cursor session auto-approval explicitly", async () => {
    const view = renderForm();
    await screen.findByRole("button", { name: "Auto" });
    fireEvent.click(
      screen.getByRole("button", { name: /Auto-approve this session/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Set as default" }));
    await waitFor(() =>
      expect(
        settings.newSessionDefaults?.byProvider?.cursor?.permissionMode,
      ).toBe("bypassPermissions"),
    );
    view.unmount();
    renderForm();
    await screen.findByRole("button", { name: "Auto" });
    expect(
      screen
        .getByRole("button", { name: /Auto-approve this session/ })
        .classList.contains("selected"),
    ).toBe(true);
    const composer = screen.getByRole("textbox");
    composer.textContent = "test session permissions";
    fireEvent.input(composer);
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(api.startSession).toHaveBeenCalledWith(
        "cursor-test-project",
        "test session permissions",
        expect.objectContaining({
          provider: "cursor",
          mode: "bypassPermissions",
        }),
      ),
    );
  });
  it("saves, restores and submits the model, reasoning, Fast, context and permission selection", async () => {
    const view = renderForm();
    await screen.findByRole("button", { name: "Auto" });
    choose("Model", "GPT-5.6 Sol");
    await waitFor(() =>
      expect(api.prepareCursorSession).toHaveBeenLastCalledWith(
        expect.objectContaining({ model: "gpt-5.6-sol" }),
      ),
    );
    const prepareCount = vi.mocked(api.prepareCursorSession).mock.calls.length;
    const discardCount = vi.mocked(api.discardCursorSession).mock.calls.length;
    choose("Thinking effort", "Extra high");
    choose("Context window", "1M");
    fireEvent.click(screen.getByRole("switch", { name: "Fast" }));
    expect(api.prepareCursorSession).toHaveBeenCalledTimes(prepareCount);
    expect(api.discardCursorSession).toHaveBeenCalledTimes(discardCount);
    fireEvent.click(screen.getByRole("button", { name: /Plan mode/i }));
    fireEvent.click(screen.getByRole("button", { name: "Set as default" }));
    const model = "gpt-5.6-sol[context=1m,reasoning=xhigh,fast=true]";
    await waitFor(() =>
      expect(api.updateServerSettings).toHaveBeenCalledWith({
        newSessionDefaults: expect.objectContaining({
          provider: "cursor",
          model,
          permissionMode: "plan",
          byProvider: {
            cursor: expect.objectContaining({
              model,
              permissionMode: "plan",
              serviceTier: undefined,
              thinking: undefined,
            }),
          },
        }),
      }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Set as default",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
    expect(settings.newSessionDefaults?.byProvider?.codex).toEqual({
      model: "gpt-6-astra",
      serviceTier: "priority",
    });

    view.unmount();
    renderForm();
    await screen.findByRole("button", { name: "GPT-5.6 Sol" });
    expect(screen.getByRole("button", { name: "Extra high" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1M" })).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Fast" }).getAttribute("aria-checked"),
    ).toBe("true");
    const composer = screen.getByRole("textbox");
    composer.textContent = "verify saved configuration";
    fireEvent.input(composer);
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(api.startSession).toHaveBeenCalledWith(
        "cursor-test-project",
        "verify saved configuration",
        expect.objectContaining({
          provider: "cursor",
          model,
          mode: "plan",
          serviceTier: undefined,
          reasoningEffort: undefined,
        }),
      ),
    );
  });

  it("exposes a single base model and only that model's supported controls", async () => {
    renderForm();
    await screen.findByRole("button", { name: "Auto" });
    expect(
      screen.getByText(/Cursor chooses the model in Auto mode/),
    ).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Fast" })).toBeNull();
    choose("Model", "Claude Opus 5");
    expect(
      screen.queryByText(/Cursor chooses the model in Auto mode/),
    ).toBeNull();
    choose("Thinking", "Thinking: off");
    choose("Thinking effort", "Max");
    choose("Context window", "1M");
    expect(screen.getByRole("button", { name: "Thinking: off" })).toBeTruthy();
    choose("Model", "Composer 2.5");
    expect(
      screen.queryByRole("heading", { name: "Thinking effort" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Context window" }),
    ).toBeNull();
    expect(
      screen.getByRole("switch", { name: "Fast" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: "Fast" }));
    fireEvent.click(screen.getByRole("button", { name: "Set as default" }));
    await waitFor(() =>
      expect(settings.newSessionDefaults?.model).toBe(
        "composer-2.5[fast=false]",
      ),
    );
  });

  it("restores a saved variant as its model, effort and Fast switch", async () => {
    settings.newSessionDefaults = {
      provider: "cursor",
      model: "gpt-5.6-sol-high-fast",
    };
    renderForm();
    await screen.findByRole("button", { name: "GPT-5.6 Sol" });
    expect(screen.getByRole("button", { name: "High" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "272K" })).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Fast" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByText(/Using your saved model selection/)).toBeNull();
  });

  it("replaces a flat model list with the parameterized catalog", async () => {
    providerHolder.providers = [
      {
        ...cursor,
        models: [
          { id: "auto", name: "Auto" },
          { id: "grok-4.7", name: "Grok 4.7" },
        ],
      },
    ];
    settings.newSessionDefaults = {
      provider: "cursor",
      model: "grok-4.7[context=500K,reasoning_effort=high,fast=true]",
      permissionMode: "default",
      byProvider: {
        cursor: {
          model: "grok-4.7[context=500K,reasoning_effort=high,fast=true]",
          permissionMode: "default",
        },
      },
    };
    renderForm();
    await screen.findByRole("button", { name: "Grok 4.7" });
    expect(screen.getByRole("button", { name: "500K" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "High" })).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Fast" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByText(/Using your saved model selection/)).toBeNull();
    expect(api.getProvider).toHaveBeenCalledWith("cursor", { fresh: true });
  });
});
