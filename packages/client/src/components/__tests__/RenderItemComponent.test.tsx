import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { mergeStreamMessage } from "../../lib/mergeMessages";
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

describe("RenderItemComponent pending input", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("keeps the same bubble while a steered prompt becomes adopted", () => {
    const pending: Message = {
      uuid: "client-steer",
      type: "user",
      _source: "sdk",
      isOptimistic: true,
      codexTurnId: "active-turn",
      message: { role: "user", content: "Please check the latest source" },
    };
    const view = (message: Message) => (
      <I18nProvider>
        <RenderItemComponent
          item={promptItem(message)}
          isStreaming={false}
          thinkingExpanded={false}
          toggleThinkingExpanded={() => {}}
          sessionProvider="codex"
        />
      </I18nProvider>
    );
    const { container, rerender } = render(view(pending));
    const bubble = container.querySelector(".message-user-prompt");
    expect(bubble?.closest(".user-prompt-awaiting")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Waiting to be picked up",
    );
    expect(screen.getByRole("button", { name: "Copy message" })).toBeDefined();

    const adopted = mergeStreamMessage([pending], {
      ...pending,
      isOptimistic: false,
    }).messages[0];
    if (!adopted) throw new Error("Missing adopted prompt");
    rerender(view(adopted));
    expect(container.querySelector(".message-user-prompt")).toBe(bubble);
    expect(container.querySelector(".user-prompt-awaiting")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows pending status for image-only messages in Chinese", async () => {
    window.localStorage.setItem("yep-anywhere-locale", "zh-CN");
    renderPrompt(
      {
        uuid: "image-steer",
        type: "user",
        isOptimistic: true,
        message: {
          role: "user",
          content: [
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ],
        },
      },
      "codex",
    );
    expect(await screen.findByText("等待采用")).toBeDefined();
    expect(
      document.querySelector(".user-prompt-awaiting .uploaded-file"),
    ).not.toBeNull();
  });

  it("treats a persisted prompt as adopted even with a stale optimistic flag", () => {
    renderPrompt(
      {
        uuid: "persisted-user",
        type: "user",
        _source: "jsonl",
        isOptimistic: true,
        message: { role: "user", content: "Already in history" },
      },
      "codex",
    );
    expect(screen.queryByRole("status")).toBeNull();
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
