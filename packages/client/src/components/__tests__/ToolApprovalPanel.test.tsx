import {
  cleanup,
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

describe("ToolApprovalPanel", () => {
  afterEach(() => cleanup());

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

  it("offers OpenCode's always approval when the bridge advertises it", async () => {
    const onApproveAlways = vi.fn(async () => undefined);
    const request: InputRequest = {
      id: "approval-opencode",
      sessionId: "session-opencode",
      type: "tool-approval",
      prompt: "Allow external_directory /tmp/*?",
      toolName: "OpenCode",
      toolInput: {
        approvalKind: "opencode_permission",
        availableDecisions: ["once", "always", "reject"],
        permission: "external_directory",
        patterns: ["/tmp/*"],
        persistentPatterns: ["/tmp/*"],
      },
      timestamp: "2026-07-17T00:00:00.000Z",
    };
    render(
      <I18nProvider>
        <ToolApprovalPanel
          request={request}
          sessionId="session-opencode"
          onApprove={vi.fn(async () => undefined)}
          onApproveAlways={onApproveAlways}
          onDeny={vi.fn(async () => undefined)}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("button", { name: /^1\s*Allow$/i })).toBeTruthy();
    const alwaysApproval = screen.getByRole("button", {
      name: /Always allow/i,
    });
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeTruthy();
    await waitFor(() =>
      expect((alwaysApproval as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(alwaysApproval);
    await waitFor(() => expect(onApproveAlways).toHaveBeenCalledTimes(1));
  });
});
