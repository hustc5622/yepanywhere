import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import { ProviderBadge } from "../ProviderBadge";

afterEach(() => {
  cleanup();
  localStorage.removeItem(UI_KEYS.locale);
});

describe("Codex service tier badge", () => {
  it.each([
    ["en", "Fast (priority)"],
    ["zh-CN", "Fast（优先）"],
  ])("labels priority as Fast in %s", async (locale, label) => {
    localStorage.setItem(UI_KEYS.locale, locale);
    render(
      <I18nProvider>
        <ProviderBadge
          provider="codex"
          model="gpt-6-astra"
          reasoningEffort="xhigh"
          serviceTier="priority"
        />
        <ProviderBadge provider="codex" serviceTier="priority" compact />
      </I18nProvider>,
    );
    await waitFor(() => {
      expect(
        screen.getByText((content) => content.includes(`xhigh · ${label}`)),
      ).toBeTruthy();
      expect(screen.getByTitle(`Codex (${label})`)).toBeTruthy();
    });
  });

  it("renders standard and legacy Fast tiers, preserving unknown tier names", () => {
    const { rerender, container } = render(
      <ProviderBadge provider="codex" serviceTier="default" />,
    );
    expect(container.textContent).toContain("Standard");
    rerender(<ProviderBadge provider="codex" serviceTier="fast" />);
    expect(container.textContent).toContain("Fast (priority)");
    rerender(<ProviderBadge provider="codex" serviceTier="flex" />);
    expect(container.textContent).toContain("flex");
    rerender(<ProviderBadge provider="codex" />);
    expect(container.textContent).not.toContain("Fast");
    rerender(<ProviderBadge provider="claude" serviceTier="priority" />);
    expect(container.textContent).toContain("priority");
    expect(container.textContent).not.toContain("Fast");
  });
});
