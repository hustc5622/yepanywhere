import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRenderer } from "../ReadRenderer";

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

const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

if (!readRenderer.renderInteractiveSummary) {
  throw new Error("Read renderer must provide interactive summary");
}

describe("ReadRenderer", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalCreateObjectUrl) {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectUrl,
      });
    } else {
      Reflect.deleteProperty(URL, "createObjectURL");
    }
    if (originalRevokeObjectUrl) {
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectUrl,
      });
    } else {
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  it("keeps normal text reads clickable", () => {
    render(
      <div>
        {readRenderer.renderInteractiveSummary?.(
          { file_path: "packages/client/src/hooks/useGlobalSessions.ts" },
          {
            type: "text",
            file: {
              filePath: "packages/client/src/hooks/useGlobalSessions.ts",
              content: 'import { useCallback } from "react";\n',
              numLines: 1,
              startLine: 1,
              totalLines: 1,
            },
          },
          false,
          renderContext,
        )}
      </div>,
    );

    expect(
      screen.getByRole("button", { name: /useGlobalSessions\.ts/i }),
    ).toBeDefined();
  });

  it("does not offer an empty modal for PTY handoff reads", () => {
    render(
      <div>
        {readRenderer.renderInteractiveSummary?.(
          { file_path: "packages/client/src/hooks/useGlobalSessions.ts" },
          {
            type: "text",
            file: {
              filePath: "packages/client/src/hooks/useGlobalSessions.ts",
              content: "",
              numLines: 0,
              startLine: 1,
              totalLines: 260,
            },
            session_id: 37863,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(
      screen.queryByRole("button", { name: /useGlobalSessions\.ts/i }),
    ).toBeNull();
    expect(screen.getByText(/useGlobalSessions\.ts/)).toBeDefined();
    expect(screen.getByText(/continues in Shell/)).toBeDefined();
  });

  it("renders PTY handoff result without a clickable file button", () => {
    render(
      <div>
        {readRenderer.renderToolResult(
          {
            type: "text",
            file: {
              filePath: "packages/client/src/hooks/useGlobalSessions.ts",
              content: "",
              numLines: 0,
              startLine: 1,
              totalLines: 260,
            },
            session_id: 37863,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(
      screen.queryByRole("button", { name: /useGlobalSessions\.ts/i }),
    ).toBeNull();
    expect(screen.getByText(/continues in Shell/)).toBeDefined();
  });

  it("renders tagged read output instead of a failed read fallback", () => {
    const rawResult =
      '<path>/repo/data/benchmark_runs/j-9oi4c3ufw4__aime_25_hf/task.json</path>\n<type>file</type>\n<content>\n1: {\n2:   "task_id": "j-9oi4c3ufw4"\n3: }\n(End of file - total 3 lines)\n</content>';

    render(
      <div>
        {readRenderer.renderToolResult(
          rawResult as never,
          false,
          renderContext,
          {
            file_path:
              "/repo/data/benchmark_runs/j-9oi4c3ufw4__aime_25_hf/task.json",
          },
        )}
      </div>,
    );

    expect(screen.getByRole("button", { name: /task\.json/i })).toBeDefined();
    expect(screen.queryByText("Failed to read file")).toBeNull();
    expect(
      readRenderer.getResultSummary?.(rawResult as never, false, {
        file_path:
          "/repo/data/benchmark_runs/j-9oi4c3ufw4__aime_25_hf/task.json",
      } as never),
    ).toBe("task.json");
  });

  it("releases temporary PDF object URLs after the viewer consumes them", () => {
    vi.useFakeTimers();
    const createObjectUrl = vi.fn(() => "blob:yep-pdf");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });
    vi.spyOn(window, "open").mockReturnValue(window);

    render(
      <div>
        {readRenderer.renderToolResult(
          {
            type: "pdf",
            file: {
              base64: "JVBERi0xLjQ=",
              type: "application/pdf",
            },
          },
          false,
          renderContext,
        )}
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Open PDF/i }));
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:yep-pdf");
  });
});
