import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../api/client";
import { SchemaValidationProvider } from "../../../contexts/SchemaValidationContext";
import { ToastProvider } from "../../../contexts/ToastContext";
import { I18nProvider } from "../../../i18n";
import type { AssistantOutputToolGroupItem } from "../../../types/renderItems";
import { AssistantOutputToolGroupRow } from "../AssistantOutputToolGroupRow";

describe("AssistantOutputToolGroupRow", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("expands already-loaded live details without an API request", () => {
    const getDetails = vi.spyOn(api, "getSessionToolGroupDetails");
    const item: AssistantOutputToolGroupItem = {
      type: "assistant_output_tool_group",
      id: "group-1",
      tools: [
        {
          type: "tool_call",
          id: "tool-1",
          toolName: "Bash",
          toolInput: { command: "pnpm test" },
          toolResult: { content: "passed", isError: false },
          status: "complete",
          sourceMessages: [],
        },
        {
          type: "tool_call",
          id: "tool-2",
          toolName: "Edit",
          toolInput: { file_path: "src/example.ts" },
          status: "aborted",
          sourceMessages: [],
        },
      ],
      sourceMessages: [],
    };
    const { container } = render(
      <I18nProvider>
        <ToastProvider>
          <SchemaValidationProvider>
            <AssistantOutputToolGroupRow item={item} sessionProvider="codex" />
          </SchemaValidationProvider>
        </ToastProvider>
      </I18nProvider>,
    );

    expect(container.querySelectorAll(".tool-row")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { expanded: false }));

    expect(container.querySelectorAll(".tool-row")).toHaveLength(2);
    expect(getDetails).not.toHaveBeenCalled();
  });
});
