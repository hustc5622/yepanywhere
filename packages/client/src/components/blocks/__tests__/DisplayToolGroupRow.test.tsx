import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../api/client";
import { SchemaValidationProvider } from "../../../contexts/SchemaValidationContext";
import { ToastProvider } from "../../../contexts/ToastContext";
import { I18nProvider } from "../../../i18n";
import type { DisplayToolGroupItem } from "../../../types/renderItems";
import { DisplayToolGroupRow } from "../DisplayToolGroupRow";

function item(): DisplayToolGroupItem {
  return {
    type: "display_tool_group",
    id: "group-1",
    projectId: "project-1",
    sessionId: "session-1",
    revision: "revision-1",
    group: {
      type: "tool_group",
      id: "group-1",
      status: "completed",
      count: 1,
      failedCount: 0,
      toolNames: ["Read"],
      detailRef: "detail-1",
    },
    sourceMessages: [],
  };
}

describe("DisplayToolGroupRow", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("fetches normalized tool messages only after expansion", async () => {
    const getDetails = vi
      .spyOn(api, "getSessionToolGroupDetails")
      .mockResolvedValue({
        sessionId: "session-1",
        revision: "revision-1",
        detailRef: "detail-1",
        messages: [
          {
            uuid: "tool-message",
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tool-1",
                  name: "Read",
                  input: { file_path: "src/example.ts" },
                },
              ],
            },
          },
          {
            uuid: "result-message",
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-1",
                  content: "example body",
                },
              ],
            },
          },
        ],
      });
    const { container } = render(
      <I18nProvider>
        <ToastProvider>
          <SchemaValidationProvider>
            <DisplayToolGroupRow item={item()} sessionProvider="codex" />
          </SchemaValidationProvider>
        </ToastProvider>
      </I18nProvider>,
    );

    expect(getDetails).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { expanded: false }));

    await waitFor(() => expect(getDetails).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(container.querySelectorAll(".tool-row")).toHaveLength(1),
    );
    expect(getDetails).toHaveBeenCalledWith(
      "project-1",
      "session-1",
      "detail-1",
      expect.objectContaining({ revision: "revision-1" }),
    );
  });

  it("auto-expands the active external live tail only", async () => {
    const getDetails = vi
      .spyOn(api, "getSessionToolGroupDetails")
      .mockResolvedValue({
        sessionId: "session-1",
        revision: "revision-1",
        detailRef: "detail-1",
        messages: [],
      });
    const baseItem = item();
    if (baseItem.group.type !== "tool_group") {
      throw new Error("expected tool group fixture");
    }
    const liveItem: DisplayToolGroupItem = {
      ...baseItem,
      group: { ...baseItem.group, status: "running", liveTail: true },
    };

    render(
      <I18nProvider>
        <ToastProvider>
          <SchemaValidationProvider>
            <DisplayToolGroupRow item={liveItem} sessionProvider="codex" />
          </SchemaValidationProvider>
        </ToastProvider>
      </I18nProvider>,
    );

    await waitFor(() => expect(getDetails).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
  });
});
