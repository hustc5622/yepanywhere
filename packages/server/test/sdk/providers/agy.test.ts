import { describe, expect, it } from "vitest";
import {
  buildAgyModelCatalog,
  parseAgyModelsOutput,
  resolveAgyModelChoice,
} from "../../../src/sdk/providers/agy-models.js";
import {
  buildAgyElicitationContent,
  planAgyQuestionnaire,
} from "../../../src/sdk/providers/agy-questions.js";
import {
  agyToolResultText,
  convertAgyUpdate,
  recordAgyToolNames,
  toAgyMode,
} from "../../../src/sdk/providers/agy.js";
import { inferAgyNativeToolName } from "../../../src/sessions/agy-tools.js";

// `agy models` output captured from Antigravity CLI 1.5.13 (Google AI Pro).
const MODELS_OUTPUT = [
  "Fetching available models...",
  "gemini-4-neon-high\tGemini 4 Neon (High)",
  "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)",
  "gemini-4-neon-medium\tGemini 4 Neon (Medium)",
  "gemini-4-neon-low\tGemini 4 Neon (Low)",
  "gemini-pro-orchestrator-neon\tOrchestrator (Neon)",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
].join("\n");

describe("agy model catalog", () => {
  it("groups tiered slugs into families with reasoning efforts", () => {
    const models = buildAgyModelCatalog(parseAgyModelsOutput(MODELS_OUTPUT));
    expect(models.map((model) => model.id)).toEqual([
      "gemini-4-neon",
      "gemini-pro-orchestrator-neon",
      "gemini-3.8-flash",
      "gpt-oss-120b-medium",
    ]);
    const neon = models[0];
    expect(neon?.name).toBe("Gemini 4 Neon");
    expect(
      neon?.supportedReasoningEfforts?.map((e) => e.reasoningEffort),
    ).toEqual(["low", "medium", "high", "xhigh"]);
    expect(neon?.defaultReasoningEffort).toBe("high");
    // A single-tier slug stays whole, exactly like agy's ACP option value.
    expect(models[3]).toEqual({
      id: "gpt-oss-120b-medium",
      name: "GPT-OSS 120B (Medium)",
    });
  });

  it("resolves families, persisted slugs and efforts", () => {
    const families = [
      "gemini-4-neon",
      "gemini-3.8-flash",
      "gpt-oss-120b-medium",
    ];
    expect(resolveAgyModelChoice(families, "gemini-4-neon", "xhigh")).toEqual({
      family: "gemini-4-neon",
      tier: "xhigh",
    });
    expect(
      resolveAgyModelChoice(families, "gemini-3.8-flash-low", undefined),
    ).toEqual({ family: "gemini-3.8-flash", tier: "low" });
    expect(
      resolveAgyModelChoice(families, "gpt-oss-120b-medium", "high"),
    ).toEqual({ family: "gpt-oss-120b-medium", tier: "high" });
    expect(resolveAgyModelChoice(families, "unknown", "high")).toBeNull();
  });
});

describe("agy permission modes", () => {
  const all = ["default", "accept-edits", "auto", "plan"];
  it("maps Yep modes onto agy execution modes", () => {
    expect(toAgyMode("default", all)).toBe("default");
    expect(toAgyMode("acceptEdits", all)).toBe("accept-edits");
    expect(toAgyMode("auto", all)).toBe("auto");
    expect(toAgyMode("plan", all)).toBe("plan");
    expect(toAgyMode("bypassPermissions", all)).toBe("auto");
  });

  it("falls back when the account has no auto mode", () => {
    const noAuto = ["default", "accept-edits", "plan"];
    expect(toAgyMode("auto", noAuto)).toBe("default");
    expect(toAgyMode("bypassPermissions", noAuto)).toBe("accept-edits");
  });
});

describe("agy questionnaire", () => {
  // Captured from `ask_question` elicitation (references/antigravity/probe).
  const schema = {
    type: "object",
    properties: {
      q1: {
        type: "string",
        title: "Which color do you prefer?",
        oneOf: [
          { const: "1", title: "red" },
          { const: "2", title: "blue" },
        ],
      },
      q1_other: {
        type: "string",
        title: "Other",
        description: "Optional free-form answer to: Which color do you prefer?",
      },
    },
  };

  it("plans one question with a custom answer slot", () => {
    const plan = planAgyQuestionnaire(schema, "The agent has a question.");
    expect(plan?.questions).toEqual([
      {
        id: "q1",
        question: "Which color do you prefer?",
        header: "Question",
        options: [
          { label: "red", value: "1", description: "" },
          { label: "blue", value: "2", description: "" },
        ],
        multiSelect: false,
        custom: true,
        required: false,
      },
    ]);
  });

  it("maps values, labels and free text back to the schema", () => {
    const plan = planAgyQuestionnaire(schema, undefined);
    if (!plan) throw new Error("plan expected");
    expect(buildAgyElicitationContent(plan, { q1: "2" })).toEqual({ q1: "2" });
    expect(buildAgyElicitationContent(plan, { q1: "blue" })).toEqual({
      q1: "2",
    });
    expect(buildAgyElicitationContent(plan, { q1: "green" })).toEqual({
      q1_other: "green",
    });
  });
});

describe("agy ACP update conversion", () => {
  const base = {
    toolCallId: "call_1",
    name: "run_command",
    kind: "execute",
    title: "ls -la",
    rawInput: { CommandLine: "ls -la", toolSummary: "List files" },
  };

  it("emits a tool row once and a result on completion", () => {
    const seen = new Map<string, { name: string; input: string }>();
    const started = convertAgyUpdate(
      { sessionUpdate: "tool_call", status: "in_progress", ...base } as never,
      "s1",
      seen,
    );
    expect(started).toHaveLength(1);
    const block = (
      started[0] as { message: { content: Array<Record<string, unknown>> } }
    ).message.content[0];
    expect(block).toMatchObject({
      type: "tool_use",
      id: "call_1",
      name: "Bash",
      input: { command: "ls -la", description: "List files" },
    });

    // pending (approval) → in_progress: same input, no duplicate row.
    expect(
      convertAgyUpdate(
        {
          sessionUpdate: "tool_call_update",
          status: "pending",
          ...base,
        } as never,
        "s1",
        seen,
      ),
    ).toHaveLength(0);

    const done = convertAgyUpdate(
      {
        sessionUpdate: "tool_call_update",
        status: "completed",
        ...base,
        rawOutput: { output: "a\nb\n", exit_code: 0 },
      } as never,
      "s1",
      seen,
    );
    expect(done).toHaveLength(1);
    expect(
      (done[0] as { message: { content: Array<Record<string, unknown>> } })
        .message.content[0],
    ).toMatchObject({
      type: "tool_result",
      tool_use_id: "call_1",
      content: "a\nb",
    });
  });

  it("reads diff and text content as result text", () => {
    expect(
      agyToolResultText({
        rawOutput: {},
        content: [{ type: "content", content: { type: "text", text: "ok" } }],
      }),
    ).toBe("ok");
  });
});

describe("agy vendor tool names", () => {
  it("records names from raw frames the SDK would strip", () => {
    const names = new Map<string, string>();
    recordAgyToolNames(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_9",
            name: "write_file",
            title: "File ../x.txt",
          },
        },
      },
      names,
    );
    recordAgyToolNames(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "session/request_permission",
        params: { toolCall: { toolCallId: "call_10", name: "run_command" } },
      },
      names,
    );
    expect([...names]).toEqual([
      ["call_9", "write_file"],
      ["call_10", "run_command"],
    ]);
    // The recorded name wins over the stripped update's title.
    const rows = convertAgyUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "call_9",
        status: "in_progress",
        kind: "edit",
        title: "File ../x.txt",
        rawInput: { Path: "/w/x.txt", Content: "hi" },
      } as never,
      "s",
      new Map(),
      names,
    );
    expect(
      (rows[0] as { message: { content: Array<Record<string, unknown>> } })
        .message.content[0],
    ).toMatchObject({ name: "Write", input: { file_path: "/w/x.txt" } });
  });

  it("infers names from argument shapes", () => {
    expect(inferAgyNativeToolName({ rawInput: { CommandLine: "ls" } })).toBe(
      "run_command",
    );
    expect(
      inferAgyNativeToolName({
        kind: "edit",
        rawInput: { Path: "/a", Content: "x", Overwrite: true },
      }),
    ).toBe("write_file");
    expect(
      inferAgyNativeToolName({ kind: "read", rawInput: { Path: "/a" } }),
    ).toBe("read_file");
    expect(
      inferAgyNativeToolName({ title: "Run ask_question", rawInput: {} }),
    ).toBe("ask_question");
    expect(
      inferAgyNativeToolName({
        rawInput: { TargetFile: "/a", TargetContent: "x" },
      }),
    ).toBe("replace_file_content");
  });
});
