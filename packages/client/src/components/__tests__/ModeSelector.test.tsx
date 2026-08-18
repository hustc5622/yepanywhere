import { fireEvent, render, screen } from "@testing-library/react";
import type { PermissionMode, ProviderName } from "@yep-anywhere/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ModeSelector } from "../ModeSelector";

beforeEach(() => {
  localStorage.setItem("yep-anywhere-locale", "en");
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
});

describe("ModeSelector provider copy", () => {
  it.each<{
    provider: ProviderName;
    mode: PermissionMode;
    modes: readonly PermissionMode[];
    label: string;
    title: string;
    description: string;
  }>([
    {
      provider: "codex",
      mode: "auto",
      modes: ["auto", "plan", "bypassPermissions"],
      label: "cf compatible (Yep default)",
      title: "Codex Access",
      description:
        "No filesystem or network sandbox; Codex can still choose to request approval",
    },
    {
      provider: "kimi",
      mode: "bypassPermissions",
      modes: ["default", "plan", "auto", "bypassPermissions"],
      label: "YOLO",
      title: "Kimi Session Mode",
      description:
        "Auto-approve regular tools; sensitive actions, questions, and plan review still appear",
    },
  ])(
    "shows $provider's native labels and explanations",
    ({ provider, mode, modes, label, title, description }) => {
      render(
        <I18nProvider>
          <ModeSelector
            mode={mode}
            onModeChange={vi.fn()}
            provider={provider}
            permissionModes={modes}
          />
        </I18nProvider>,
      );

      fireEvent.click(screen.getByRole("button", { name: label }));

      expect(screen.getByText(title)).toBeTruthy();
      expect(screen.getByText(description)).toBeTruthy();
    },
  );
});
