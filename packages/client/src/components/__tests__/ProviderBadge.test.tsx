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
  it.each(["medium", "high", "xhigh", "max", "ultra"])(
    "preserves the exact Codex reasoning tier %s",
    (effort) => {
      render(<ProviderBadge provider="codex" reasoningEffort={effort} />);
      expect(screen.getByText(effort)).toBeTruthy();
    },
  );

  it("keeps the provider identity on mobile when no config label exists", () => {
    const { container, rerender } = render(<ProviderBadge provider="codex" />);
    const providerBadge = container.querySelector(".provider-badge");

    expect(providerBadge?.classList).not.toContain(
      "provider-badge--mobile-config-only",
    );
    expect(screen.getByText("Codex")).toBeTruthy();

    rerender(<ProviderBadge provider="codex" model="gpt-6-astra" />);
    expect(container.querySelector(".provider-badge")?.classList).toContain(
      "provider-badge--mobile-config-only",
    );
  });

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

describe("Cursor model parameter badge", () => {
  it.each([
    ["en", "Fast off", "High"],
    ["zh-CN", "Fast 关", "高"],
  ])("shows Fast off for %s", async (locale, fastLabel, effortLabel) => {
    localStorage.setItem(UI_KEYS.locale, locale);
    render(
      <I18nProvider>
        <ProviderBadge
          provider="cursor"
          model="grok-4.7[context=500k,reasoning_effort=high,fast=false]"
        />
      </I18nProvider>,
    );
    await waitFor(() => {
      expect(
        screen.getByText(`Grok-4.7 · 500K · ${effortLabel} · ${fastLabel}`),
      ).toBeTruthy();
    });
  });

  it("shows Fast when the expression turns it on", async () => {
    localStorage.setItem(UI_KEYS.locale, "en");
    render(
      <I18nProvider>
        <ProviderBadge
          provider="cursor"
          model="grok-4.7[context=500k,reasoning_effort=high,fast=true]"
        />
      </I18nProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("Grok-4.7 · 500K · High · Fast")).toBeTruthy();
    });
  });

  it("splits a legacy variant into effort and Fast", () => {
    const { container } = render(
      <ProviderBadge provider="cursor" model="gpt-5.6-sol-high-fast" />,
    );
    expect(container.textContent).toContain("Gpt-5.6-sol");
    expect(container.textContent).toContain("High");
    expect(container.textContent).toContain("Fast");
    expect(container.textContent).not.toContain("Gpt-5.6-sol-high-fast");
  });

  it("shows only the effort encoded in a legacy variant", async () => {
    localStorage.setItem(UI_KEYS.locale, "zh-CN");
    render(
      <I18nProvider>
        <ProviderBadge provider="cursor" model="claude-opus-5-5-high" />
      </I18nProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("Opus 5.5 · 高")).toBeTruthy();
    });
    expect(screen.queryByText(/Fast/)).toBeNull();
    expect(screen.queryByText(/300K/)).toBeNull();
  });
});
