import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../contexts/SessionMetadataContext";
import { SubagentDetailContext } from "../../contexts/SubagentDetailContext";
import { CodexNativeItemBlock } from "../blocks/codex/CodexNativeItemBlock";
import { CodexNativeSubAgentBlock } from "../blocks/codex/CodexNativeSubAgentBlock";

afterEach(cleanup);

function withParent(child: ReactNode, statuses: Record<string, string> = {}) {
  const openAgent = vi.fn();
  const rendered = render(
    <SessionMetadataProvider
      projectId="project"
      projectPath={null}
      sessionId="immediate-parent"
    >
      <SubagentDetailContext.Provider value={{ openAgent, statuses }}>
        {child}
      </SubagentDetailContext.Provider>
    </SessionMetadataProvider>,
  );
  return { ...rendered, openAgent };
}

describe("CodexNativeSubAgentBlock", () => {
  it("keeps item completion separate from the child task and opens inside its immediate parent", () => {
    const { openAgent } = withParent(
      <CodexNativeSubAgentBlock
        kind="started"
        agentPath="/root/reviewer/check_schema"
        agentThreadId="child"
        lifecycle="completed"
      />,
    );
    expect(screen.getByText("check_schema")).toBeDefined();
    expect(screen.getByText("/root/reviewer/check_schema")).toBeDefined();
    expect(screen.getByText("Task started")).toBeDefined();
    expect(screen.queryByText("completed")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "View details for /root/reviewer/check_schema",
      }),
    );
    expect(openAgent).toHaveBeenCalledWith({
      agentId: "child",
      parentSessionId: "immediate-parent",
      name: "/root/reviewer/check_schema",
    });
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("does not invent a session navigation action when the detail context is missing", () => {
    render(
      <CodexNativeSubAgentBlock
        projectId="project"
        kind="started"
        agentPath="/root/worker"
        agentThreadId="child"
        lifecycle="completed"
      />,
    );
    expect(screen.getByText("worker")).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("opens v1 receivers before states are available and does not treat a finished spawn call as task completion", () => {
    const { openAgent } = withParent(
      <CodexNativeItemBlock
        item={{
          id: "spawn",
          type: "codex_native_item",
          projectId: "project",
          lifecycle: "completed",
          sourceMessages: [],
          threadItem: {
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "completed",
            receiverThreadIds: ["child-thread"],
            agentsStates: {},
            model: "model",
            reasoningEffort: "high",
            prompt: "gAAAAA-private-tool-message",
          },
        }}
      />,
    );
    expect(screen.getByText("status unknown")).toBeDefined();
    expect(screen.queryByText("gAAAAA-private-tool-message")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "View details for child-thread" }),
    );
    expect(openAgent).toHaveBeenCalledWith({
      agentId: "child-thread",
      parentSessionId: "immediate-parent",
      name: "child-thread",
      status: "unknown",
    });
  });

  it("labels all native v1 terminal states without showing them as running", () => {
    const { container } = withParent(
      <CodexNativeSubAgentBlock
        tool="wait"
        lifecycle="completed"
        agentsStates={{
          completed: { status: "completed", message: "Task result" },
          closed: { status: "shutdown", message: null },
          unavailable: { status: "notFound", message: null },
          initializing: { status: "pendingInit", message: null },
        }}
      />,
    );
    for (const status of ["turn finished", "closed", "unavailable", "starting"])
      expect(screen.getAllByText(status).length).toBeGreaterThan(0);
    expect(container.querySelector(".status-running")).toBeNull();
    expect(screen.queryByText("Task result")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });

  it("does not rewrite an earlier activity with the child's current status", () => {
    withParent(
      <CodexNativeSubAgentBlock
        kind="started"
        agentPath="/root/reviewer"
        agentThreadId="child"
        lifecycle="completed"
      />,
      { child: "completed" },
    );
    expect(screen.getByText("Task started")).toBeDefined();
    expect(screen.queryByText("turn finished")).toBeNull();
  });

  it("keeps a historical collaboration snapshot when the current child status changes", () => {
    withParent(
      <CodexNativeSubAgentBlock
        tool="spawnAgent"
        lifecycle="completed"
        agentsStates={{
          child: { status: "running", message: "Earlier update" },
        }}
      />,
      { child: "completed" },
    );
    expect(screen.queryByText("turn finished")).toBeNull();
    expect(screen.getByText("running")).toBeDefined();
    expect(screen.queryByText("Earlier update")).toBeNull();
  });

  it("keeps the delegation entry and historical status without exposing messages in the main flow", () => {
    const { openAgent } = withParent(
      <CodexNativeSubAgentBlock
        kind="completed"
        agentPath="/root/reviewer"
        agentThreadId="child"
        lifecycle="completed"
        startedAt="2026-10-08T03:07:14Z"
        activity={{
          events: [
            { id: "start", kind: "started" },
            { id: "end", kind: "completed" },
          ],
          task: { encrypted: true },
          result: { text: "No blocking issues", encrypted: false },
        }}
      />,
      { child: "running" },
    );
    expect(screen.getByText("Turn finished")).toBeDefined();
    expect(screen.queryByText("running")).toBeNull();
    expect(screen.getByText("Delegated subtask")).toBeDefined();
    expect(screen.queryByText("Assigned task")).toBeNull();
    expect(
      screen.queryByText(
        "Codex encrypted this message. Its text is unavailable.",
      ),
    ).toBeNull();
    expect(screen.queryByText("Returned result")).toBeNull();
    expect(screen.queryByText("No blocking issues")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(openAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "child", status: "completed" }),
    );
  });

  it("renders communication to root as a message event, not a new child task", () => {
    const { container } = withParent(
      <CodexNativeSubAgentBlock
        kind="interacted"
        operation="send_message"
        agentPath="/root"
        agentThreadId="root-thread"
        lifecycle="completed"
      />,
    );
    expect(screen.getByText("Sent a message to Main agent")).toBeDefined();
    expect(container.querySelector(".codex-native-subagent")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not invent a delegation start when only a terminal page is loaded", () => {
    withParent(
      <CodexNativeSubAgentBlock
        kind="completed"
        agentPath="/root/review"
        agentThreadId="child"
        lifecycle="completed"
      />,
    );
    expect(screen.getByText("Subtask record")).toBeDefined();
    expect(screen.queryByText("Delegated subtask")).toBeNull();
  });

  it.each([
    { agentThreadId: "immediate-parent", agentPath: "/root/current" },
    { agentThreadId: "root-thread", agentPath: "/root" },
  ])(
    "does not open the current or root conversation as its own child: $agentPath",
    (agent) => {
      withParent(
        <CodexNativeSubAgentBlock
          {...agent}
          kind="interacted"
          lifecycle="completed"
        />,
      );
      expect(screen.queryByRole("button")).toBeNull();
    },
  );
});
