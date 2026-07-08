import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webSearchRenderer } from "../WebSearchRenderer";

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

describe("WebSearchRenderer", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders OpenCode text search output and extracts links", () => {
    render(
      <div>
        {webSearchRenderer.renderToolResult(
          "The ST4000VN006 comparison is covered at https://www.seagate.com/products/nas-drives/ironwolf-hard-drive/",
          false,
          renderContext,
          { query: "ST4000VN006 ST4000VN008" },
        )}
      </div>,
    );

    expect(screen.getByText('"ST4000VN006 ST4000VN008"')).toBeDefined();
    expect(screen.getByText(/ST4000VN006 comparison/)).toBeDefined();
    const link = screen.getByRole("link", {
      name: "www.seagate.com",
    }) as HTMLAnchorElement;
    expect(link.href).toBe(
      "https://www.seagate.com/products/nas-drives/ironwolf-hard-drive/",
    );
  });
});
