import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SchemaValidationProvider } from "../../../contexts/SchemaValidationContext";
import { SessionMetadataProvider } from "../../../contexts/SessionMetadataContext";
import { ToastProvider } from "../../../contexts/ToastContext";
import { I18nProvider } from "../../../i18n";
import { ToolCallRow } from "../ToolCallRow";

function renderWithToolProviders(ui: React.ReactNode) {
  return render(
    <ToastProvider>
      <SchemaValidationProvider>{ui}</SchemaValidationProvider>
    </ToastProvider>,
  );
}

describe("ToolCallRow", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps pending Codex Bash rows collapsed without IN/OUT preview cards", () => {
    const { container } = renderWithToolProviders(
      <ToolCallRow
        id="tool-1"
        toolName="Bash"
        toolInput={{ command: "npm run test:e2e:pipeline-v2" }}
        status="pending"
        sessionProvider="codex"
      />,
    );

    expect(screen.getByText("Bash")).toBeDefined();
    expect(screen.getByText("npm run test:e2e:pipeline-v2")).toBeDefined();
    expect(container.querySelector(".tool-row-collapsed-preview")).toBeNull();
    expect(container.querySelector(".tool-use-expanded")).toBeNull();
  });

  it("shows PTY-backed read shell rows inline without requiring expansion", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-pty-read"
        toolName="WriteStdin"
        toolInput={{
          session_id: 37863,
          chars: "",
          linked_tool_name: "Read",
          linked_file_path: "packages/client/src/hooks/useGlobalSessions.ts",
        }}
        toolResult={{
          content:
            "Chunk ID: ff710e\nWall time: 0.0518 seconds\nProcess exited with code 0\nOutput:\nline 1\nline 2\n",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(screen.getByText("Shell")).toBeDefined();
    expect(
      screen.getByRole("button", { name: /useGlobalSessions\.ts/i }),
    ).toBeDefined();
    expect(screen.getByText(/2 lines/)).toBeDefined();
    expect(container.querySelector(".expand-chevron")).toBeNull();
  });

  it("keeps generic shell rows expandable when no inline PTY summary applies", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-pty-generic"
        toolName="WriteStdin"
        toolInput={{ session_id: 37863, chars: "" }}
        toolResult={{
          content:
            "Chunk ID: ff710e\nWall time: 0.0518 seconds\nProcess exited with code 0\nOutput:\nline 1\nline 2\n",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(container.querySelector(".expand-chevron")).not.toBeNull();
  });

  it("shows the command and readable output for Codex code-mode exec rows", () => {
    const command =
      'rg -n "deploymentDevServerDescription" packages/client/src/i18n/zh-CN.json';
    const { container } = render(
      <ToolCallRow
        id="tool-code-exec"
        toolName="CodexExec"
        toolInput={{
          script:
            'const result = await tools.exec_command({"cmd":"rg -n \\"deploymentDevServerDescription\\" packages/client/src/i18n/zh-CN.json"});\ntext(result.output);',
        }}
        toolResult={{
          content:
            "Script completed\nWall time 0.2 seconds\nOutput:\npackages/client/src/i18n/zh-CN.json:692: deployment",
          structured: [
            {
              type: "input_text",
              text: "Script completed\nWall time 0.2 seconds\nOutput:\n",
            },
            {
              type: "input_text",
              text: "packages/client/src/i18n/zh-CN.json:692: deployment",
            },
          ],
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    expect(screen.getByText("exec")).toBeDefined();
    expect(screen.getByText(command)).toBeDefined();
    expect(container.querySelector(".expand-chevron")).not.toBeNull();

    const header = container.querySelector(".tool-row-header");
    expect(header).not.toBeNull();
    fireEvent.click(header as HTMLElement);

    expect(screen.getByText("Completed")).toBeDefined();
    expect(screen.getByText("0.2s · 1 operation · 1 line")).toBeDefined();
    expect(
      screen.getByText("packages/client/src/i18n/zh-CN.json:692: deployment"),
    ).toBeDefined();
    expect(container.textContent).not.toContain('"type": "input_text"');
    expect(container.textContent).not.toContain('"text": "Script completed');

    const rawDetails = container.querySelector(".codex-exec-raw-details");
    expect(rawDetails).not.toBeNull();
    expect(rawDetails?.hasAttribute("open")).toBe(false);
  });

  it("labels web__run semantically and highlights queries and returned sources", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-code-web"
        toolName="CodexExec"
        toolInput={{
          script:
            'const r = await tools.web__run({search_query:[{q:"Home Assistant official docs"},{q:"Xiaomi Home integration"}],response_length:"long"});text(JSON.stringify(r));',
        }}
        toolResult={{
          content:
            'Script completed\nWall time 2.5 seconds\nOutput:\n"Home Assistant (https://www.home-assistant.io/)"',
          structured: [
            {
              type: "input_text",
              text: "Script completed\nWall time 2.5 seconds\nOutput:\n",
            },
            {
              type: "input_text",
              text: JSON.stringify(
                "Home Assistant (https://www.home-assistant.io/)",
              ),
            },
          ],
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    expect(screen.getByText("web")).toBeDefined();
    expect(container.textContent).toContain("Search · 2 queries");
    expect(container.textContent).toContain("1 source");

    const header = container.querySelector(".tool-row-header");
    fireEvent.click(header as HTMLElement);

    expect(screen.getByText("Home Assistant official docs")).toBeDefined();
    expect(screen.getByText("Xiaomi Home integration")).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: /Home Assistant/i })
        .getAttribute("href"),
    ).toBe("https://www.home-assistant.io/");
    expect(container.textContent).not.toContain("No text output");
  });

  it("renders wait effects instead of raw JSON", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-wait"
        toolName="wait"
        toolInput={{
          cell_id: "1",
          yield_time_ms: 10000,
          poll_count: 3,
          total_wall_time_seconds: 30,
        }}
        toolResult={{
          content:
            "Script running with cell ID 1\nWall time 10.0 seconds\nOutput:\n",
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    expect(screen.getByText("wait")).toBeDefined();
    expect(container.textContent).toContain("Cell 1 still running");
    expect(container.textContent).toContain("3 polls · 30s");

    const header = container.querySelector(".tool-row-header");
    fireEvent.click(header as HTMLElement);
    expect(container.textContent).toContain("no new output arrived");
    expect(container.textContent).not.toContain('"cell_id"');
  });

  it("does not apply the Codex renderer to another provider's exec tool", () => {
    const { container } = render(
      <ToolCallRow
        id="other-provider-exec"
        toolName="exec"
        toolInput={{ script: "provider-specific input" }}
        status="pending"
        sessionProvider="opencode"
      />,
    );

    const header = container.querySelector(".tool-row-header");
    expect(header).not.toBeNull();
    fireEvent.click(header as HTMLElement);

    expect(container.querySelector(".codex-exec-details")).toBeNull();
    expect(container.querySelector(".tool-fallback")).not.toBeNull();
  });

  it("uses semantic OpenCode shell titles and includes command in details", () => {
    const { container } = renderWithToolProviders(
      <ToolCallRow
        id="oc-bash"
        toolName="bash"
        toolInput={{
          command: "git status --short",
          opencodeTitle: "git status",
        }}
        toolResult={{ content: " M src/app.ts", isError: false }}
        status="complete"
        sessionProvider="opencode"
      />,
    );

    expect(screen.getByText("Ran")).toBeDefined();
    expect(screen.getByText("git status --short")).toBeDefined();
    expect(container.textContent).not.toContain("Bash command");
    fireEvent.click(container.querySelector(".tool-row-header") as HTMLElement);
    expect(screen.getByText("Command")).toBeDefined();
    expect(screen.getByText("M src/app.ts", { exact: false })).toBeDefined();
  });

  it.each([
    ["pending", "Writing"],
    ["error", "Write failed"],
    ["aborted", "Write"],
  ] as const)(
    "uses a status-aware OpenCode write title while %s",
    (status, expectedTitle) => {
      const { container } = renderWithToolProviders(
        <ToolCallRow
          id={`oc-write-${status}`}
          toolName="write"
          toolInput={{ filePath: "src/app.ts", content: "updated" }}
          toolResult={
            status === "error"
              ? { content: "permission denied", isError: true }
              : undefined
          }
          status={status}
          sessionProvider="opencode"
        />,
      );

      expect(container.querySelector(".tool-name")?.textContent).toBe(
        expectedTitle,
      );
    },
  );

  it("does not apply OpenCode status titles to another provider", () => {
    const { container } = renderWithToolProviders(
      <ToolCallRow
        id="codex-write-pending"
        toolName="Write"
        toolInput={{ file_path: "src/app.ts", content: "updated" }}
        status="pending"
        sessionProvider="codex"
      />,
    );

    expect(container.querySelector(".tool-name")?.textContent).toBe("Write");
  });

  it("renders OpenCode skills without exposing the skill_content envelope", () => {
    const { container } = render(
      <ToolCallRow
        id="oc-skill"
        toolName="skill"
        toolInput={{
          name: "git-commit-push",
          opencodeTitle: "git-commit-push",
        }}
        toolResult={{
          content:
            '"<skill_content name=\\"git-commit-push\\">\\n# Skill: git-commit-push\\nReview changes first.\\n</skill_content>"',
          isError: false,
        }}
        status="complete"
        sessionProvider="opencode"
      />,
    );

    expect(screen.getByText("Skill")).toBeDefined();
    expect(screen.getByText("git-commit-push", { exact: false })).toBeDefined();
    fireEvent.click(container.querySelector(".tool-row-header") as HTMLElement);
    expect(screen.getByText("Loaded skill")).toBeDefined();
    expect(container.textContent).not.toContain("<skill_content");
    fireEvent.click(screen.getByText("Instructions"));
    expect(container.textContent).toContain("# Skill: git-commit-push");
  });

  it("renders the OpenCode task tool as a clickable subagent card", () => {
    const { container } = render(
      <MemoryRouter>
        <I18nProvider>
          <SessionMetadataProvider
            projectId="proj-1"
            projectPath={null}
            sessionId="ses_parent"
          >
            <ToolCallRow
              id="toolu_task"
              toolName="task"
              toolInput={{
                description: "Analyze swing middleware",
                prompt: "investigate the swing middleware",
                subagent_type: "explore",
                opencodeMetadata: {
                  sessionId: "ses_child",
                  parentSessionId: "ses_parent",
                },
              }}
              toolResult={{
                content: '<task id="ses_child" state="completed"></task>',
                isError: false,
              }}
              status="complete"
              sessionProvider="opencode"
            />
          </SessionMetadataProvider>
        </I18nProvider>
      </MemoryRouter>,
    );

    // Links to the subagent's own session page instead of expanding a tool row.
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(
      "/projects/proj-1/sessions/ses_child",
    );
    expect(container.textContent).toContain("Analyze swing middleware");
    expect(container.textContent).toContain("explore");
    expect(container.querySelector(".tool-row-header")).toBeNull();
  });

  it("keeps a launched OpenCode background task in the running state", () => {
    const { container } = render(
      <MemoryRouter>
        <I18nProvider>
          <SessionMetadataProvider
            projectId="proj-1"
            projectPath={null}
            sessionId="ses_parent"
          >
            <ToolCallRow
              id="toolu_background_task"
              toolName="task"
              toolInput={{
                description: "Analyze in background",
                subagent_type: "explore",
                opencodeMetadata: {
                  sessionId: "ses_child",
                  parentSessionId: "ses_parent",
                  background: true,
                },
              }}
              toolResult={{
                content: '<task id="ses_child" state="running"></task>',
                isError: false,
              }}
              status="pending"
              sessionProvider="opencode"
            />
          </SessionMetadataProvider>
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(container.textContent).toContain("running");
    expect(container.textContent).not.toContain("completed");
    expect(container.querySelector(".tool-row-header")).toBeNull();
  });

  it("keeps a reconciled terminal task state over the launcher output", () => {
    const { container } = render(
      <MemoryRouter>
        <I18nProvider>
          <SessionMetadataProvider
            projectId="proj-1"
            projectPath={null}
            sessionId="ses_parent"
          >
            <ToolCallRow
              id="toolu_completed_background_task"
              toolName="task"
              toolInput={{
                description: "Analyze in background",
                opencodeMetadata: {
                  sessionId: "ses_child",
                  parentSessionId: "ses_parent",
                  background: true,
                },
              }}
              toolResult={{
                content: '<task id="ses_child" state="running"></task>',
                isError: false,
              }}
              status="complete"
              sessionProvider="opencode"
            />
          </SessionMetadataProvider>
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(container.textContent).toContain("completed");
    expect(container.textContent).not.toContain("running");
  });

  it("keeps failed OpenCode task details expandable without a child link", () => {
    const { container } = render(
      <MemoryRouter>
        <I18nProvider>
          <ToolCallRow
            id="toolu_failed_task"
            toolName="task"
            toolInput={{
              description: "Launch missing agent",
              subagent_type: "missing-agent",
            }}
            toolResult={{
              content: "Unknown agent type: missing-agent is not valid",
              isError: true,
            }}
            status="error"
            sessionProvider="opencode"
          />
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(container.querySelector(".tool-row-header")).not.toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.textContent).not.toContain("Unknown agent type");

    fireEvent.click(container.querySelector(".tool-row-header") as HTMLElement);

    expect(container.textContent).toContain(
      "Unknown agent type: missing-agent is not valid",
    );
    expect(container.querySelector(".tool-fallback-error")).not.toBeNull();
  });

  it("renders failed OpenCode skills as errors, not loaded instructions", () => {
    const { container } = render(
      <ToolCallRow
        id="oc-skill-error"
        toolName="skill"
        toolInput={{ name: "missing-skill" }}
        toolResult={{ content: "Skill not found", isError: true }}
        status="error"
        sessionProvider="opencode"
      />,
    );

    expect(container.querySelector(".tool-name")?.textContent).toBe(
      "Skill failed",
    );
    fireEvent.click(container.querySelector(".tool-row-header") as HTMLElement);
    expect(screen.getByText("Failed skill")).toBeDefined();
    expect(screen.getByText("Error details")).toBeDefined();
    expect(screen.queryByText("Loaded skill")).toBeNull();
    expect(screen.queryByText("Instructions")).toBeNull();
    fireEvent.click(screen.getByText("Error details"));
    expect(container.textContent).toContain("Skill not found");
  });
});
