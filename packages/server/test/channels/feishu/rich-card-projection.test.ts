import { describe, expect, it } from "vitest";
import { FeishuRichCardProjection } from "../../../src/channels/feishu/rich-card-projection.js";
import { CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE } from "../../../src/codex-events/types.js";
import type { ThreadItem } from "../../../src/sdk/providers/codex-protocol/index.js";

describe("FeishuRichCardProjection", () => {
  it("renders safe rich sections for plan, tools, diffs, subagents and warnings", () => {
    const projection = new FeishuRichCardProjection();
    projection.observe({
      type: "assistant",
      uuid: "plan-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "plan-1",
            name: "UpdatePlan",
            status: "completed",
            input: {
              explanation: "Verify the change",
              plan: [
                { step: "Inspect", status: "completed" },
                { step: "Test", status: "in_progress" },
              ],
            },
          },
        ],
      },
    });
    projection.observe({
      type: "assistant",
      uuid: "commentary-1",
      codexMessagePhase: "commentary",
      message: { content: "Checking <script>steal()</script> now" },
    });
    projection.observe({
      type: "assistant",
      uuid: "tool-message",
      message: {
        content: [
          {
            type: "thinking",
            thinking: "private chain of thought",
          },
          {
            type: "tool_use",
            id: "exec-1",
            name: "Bash",
            input: { command: "print SUPER_SECRET" },
          },
          {
            type: "tool_use",
            id: "edit-1",
            name: "Edit",
            input: {
              file_path: "/private/work/src/app.ts",
              patch: "@@\n-old\n+new",
            },
          },
        ],
      },
    });
    projection.observe({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "exec-1",
            content: "SUPER_SECRET",
          },
        ],
      },
    });
    projection.observe({
      type: "assistant",
      isSubagent: true,
      agentId: "audit-agent",
      message: { content: "private subagent text" },
    });
    projection.observe({
      type: "assistant",
      isSubagent: true,
      agentId: "audit-agent",
      codexThreadItemLifecycle: "completed",
      codexThreadItem: {
        type: "agentMessage",
        id: "private-subagent-final",
        phase: "final_answer",
        text: "private canonical subagent text",
      },
    });
    projection.observe({
      type: "system",
      subtype: "warning",
      warning: "Temporary overload; retrying",
    });

    const rendered = projection.render(
      "Codex 正在处理…",
      "Final answer",
      "rich",
    );

    expect(rendered).toContain("### 计划");
    expect(rendered).toContain("✅ Inspect");
    expect(rendered).toContain("▶️ Test");
    expect(rendered).toContain("### 进展");
    expect(rendered).toContain("[已移除脚本]");
    expect(rendered).toContain("### 工具");
    expect(rendered).toContain("Bash · 已完成");
    expect(rendered).toContain("### 文件变更");
    expect(rendered).toContain("app.ts · +1 / -1");
    expect(rendered).toContain("### 子代理");
    expect(rendered).toContain("子代理 · 进行中");
    expect(rendered).not.toContain("audit-agent");
    expect(rendered).toContain("### 提示");
    expect(rendered).toContain("### 回复");
    expect(rendered).toContain("Final answer");
    expect(rendered).not.toContain("SUPER_SECRET");
    expect(rendered).toContain("private chain of thought");
    expect(rendered).not.toContain("private subagent text");
    expect(rendered).not.toContain("private canonical subagent text");
    expect(rendered).not.toContain("/private/work");
    expect(projection.snapshot().artifacts).toEqual([]);
  });

  it("isolates mutable status and tool lifecycle from append-only progress", () => {
    const projection = new FeishuRichCardProjection();
    projection.observe({
      type: "assistant",
      uuid: "commentary-stable",
      codexMessagePhase: "commentary",
      message: { content: "已完成第一步" },
    });
    projection.observe({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "mcp-failed",
            name: "lark:lark_speech_recognize",
            status: "in_progress",
            input: { file_path: "/private/input.audio" },
          },
        ],
      },
    });

    const waiting = projection.renderSections("等待审批", "");
    projection.observe({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "mcp-failed",
            content: "MCP tool call failed",
            is_error: true,
          },
        ],
      },
    });
    const failed = projection.renderSections("正在继续", "");

    expect(waiting.progress).toBe(failed.progress);
    expect(waiting.status).not.toBe(failed.status);
    expect(waiting.tools).toContain("进行中");
    expect(failed.tools).toContain("失败");
    expect(failed.artifacts).toBe("");
    expect(projection.snapshot().artifacts).toEqual([]);
  });

  it("keeps compact mode concise", () => {
    const projection = new FeishuRichCardProjection();
    projection.observe({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "plan",
            name: "UpdatePlan",
            input: {
              plan: [
                { step: "Inspect", status: "completed" },
                { step: "Test", status: "pending" },
              ],
            },
          },
          { type: "tool_use", id: "exec", name: "Bash", input: {} },
        ],
      },
    });

    const rendered = projection.render("Working", "Answer", "compact");
    expect(rendered).toContain("计划：1/2");
    expect(rendered).toContain("工具：Bash");
    expect(rendered).toContain("Answer");
    expect(rendered).not.toContain("### 文件变更");
  });

  it.each(["rich", "compact", "plain"] as const)(
    "escapes Feishu tag markup in %s answers and commentary",
    (mode) => {
      const projection = new FeishuRichCardProjection();
      projection.observe({
        type: "assistant",
        uuid: "commentary-tag",
        codexMessagePhase: "commentary",
        message: { content: "Checking <at id=all></at> now" },
      });

      const rendered = projection.render(
        "Working",
        "Done <at id=all></at>",
        mode,
      );

      expect(rendered).not.toContain("<at");
      expect(rendered).toContain("&lt;at id=all&gt;&lt;/at&gt;");
    },
  );

  it.each(["rich", "compact", "plain"] as const)(
    "keeps local paths readable without emitting unusable Markdown links in %s mode",
    (mode) => {
      const projection = new FeishuRichCardProjection();
      const rendered = projection.render(
        "Working",
        [
          "See [app.ts](/Users/developer/project/src/app.ts:12)",
          "Config: ~/.codex/config.toml",
          "Windows: C:\\work\\project\\app.ts",
          "URI: file:///Users/developer/project/README.md",
        ].join("\n"),
        mode,
      );

      expect(rendered).toContain(
        "app.ts（`/Users/developer/project/src/app.ts:12`）",
      );
      expect(rendered).toContain("~/.codex/config.toml");
      expect(rendered).toContain("C:\\work\\project\\app.ts");
      expect(rendered).toContain("file:///Users/developer/project/README.md");
      expect(rendered).not.toContain("[已隐藏本地路径]");
      expect(rendered).not.toContain(
        "[app.ts](/Users/developer/project/src/app.ts:12)",
      );
    },
  );

  it("settles every running activity when the turn reaches a terminal state", () => {
    const projection = new FeishuRichCardProjection();
    projection.observe({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "private" },
          { type: "tool_use", id: "exec", name: "Bash", input: {} },
        ],
      },
    });

    projection.settleRunning("failed");

    const rendered = projection.render("任务已停止", "任务已停止。", "rich");
    expect(rendered).toContain("Bash · 失败");
    expect(rendered).not.toContain("Bash · 进行中");
    expect(rendered).not.toContain("正在推理");
  });

  it("projects every canonical ThreadItem variant into safe bounded sections", () => {
    const projection = new FeishuRichCardProjection();
    const items: ThreadItem[] = [
      {
        type: "userMessage",
        id: "user-1",
        clientId: "client-1",
        content: [
          {
            type: "text",
            text: "USER_SECRET_CONTENT",
            text_elements: [],
          },
        ],
      },
      {
        type: "hookPrompt",
        id: "hook-1",
        fragments: [
          {
            hookRunId: "hook-run-1",
            text: "HOOK_SECRET /private/work/hook.md",
          },
        ],
      },
      {
        type: "agentMessage",
        id: "commentary-1",
        phase: "commentary",
        text: "正在检查 token=commentary-secret /private/work/src/app.ts",
        memoryCitation: null,
      },
      {
        type: "functionCallOutput",
        id: "function-output-1",
        name: "lookup",
        namespace: "fixture",
        output: "FUNCTION_OUTPUT_SECRET",
      },
      {
        type: "plan",
        id: "plan-1",
        text: "检查实现，然后运行测试",
      },
      {
        type: "reasoning",
        id: "reasoning-1",
        summary: ["已核对安全边界"],
        content: ["RAW_REASONING_SECRET /private/reasoning.txt"],
      },
      {
        type: "commandExecution",
        id: "command-1",
        command: "print COMMAND_SECRET",
        cwd: "/private/work",
        aggregatedOutput: "COMMAND_OUTPUT_SECRET",
        status: "inProgress",
        pluginId: null,
        scriptPath: null,
        processId: null,
        source: "agent",
        commandActions: [],
        exitCode: null,
        durationMs: null,
      },
      {
        type: "fileChange",
        id: "file-1",
        changes: [
          {
            path: "/private/work/src/app.ts",
            kind: { type: "update", move_path: null },
            diff: "@@\n-OLD_FILE_SECRET\n+NEW_FILE_SECRET",
          },
        ],
        status: "inProgress",
      },
      {
        type: "mcpToolCall",
        id: "mcp-1",
        server: "files",
        tool: "read",
        status: "inProgress",
        arguments: { api_key: "MCP_ARGUMENT_SECRET" },
        result: {
          content: ["MCP_RESULT_SECRET"],
          structuredContent: null,
          _meta: null,
        },
        error: null,
        appContext: null,
        pluginId: null,
        readOnlyHint: null,
        durationMs: null,
      },
      {
        type: "dynamicToolCall",
        id: "dynamic-1",
        namespace: "apps",
        tool: "search",
        status: "inProgress",
        arguments: { token: "DYNAMIC_ARGUMENT_SECRET" },
        contentItems: [
          { type: "inputText", text: "DYNAMIC_OUTPUT_SECRET" },
          { type: "inputImage", imageUrl: "data:image/png;base64,AAAA" },
        ],
        success: null,
        durationMs: null,
      },
      {
        type: "collabAgentToolCall",
        id: "collab-1",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: "sender-thread",
        receiverThreadIds: ["receiver-thread"],
        prompt: "COLLAB_PROMPT_SECRET",
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      },
      {
        type: "subAgentActivity",
        id: "subagent-1",
        kind: "started",
        agentThreadId: "agent-thread",
        agentPath: "/private/work/agents/a",
      },
      {
        type: "webSearch",
        id: "web-1",
        query: "WEB_QUERY_SECRET /private/work",
        action: null,
        results: [{ url: "https://secret.example" }],
      },
      {
        type: "imageView",
        id: "image-view-1",
        path: "/private/work/SECRET_IMAGE.png",
      },
      { type: "sleep", id: "sleep-1", durationMs: 1_500 },
      {
        type: "imageGeneration",
        id: "image-generation-1",
        status: "inProgress",
        revisedPrompt: "IMAGE_PROMPT_SECRET",
        result: "data:image/png;base64,BBBB",
        savedPath: "/private/work/generated.png",
      },
      {
        type: "enteredReviewMode",
        id: "review-enter-1",
        review: "REVIEW_ENTER_SECRET /private/work",
      },
      {
        type: "exitedReviewMode",
        id: "review-exit-1",
        review: "REVIEW_EXIT_SECRET /private/work",
      },
      { type: "contextCompaction", id: "compaction-1" },
    ];

    expect([...new Set(items.map((item) => item.type))].sort()).toEqual(
      Object.keys(CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE).sort(),
    );

    for (const item of items) {
      observeCanonical(projection, item, "started");
      observeCanonical(
        projection,
        {
          ...item,
          ...(Object.hasOwn(item, "status") ? { status: "completed" } : {}),
        },
        "completed",
      );
    }
    observeCanonical(
      projection,
      {
        type: "agentMessage",
        id: "final-1",
        phase: "final_answer",
        text: "最终答复 token=final-secret /private/work/result.txt",
        memoryCitation: null,
      },
      "completed",
    );

    const snapshot = projection.snapshot();
    const rendered = projection.render("任务完成", "", "rich");

    expect(snapshot.planStatus).toBe("completed");
    expect(snapshot.reasoningActive).toBe(false);
    expect(snapshot.reasoningSummaries).toEqual([
      "已核对安全边界\nRAW_REASONING_SECRET /private/reasoning.txt",
    ]);
    expect(snapshot.artifacts).toEqual([]);
    expect(rendered).toContain("### 计划");
    expect(rendered).toContain("检查实现，然后运行测试");
    expect(rendered).toContain("### 进展");
    expect(rendered).toContain("正在检查 token=commentary-secret");
    expect(rendered).toContain("推理摘要：已核对安全边界");
    expect(rendered).toContain("### 工具");
    expect(rendered).toContain("Command execution · 已完成");
    expect(rendered).toContain("MCP · files/read · 已完成");
    expect(rendered).toContain("Dynamic tool · apps/search · 已完成");
    expect(rendered).toContain("Function output · fixture/lookup · 已完成");
    expect(rendered).toContain("Web search · 已完成");
    expect(rendered).toContain("Image view · 已完成");
    expect(rendered).toContain("Image generation · 已完成");
    expect(rendered).toContain("### 文件变更");
    expect(rendered).toContain("app.ts · +1 / -1 · 已完成");
    expect(rendered).toContain("### 子代理");
    expect(rendered).toContain("子代理 · spawnAgent · 已完成");
    expect(rendered).toContain("子代理活动 · 开始 · 已完成");
    expect(rendered).toContain("### 状态");
    expect(rendered).toContain("用户输入 · 已完成");
    expect(rendered).toContain("Hook 上下文 · 已完成");
    expect(rendered).toContain("等待 1.5 秒 · 已完成");
    expect(rendered).toContain("进入 Review 模式 · 已完成");
    expect(rendered).toContain("退出 Review 模式 · 已完成");
    expect(rendered).toContain("上下文压缩 · 已完成");
    expect(rendered).toContain("### 回复");
    expect(rendered).toContain(
      "正在检查 token=commentary-secret /private/work/src/app.ts",
    );
    expect(rendered).toContain(
      "最终答复 token=final-secret /private/work/result.txt",
    );

    expect(snapshot.details.length).toBeLessThanOrEqual(8);
    for (const text of [
      "commentary-secret",
      "RAW_REASONING_SECRET",
      "final-secret",
      "IMAGE_PROMPT_SECRET",
      "REVIEW_ENTER_SECRET",
      "REVIEW_EXIT_SECRET",
    ]) {
      expect(rendered).toContain(text);
    }
    expect(rendered).toContain("SECRET_IMAGE");
  });

  it("uses canonical items once and gives unknown newer items an explicit safe fallback", () => {
    const projection = new FeishuRichCardProjection();
    projection.observe({
      type: "assistant",
      uuid: "command-message",
      codexThreadItemLifecycle: "completed",
      codexThreadItem: {
        type: "commandExecution",
        id: "command-1",
        status: "completed",
        command: "echo CANONICAL_COMMAND_SECRET",
        cwd: "/private/work",
        aggregatedOutput: "CANONICAL_OUTPUT_SECRET",
      },
      message: {
        content: [
          {
            type: "tool_use",
            id: "command-1",
            name: "Bash",
            input: { command: "echo LEGACY_COMMAND_SECRET" },
          },
        ],
      },
    });
    projection.observe({
      type: "system",
      subtype: "codex_native_item",
      codexThreadItemLifecycle: "completed",
      codexThreadItem: {
        type: "futureSecretTool",
        id: "future-1",
        arguments: { token: "FUTURE_SECRET" },
        path: "/private/future.txt",
      },
    });

    const snapshot = projection.snapshot();
    const rendered = projection.render("Working", "", "rich");
    expect(snapshot.tools).toEqual([
      { id: "command-1", name: "Command execution", status: "completed" },
    ]);
    expect(rendered).toContain("暂不支持的原生项目（futureSecretTool）");
    expect(rendered).not.toContain("Bash");
    expect(rendered).toContain("CANONICAL_COMMAND_SECRET");
    expect(JSON.stringify(projection.renderStreamingActivityRows())).toContain(
      "CANONICAL_COMMAND_SECRET",
    );
    expect(rendered).toContain("CANONICAL_OUTPUT_SECRET");
    expect(rendered).not.toContain("LEGACY_COMMAND_SECRET");
    expect(rendered).toContain("FUTURE_SECRET");
    expect(rendered).toContain("/private/");
  });

  it("bounds canonical collections and visible text", () => {
    const projection = new FeishuRichCardProjection();
    for (let index = 0; index < 40; index += 1) {
      observeCanonical(
        projection,
        {
          type: "dynamicToolCall",
          id: `dynamic-${index}`,
          namespace: "bounded",
          tool: `tool-${index}`,
          status: "inProgress",
        },
        "started",
      );
      observeCanonical(
        projection,
        {
          type: "contextCompaction",
          id: `compaction-${index}`,
        },
        "completed",
      );
      observeCanonical(
        projection,
        {
          type: "reasoning",
          id: `reasoning-${index}`,
          summary: [`summary-${index}`],
          content: [`raw-${index}`],
        },
        "completed",
      );
      projection.observe({
        type: "system",
        subtype: "codex_native_item",
        codexThreadItem: { type: `future-${index}`, id: `future-${index}` },
      });
    }
    observeCanonical(
      projection,
      {
        type: "agentMessage",
        id: "final-long",
        phase: "final_answer",
        text: "x".repeat(40_000),
      },
      "completed",
    );

    const snapshot = projection.snapshot();
    expect(snapshot.tools).toHaveLength(24);
    expect(snapshot.activities).toHaveLength(16);
    expect(snapshot.reasoningSummaries).toHaveLength(4);
    expect(snapshot.warnings).toHaveLength(6);
    expect(snapshot.finalAnswer?.length).toBeLessThanOrEqual(28_000);
    expect(snapshot.finalAnswer?.endsWith("…")).toBe(true);
    expect(snapshot.tools[0]?.id).toBe("dynamic-16");
    expect(snapshot.activities[0]?.id).toBe("compaction-24");
  });
});

function observeCanonical(
  projection: FeishuRichCardProjection,
  item: object,
  lifecycle: "started" | "completed",
): void {
  projection.observe({
    type: "system",
    subtype: "codex_native_item",
    codexThreadItem: item,
    codexThreadItemLifecycle: lifecycle,
    codexRawReasoningAllowed: false,
  });
}
