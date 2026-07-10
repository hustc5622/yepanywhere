import { describe, expect, it } from "vitest";
import {
  getCodexExecOverview,
  getCodexExecResultOverview,
  getCodexExecSummary,
  shouldParseCodexExecNestedResults,
} from "../codexExec";

describe("Codex exec summaries", () => {
  it("shows the nested shell command for a single exec_command call", () => {
    const summary = getCodexExecSummary({
      script:
        'const result = await tools.exec_command({"cmd": "pnpm --filter @yep-anywhere/client test"});',
    });

    expect(summary).toBe("pnpm --filter @yep-anywhere/client test");
  });

  it("summarizes parallel shell calls without dumping the orchestration script", () => {
    const overview = getCodexExecOverview(`
      const results = await Promise.all([
        tools.exec_command({cmd: "git status --short"}),
        tools.exec_command({cmd: "rg -n \\\"exec_command\\\" packages/client/src"}),
        tools.exec_command({cmd: "pnpm typecheck"})
      ]);
      results.forEach((result) => text(result.output));
    `);

    expect(overview.operationCount).toBe(3);
    expect(overview.commandCount).toBe(3);
    expect(overview.summary).toContain("3 commands");
    expect(overview.summary).toContain("git status --short");
    expect(overview.summary).toContain('rg -n "exec_command"');
    expect(overview.summary).toContain("+1");
  });

  it("names non-shell operations in mixed code-mode scripts", () => {
    const summary = getCodexExecSummary(`
      await tools.update_plan({plan: []});
      const image = await tools.view_image({path: "/tmp/example.png"});
      image(image.image_url);
    `);

    expect(summary).toBe("2 operations · update_plan · view_image");
  });

  it("supports quoted object keys and command strings", () => {
    const overview = getCodexExecOverview(`
      const first = await tools.exec_command({"cmd":"rg -n \\"exec_command\\" packages/client/src"});
      const second = await tools.exec_command({'cmd': 'pnpm lint'});
    `);

    expect(overview.operations).toEqual([
      {
        name: "exec_command",
        command: 'rg -n "exec_command" packages/client/src',
      },
      { name: "exec_command", command: "pnpm lint" },
    ]);
  });

  it("does not assign a later literal command to an earlier dynamic call", () => {
    const overview = getCodexExecOverview(`
      await tools.exec_command({cmd});
      await tools.exec_command({"cmd":"pnpm test"});
    `);

    expect(overview.operations).toEqual([
      { name: "exec_command" },
      { name: "exec_command", command: "pnpm test" },
    ]);
  });

  it("only opts into nested result parsing for explicit result envelopes", () => {
    expect(
      shouldParseCodexExecNestedResults({
        script:
          'const r = await tools.exec_command({"cmd":"check"});\ntext(r.output);',
      }),
    ).toBe(false);
    expect(
      shouldParseCodexExecNestedResults({
        script:
          'const r = await tools.exec_command({"cmd":"check"});\ntext(JSON.stringify({exit_code:r.exit_code, output:r.output}));',
      }),
    ).toBe(true);
  });
});

describe("Codex exec results", () => {
  it("unwraps the code-mode header and content-item text", () => {
    const overview = getCodexExecResultOverview([
      {
        type: "input_text",
        text: "Script completed\nWall time 0.2 seconds\nOutput:\n",
      },
      {
        type: "input_text",
        text: "packages/client/src/i18n/zh-CN.json:692: deployment",
      },
    ]);

    expect(overview).toMatchObject({
      status: "completed",
      wallTimeSeconds: 0.2,
      output: "packages/client/src/i18n/zh-CN.json:692: deployment",
      outputLineCount: 1,
      unknownItemCount: 0,
    });
  });

  it("extracts nested command metadata instead of showing its JSON wrapper", () => {
    const overview = getCodexExecResultOverview(
      [
        {
          type: "input_text",
          text: "Script completed\nWall time 0.8 seconds\nOutput:\n",
        },
        {
          type: "input_text",
          text: JSON.stringify({
            exit_code: 0,
            wall_time_seconds: 0.27,
            output: "Checked 779 files. No fixes applied.",
          }),
        },
      ],
      false,
      { parseNestedResults: true },
    );

    expect(overview.output).toBe("Checked 779 files. No fixes applied.");
    expect(overview.segments).toEqual([
      expect.objectContaining({
        exitCode: 0,
        wallTimeSeconds: 0.27,
        isError: false,
      }),
    ]);
  });

  it("keeps shell business JSON verbatim without an explicit envelope signal", () => {
    const businessJson = '{"exit_code":1,"output":"domain data"}';
    const overview = getCodexExecResultOverview([
      {
        type: "input_text",
        text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
      },
      { type: "input_text", text: businessJson },
    ]);

    expect(overview.status).toBe("completed");
    expect(overview.output).toBe(businessJson);
    expect(overview.segments[0]?.exitCode).toBeUndefined();
    expect(overview.segments[0]?.isError).toBe(false);
  });

  it("recognizes failed scripts and keeps the readable error", () => {
    const overview = getCodexExecResultOverview([
      {
        type: "input_text",
        text: "Script failed\nWall time 0.0 seconds\nOutput:\n",
      },
      { type: "input_text", text: "Script error:\nboom" },
    ]);

    expect(overview.status).toBe("failed");
    expect(overview.output).toBe("Script error:\nboom");
    expect(overview.segments[0]?.isError).toBe(true);
  });

  it("preserves image outputs without dumping image JSON", () => {
    const overview = getCodexExecResultOverview([
      {
        type: "input_text",
        text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
      },
      {
        type: "input_image",
        image_url: "data:image/png;base64,AAAA",
        detail: "original",
      },
      { type: "encrypted_content", encrypted_content: "hidden" },
    ]);

    expect(overview.images).toEqual([
      {
        imageUrl: "data:image/png;base64,AAAA",
        detail: "original",
      },
    ]);
    expect(overview.output).toBe("");
    expect(overview.unknownItemCount).toBe(1);
  });

  it("accepts legacy JSON-encoded content-item arrays", () => {
    const result = JSON.stringify([
      { type: "input_text", text: "Script completed\nOutput:\n" },
      { type: "input_text", text: "done" },
    ]);

    expect(getCodexExecResultOverview(result)).toMatchObject({
      status: "completed",
      output: "done",
    });
  });

  it("recognizes running and terminated script headers", () => {
    expect(
      getCodexExecResultOverview(
        "Script running with cell ID 57\nWall time 10.0 seconds\nOutput:\n",
      ),
    ).toMatchObject({
      status: "running",
      cellId: "57",
      wallTimeSeconds: 10,
    });
    expect(
      getCodexExecResultOverview(
        "Script terminated\nWall time 1.2 seconds\nOutput:\n",
      ),
    ).toMatchObject({
      status: "terminated",
      wallTimeSeconds: 1.2,
    });
  });
});
