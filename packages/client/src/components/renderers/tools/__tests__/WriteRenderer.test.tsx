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

  it("renders raw OpenCode write success using the input file and content", () => {
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
});
