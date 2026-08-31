import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { ExpandableSessionTitle } from "../ExpandableSessionTitle";

function renderTitle(fullTitle?: string | null) {
  return render(
    <I18nProvider>
      <ExpandableSessionTitle
        title="Concise session title..."
        fullTitle={fullTitle}
      />
    </I18nProvider>,
  );
}

describe("ExpandableSessionTitle", () => {
  it("reveals the full current-session title instead of a session switcher", () => {
    const fullTitle =
      "This is the complete original session title with all of its details.";
    renderTitle(fullTitle);

    const trigger = screen.getByRole("button", {
      name: "Show full title: Concise session title...",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const dialog = screen.getByRole("dialog", {
      name: "Full session title",
    });
    expect(dialog.textContent).toContain(fullTitle);
    expect(screen.queryByText("Recent Sessions")).toBeNull();

    fireEvent.scroll(dialog);
    expect(screen.getByRole("dialog")).toBe(dialog);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("falls back to the displayed title when no full title is available", () => {
    renderTitle(null);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show full title: Concise session title...",
      }),
    );

    expect(screen.getByRole("dialog").textContent).toContain(
      "Concise session title...",
    );
  });
});
