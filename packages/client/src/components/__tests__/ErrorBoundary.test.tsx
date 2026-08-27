import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ErrorBoundary, isConfirmedBuildMismatch } from "../ErrorBoundary";

function BrokenView(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'split')");
}

describe("ErrorBoundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not infer a version mismatch from an ordinary TypeError", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              current: "2026.8.5",
              build: { buildId: "test-server-build" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    render(
      <I18nProvider>
        <ErrorBoundary>
          <BrokenView />
        </ErrorBoundary>
      </I18nProvider>,
    );

    expect(screen.getByText(/Cannot read properties/)).toBeDefined();
    await waitFor(() => expect(screen.getByText("2026.8.5")).toBeDefined());
    expect(screen.queryByText("Client and server builds differ.")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Report Issue" }).getAttribute("href"),
    ).toBe("https://github.com/hustc5622/yepanywhere/issues");
    expect(document.body.textContent).not.toContain("npm i -g yepanywhere");
  });

  it("requires explicit non-dev build ids before declaring a mismatch", () => {
    expect(isConfirmedBuildMismatch("client", "server", "production")).toBe(
      true,
    );
    expect(isConfirmedBuildMismatch("same", "same", "production")).toBe(false);
    expect(isConfirmedBuildMismatch("client", "server", "dev")).toBe(false);
    expect(isConfirmedBuildMismatch("client", null, "production")).toBe(false);
  });

  it("falls back to a generic error when version lookup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );

    render(
      <I18nProvider>
        <ErrorBoundary>
          <BrokenView />
        </ErrorBoundary>
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getAllByText("Unknown").length).toBe(2));
    expect(screen.queryByText("Client and server builds differ.")).toBeNull();
    expect(screen.getByRole("button", { name: "Reload Page" })).toBeDefined();
  });
});
