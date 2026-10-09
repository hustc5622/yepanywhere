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
import { getThinkingSetting } from "../../hooks/useModelSettings";
import { useProviders } from "../../hooks/useProviders";
import { useServerSettings } from "../../hooks/useServerSettings";
import { I18nProvider } from "../../i18n";
import { updateNewSessionLayout } from "../../lib/newSessionLayout";
import { setCurrentInstallId } from "../../lib/storageKeys";
import { NewSessionForm } from "../NewSessionForm";

vi.mock("../../hooks/useProviders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useProviders")>()),
  useProviders: vi.fn(),
}));
vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: vi.fn(),
}));
vi.mock("../CodexUsageCard", () => ({ CodexUsageCard: () => null }));
vi.mock("../VoiceInputButton", () => ({ VoiceInputButton: () => null }));

const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
const provider: ProviderInfo = {
  name: "codex",
  displayName: "Codex",
  installed: true,
  authenticated: true,
  enabled: true,
  supportsPermissionMode: false,
  supportsThinkingToggle: true,
  models: [
    {
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      description: "Test model",
      defaultReasoningEffort: "xhigh",
      supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
        reasoningEffort,
      })),
    },
  ],
};

function formElement(compact: boolean) {
  return (
    <MemoryRouter>
      <I18nProvider>
        <ToastProvider>
          <NewSessionForm projectId="test-project" compact={compact} />
        </ToastProvider>
      </I18nProvider>
    </MemoryRouter>
  );
}

function renderForm(compact: boolean) {
  return render(formElement(compact));
}

function selectEffort(compact: boolean, label: string) {
  if (compact) {
    fireEvent.click(
      screen.getByRole("button", { name: `Thinking effort: ${label}` }),
    );
  } else {
    fireEvent.click(screen.getByRole("button", { name: /Thinking: on/ }));
    fireEvent.click(
      screen.getByRole("button", { name: `Thinking: on (${label})` }),
    );
  }
}

describe("Codex new session reasoning", () => {
  let testScope = 0;
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setCurrentInstallId(`new-session-form-${++testScope}`);
    vi.mocked(useProviders).mockReturnValue({
      providers: [provider],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(useServerSettings).mockReturnValue({
      settings: {
        newSessionDefaults: {
          provider: "codex",
          model: "gpt-6-astra",
          // Reproduce previously saved conflicting shared/native settings.
          thinking: "on:high",
          reasoningEffort: "xhigh",
        },
      } as ServerSettings,
      isLoading: false,
      error: null,
      updateSetting: vi.fn(),
      refetch: vi.fn(),
    });
    vi.spyOn(api, "startSession").mockResolvedValue({
      sessionId: "new-thread",
      processId: "new-process",
      permissionMode: "default",
      modeVersion: 0,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps account placeholders and the draft through settings and account loading", async () => {
    const readyProviders = vi.mocked(useProviders).getMockImplementation()?.();
    const readySettings = vi
      .mocked(useServerSettings)
      .getMockImplementation()?.();
    if (!readyProviders || !readySettings)
      throw new Error("Missing hook fixtures");
    vi.mocked(useProviders).mockReturnValue({
      ...readyProviders,
      providers: [],
      loading: true,
    });
    vi.mocked(useServerSettings).mockReturnValue({
      ...readySettings,
      settings: null,
      isLoading: true,
    });
    updateNewSessionLayout({ provider: "codex", codexAccountCount: 3 });
    let resolveAccounts!: (
      response: Awaited<ReturnType<typeof api.getCodexAccounts>>,
    ) => void;
    vi.spyOn(api, "getCodexAccounts").mockReturnValue(
      new Promise((resolve) => {
        resolveAccounts = resolve;
      }),
    );
    const view = renderForm(false);
    const composer = screen.getByRole("textbox");
    composer.textContent = "Draft while loading";
    fireEvent.input(composer);
    expect(
      view.container.querySelectorAll(".new-session-account-skeleton"),
    ).toHaveLength(3);

    vi.mocked(useProviders).mockReturnValue(readyProviders);
    vi.mocked(useServerSettings).mockReturnValue(readySettings);
    view.rerender(formElement(false));
    expect(
      view.container.querySelectorAll(".new-session-account-skeleton"),
    ).toHaveLength(3);
    await act(async () => {
      resolveAccounts({
        accounts: Array.from({ length: 3 }, (_, i) => ({
          id: i === 0 ? "default" : `account-${i}`,
          label: null,
          codexHome: `/test/account-${i}`,
          isDefault: i === 0,
          isActive: i === 0,
          account: {
            type: "chatgpt",
            email: `account-${i}@example.com`,
            planType: "pro",
          },
          usage: null,
          error: null,
          login: null,
        })),
        error: null,
      });
    });
    expect(
      view.container.querySelectorAll(".new-session-account-skeleton"),
    ).toHaveLength(0);
    expect(screen.getByText("account-2@example.com")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBe(composer);
    expect(composer.textContent).toBe("Draft while loading");
  });

  it.each([
    [true, "Medium", "medium"],
    [true, "High", "high"],
    [true, "Extra high", "xhigh"],
    [true, "Max", "max"],
    [true, "ultra", "ultra"],
    [false, "Medium", "medium"],
    [false, "High", "high"],
    [false, "Max", "max"],
    [false, "ultra", "ultra"],
  ] as const)(
    "submits the selected %s/%s tier instead of the saved CLI default",
    async (compact, label, effort) => {
      renderForm(compact);
      selectEffort(compact, label);
      const composer = screen.getByRole("textbox");
      composer.textContent = "test prompt";
      fireEvent.input(composer);
      fireEvent.click(screen.getByRole("button", { name: "Start session" }));
      await waitFor(() =>
        expect(api.startSession).toHaveBeenCalledWith(
          "test-project",
          "test prompt",
          expect.objectContaining({
            provider: "codex",
            model: "gpt-6-astra",
            reasoningEffort: effort,
            thinking: effort === "ultra" ? undefined : `on:${effort}`,
          }),
        ),
      );
      if (effort !== "ultra") expect(getThinkingSetting()).toBe(`on:${effort}`);
    },
  );

  it("restores and submits the same native tier when saved shared thinking disagrees", async () => {
    renderForm(true);
    expect(
      screen
        .getByRole("button", { name: "Thinking effort: Extra high" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Thinking effort: High" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    const composer = screen.getByRole("textbox");
    composer.textContent = "test prompt";
    fireEvent.input(composer);
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(api.startSession).toHaveBeenCalledWith(
        "test-project",
        "test prompt",
        expect.objectContaining({
          thinking: "on:xhigh",
          reasoningEffort: "xhigh",
        }),
      ),
    );
    expect(getThinkingSetting()).toBe("on:xhigh");
  });

  it("shows only the model's supported native tiers in compact mode", () => {
    vi.mocked(useProviders).mockReturnValue({
      providers: [
        {
          ...provider,
          models: [
            {
              ...provider.models?.[0],
              id: "gpt-6-astra",
              name: "Test model",
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: ["low", "high", "max"].map(
                (reasoningEffort) => ({ reasoningEffort }),
              ),
            },
          ],
        },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    renderForm(true);
    expect(
      screen.queryByRole("button", { name: "Thinking effort: Medium" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Thinking effort: Extra high" }),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Thinking effort: High" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
