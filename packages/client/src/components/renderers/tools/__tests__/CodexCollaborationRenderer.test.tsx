import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolCallRow } from "../../../blocks/ToolCallRow";

describe("Codex collaboration tool renderers", () => {
  afterEach(() => cleanup());

  it("shows a spawned child as an agent task without exposing its opaque message", () => {
    const { container } = render(
      <ToolCallRow
        id="spawn-1"
        toolName="spawn_agent"
        toolInput={{
          task_name: "review_runtime",
          fork_turns: "all",
          message: "gAAAAA-opaque-encrypted-agent-message",
        }}
        toolResult={{
          content: JSON.stringify({ task_name: "/root/review_runtime" }),
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    expect(screen.getByText("Agent")).toBeDefined();
    expect(screen.getByText("Started /root/review_runtime")).toBeDefined();

    const header = container.querySelector(".tool-row-header");
    expect(header).not.toBeNull();
    fireEvent.click(header as HTMLElement);

    expect(screen.getByText("Result")).toBeDefined();
    expect(container.textContent).not.toContain("gAAAAA-opaque");
  });

  it("summarizes and expands the current Codex subagent set", () => {
    const { container } = render(
      <ToolCallRow
        id="agents-1"
        toolName="list_agents"
        toolInput={{}}
        toolResult={{
          content: JSON.stringify({
            agents: [
              {
                agent_name: "/root",
                agent_status: "running",
                last_task_message: "Main thread",
              },
              {
                agent_name: "/root/review_runtime",
                agent_status: "running",
                last_task_message: null,
              },
              {
                agent_name: "/root/review_codex",
                agent_status: "completed",
                last_task_message: "Found one issue",
              },
              {
                agent_name: "/root/review_sessions_ui",
                agent_status: "running",
                last_task_message: null,
              },
            ],
          }),
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    expect(screen.getByText("Agents")).toBeDefined();
    expect(screen.getByText("2 running · 3 subagents")).toBeDefined();

    const header = container.querySelector(".tool-row-header");
    fireEvent.click(header as HTMLElement);
    expect(screen.getByText("/root/review_runtime")).toBeDefined();
    expect(screen.getByText("/root/review_codex")).toBeDefined();
    expect(screen.getByText("Found one issue")).toBeDefined();
    expect(container.textContent).not.toContain("Main thread");
  });

  it("keeps the interrupted agent and its previous state in the summary", () => {
    render(
      <ToolCallRow
        id="interrupt-1"
        toolName="interrupt_agent"
        toolInput={{ target: "/root/review_runtime" }}
        toolResult={{
          content: JSON.stringify({ previous_status: "running" }),
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    expect(
      screen.getByText("Interrupted /root/review_runtime · was running"),
    ).toBeDefined();
  });

  it("preserves UUID targets used by Codex collaboration tools", () => {
    const threadId = "019f4af6-57d5-73e1-96d0-b3ee3a8eceda";
    render(
      <ToolCallRow
        id="interrupt-uuid"
        toolName="interrupt_agent"
        toolInput={{ target: threadId }}
        toolResult={{
          content: JSON.stringify({ previous_status: "running" }),
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    expect(
      screen.getByText(`Interrupted ${threadId} · was running`),
    ).toBeDefined();
  });
});
