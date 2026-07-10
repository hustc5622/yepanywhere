import { describe, expect, it } from "vitest";
import { getToolSummary } from "../summaries";

describe("getToolSummary", () => {
  it("prefers linked file name for write_stdin summaries", () => {
    const summary = getToolSummary(
      "WriteStdin",
      {
        session_id: 37863,
        chars: "",
        linked_file_path: "packages/client/src/hooks/useGlobalSessions.ts",
        linked_tool_name: "Read",
        linked_command:
          "sed -n '1,260p' packages/client/src/hooks/useGlobalSessions.ts",
      },
      {
        content:
          'Chunk ID: 6dceb3\nWall time: 0.0522 seconds\nProcess exited with code 0\nOutput:\nimport { useCallback } from "react";\n',
        isError: false,
      },
      "complete",
    );

    expect(summary).toBe(
      "Read via PTY: useGlobalSessions.ts → exit 0 in 0.0522 seconds",
    );
  });

  it("uses raw write_stdin content when structured result is absent", () => {
    const summary = getToolSummary(
      "WriteStdin",
      {
        session_id: 70073,
        chars: "",
        linked_command:
          "sed -n '1,140p' packages/client/src/layouts/NavigationLayout.tsx",
      },
      {
        content:
          'Chunk ID: fefaef\nWall time: 0.0520 seconds\nProcess exited with code 0\nOutput:\nimport { useEffect } from "react";\n',
        isError: false,
      },
      "complete",
    );

    expect(summary).toBe(
      "sed -n '1,140p' packages/client/src/layouts/NavigationLayout.tsx → exit 0 in 0.0520 seconds",
    );
  });

  it("includes linked command for completed write_stdin rows with no output", () => {
    const summary = getToolSummary(
      "WriteStdin",
      {
        session_id: 70073,
        chars: "",
        linked_command:
          "sed -n '1,140p' packages/client/src/layouts/NavigationLayout.tsx",
      },
      {
        content:
          "Chunk ID: d73b4e\nWall time: 1.0001 seconds\nProcess running with session ID 70073\nOutput:\n",
        isError: false,
      },
      "complete",
    );

    expect(summary).toBe(
      "sed -n '1,140p' packages/client/src/layouts/NavigationLayout.tsx → No output",
    );
  });

  it("keeps OpenCode command context visible after bash completes", () => {
    const summary = getToolSummary(
      "bash",
      {
        command: 'rg -n "opencode" packages/client/src',
        opencodeTitle: 'rg -n "opencode" packages/client/src',
      },
      {
        content: "packages/client/src/pages/SessionPage.tsx:107:OpenCode",
        isError: false,
      },
      "complete",
      { provider: "opencode" },
    );

    expect(summary).toBe('rg -n "opencode" packages/client/src');
  });

  it("prefers OpenCode bash command over generic title", () => {
    const summary = getToolSummary(
      "Bash",
      {
        command: "pnpm test -- --runInBand",
        opencodeTitle: "bash",
      },
      {
        content: "ok",
        isError: false,
      },
      "complete",
      { provider: "opencode" },
    );

    expect(summary).toBe("pnpm test -- --runInBand");
  });

  it("shows OpenCode read target instead of generic done", () => {
    const summary = getToolSummary(
      "read",
      {
        filePath: "/repo/packages/client/src/components/blocks/ToolCallRow.tsx",
      },
      {
        content: "file contents",
        isError: false,
      },
      "complete",
      { provider: "opencode" },
    );

    expect(summary).toBe(
      "/repo/packages/client/src/components/blocks/ToolCallRow.tsx → ToolCallRow.tsx",
    );
  });

  it("keeps the Codex code-mode exec command overview after completion", () => {
    const summary = getToolSummary(
      "CodexExec",
      {
        script:
          'const result = await tools.exec_command({"cmd": "pnpm lint"});',
      },
      { content: "Script completed", isError: false },
      "complete",
      { provider: "codex" },
    );

    expect(summary).toBe("pnpm lint");
  });
});
