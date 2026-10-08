import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { InputRequest } from "../../types";
import { ToolApprovalPanel } from "../ToolApprovalPanel";

function renderPanel(actionUrl: string) {
  const request: InputRequest = {
    id: "approval-url",
    sessionId: "session-url",
    type: "tool-approval",
    prompt: "Sign in to continue",
    toolName: "MCP",
    toolInput: {
      approvalKind: "mcp_url_action",
      approvalPrompt: "Sign in to continue",
      actionUrl,
      actionLabel: "Open required page",
    },
    timestamp: "2026-07-15T00:00:00.000Z",
  };
  return render(
    <I18nProvider>
      <ToolApprovalPanel
        request={request}
        sessionId="session-url"
        onApprove={vi.fn(async () => undefined)}
        onDeny={vi.fn(async () => undefined)}
      />
    </I18nProvider>,
  );
}

async function renderKeyboardPanel(feedback?: string) {
  localStorage.removeItem(
    "draft-tool-prompt-session-shortcuts-toolApprovalFeedback",
  );
  if (feedback) {
    localStorage.setItem(
      "draft-tool-prompt-session-shortcuts-toolApprovalFeedback",
      feedback,
    );
  }
  const onApprove = vi.fn(async () => undefined);
  const onDeny = vi.fn(async () => undefined);
  const onDenyWithFeedback = vi.fn(async (_feedback: string) => undefined);
  render(
    <I18nProvider>
      <ToolApprovalPanel
        request={{
          id: "approval-shortcuts",
          sessionId: "session-shortcuts",
          type: "tool-approval",
          prompt: "Run command?",
          toolName: "Bash",
          toolInput: { command: "pwd" },
          timestamp: "2026-10-08T00:00:00.000Z",
        }}
        sessionId="session-shortcuts"
        onApprove={onApprove}
        onDeny={onDeny}
        onDenyWithFeedback={onDenyWithFeedback}
      />
      <input aria-label="Other input" />
      <textarea aria-label="Other draft" />
      <div contentEditable suppressContentEditableWarning>
        <span data-testid="historical-editor">Editing a historical prompt</span>
      </div>
    </I18nProvider>,
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: /^1.*Yes/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  return { onApprove, onDeny, onDenyWithFeedback };
}

describe("ToolApprovalPanel", () => {
  afterEach(() => cleanup());

  it("does not approve or deny while typing in another editor", async () => {
    const { onApprove, onDeny } = await renderKeyboardPanel();
    for (const target of [
      screen.getByRole("textbox", { name: "Other input" }),
      screen.getByRole("textbox", { name: "Other draft" }),
      screen.getByTestId("historical-editor"),
    ]) {
      for (const key of ["1", "2", "3", "Enter", "Escape"]) {
        const event = createEvent.keyDown(target, { key });
        fireEvent(target, event);
        expect(event.defaultPrevented).toBe(false);
      }
    }
    expect(onApprove).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "1" });
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
  });

  it("ignores handled keys and IME confirmation before applying approval shortcuts", async () => {
    const { onApprove, onDeny } = await renderKeyboardPanel();
    const handled = createEvent.keyDown(window, { key: "Enter" });
    handled.preventDefault();
    fireEvent(window, handled);
    fireEvent.keyDown(window, { key: "Enter", isComposing: true });
    fireEvent.keyDown(window, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    expect(onApprove).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("keeps feedback Enter local to the panel and waits for IME to finish", async () => {
    const { onApprove, onDenyWithFeedback } =
      await renderKeyboardPanel("请调整命令");
    const feedback = screen.getByDisplayValue("请调整命令");
    fireEvent.keyDown(screen.getByTestId("historical-editor"), {
      key: "Enter",
    });
    fireEvent.keyDown(feedback, { key: "Enter", isComposing: true });
    fireEvent.keyDown(feedback, { key: "Enter", keyCode: 229 });
    expect(onDenyWithFeedback).not.toHaveBeenCalled();
    expect(onApprove).not.toHaveBeenCalled();

    fireEvent.keyDown(feedback, { key: "Enter" });
    await waitFor(() =>
      expect(onDenyWithFeedback).toHaveBeenCalledWith("请调整命令"),
    );
  });

  it("renders safe MCP URL actions as external links", () => {
    renderPanel("https://example.com/sign-in");
    const link = screen.getByRole("link", {
      name: "Open required page",
    });
    expect(link.getAttribute("href")).toBe("https://example.com/sign-in");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("does not render unsafe MCP URL actions", () => {
    renderPanel("file:///tmp/secret");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("approves a Kimi plan without switching its permission mode", async () => {
    const onApprove = vi.fn(async () => undefined);
    const onApproveAcceptEdits = vi.fn(async () => undefined);
    const request: InputRequest = {
      id: "approval-kimi-plan",
      sessionId: "session-kimi-plan",
      type: "tool-approval",
      prompt: "Accept this plan?",
      toolName: "ExitPlanMode",
      toolInput: { kind: "switch_mode", title: "ExitPlanMode" },
      timestamp: "2026-08-14T00:00:00.000Z",
    };
    render(
      <I18nProvider>
        <ToolApprovalPanel
          request={request}
          sessionId="session-kimi-plan"
          onApprove={onApprove}
          onApproveAcceptEdits={onApproveAcceptEdits}
          onDeny={vi.fn(async () => undefined)}
          preserveModeOnPlanApproval
        />
      </I18nProvider>,
    );

    const approve = screen.getByRole("button", {
      name: /Approve and keep current permission mode/i,
    });
    expect(screen.queryByRole("button", { name: /auto-accept/i })).toBeNull();
    await waitFor(() =>
      expect((approve as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(approve);
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApproveAcceptEdits).not.toHaveBeenCalled();
  });

  it("offers every Codex permission decision, including strict review", async () => {
    const onApprove = vi.fn(async () => undefined);
    const onApproveStrictAutoReview = vi.fn(async () => undefined);
    const onApproveForSession = vi.fn(async () => undefined);
    const onDeny = vi.fn(async () => undefined);
    const request: InputRequest = {
      id: "approval-permissions",
      sessionId: "session-permissions",
      type: "tool-approval",
      prompt: "Allow requested permissions?",
      toolName: "Permissions",
      toolInput: { approvalKind: "permissions" },
      timestamp: "2026-07-15T00:00:00.000Z",
    };
    render(
      <I18nProvider>
        <ToolApprovalPanel
          request={request}
          sessionId="session-permissions"
          onApprove={onApprove}
          onApproveStrictAutoReview={onApproveStrictAutoReview}
          onApproveForSession={onApproveForSession}
          onDeny={onDeny}
        />
      </I18nProvider>,
    );

    const strictReview = screen.getByRole("button", {
      name: /strict command review/i,
    });
    expect(
      screen.getByRole("button", { name: /Grant for this turn$/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Grant for this session/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Continue without these permissions/i,
      }),
    ).toBeTruthy();
    await waitFor(() =>
      expect((strictReview as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(strictReview);
    await waitFor(() =>
      expect(onApproveStrictAutoReview).toHaveBeenCalledTimes(1),
    );
  });

  it("uses the Codex session approval instead of accept-edits for file grants", async () => {
    const onApproveAcceptEdits = vi.fn(async () => undefined);
    const onApproveForSession = vi.fn(async () => undefined);
    const request: InputRequest = {
      id: "approval-file",
      sessionId: "session-file",
      type: "tool-approval",
      prompt: "Allow file changes?",
      toolName: "Edit",
      toolInput: { approvalKind: "file_change" },
      timestamp: "2026-07-15T00:00:00.000Z",
    };
    render(
      <I18nProvider>
        <ToolApprovalPanel
          request={request}
          sessionId="session-file"
          onApprove={vi.fn(async () => undefined)}
          onApproveAcceptEdits={onApproveAcceptEdits}
          onApproveForSession={onApproveForSession}
          onDeny={vi.fn(async () => undefined)}
        />
      </I18nProvider>,
    );

    const sessionApproval = screen.getByRole("button", {
      name: /Allow for this session/i,
    });
    await waitFor(() =>
      expect((sessionApproval as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(sessionApproval);
    await waitFor(() => expect(onApproveForSession).toHaveBeenCalledTimes(1));
    expect(onApproveAcceptEdits).not.toHaveBeenCalled();
  });

  it("applies an offered Codex command policy instead of claiming a session grant", async () => {
    const onApproveForSession = vi.fn(async () => undefined);
    const onApproveAlways = vi.fn(async () => undefined);
    const request: InputRequest = {
      id: "approval-command-policy",
      sessionId: "session-command-policy",
      type: "tool-approval",
      prompt: "Allow Bash?",
      toolName: "Bash",
      toolInput: {
        approvalKind: "command_execution",
        command: "git status",
        availableDecisions: [
          "accept",
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["git", "status"],
            },
          },
          "decline",
        ],
      },
      timestamp: "2026-09-04T00:00:00.000Z",
    };
    render(
      <I18nProvider>
        <ToolApprovalPanel
          request={request}
          sessionId="session-command-policy"
          onApprove={vi.fn(async () => undefined)}
          onApproveForSession={onApproveForSession}
          onApproveAlways={onApproveAlways}
          onDeny={vi.fn(async () => undefined)}
        />
      </I18nProvider>,
    );

    expect(
      screen.queryByRole("button", { name: /Allow for this session/i }),
    ).toBeNull();
    const applyPolicy = screen.getByRole("button", {
      name: /Apply command policy/i,
    });
    await waitFor(() =>
      expect((applyPolicy as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(applyPolicy);
    await waitFor(() => expect(onApproveAlways).toHaveBeenCalledTimes(1));
    expect(onApproveForSession).not.toHaveBeenCalled();
  });
});
