import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DisplayToolGroupItem } from "../../../types/renderItems";
import {
  ProjectedToolGroupRow,
  ProjectedToolStepRow,
} from "../ProjectedToolGroupRow";

const api = vi.hoisted(() => ({
  getSessionDisplayGroup: vi.fn(),
  getSessionDisplayTool: vi.fn(),
  getSessionDisplayToolOutput: vi.fn(),
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("ProjectedToolGroupRow", () => {
  it("does not fetch dynamic content for a collapsed running tool", async () => {
    vi.useFakeTimers();
    render(
      <ProjectedToolStepRow
        step={{ ...step, status: "running" }}
        projectId="project"
        sessionId="never-expanded"
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(api.getSessionDisplayTool).not.toHaveBeenCalled();
    expect(api.getSessionDisplayToolOutput).not.toHaveBeenCalled();
  });

  it("retains paged details and output on unchanged responses without reloading full details", async () => {
    vi.useFakeTimers();
    const detail = {
      toolId: "step",
      version: 1,
      messages: [],
      liveOutput: "initial progress",
      liveOutputRevision: "r1",
      rawJson: {
        content: "first detail page",
        offset: 0,
        total: 100,
        revision: "body",
      },
      nextCursor: "page2",
    };
    api.getSessionDisplayTool.mockResolvedValue(detail);
    api.getSessionDisplayToolOutput.mockResolvedValue({
      revision: "r1",
      status: "running",
    });
    render(
      <ProjectedToolStepRow
        step={{ ...step, status: "running" }}
        projectId="project"
        sessionId="conditional-paging"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Bash"));
    });
    api.getSessionDisplayTool.mockResolvedValue({
      ...detail,
      rawJson: { ...detail.rawJson, content: "second detail page", offset: 50 },
      nextCursor: undefined,
    });
    await act(async () => {
      fireEvent.click(screen.getByText("sessionToolGroupLoadMore"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(api.getSessionDisplayToolOutput.mock.calls[0]?.[3].since).toBe("r1");
    expect(screen.getByText("initial progress")).toBeTruthy();
    expect(screen.getByText("second detail page")).toBeTruthy();
    api.getSessionDisplayToolOutput.mockResolvedValue({
      revision: "r2",
      status: "running",
      output: "new progress",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText("new progress")).toBeTruthy();
    api.getSessionDisplayToolOutput.mockResolvedValue({
      revision: "r2",
      status: "running",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(api.getSessionDisplayToolOutput.mock.calls[2]?.[3].since).toBe("r2");
    expect(screen.getByText("new progress")).toBeTruthy();
    expect(screen.getByText("second detail page")).toBeTruthy();
    expect(api.getSessionDisplayTool).toHaveBeenCalledTimes(2);
  });

  it("pauses hidden readers and never overlaps slow output requests or applies a late closed response", async () => {
    vi.useFakeTimers();
    api.getSessionDisplayTool.mockResolvedValue({
      toolId: "step",
      version: 1,
      messages: [],
      liveOutput: "before",
    });
    let resolve!: (value: unknown) => void;
    api.getSessionDisplayToolOutput.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(
      <ProjectedToolStepRow
        step={{ ...step, status: "running" }}
        projectId="project"
        sessionId="slow-output"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Bash"));
    });
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(api.getSessionDisplayToolOutput).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(api.getSessionDisplayToolOutput).toHaveBeenCalledTimes(1);
    const signal = api.getSessionDisplayToolOutput.mock.calls[0]?.[3].signal;
    expect(signal.aborted).toBe(false);
    fireEvent.click(screen.getByText("Bash"));
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolve({ revision: "late", status: "running", output: "late output" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(api.getSessionDisplayToolOutput).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("late output")).toBeNull();
  });

  it("loads the final result once when lightweight polling sees completion before the projection", async () => {
    vi.useFakeTimers();
    api.getSessionDisplayTool.mockResolvedValue({
      toolId: "step",
      version: 1,
      messages: [],
      liveOutput: "working",
      liveOutputRevision: "r1",
    });
    api.getSessionDisplayToolOutput.mockResolvedValue({
      revision: "r2",
      status: "completed",
      output: "",
    });
    const props = { projectId: "project", sessionId: "output-completed" };
    const { rerender } = render(
      <ProjectedToolStepRow {...props} step={{ ...step, status: "running" }} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Bash"));
    });
    api.getSessionDisplayTool.mockResolvedValue({
      toolId: "step",
      version: 2,
      messages: [],
      rawJson: {
        content: "final result",
        offset: 0,
        total: 12,
        revision: "body",
      },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(screen.getByText("final result")).toBeTruthy();
    expect(api.getSessionDisplayTool).toHaveBeenCalledTimes(2);
    expect(api.getSessionDisplayToolOutput).toHaveBeenCalledTimes(1);
    await act(async () => {
      rerender(
        <ProjectedToolStepRow {...props} step={{ ...step, version: 2 }} />,
      );
    });
    expect(api.getSessionDisplayTool).toHaveBeenCalledTimes(2);
  });

  it("shows the latest output before paged command details and follows the tail", async () => {
    api.getSessionDisplayTool.mockResolvedValue({
      toolId: "step",
      version: 1,
      messages: [],
      liveOutput: `${Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\r\n")}\r\n`,
      rawJson: {
        content: "large command details",
        offset: 0,
        total: 100,
        revision: "1",
      },
    });
    const { container } = render(
      <ProjectedToolStepRow
        step={{ ...step, status: "running", preview: "" }}
        projectId="project"
        sessionId="live-paged-output"
      />,
    );
    expect(screen.queryByText("sessionDisplayLatestOutput")).toBeNull();
    fireEvent.click(screen.getByText("Bash"));
    await screen.findByText("large command details");
    const output = container.querySelector(".tool-live-output pre");
    expect(output?.textContent?.split("\n")).toEqual(
      Array.from({ length: 12 }, (_, i) => `line ${i + 3}`),
    );
    expect(
      (output?.compareDocumentPosition(
        screen.getByText("large command details"),
      ) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps slow output requests alive, refreshes while open, and stops on collapse", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    api.getSessionDisplayTool.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(
      <ProjectedToolStepRow
        step={{ ...step, status: "running", preview: "" }}
        projectId="project"
        sessionId="live-refresh-output"
      />,
    );
    fireEvent.click(screen.getByText("Bash"));
    expect(screen.getByText("sessionDisplayWaitingOutput")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(api.getSessionDisplayTool).toHaveBeenCalledTimes(1);
    expect(api.getSessionDisplayTool.mock.calls[0]?.[3].signal.aborted).toBe(
      false,
    );
    await act(async () => {
      resolve({
        toolId: "step",
        version: 1,
        messages: [],
        liveOutput: "first progress",
      });
    });
    expect(screen.getByText("first progress")).toBeTruthy();
    api.getSessionDisplayToolOutput.mockResolvedValue({
      revision: "output-2",
      status: "running",
      output: "latest progress",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText("latest progress")).toBeTruthy();
    expect(screen.queryByText("first progress")).toBeNull();
    fireEvent.click(screen.getByText("Bash"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(api.getSessionDisplayTool).toHaveBeenCalledTimes(1);
    expect(api.getSessionDisplayToolOutput).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("latest progress")).toBeNull();
  });

  it("switches to the final result and stops polling when the command completes", async () => {
    vi.useFakeTimers();
    api.getSessionDisplayTool.mockResolvedValue({
      toolId: "step",
      version: 1,
      messages: [],
      liveOutput: "working",
    });
    const props = { projectId: "project", sessionId: "live-completion-output" };
    const { rerender } = render(
      <ProjectedToolStepRow {...props} step={{ ...step, status: "running" }} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Bash"));
    });
    expect(screen.getByText("working")).toBeTruthy();
    api.getSessionDisplayTool.mockResolvedValue({
      toolId: "step",
      version: 2,
      messages: [],
      rawJson: { content: "final result", offset: 0, total: 12, revision: "2" },
    });
    await act(async () => {
      rerender(
        <ProjectedToolStepRow {...props} step={{ ...step, version: 2 }} />,
      );
    });
    expect(screen.getByText("final result")).toBeTruthy();
    expect(screen.queryByText("sessionDisplayLatestOutput")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(api.getSessionDisplayTool).toHaveBeenCalledTimes(2);
  });

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

  it("ticks an elapsed badge for a running step and drops it once finished", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T10:00:30.000Z"));
    const timestamp = "2026-01-02T10:00:00.000Z";
    const { rerender } = render(
      <ProjectedToolStepRow
        step={{ ...step, status: "running", timestamp }}
        projectId="project"
        sessionId="elapsed"
      />,
    );

    expect(screen.getByTestId("display-step-elapsed").textContent).toBe("30s");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(42_000);
    });
    expect(screen.getByTestId("display-step-elapsed").textContent).toBe(
      "1m12s",
    );

    rerender(
      <ProjectedToolStepRow
        step={{ ...step, status: "completed", timestamp }}
        projectId="project"
        sessionId="elapsed"
      />,
    );
    expect(screen.queryByTestId("display-step-elapsed")).toBeNull();
  });

  it("omits the elapsed badge when the step has no start timestamp", () => {
    render(
      <ProjectedToolStepRow
        step={{ ...step, status: "running" }}
        projectId="project"
        sessionId="elapsed-missing"
      />,
    );
    expect(screen.queryByTestId("display-step-elapsed")).toBeNull();
  });
});
