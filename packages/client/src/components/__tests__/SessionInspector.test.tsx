import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AppSessionSummary, SessionQuestion } from "@yep-anywhere/shared";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import type { Message, ProviderName } from "../../types";
import { SessionInspector } from "../SessionInspector";

vi.mock("../../hooks/useGitStatus", () => ({
  useGitStatus: () => ({
    gitStatus: { isGitRepo: true, isClean: true, files: [] },
    loading: false,
    error: null,
  }),
}));

function renderInspector(
  provider: ProviderName,
  messages: Message[],
  userQuestions?: SessionQuestion[],
  onClose?: () => void,
  subagentThreads?: NonNullable<AppSessionSummary["subagentThreads"]>,
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
          subagentThreads={subagentThreads}
          onSelectMessage={vi.fn()}
        />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("SessionInspector", () => {
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

  it("lists OpenCode subagents with links to their child sessions", () => {
    renderInspector("opencode", [
      {
        uuid: "msg-task",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_task",
              name: "task",
              input: {
                description: "Analyze swing middleware",
                subagent_type: "explore",
              },
              opencodeMetadata: {
                sessionId: "ses_child",
                parentSessionId: "ses_parent",
              },
              opencodeStatus: "completed",
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_task",
              content: '<task id="ses_child" state="completed"></task>',
            },
          ],
        },
      },
    ]);

    const link = screen.getByRole("link", {
      name: /Analyze swing middleware/i,
    });
    expect(link.getAttribute("href")).toBe(
      "/projects/project-1/sessions/ses_child",
    );
    expect(link.closest(".session-inspector-content")).not.toBeNull();
    expect(screen.getByText("explore", { exact: false })).not.toBeNull();
  });

  it("uses the latest persisted state for an OpenCode background subagent", () => {
    renderInspector("opencode", [
      {
        uuid: "msg-task",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_task",
              name: "task",
              input: {
                description: "Analyze in background",
                subagent_type: "explore",
              },
              opencodeMetadata: {
                sessionId: "ses_child",
                parentSessionId: "session-1",
                background: true,
              },
              opencodeStatus: "completed",
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_task",
              content: '<task id="ses_child" state="running"></task>',
            },
          ],
        },
      },
      {
        uuid: "msg-complete",
        type: "user",
        content: '<task id="ses_child" state="completed"></task>',
      },
    ]);

    const link = screen.getByRole("link", { name: /Analyze in background/i });
    expect(link.textContent).toContain("completed");
    expect(link.textContent).not.toContain("running");
  });

  it("renders persisted Codex descendants as a navigable tree with canonical status", () => {
    renderInspector(
      "codex",
      [
        {
          uuid: "spawn-child",
          type: "system",
          codexThreadId: "session-1",
          codexThreadItemLifecycle: "completed",
          codexThreadItem: {
            type: "collabAgentToolCall",
            id: "spawn-child",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "session-1",
            receiverThreadIds: ["child-one"],
            prompt: "must-not-leak child prompt",
            agentsStates: {
              "child-one": {
                status: "running",
                message: "must-not-leak agent result",
              },
            },
          },
        },
        {
          uuid: "nested-started",
          type: "system",
          codexThreadId: "child-one",
          codexThreadItemLifecycle: "completed",
          codexThreadItem: {
            type: "subAgentActivity",
            id: "nested-started",
            kind: "started",
            agentThreadId: "child-two",
            agentPath: "/test-fixtures/codex/agents/must-not-leak",
          },
        },
      ],
      undefined,
      undefined,
      [
        {
          sessionId: "child-one",
          parentSessionId: "session-1",
          depth: 1,
          agentNickname: "Scout",
          agentRole: "explorer",
        },
        {
          sessionId: "child-two",
          parentSessionId: "child-one",
          depth: 2,
          agentNickname: "Builder",
          agentRole: "worker",
        },
      ],
    );

    const scoutLink = screen.getByRole("link", { name: /Scout/i });
    const builderLink = screen.getByRole("link", { name: /Builder/i });
    expect(scoutLink.getAttribute("href")).toBe(
      "/projects/project-1/sessions/child-one",
    );
    expect(builderLink.getAttribute("href")).toBe(
      "/projects/project-1/sessions/child-two",
    );
    expect(scoutLink.textContent).toContain("explorer");
    expect(scoutLink.textContent).toContain("running");
    expect(builderLink.closest("li")?.getAttribute("data-depth")).toBe("2");
    expect(
      screen.queryByText("must-not-leak child prompt", { exact: false }),
    ).toBeNull();
    expect(
      screen.queryByText("must-not-leak agent result", { exact: false }),
    ).toBeNull();
    expect(screen.queryByText("must-not-leak", { exact: false })).toBeNull();
  });

  it("shows canonical-only Codex children without creating a session link", () => {
    renderInspector("codex", [
      {
        uuid: "spawn-live-only",
        type: "system",
        codexThreadId: "session-1",
        codexThreadItemLifecycle: "completed",
        codexThreadItem: {
          type: "collabAgentToolCall",
          id: "spawn-live-only",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "session-1",
          receiverThreadIds: ["child-live-only"],
          prompt: "must-not-display live prompt",
          agentsStates: {
            "child-live-only": { status: "pendingInit" },
          },
        },
      },
    ]);

    expect(screen.getByText("child-live-only")).not.toBeNull();
    expect(
      screen.getByText("Transcript not available yet", { exact: false }),
    ).not.toBeNull();
    expect(screen.queryByRole("link", { name: /child-live-only/i })).toBeNull();
    expect(
      screen.queryByText("must-not-display live prompt", { exact: false }),
    ).toBeNull();
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
