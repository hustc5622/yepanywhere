import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { CodexAgentWaitBlock } from "../blocks/codex/CodexAgentWaitBlock";
import { CodexNativeItemBlock } from "../blocks/codex/CodexNativeItemBlock";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

describe("Codex agent coordination wait", () => {
  it("ticks from the real start time and removes the spinner when the wait ends", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T03:24:05Z"));
    const { container, rerender } = render(
      <CodexAgentWaitBlock status="running" startedAt="2026-10-08T03:24:02Z" />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Waiting for agent updates",
    );
    expect(container.querySelector(".codex-agent-wait-spinner")).not.toBeNull();
    expect(screen.getByText("Waited 3s")).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("Waited 5s")).toBeDefined();
    rerender(
      <CodexAgentWaitBlock
        status="completed"
        startedAt="2026-10-08T03:24:02Z"
        completedAt="2026-10-08T03:24:07Z"
        outcome="message"
      />,
    );
    expect(container.querySelector(".codex-agent-wait-spinner")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Agent update received",
    );
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText("Waited 5s")).toBeDefined();
  });

  it("shows fractional actual duration, not the requested timeout", () => {
    render(
      <CodexNativeItemBlock
        item={{
          type: "codex_native_item",
          id: "wait-1",
          lifecycle: "completed",
          sourceMessages: [],
          threadItem: {
            type: "agentWait",
            id: "wait-1",
            status: "completed",
            outcome: "message",
            startedAt: "2026-10-08T03:24:02.018Z",
            completedAt: "2026-10-08T03:24:03.806Z",
            timeout_ms: 60_000,
          },
        }}
      />,
    );
    expect(screen.getByText("Waited 1.8s")).toBeDefined();
    expect(screen.queryByText(/60/)).toBeNull();
  });

  it.each([
    ["completed", "timeout", "Wait timed out"],
    ["completed", "user_input", "Wait ended by new input"],
    ["interrupted", "user_input", "Wait ended by new input"],
    ["completed", "unknown", "Wait finished"],
    ["interrupted", undefined, "Wait interrupted"],
    ["failed", undefined, "Wait failed"],
  ])(
    "describes %s/%s without claiming the subtask finished",
    (status, outcome, label) => {
      render(
        <CodexAgentWaitBlock
          status={status}
          outcome={outcome}
          durationMs={600}
        />,
      );
      expect(screen.getByRole("status").textContent).toBe(label);
      expect(screen.getByText("Waited 0.6s")).toBeDefined();
      expect(screen.queryByText("Turn finished")).toBeNull();
    },
  );

  it("does not invent elapsed time for old records without timing", () => {
    const { container } = render(
      <CodexAgentWaitBlock status="completed" startedAt="invalid" />,
    );
    expect(screen.getByText("Duration not recorded")).toBeDefined();
    expect(container.querySelector(".codex-agent-wait-spinner")).toBeNull();
  });

  it("localizes completed wait text", async () => {
    localStorage.setItem("yep-anywhere-locale", "zh-CN");
    render(
      <I18nProvider>
        <CodexAgentWaitBlock
          status="completed"
          durationMs={1788}
          outcome="message"
        />
      </I18nProvider>,
    );
    expect(await screen.findByText("已收到协作更新")).toBeDefined();
    expect(screen.getByText("已等待 1.8s")).toBeDefined();
  });
});
