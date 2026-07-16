import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { RemoteProjectIcon } from "../RemoteProjectIcon";

describe("RemoteProjectIcon", () => {
  it("shows an accessible marker for remote Claude projects", () => {
    render(
      <I18nProvider>
        <RemoteProjectIcon isRemoteProject />
      </I18nProvider>,
    );

    expect(
      screen.getByRole("img", { name: "Remote Claude Code project" }),
    ).toBeTruthy();
  });

  it("renders nothing for ordinary local projects", () => {
    const { container } = render(
      <I18nProvider>
        <RemoteProjectIcon />
      </I18nProvider>,
    );

    expect(container.innerHTML).toBe("");
  });
});
