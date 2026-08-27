import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeRenderer } from "../WriteRenderer";

vi.mock("../../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    enabled: false,
    reportValidationError: vi.fn(),
    isToolIgnored: vi.fn(() => false),
    ignoreToolErrors: vi.fn(),
    clearIgnoredTools: vi.fn(),
    ignoredTools: [],
  }),
}));

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
};

describe("WriteRenderer", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders raw write success using the input file and content", () => {
    render(
      <div>
        {writeRenderer.renderToolResult(
          "Wrote file successfully." as never,
          false,
          renderContext,
          {
            file_path: "/repo/migrations/0011_benchmark_metrics.sql",
            content:
              "CREATE TABLE benchmark_metric (\n  id BIGINT PRIMARY KEY\n);",
          },
        )}
      </div>,
    );

    expect(screen.getByText("0011_benchmark_metrics.sql")).toBeDefined();
    expect(screen.getByText("3 lines written")).toBeDefined();
    expect(screen.getByText(/CREATE TABLE benchmark_metric/)).toBeDefined();
    expect(screen.queryByText("Wrote file successfully.")).toBeNull();
  });

  it("tolerates a lazy-created Write call with no input yet", () => {
    expect(writeRenderer.getUseSummary?.({})).toBe("Writing...");
    expect(
      writeRenderer.renderCollapsedPreview?.(
        {},
        undefined,
        false,
        renderContext,
      ),
    ).toBeNull();

    render(<div>{writeRenderer.renderToolUse({}, renderContext)}</div>);
    expect(screen.getByText("Preparing write")).toBeDefined();
  });

  it("accepts Kimi's path alias once the streamed input is complete", () => {
    render(
      <div>
        {writeRenderer.renderCollapsedPreview?.(
          {
            path: "/repo/src/app.ts",
            content: "export const value = 1;\n",
          },
          undefined,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText("2 lines")).toBeDefined();
    expect(screen.getByText(/export const value/)).toBeDefined();
  });

  it("renders a complete structured result without relying on tool input", () => {
    render(
      <div>
        {writeRenderer.renderToolResult(
          {
            type: "text",
            file: {
              filePath: "/repo/src/result.ts",
              content: "done\n",
              numLines: 2,
              startLine: 1,
              totalLines: 2,
            },
          },
          false,
          renderContext,
          {},
        )}
      </div>,
    );

    expect(screen.getByText("result.ts")).toBeDefined();
    expect(screen.getByText("2 lines written")).toBeDefined();
  });
});
