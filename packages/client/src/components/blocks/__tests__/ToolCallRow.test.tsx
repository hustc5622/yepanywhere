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
});
