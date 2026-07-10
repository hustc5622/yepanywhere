import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolCallRow } from "../ToolCallRow";

describe("ToolCallRow", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps pending Codex Bash rows collapsed without IN/OUT preview cards", () => {
    const { container } = render(
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
});
