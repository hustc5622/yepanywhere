import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { Message } from "../../types";
import type { RenderItem } from "../../types/renderItems";
import { RenderItemComponent } from "../RenderItemComponent";

function promptItem(message: Message): RenderItem {
  return {
    id: `prompt-${message.uuid}`,
    type: "user_prompt",
    content: message.message?.content ?? "prompt",
    sourceMessages: [message],
  };
}

function renderPrompt(
  message: Message,
  provider: string,
  onEditUserPrompt = vi.fn(),
) {
  render(
    <I18nProvider>
      <RenderItemComponent
        item={promptItem(message)}
        isStreaming={false}
        thinkingExpanded={false}
        toggleThinkingExpanded={() => {}}
        sessionProvider={provider}
        onEditUserPrompt={onEditUserPrompt}
      />
    </I18nProvider>,
  );
  return onEditUserPrompt;
}

function renderItem(item: RenderItem) {
  return render(
    <I18nProvider>
      <RenderItemComponent
        item={item}
        isStreaming={false}
        thinkingExpanded={false}
        toggleThinkingExpanded={() => {}}
      />
    </I18nProvider>,
  );
}

describe("RenderItemComponent edit availability", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("does not accidentally expose edit for unsupported providers", () => {
    renderPrompt(
      {
        uuid: "gemini-user",
        type: "user",
        _source: "jsonl",
        message: { role: "user", content: "gemini prompt" },
      },
      "gemini",
    );

    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
  });
});

describe("RenderItemComponent provider-native items", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders status-only Codex collaboration agent states", () => {
    renderItem({
      type: "codex_native_item",
      id: "collab-1",
      lifecycle: "completed",
      threadItem: {
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        agentsStates: {
          "child-thread": {
            status: "completed",
            message: "Review complete",
          },
        },
      },
      sourceMessages: [],
    });

    expect(screen.getAllByText("child-thread").length).toBeGreaterThan(0);
    expect(screen.getByText("completed")).not.toBeNull();
    expect(screen.getByText("Review complete")).not.toBeNull();
  });

  it("renders lowercase Codex subagent activity kinds", () => {
    renderItem({
      type: "codex_native_item",
      id: "activity-1",
      lifecycle: "completed",
      threadItem: {
        type: "subAgentActivity",
        kind: "interrupted",
        agentThreadId: "child-thread",
        agentPath: "/root/worker",
      },
      sourceMessages: [],
    });

    expect(screen.getByText("Interrupted", { exact: false })).not.toBeNull();
    expect(screen.getByText("/root/worker")).not.toBeNull();
  });

  it("localizes Kimi goal copy and keeps zero budgets finite", async () => {
    window.localStorage.setItem("yep-anywhere-locale", "zh-CN");
    const { container } = renderItem({
      type: "system",
      id: "goal-1",
      subtype: "kimi_goal",
      content: "",
      goalSnapshot: {
        goalId: "goal-1",
        objective: "完成审查",
        status: "cleared",
        turnsUsed: 0,
        budgetLimits: { turnBudget: 0 },
        change: "cleared",
      },
      sourceMessages: [],
    });

    expect(
      await screen.findByText("目标已清除", { exact: false }),
    ).not.toBeNull();
    expect(
      container
        .querySelector(".kimi-goal-progress-fill")
        ?.getAttribute("style"),
    ).not.toContain("NaN");
  });
});
