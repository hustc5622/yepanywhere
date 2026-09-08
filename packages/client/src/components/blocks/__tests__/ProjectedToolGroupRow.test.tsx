import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DisplayToolGroupItem } from "../../../types/renderItems";
import { ProjectedToolGroupRow } from "../ProjectedToolGroupRow";

const api = vi.hoisted(() => ({
  getSessionDisplayGroup: vi.fn(),
  getSessionDisplayTool: vi.fn(),
}));
vi.mock("../../../api/client", () => ({ api }));
vi.mock("../../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("../ToolCallRow", () => ({
  ToolCallRow: ({ detailOnly }: { detailOnly?: boolean }) => (
    <div>{detailOnly ? "tool details" : "nested tool row"}</div>
  ),
}));

const step = {
  id: "step",
  groupId: "group",
  name: "Bash",
  summary: "pnpm test",
  status: "completed" as const,
  preview: "Current output",
  truncated: false,
  version: 1,
};

function item(
  id: string,
  displayMode: "steps" | "summary",
  includeSteps = displayMode === "steps",
): DisplayToolGroupItem {
  return {
    type: "display_tool_group",
    id,
    projectId: "project",
    sessionId: id,
    revision: "v2",
    sourceMessages: [],
    group: {
      type: "tool_group",
      id: "group",
      detailRef: "group",
      count: 1,
      failedCount: 0,
      status: "completed",
      toolNames: ["Bash"],
      displayMode,
      ...(includeSteps ? { steps: [step] } : {}),
    },
  };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("ProjectedToolGroupRow", () => {
  it("shows the active tool name and command without an output preview", () => {
    render(<ProjectedToolGroupRow item={item("compact", "steps")} />);
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.queryByText("Current output")).toBeNull();
    expect(api.getSessionDisplayGroup).not.toHaveBeenCalled();
    expect(api.getSessionDisplayTool).not.toHaveBeenCalled();
  });

  it("uses the same collapsed row treatment for different tool types", () => {
    const uniform = item("uniform", "steps");
    if (uniform.group.type !== "tool_group") throw new Error("Expected group");
    uniform.group.count = 2;
    uniform.group.toolNames = ["Bash", "Edit"];
    uniform.group.steps = [
      step,
      {
        ...step,
        id: "edit-step",
        name: "Edit",
        summary: "/workspace/App.tsx",
        preview: "@@ -1 +1 @@",
      },
    ];

    render(<ProjectedToolGroupRow item={uniform} />);

    expect(screen.getAllByTestId("display-step")).toHaveLength(2);
    expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(2);
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.getByText("/workspace/App.tsx")).toBeTruthy();
    expect(screen.queryByText("@@ -1 +1 @@")).toBeNull();
  });

  it("opens the selected tool directly and renders its full detail body", async () => {
    api.getSessionDisplayTool.mockResolvedValue({
      toolId: "step",
      version: 1,
      messages: [
        {
          uuid: "tool",
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "raw-tool",
                name: "Bash",
                input: { command: "pnpm test" },
              },
            ],
          },
        },
      ],
    });
    render(<ProjectedToolGroupRow item={item("detail", "steps")} />);
    fireEvent.click(screen.getByText("Bash"));
    await waitFor(() =>
      expect(api.getSessionDisplayTool).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByText("tool details")).toBeTruthy();
    expect(screen.queryByText("nested tool row")).toBeNull();
  });

  it("collapses an uninspected active stage back to its aggregate", () => {
    const { rerender } = render(
      <ProjectedToolGroupRow item={item("handoff", "steps")} />,
    );
    rerender(<ProjectedToolGroupRow item={item("handoff", "summary")} />);
    expect(screen.queryByText("Bash")).toBeNull();
    expect(api.getSessionDisplayGroup).not.toHaveBeenCalled();
  });

  it("loads the tool index only after a historical aggregate is opened", async () => {
    api.getSessionDisplayGroup.mockResolvedValue({
      groupId: "group",
      steps: [step],
      total: 1,
    });
    render(<ProjectedToolGroupRow item={item("lazy-group", "summary")} />);

    expect(screen.queryByText("Bash")).toBeNull();
    expect(api.getSessionDisplayGroup).not.toHaveBeenCalled();
    expect(api.getSessionDisplayTool).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: /sessionToolGroupCount/ }),
    );
    await waitFor(() =>
      expect(api.getSessionDisplayGroup).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByText("Bash")).toBeTruthy();
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.queryByText("Current output")).toBeNull();
    expect(api.getSessionDisplayTool).not.toHaveBeenCalled();
  });

  it("does not reload previously opened tool bodies when the group reopens", async () => {
    api.getSessionDisplayGroup.mockResolvedValue({
      groupId: "group",
      steps: [step],
      total: 1,
    });
    api.getSessionDisplayTool.mockResolvedValue({
      toolId: "step",
      version: 1,
      messages: [
        {
          uuid: "tool",
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "raw-tool",
                name: "Bash",
                input: { command: "pnpm test" },
              },
            ],
          },
        },
      ],
    });
    render(<ProjectedToolGroupRow item={item("reopen", "summary")} />);

    const groupHeader = screen.getByRole("button", {
      name: /sessionToolGroupCount/,
    });
    fireEvent.click(groupHeader);
    fireEvent.click(await screen.findByText("Bash"));
    await waitFor(() =>
      expect(api.getSessionDisplayTool).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByText("tool details")).toBeTruthy();

    fireEvent.click(groupHeader);
    expect(screen.queryByText("Bash")).toBeNull();
    fireEvent.click(groupHeader);
    expect(await screen.findByText("Bash")).toBeTruthy();
    expect(screen.queryByText("tool details")).toBeNull();
    expect(api.getSessionDisplayTool).toHaveBeenCalledTimes(1);
  });
});
