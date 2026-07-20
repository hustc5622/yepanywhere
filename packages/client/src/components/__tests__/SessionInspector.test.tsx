import { cleanup, render, screen } from "@testing-library/react";
import type { SessionQuestion } from "@yep-anywhere/shared";
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
) {
  window.localStorage.setItem(UI_KEYS.locale, "en");
  return render(
    <MemoryRouter>
      <I18nProvider>
        <SessionInspector
          presentation="sidebar"
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
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(UI_KEYS.locale);
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
