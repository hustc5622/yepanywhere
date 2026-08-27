import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n";
import { ToolRenderErrorBoundary } from "../ToolRenderErrorBoundary";

function BrokenRenderer(): never {
  throw new TypeError("synthetic renderer failure");
}

describe("ToolRenderErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("contains a renderer exception inside its tool row", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <I18nProvider>
        <ToolRenderErrorBoundary
          toolId="tool-1"
          toolName="Write"
          status="pending"
          input={{}}
          result={undefined}
        >
          <BrokenRenderer />
        </ToolRenderErrorBoundary>
      </I18nProvider>,
    );

    expect(screen.getByText("Write")).toBeDefined();
    expect(
      screen.getByText("Tool details are temporarily unavailable"),
    ).toBeDefined();
  });

  it("recovers when a richer tool snapshot arrives", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { rerender } = render(
      <I18nProvider>
        <ToolRenderErrorBoundary
          toolId="tool-1"
          toolName="Write"
          status="pending"
          input={{}}
          result={undefined}
        >
          <BrokenRenderer />
        </ToolRenderErrorBoundary>
      </I18nProvider>,
    );

    const fullInput = { path: "/repo/app.ts", content: "done" };
    rerender(
      <I18nProvider>
        <ToolRenderErrorBoundary
          toolId="tool-1"
          toolName="Write"
          status="pending"
          input={fullInput}
          result={undefined}
        >
          <div>Recovered renderer</div>
        </ToolRenderErrorBoundary>
      </I18nProvider>,
    );

    expect(screen.getByText("Recovered renderer")).toBeDefined();
  });
});
