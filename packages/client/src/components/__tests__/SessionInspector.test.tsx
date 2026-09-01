import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { SessionQuestion } from "@yep-anywhere/shared";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import type { Message, ProviderName } from "../../types";
import { SessionInspector } from "../SessionInspector";

vi.mock("../../hooks/useGitStatus", () => ({
  useGitStatus: () => ({
    gitStatus: {
      isGitRepo: true,
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      isClean: true,
      files: [],
    },
    loading: false,
    error: null,
  }),
}));

function renderInspector(
  provider: ProviderName,
  messages: Message[],
  userQuestions?: SessionQuestion[],
  onClose?: () => void,
) {
  window.localStorage.setItem(UI_KEYS.locale, "en");
  return render(
    <MemoryRouter>
      <I18nProvider>
        <SessionInspector
          presentation="sidebar"
          onClose={onClose}
          messages={messages}
          userQuestions={userQuestions}
          projectId="project-1"
          sessionId="session-1"
          provider={provider}
          status={{ owner: "none" }}
          onSelectMessage={vi.fn()}
        />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("SessionInspector", () => {
  it("indexes every file in a multi-file Codex Edit and separates external files with the same name", () => {
    const first = "/tmp/one/api_request.py";
    const second = "/tmp/two/api_request.py";
    const messages: Message[] = [
      {
        uuid: "multi-edit",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "edit-1",
              name: "Edit",
              input: {
                changes: [
                  { path: first, kind: "add", diff: "import json" },
                  { path: second, kind: "add", diff: "import os" },
                  { path: "src/main.ts", kind: "update", diff: "+safe" },
                ],
              },
            },
          ],
        },
      },
      {
        uuid: "repeat-edit",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "edit-2",
              name: "Edit",
              input: {
                file_path: first,
                changes: [{ path: first, kind: "update", diff: "+safe" }],
              },
            },
          ],
        },
      },
    ];
    renderInspector("codex", messages);
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    const firstFile = screen.getByTitle(first);
    expect(firstFile.textContent).toContain("Edit - 2");
    expect(screen.getByTitle(second).textContent).toContain("Modified - Edit");
    expect(screen.getByTitle(second).textContent).not.toContain("Edit - 2");
    expect(screen.getByTitle("src/main.ts")).toBeDefined();
    expect(screen.queryByText("[path hidden]")).toBeNull();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(UI_KEYS.locale);
  });

  it("offers a collapse control for the desktop sidebar", () => {
    const onClose = vi.fn();
    renderInspector("claude", [], undefined, onClose);

    const collapseButton = screen.getByRole("button", {
      name: "Collapse session outline",
    });
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(collapseButton);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("loads the complete session index as soon as the inspector is visible", async () => {
    const onLoadLegacyDetails = vi.fn();
    window.localStorage.setItem(UI_KEYS.locale, "en");
    render(
      <MemoryRouter>
        <I18nProvider>
          <SessionInspector
            presentation="sidebar"
            messages={[]}
            userQuestions={[
              { id: "user-1", text: "Question", turnId: "turn:user-1" },
            ]}
            questionCoverage="complete"
            hasLegacyDetails={false}
            onLoadLegacyDetails={onLoadLegacyDetails}
            projectId="project-1"
            sessionId="session-1"
            provider="codex"
            status={{ owner: "none" }}
            onSelectMessage={vi.fn()}
          />
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText("Question")).not.toBeNull();
    await waitFor(() => expect(onLoadLegacyDetails).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByText("Load files, checks, plan, and sub-agent details"),
    ).toBeNull();
  });

  it("waits for the mobile inspector drawer to open before loading its index", async () => {
    const onLoadLegacyDetails = vi.fn();
    window.localStorage.setItem(UI_KEYS.locale, "en");
    const { rerender } = render(
      <MemoryRouter>
        <I18nProvider>
          <SessionInspector
            presentation="drawer"
            isOpen={false}
            messages={[]}
            hasLegacyDetails={false}
            onLoadLegacyDetails={onLoadLegacyDetails}
            projectId="project-1"
            sessionId="session-1"
            provider="codex"
            status={{ owner: "none" }}
            onSelectMessage={vi.fn()}
          />
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(onLoadLegacyDetails).not.toHaveBeenCalled();
    rerender(
      <MemoryRouter>
        <I18nProvider>
          <SessionInspector
            presentation="drawer"
            isOpen
            messages={[]}
            hasLegacyDetails={false}
            onLoadLegacyDetails={onLoadLegacyDetails}
            projectId="project-1"
            sessionId="session-1"
            provider="codex"
            status={{ owner: "none" }}
            onSelectMessage={vi.fn()}
          />
        </I18nProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(onLoadLegacyDetails).toHaveBeenCalledTimes(1));
  });

  it("offers an explicit retry only after automatic index loading fails", () => {
    const onLoadLegacyDetails = vi.fn();
    window.localStorage.setItem(UI_KEYS.locale, "en");
    render(
      <MemoryRouter>
        <I18nProvider>
          <SessionInspector
            presentation="sidebar"
            messages={[]}
            hasLegacyDetails={false}
            legacyDetailsError
            onLoadLegacyDetails={onLoadLegacyDetails}
            projectId="project-1"
            sessionId="session-1"
            provider="codex"
            status={{ owner: "none" }}
            onSelectMessage={vi.fn()}
          />
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(onLoadLegacyDetails).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Session index failed to load. Retry",
      }),
    );
    expect(onLoadLegacyDetails).toHaveBeenCalledTimes(1);
  });

  it("keeps the current project branch visible when the working tree is clean", () => {
    renderInspector("claude", []);
    fireEvent.click(screen.getByRole("tab", { name: "Git" }));

    expect(screen.getByText("Current project state")).not.toBeNull();
    expect(screen.getByText("main")).not.toBeNull();
    expect(screen.getByText("Working tree clean")).not.toBeNull();
  });

  it("shows Codex channel metadata for Codex sessions", () => {
    renderInspector("codex", [
      {
        uuid: "msg-1",
        type: "assistant",
        codexMessagePhase: "commentary",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I am checking the repo." }],
        },
      },
      {
        uuid: "msg-2",
        type: "assistant",
        codexMessagePhase: "commentary",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Still checking." }],
        },
      },
      {
        uuid: "msg-3",
        type: "assistant",
        codexMessagePhase: "final_answer",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
        },
      },
    ]);

    expect(screen.getByLabelText("Channels")).not.toBeNull();
    expect(screen.getByText("Commentary")).not.toBeNull();
    expect(screen.getByText("Final")).not.toBeNull();
    expect(screen.getByText("2 messages")).not.toBeNull();
    expect(screen.getByText("1 messages")).not.toBeNull();
    expect(screen.queryByText("I am checking the repo.")).toBeNull();
    expect(screen.queryByText("Done.")).toBeNull();
  });

  it("uses a native Codex turn plan in the inspector", () => {
    renderInspector("codex", [
      {
        id: "native-turn-plan",
        type: "system",
        subtype: "codex_native_item",
        codexThreadItemLifecycle: "completed",
        codexThreadItem: {
          type: "turnPlan",
          steps: [
            { step: "Inspect duplicate rows", status: "completed" },
            { step: "Fix plan rendering", status: "in_progress" },
          ],
          explanation: "Keep the checklist in the session outline.",
        },
      },
    ]);

    expect(screen.getByText("Plan")).not.toBeNull();
    expect(screen.getByText("1/2 complete")).not.toBeNull();
    expect(screen.getByText("Inspect duplicate rows")).not.toBeNull();
    expect(screen.getByText("Fix plan rendering")).not.toBeNull();
    expect(
      screen.getByText("Keep the checklist in the session outline."),
    ).not.toBeNull();
  });

  it("shows the authoritative Codex goal instead of deriving it from the user prompt", () => {
    const { container } = renderInspector("codex", [
      {
        uuid: "original-user-prompt",
        type: "user",
        message: {
          role: "user",
          content: "Original broad request from the user",
        },
      },
      {
        id: "current-thread-goal",
        type: "system",
        subtype: "codex_native_item",
        codexThreadItemLifecycle: "completed",
        codexThreadItem: {
          type: "threadGoal",
          objective: "Authoritative persisted goal objective",
          status: "active",
          tokenBudget: 100_000,
          tokensUsed: 12_500,
          timeUsedSeconds: 90,
        },
      },
    ]);

    expect(
      container.querySelector(".codex-native-goal-objective")?.textContent,
    ).toBe("Authoritative persisted goal objective");
    expect(screen.getByText("Active")).not.toBeNull();
    expect(screen.getByText("Tokens: 12.5K / 100.0K")).not.toBeNull();
    expect(screen.getByText("Time: 1m 30s")).not.toBeNull();
  });

  it("uses a persisted Kimi TodoList write in the inspector", () => {
    renderInspector("kimi", [
      {
        id: "kimi-todo-message",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "kimi-todo-1",
              name: "TodoList",
              input: {
                todos: [
                  { title: "Inspect duplicate rows", status: "done" },
                  { title: "Fix Kimi plan rendering", status: "in_progress" },
                ],
              },
            },
          ],
        },
      },
    ]);

    expect(screen.getByText("Plan")).not.toBeNull();
    expect(screen.getByText("1/2 complete")).not.toBeNull();
    expect(screen.getByText("Inspect duplicate rows")).not.toBeNull();
    expect(screen.getByText("Fix Kimi plan rendering")).not.toBeNull();
  });

  it("uses lowercase Codex activity kinds and the latest subagent state", () => {
    renderInspector("codex", [
      {
        uuid: "activity-started",
        type: "system",
        subtype: "codex_native_item",
        codexThreadItemLifecycle: "completed",
        codexThreadItem: {
          type: "subAgentActivity",
          id: "activity-1",
          kind: "started",
          agentThreadId: "child-thread",
          agentPath: "/root/worker",
        },
      },
      {
        uuid: "activity-interrupted",
        type: "system",
        subtype: "codex_native_item",
        codexThreadItemLifecycle: "completed",
        codexThreadItem: {
          type: "subAgentActivity",
          id: "activity-2",
          kind: "interrupted",
          agentThreadId: "child-thread",
          agentPath: "/root/worker",
        },
      },
    ]);

    const link = screen.getByRole("link", { name: /\/root\/worker/i });
    expect(link.getAttribute("href")).toBe(
      "/projects/project-1/sessions/child-thread",
    );
    expect(link.textContent).toContain("interrupted");
    expect(
      screen.getAllByRole("link", { name: /\/root\/worker/i }),
    ).toHaveLength(1);
  });

  it("lists Codex collab states that only contain status and message", () => {
    renderInspector("codex", [
      {
        uuid: "collab-spawn",
        type: "system",
        subtype: "codex_native_item",
        codexThreadItemLifecycle: "completed",
        codexThreadItem: {
          type: "collabAgentToolCall",
          id: "collab-1",
          tool: "spawnAgent",
          agentsStates: {
            "child-status-only": {
              status: "completed",
              message: "Finished review",
            },
          },
        },
      },
      {
        uuid: "collab-wait",
        type: "system",
        subtype: "codex_native_item",
        codexThreadItemLifecycle: "completed",
        codexThreadItem: {
          type: "collabAgentToolCall",
          id: "collab-2",
          tool: "wait",
          agentsStates: {
            "child-status-only": {
              status: "failed",
              message: "Review failed",
            },
          },
        },
      },
    ]);

    const link = screen.getByRole("link", { name: /child-status-only/i });
    expect(link.getAttribute("href")).toBe(
      "/projects/project-1/sessions/child-status-only",
    );
    expect(link.textContent).toContain("failed");
    expect(link.textContent).not.toContain("completed");
  });

  it("does not show Codex channel metadata for Claude sessions", () => {
    renderInspector("claude", [
      {
        uuid: "msg-1",
        type: "assistant",
        codexMessagePhase: "commentary",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Claude text" }],
        },
      },
    ]);

    expect(screen.queryByLabelText("Channels")).toBeNull();
    expect(screen.queryByText("Commentary")).toBeNull();
  });

  it("shows backend user questions when the current message window is empty", () => {
    renderInspector(
      "claude",
      [],
      [
        {
          id: "question-1",
          text: "Earlier prompt from the raw session file",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
    );

    expect(
      screen.getByText("Earlier prompt from the raw session file"),
    ).not.toBeNull();
  });

  it("merges display and live questions by stable Codex identity", () => {
    renderInspector(
      "codex",
      [
        {
          uuid: "live-question",
          type: "user",
          clientUserMessageId: "client-question-1",
          codexCorrelationKey: "codex:user-message:client-question-1",
          timestamp: "2026-09-01T11:47:39.535Z",
          message: { role: "user", content: "Same prompt" },
        },
      ],
      [
        {
          id: "persisted-question",
          clientUserMessageId: "client-question-1",
          codexCorrelationKey: "codex:user-message:client-question-1",
          text: "Same prompt",
          timestamp: "2026-09-01T11:47:42.595Z",
        },
      ],
    );

    expect(screen.getAllByText("Same prompt")).toHaveLength(1);
  });

  it("shows all backend user questions instead of only the latest ones", () => {
    const userQuestions = Array.from({ length: 13 }, (_, index) => ({
      id: `question-${index + 1}`,
      text: `Backend prompt ${index + 1}`,
      timestamp: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
    }));

    renderInspector("claude", [], userQuestions);

    expect(screen.getByText("Backend prompt 1")).not.toBeNull();
    expect(screen.getByText("Backend prompt 13")).not.toBeNull();
  });
});
