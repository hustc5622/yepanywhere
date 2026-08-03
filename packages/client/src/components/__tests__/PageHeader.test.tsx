import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { PageHeader } from "../PageHeader";

function renderHeader(isWideScreen: boolean, onOpenSidebar = vi.fn()) {
  render(
    <I18nProvider>
      <PageHeader
        title="Test page"
        onOpenSidebar={onOpenSidebar}
        isWideScreen={isWideScreen}
      />
    </I18nProvider>,
  );
  return onOpenSidebar;
}

describe("PageHeader sidebar control", () => {
  it("does not render a sidebar control in desktop content headers", () => {
    renderHeader(true);

    expect(screen.queryByRole("button", { name: "Open sidebar" })).toBeNull();
  });

  it("keeps the sidebar entry point in mobile content headers", () => {
    const onOpenSidebar = renderHeader(false);
    const openButton = screen.getByRole("button", { name: "Open sidebar" });

    fireEvent.click(openButton);

    expect(onOpenSidebar).toHaveBeenCalledTimes(1);
  });
});
