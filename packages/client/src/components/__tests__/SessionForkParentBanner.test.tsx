import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import {
  SessionForkParentBanner,
  buildForkParentLocatorPath,
} from "../SessionForkParentBanner";

function renderBanner(forkParentSessionId: string) {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <SessionForkParentBanner
          basePath=""
          session={{ forkParentSessionId }}
        />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("SessionForkParentBanner", () => {
  afterEach(cleanup);

  it("links a source-preserving fork through the session locator", () => {
    renderBanner("019c1e57-962a-7a52-89f7-54cd7a72c455");

    expect(
      screen.getByText("This conversation was branched from another session"),
    ).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: /open source session/i })
        .getAttribute("href"),
    ).toBe("/sessions/019c1e57-962a-7a52-89f7-54cd7a72c455");
    expect(screen.queryByText(/subagent session/i)).toBeNull();
  });

  it("shows a path-free unavailable fallback for invalid lineage metadata", () => {
    const invalidPath = "/test-fixtures/codex/sessions/source.jsonl";
    const { container } = renderBanner(invalidPath);

    expect(
      screen.getByText("Source session navigation is unavailable"),
    ).toBeDefined();
    expect(screen.getByRole("status")).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.innerHTML).not.toContain(invalidPath);
    expect(container.innerHTML).not.toContain("/test-fixtures");
  });

  it("rejects path-shaped ids and encodes supported opaque ids", () => {
    expect(buildForkParentLocatorPath("/yep/", "ses_parent:1")).toBe(
      "/yep/sessions/ses_parent%3A1",
    );
    expect(buildForkParentLocatorPath("", "../source")).toBeNull();
    expect(buildForkParentLocatorPath("", "source/session")).toBeNull();
  });
});
