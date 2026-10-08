import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider, useI18n } from "../../../../i18n";
import { ToolCallRow } from "../../../blocks/ToolCallRow";

describe("Codex collaboration tool renderers", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

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

  it("reads the native v2 completed/errored union without guessing that unknown agents are running", () => {
    const { container } = render(
      <ToolCallRow
        id="native-status"
        toolName="list_agents"
        toolInput={{}}
        toolResult={{
          content: JSON.stringify({
            agents: [
              { agent_name: "/root/working", agent_status: "running" },
              {
                agent_name: "/root/done",
                agent_status: { completed: "Verified the result" },
              },
              {
                agent_name: "/root/failed",
                agent_status: { errored: "Provider unavailable" },
              },
              { agent_name: "/root/closed", agent_status: "shutdown" },
              { agent_name: "/root/missing", agent_status: "not_found" },
              { agent_name: "/root/starting", agent_status: "pending_init" },
              { agent_name: "/root/future", agent_status: { new_state: true } },
            ],
          }),
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );
    expect(screen.getByText("1 running · 7 subagents")).toBeDefined();
    fireEvent.click(container.querySelector("summary") as HTMLElement);
    for (const label of [
      "turn finished",
      "failed",
      "closed",
      "unavailable",
      "starting",
      "status unknown",
      "Verified the result",
      "Provider unavailable",
    ]) {
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  it("localizes the summary and details and responds to a locale change", async () => {
    function ChangeLanguage() {
      const { setLocale } = useI18n();
      return (
        <button type="button" onClick={() => setLocale("zh-CN")}>
          中文
        </button>
      );
    }
    const { container } = render(
      <I18nProvider>
        <ChangeLanguage />
        <ToolCallRow
          id="localized-list"
          toolName="list_agents"
          toolInput={{}}
          toolResult={{
            content: JSON.stringify({
              agents: [
                {
                  agent_name: "/root/reviewer",
                  agent_status: { completed: null },
                },
              ],
            }),
            isError: false,
          }}
          status="complete"
          sessionProvider="codex"
        />
      </I18nProvider>,
    );
    expect(screen.getByText("0 running · 1 subagent")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "中文" }));
    expect(
      await screen.findByText("0 个进行中 · 共 1 个子智能体"),
    ).toBeDefined();
    fireEvent.click(container.querySelector("summary") as HTMLElement);
    expect(screen.getByText("本轮已结束")).toBeDefined();
  });

  it("keeps relative child task names relative until the tool returns its canonical path", () => {
    render(
      <ToolCallRow
        id="relative-task"
        toolName="spawn_agent"
        toolInput={{ task_name: "nested", message: "opaque" }}
        status="pending"
        sessionProvider="codex"
      />,
    );
    expect(screen.getByText("Starting nested")).toBeDefined();
    expect(screen.queryByText("Starting /root/nested")).toBeNull();
  });

  it("toggles localized details with Enter and Space", () => {
    const { container } = render(
      <ToolCallRow
        id="keyboard-details"
        toolName="interrupt_agent"
        toolInput={{ target: "/root/reviewer" }}
        toolResult={{
          content: JSON.stringify({ previous_status: { completed: null } }),
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );
    expect(
      screen.getByText("Interrupted /root/reviewer · was turn finished"),
    ).toBeDefined();
    const summary = container.querySelector("summary");
    if (!summary) throw new Error("Missing disclosure");
    expect(screen.queryByText("Result")).toBeNull();
    fireEvent.keyDown(summary, { key: "Enter" });
    expect(screen.getByText("Result")).toBeDefined();
    fireEvent.keyDown(summary, { key: " " });
    expect(screen.queryByText("Result")).toBeNull();
  });
});
