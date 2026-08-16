import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { SessionTitleService } from "../../src/services/SessionTitleService.js";
import type { Session } from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/EventBus.js";

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    projectId: "project-1" as UrlProjectId,
    title: "Please help me refactor a very long piece of code",
    fullTitle: "Please help me refactor a very long piece of code",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:01:00Z",
    messageCount: 2,
    ownership: { owner: "none" },
    provider: "claude",
    messages: [
      {
        type: "user",
        message: {
          role: "user",
          content: "Please help me refactor a very long piece of code",
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I found the duplicated logic." }],
        },
      },
    ],
    ...overrides,
  };
}

describe("SessionTitleService", () => {
  let testDir: string;
  let metadataService: SessionMetadataService;
  let eventBus: EventBus;

  beforeEach(async () => {
    testDir = join(tmpdir(), `session-title-service-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    metadataService = new SessionMetadataService({ dataDir: testDir });
    await metadataService.initialize();
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("generates and stores an AI title", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"重构重复逻辑"}' } }],
        }),
        { status: 200 },
      );
    });
    const events: unknown[] = [];
    eventBus.subscribe((event) => events.push(event));
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiBase: "https://api.example.com",
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () => createSession(),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      "X-Sub-Module",
    );
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).max_tokens,
    ).toBe(100000);
    expect(metadataService.getMetadata("session-1")?.aiTitle).toBe(
      "重构重复逻辑",
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session-metadata-changed",
        sessionId: "session-1",
        projectId: "project-1",
        aiTitle: "重构重复逻辑",
      }),
    );
  });

  it("uses DeepSeek v4 Pro by default", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"重构重复逻辑"}' } }],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () => createSession(),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe("deepseek-v4-pro");
  });

  it("accepts a JSON object wrapped in a bare or JSON code fence", async () => {
    const responses = [
      '```json\n{"title":"Refactor duplicated logic"}\n```',
      '```\n{"title":"Refactor duplicated logic again"}\n```',
    ];
    const fetchMock = vi.fn(async () => {
      const content = responses[fetchMock.mock.calls.length - 1];
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      retryMaxAttempts: 1,
      fetchImpl: fetchMock,
      loadSession: async (sessionId) => createSession({ id: sessionId }),
    });

    await service.generateForSession(
      "fenced-json",
      "project-1" as UrlProjectId,
    );
    await service.generateForSession("bare-fence", "project-1" as UrlProjectId);

    expect(metadataService.getMetadata("fenced-json")?.aiTitle).toBe(
      "Refactor duplicated logic",
    );
    expect(metadataService.getMetadata("bare-fence")?.aiTitle).toBe(
      "Refactor duplicated logic again",
    );
  });

  it("rejects explanations, non-objects, extra keys, duplicate title keys, and multiline titles", async () => {
    const invalidOutputs = [
      'Here is the result: {"title":"Refactor duplicated logic"}',
      '{"title":"Refactor duplicated logic"}\nDone.',
      '[{"title":"Refactor duplicated logic"}]',
      '{"title":"Refactor duplicated logic","reason":"concise"}',
      '{"title":"First title","title":"Second title"}',
      '{"title":"Refactor duplicated\\nlogic"}',
    ];
    const fetchMock = vi.fn(async () => {
      const content = invalidOutputs[fetchMock.mock.calls.length - 1];
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      retryMaxAttempts: 1,
      fetchImpl: fetchMock,
      loadSession: async (sessionId) => createSession({ id: sessionId }),
    });

    for (let index = 0; index < invalidOutputs.length; index += 1) {
      const sessionId = `invalid-output-${index}`;
      await service.generateForSession(sessionId, "project-1" as UrlProjectId);
      expect(metadataService.getMetadata(sessionId)).toBeUndefined();
    }

    expect(fetchMock).toHaveBeenCalledTimes(invalidOutputs.length);
  });

  it("retries generic and boilerplate title output only up to the configured limit", async () => {
    const invalidOutputs = [
      '{"title":"Here\u2019s a title for this conversation:"}',
      '{"title":"Here is a title for this conversation: Refactor duplicated logic"}',
      '{"title":"Here\u2019s a title for this conversation:"}',
    ];
    const fetchMock = vi.fn(async () => {
      const content = invalidOutputs[fetchMock.mock.calls.length - 1];
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      retryMaxAttempts: 3,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () => createSession(),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(metadataService.getMetadata("session-1")).toBeUndefined();
  });

  it("requires Chinese titles for Chinese user messages", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"重构分析提示词"}' } }],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          messages: [
            {
              type: "user",
              message: {
                role: "user",
                content: "优化 benchmark 结果分析提示词",
              },
            },
            {
              type: "assistant",
              message: {
                role: "assistant",
                content: "已改成失败模式优先的分析流程。",
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.messages[1].content).toContain(
      "Required title language:\nChinese",
    );
    expect(metadataService.getMetadata("session-1")?.aiTitle).toBe(
      "重构分析提示词",
    );
  });

  it("does not save English titles for Chinese user messages", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"title":"Refactor benchmark analysis without hardcoded limits"}',
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      retryMaxAttempts: 1,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          messages: [
            {
              type: "user",
              message: {
                role: "user",
                content: "优化 benchmark 结果分析提示词",
              },
            },
            {
              type: "assistant",
              message: {
                role: "assistant",
                content: "已改成失败模式优先的分析流程。",
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(metadataService.getMetadata("session-1")).toBeUndefined();
  });

  it("does not hard truncate model-generated titles", async () => {
    const title =
      "Refactor benchmark analysis prompt to remove hardcoded limits and preserve adaptive failure pattern sampling";
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ title }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          messages: [
            {
              type: "user",
              message: {
                role: "user",
                content:
                  "Refactor the benchmark analysis prompt to remove hardcoded limits",
              },
            },
            {
              type: "assistant",
              message: {
                role: "assistant",
                content: "Updated the prompt and related request payload.",
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(metadataService.getMetadata("session-1")?.aiTitle).toBe(title);
  });

  it("sends a configured submodule header", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"重构重复逻辑"}' } }],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      subModule: "claude-code-internal",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () => createSession(),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toHaveProperty(
      "X-Sub-Module",
      "claude-code-internal",
    );
  });

  it("uses the first real user message instead of the summary title", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"真实用户问题标题"}' } }],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          title: "Stale summary title",
          fullTitle: "Stale full summary title",
          messages: [
            {
              type: "user",
              message: {
                role: "user",
                content: "Actual first user prompt",
              },
            },
            {
              type: "assistant",
              message: {
                role: "assistant",
                content: "Actual assistant response",
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const prompt = body.messages[1].content as string;
    expect(prompt).toContain("Actual first user prompt");
    expect(prompt).not.toContain("Stale full summary title");
  });

  it("sends complete first user prompt and first final assistant response", async () => {
    const longUserPrompt = [
      "请分析这个会话标题生成问题。",
      "用户输入中间内容 ".repeat(260),
      "USER_PROMPT_TAIL_SENTINEL",
    ].join("\n");
    const longAssistantResponse = [
      "最终回答总结如下。",
      "助手回答中间内容 ".repeat(260),
      "ASSISTANT_RESPONSE_TAIL_SENTINEL",
    ].join("\n");
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"完整上下文标题"}' } }],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          provider: "codex",
          title: "请分析这个会话标题生成问题...",
          fullTitle: longUserPrompt,
          messages: [
            {
              type: "user",
              message: {
                role: "user",
                content: longUserPrompt,
              },
            },
            {
              type: "assistant",
              codexMessagePhase: "commentary",
              message: {
                role: "assistant",
                content: "我先看一下代码。",
              },
            },
            {
              type: "assistant",
              codexMessagePhase: "final_answer",
              message: {
                role: "assistant",
                content: longAssistantResponse,
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const prompt = body.messages[1].content as string;
    expect(prompt).toContain("USER_PROMPT_TAIL_SENTINEL");
    expect(prompt).toContain("ASSISTANT_RESPONSE_TAIL_SENTINEL");
    expect(prompt).not.toContain("请分析这个会话标题生成问题...");
    expect(prompt).not.toContain("我先看一下代码。");
  });

  it("skips Codex setup user messages when generating a title", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"前端标记来源"}' } }],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          provider: "codex",
          title: "现在的标记有些问题",
          fullTitle: "现在的标记有些问题",
          messages: [
            {
              type: "user",
              message: {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>setup</INSTRUCTIONS>",
                  },
                  {
                    type: "input_text",
                    text: "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
                  },
                ],
              },
            },
            {
              type: "user",
              message: {
                role: "user",
                content: "<skill>\n<name>git-commit-push</name>\n</skill>",
              },
            },
            {
              type: "user",
              message: {
                role: "user",
                content:
                  "现在的标记有些问题，是不是我通过 yep 前端创建的前面就没有绿点",
              },
            },
            {
              type: "assistant",
              codexMessagePhase: "final_answer",
              message: {
                role: "assistant",
                content: "已区分终端创建和 yep 前端创建的会话标记。",
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const prompt = body.messages[1].content as string;
    expect(prompt).toContain("现在的标记有些问题");
    expect(prompt).not.toContain("# AGENTS.md instructions");
    expect(prompt).not.toContain("<environment_context>");
    expect(prompt).not.toContain("<skill>");
  });

  it("skips Codex turn_aborted pseudo user messages when generating a title", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"继续处理用户请求"}' } }],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          provider: "codex",
          title: "<turn_aborted>\nThe user interrupted.\n</turn_aborted>",
          fullTitle: "<turn_aborted>\nThe user interrupted.\n</turn_aborted>",
          messages: [
            {
              type: "user",
              message: {
                role: "user",
                content:
                  "<turn_aborted>\nThe user interrupted.\n</turn_aborted>",
              },
            },
            {
              type: "user",
              message: {
                role: "user",
                content: "继续处理用户请求",
              },
            },
            {
              type: "assistant",
              codexMessagePhase: "final_answer",
              message: {
                role: "assistant",
                content: "继续完成了用户请求。",
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const prompt = body.messages[1].content as string;
    expect(prompt).toContain("继续处理用户请求");
    expect(prompt).not.toContain("<turn_aborted>");
  });

  it("waits for Codex final answer instead of titling from commentary", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"最终回答标题"}' } }],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          provider: "codex",
          messages: [
            {
              type: "user",
              message: { role: "user", content: "Move questions to backend" },
            },
            {
              type: "assistant",
              codexMessagePhase: "commentary",
              message: {
                role: "assistant",
                content: "I will inspect the code first.",
              },
            },
            {
              type: "assistant",
              codexMessagePhase: "final_answer",
              message: {
                role: "assistant",
                content:
                  "Implemented backend-owned session questions and updated the inspector.",
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const prompt = body.messages[1].content as string;
    expect(prompt).toContain(
      "Implemented backend-owned session questions and updated the inspector.",
    );
    expect(prompt).not.toContain("I will inspect the code first.");
  });

  it("does not generate a Codex title before the final answer is present", async () => {
    const fetchMock = vi.fn();
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          provider: "codex",
          messages: [
            {
              type: "user",
              message: { role: "user", content: "Move questions to backend" },
            },
            {
              type: "assistant",
              codexMessagePhase: "commentary",
              message: {
                role: "assistant",
                content: "I will inspect the code first.",
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(metadataService.getMetadata("session-1")).toBeUndefined();
  });

  it("waits for a tool-free OpenCode stop response before generating a title", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"title":"分析 Benchmark 失败模式"}' } },
          ],
        }),
        { status: 200 },
      );
    });
    let currentSession = createSession({
      provider: "opencode",
      messages: [
        {
          type: "user",
          message: { role: "user", content: "分析 Benchmark 失败模式" },
        },
        {
          type: "assistant",
          finish: "stop",
          openCodeHasToolPart: true,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "我将先读取 benchmark 结果。" },
              { type: "tool_use", id: "call-1", name: "Read", input: {} },
            ],
          },
        },
      ],
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () => currentSession,
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);
    expect(fetchMock).not.toHaveBeenCalled();

    currentSession = createSession({
      provider: "opencode",
      messageCount: 3,
      messages: [
        ...currentSession.messages,
        {
          type: "assistant",
          finish: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "reasoning", text: "internal reasoning" },
              { type: "thinking", text: "private thinking" },
              {
                type: "tool_result",
                tool_use_id: "call-1",
                content: "large tool output",
              },
              { type: "text", text: "已完成 Benchmark 失败模式分析。" },
            ],
          },
        },
      ],
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const prompt = body.messages[1].content as string;
    expect(prompt).toContain("已完成 Benchmark 失败模式分析。");
    expect(prompt).not.toContain("我将先读取 benchmark 结果。");
    expect(prompt).not.toContain("internal reasoning");
    expect(prompt).not.toContain("private thinking");
    expect(prompt).not.toContain("large tool output");
  });

  it("waits for Pi's tool-free stop response before generating a title", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"title":"完成 Pi 分析"}' } }],
          }),
          { status: 200 },
        ),
    );
    let currentSession = createSession({
      provider: "pi",
      messages: [
        {
          type: "user",
          message: { role: "user", content: "分析 Pi 会话" },
        },
        {
          type: "assistant",
          stopReason: "toolUse",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "我先读取文件。" },
              { type: "tool_use", id: "call-1", name: "Read", input: {} },
            ],
          },
        },
      ],
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () => currentSession,
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);
    expect(fetchMock).not.toHaveBeenCalled();

    currentSession = createSession({
      provider: "pi",
      messageCount: 3,
      messages: [
        ...currentSession.messages,
        {
          type: "assistant",
          stopReason: "stop",
          message: { role: "assistant", content: "Pi 会话分析完成。" },
        },
      ],
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.messages[1].content).toContain("Pi 会话分析完成。");
    expect(body.messages[1].content).not.toContain("我先读取文件。");
  });

  it.each(["tool-calls", "error", "content-filter", "length", "unknown"])(
    "does not generate from an OpenCode %s response with partial text",
    async (finish) => {
      const fetchMock = vi.fn();
      const service = new SessionTitleService({
        eventBus,
        metadataService,
        apiKey: "test-key",
        minRetryIntervalMs: 0,
        fetchImpl: fetchMock,
        loadSession: async () =>
          createSession({
            provider: "opencode",
            messages: [
              {
                type: "user",
                message: { role: "user", content: "Inspect the benchmark" },
              },
              {
                type: "assistant",
                finish,
                message: {
                  role: "assistant",
                  content: "Partial response before the turn failed.",
                },
              },
            ],
          }),
      });

      await service.generateForSession(
        "session-1",
        "project-1" as UrlProjectId,
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(metadataService.getMetadata("session-1")).toBeUndefined();
    },
  );

  it("keeps completed legacy OpenCode responses without finish compatible", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"title":"Legacy OpenCode response"}' } },
            ],
          }),
          { status: 200 },
        ),
    );
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          provider: "opencode",
          messages: [
            {
              type: "user",
              message: { role: "user", content: "Inspect the old session" },
            },
            {
              type: "assistant",
              openCodeCompleted: true,
              message: {
                role: "assistant",
                content: "The persisted legacy response is complete.",
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(metadataService.getMetadata("session-1")?.aiTitle).toBe(
      "Legacy OpenCode response",
    );
  });

  it("does not treat an in-progress OpenCode response without finish as complete", async () => {
    const fetchMock = vi.fn();
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          provider: "opencode",
          messages: [
            {
              type: "user",
              message: { role: "user", content: "Inspect the live session" },
            },
            {
              type: "assistant",
              message: {
                role: "assistant",
                content: "I am still working on the answer.",
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not treat reasoning-only OpenCode stop messages as final responses", async () => {
    const fetchMock = vi.fn();
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          provider: "opencode",
          messages: [
            {
              type: "user",
              message: { role: "user", content: "Inspect the benchmark" },
            },
            {
              type: "assistant",
              finish: "stop",
              message: {
                role: "assistant",
                content: [
                  { type: "reasoning", text: "internal reasoning" },
                  { type: "thinking", text: "private thinking" },
                ],
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("generates only after an owned session becomes idle", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"回答完成后标题"}' } }],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          messages: [
            {
              type: "user",
              message: { role: "user", content: "等最终回答完成后再取标题" },
            },
            {
              type: "assistant",
              codexMessagePhase: "final_answer",
              message: {
                role: "assistant",
                content: "最终回答已经完成。",
              },
            },
          ],
        }),
    });

    try {
      service.start();
      eventBus.emit({
        type: "session-created",
        session: createSession({
          messageCount: 2,
          ownership: {
            owner: "self",
            processId: "process-1",
          },
        }),
        timestamp: "2026-01-01T00:00:00Z",
      });
      eventBus.emit({
        type: "session-updated",
        sessionId: "session-1",
        projectId: "project-1" as UrlProjectId,
        messageCount: 2,
        timestamp: "2026-01-01T00:00:01Z",
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchMock).not.toHaveBeenCalled();

      eventBus.emit({
        type: "session-status-changed",
        sessionId: "session-1",
        projectId: "project-1" as UrlProjectId,
        ownership: { owner: "none" },
        timestamp: "2026-01-01T00:00:01.500Z",
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchMock).not.toHaveBeenCalled();

      eventBus.emit({
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: "project-1" as UrlProjectId,
        activity: "idle",
        timestamp: "2026-01-01T00:00:02Z",
      });
      await vi.advanceTimersByTimeAsync(2000);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(metadataService.getMetadata("session-1")?.aiTitle).toBe(
        "回答完成后标题",
      );
    } finally {
      service.stop();
      vi.useRealTimers();
    }
  });

  it("generates for completed unowned sessions discovered from disk", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"历史完成会话"}' } }],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () => createSession(),
    });

    try {
      service.start();
      eventBus.emit({
        type: "session-created",
        session: createSession({
          messageCount: 2,
          ownership: { owner: "none" },
        }),
        timestamp: "2026-01-01T00:00:00Z",
      });
      await vi.advanceTimersByTimeAsync(2000);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(metadataService.getMetadata("session-1")?.aiTitle).toBe(
        "历史完成会话",
      );
    } finally {
      service.stop();
      vi.useRealTimers();
    }
  });

  it("generates for unowned sessions after the parser discovers messages", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"解析后标题"}' } }],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () => createSession(),
    });

    try {
      service.start();
      eventBus.emit({
        type: "session-created",
        session: createSession({
          title: null,
          fullTitle: null,
          messageCount: 0,
          ownership: { owner: "none" },
        }),
        timestamp: "2026-01-01T00:00:00Z",
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchMock).not.toHaveBeenCalled();

      eventBus.emit({
        type: "session-updated",
        sessionId: "session-1",
        projectId: "project-1" as UrlProjectId,
        title: "等解析完成后再生成标题",
        messageCount: 2,
        timestamp: "2026-01-01T00:00:01Z",
      });
      await vi.advanceTimersByTimeAsync(2000);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(metadataService.getMetadata("session-1")?.aiTitle).toBe(
        "解析后标题",
      );
    } finally {
      service.stop();
      vi.useRealTimers();
    }
  });

  it("coalesces duplicate bridge and database update events for one session", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"title":"Refactor duplicated logic"}' } },
          ],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () => createSession(),
    });

    try {
      service.start();
      for (const timestamp of [
        "2026-01-01T00:00:01Z",
        "2026-01-01T00:00:01.001Z",
      ]) {
        eventBus.emit({
          type: "session-updated",
          sessionId: "session-1",
          projectId: "project-1" as UrlProjectId,
          messageCount: 2,
          timestamp,
        });
      }
      await vi.advanceTimersByTimeAsync(2_000);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(metadataService.getMetadata("session-1")?.aiTitle).toBe(
        "Refactor duplicated logic",
      );
    } finally {
      service.stop();
      vi.useRealTimers();
    }
  });

  it("generates for terminal-created Codex sessions on external updates", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"终端会话标题"}' } }],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          provider: "codex",
          messages: [
            {
              type: "user",
              message: { role: "user", content: "从终端启动 Codex CLI" },
            },
            {
              type: "assistant",
              codexMessagePhase: "final_answer",
              message: {
                role: "assistant",
                content: "终端 Codex 会话已经完成回答。",
              },
            },
          ],
        }),
    });

    try {
      service.start();
      eventBus.emit({
        type: "session-created",
        session: createSession({
          provider: "codex",
          title: null,
          fullTitle: null,
          messageCount: 0,
          ownership: { owner: "external" },
        }),
        timestamp: "2026-01-01T00:00:00Z",
      });
      eventBus.emit({
        type: "session-updated",
        sessionId: "session-1",
        projectId: "project-1" as UrlProjectId,
        title: "从终端启动 Codex CLI",
        messageCount: 2,
        timestamp: "2026-01-01T00:00:01Z",
      });
      await vi.advanceTimersByTimeAsync(2000);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(metadataService.getMetadata("session-1")?.aiTitle).toBe(
        "终端会话标题",
      );
    } finally {
      service.stop();
      vi.useRealTimers();
    }
  });

  it("backfills a recent session completed while the service was offline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T08:00:00Z"));
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"重启期间完成会话"}' } }],
        }),
        { status: 200 },
      );
    });
    const scanRecentSessions = vi.fn(async () => ({
      candidates: [
        {
          sessionId: "offline-session",
          projectId: "project-1" as UrlProjectId,
          updatedAt: "2026-07-14T07:59:00Z",
          messageCount: 2,
        },
      ],
      scannedProjects: 1,
      scannedSessions: 1,
    }));
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      scanRecentSessions,
      fetchImpl: fetchMock,
      loadSession: async (sessionId) => createSession({ id: sessionId }),
    });

    try {
      service.start();
      await service.waitForStartupBackfill();

      expect(scanRecentSessions).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(metadataService.getMetadata("offline-session")?.aiTitle).toBe(
        "重启期间完成会话",
      );
    } finally {
      service.stop();
      vi.useRealTimers();
    }
  });

  it("retries 429 and empty model output with bounded backoff", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: null } }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"title":"退避重试成功"}' } }],
          }),
          { status: 200 },
        ),
      );
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      retryMaxAttempts: 3,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 1_000,
      fetchImpl: fetchMock,
      loadSession: async () => createSession(),
    });

    try {
      const generation = service.generateForSession(
        "session-1",
        "project-1" as UrlProjectId,
      );
      await vi.runAllTimersAsync();
      await generation;

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(metadataService.getMetadata("session-1")?.aiTitle).toBe(
        "退避重试成功",
      );
    } finally {
      service.stop();
      vi.useRealTimers();
    }
  });

  it("bounds startup backfill by time window, candidate limit, and project limit", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-14T08:00:00Z");
    vi.setSystemTime(now);
    const candidates = [
      {
        sessionId: "too-old",
        projectId: "project-1" as UrlProjectId,
        updatedAt: "2026-07-10T07:59:59Z",
        messageCount: 2,
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        sessionId: `recent-${index}`,
        projectId: "project-1" as UrlProjectId,
        updatedAt: `2026-07-14T07:${String(50 - index).padStart(2, "0")}:00Z`,
        messageCount: 2,
      })),
    ];
    const scanRecentSessions = vi.fn(async () => ({
      candidates,
      scannedProjects: 3,
      scannedSessions: 200,
    }));
    const loadSession = vi.fn(async (sessionId: string) =>
      createSession({ id: sessionId }),
    );
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"title":"有限启动回补"}' } }],
          }),
          { status: 200 },
        ),
    );
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      startupBackfillWindowMs: 4 * 24 * 60 * 60 * 1000,
      startupBackfillLimit: 2,
      startupBackfillConcurrency: 1,
      startupBackfillMaxProjects: 3,
      scanRecentSessions,
      fetchImpl: fetchMock,
      loadSession,
    });

    try {
      service.start();
      await service.waitForStartupBackfill();

      expect(scanRecentSessions).toHaveBeenCalledWith({
        updatedAfterMs: now.getTime() - 4 * 24 * 60 * 60 * 1000,
        limit: 2,
        maxProjects: 3,
      });
      expect(loadSession).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(loadSession).not.toHaveBeenCalledWith(
        "too-old",
        expect.anything(),
      );
    } finally {
      service.stop();
      vi.useRealTimers();
    }
  });

  it("prioritizes invalid provider titles within the startup backfill limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T08:00:00Z"));
    const loadSession = vi.fn(async (sessionId: string) =>
      createSession({ id: sessionId }),
    );
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"title":"Recovered provider title"}' } },
          ],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      startupBackfillLimit: 1,
      scanRecentSessions: async () => ({
        candidates: [
          {
            sessionId: "ordinary-untitled",
            projectId: "project-1" as UrlProjectId,
            updatedAt: "2026-07-14T07:59:59Z",
            messageCount: 2,
          },
          {
            sessionId: "invalid-provider-title",
            projectId: "project-1" as UrlProjectId,
            updatedAt: "2026-07-14T07:59:58Z",
            messageCount: 2,
            providerTitleInvalid: true,
          },
        ],
        scannedProjects: 1,
        scannedSessions: 2,
      }),
      fetchImpl: fetchMock,
      loadSession,
    });

    try {
      service.start();
      await service.waitForStartupBackfill();

      expect(loadSession).toHaveBeenCalledOnce();
      expect(loadSession).toHaveBeenCalledWith(
        "invalid-provider-title",
        "project-1",
      );
      expect(
        metadataService.getMetadata("invalid-provider-title")?.aiTitle,
      ).toBe("Recovered provider title");
      expect(metadataService.getMetadata("ordinary-untitled")).toBeUndefined();
    } finally {
      service.stop();
      vi.useRealTimers();
    }
  });

  it("caps concurrent startup backfill model requests", async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const releases: Array<() => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          activeRequests += 1;
          maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
          releases.push(() => {
            activeRequests -= 1;
            resolve(
              new Response(
                JSON.stringify({
                  choices: [
                    { message: { content: '{"title":"并发受控回补"}' } },
                  ],
                }),
                { status: 200 },
              ),
            );
          });
        }),
    );
    const waitForFetchCalls = async (expected: number) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (fetchMock.mock.calls.length >= expected) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      expect(fetchMock).toHaveBeenCalledTimes(expected);
    };
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      startupBackfillLimit: 3,
      startupBackfillConcurrency: 2,
      scanRecentSessions: async () => ({
        candidates: ["concurrent-1", "concurrent-2", "concurrent-3"].map(
          (sessionId) => ({
            sessionId,
            projectId: "project-1" as UrlProjectId,
            updatedAt: new Date().toISOString(),
            messageCount: 2,
          }),
        ),
        scannedProjects: 1,
        scannedSessions: 3,
      }),
      fetchImpl: fetchMock,
      loadSession: async (sessionId) => createSession({ id: sessionId }),
    });

    try {
      service.start();
      await waitForFetchCalls(2);
      expect(maxActiveRequests).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      releases.shift()?.();
      await waitForFetchCalls(3);
      expect(maxActiveRequests).toBe(2);

      for (const release of releases.splice(0)) release();
      await service.waitForStartupBackfill();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      service.stop();
    }
  });

  it("does not load or overwrite titled startup backfill candidates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T08:00:00Z"));
    await metadataService.setTitle("custom-session", "Manual Title");
    await metadataService.setAiTitle("ai-session", "Existing AI Title");
    const loadSession = vi.fn(async () => createSession());
    const fetchMock = vi.fn();
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      scanRecentSessions: async () => ({
        candidates: ["custom-session", "ai-session"].map((sessionId) => ({
          sessionId,
          projectId: "project-1" as UrlProjectId,
          updatedAt: "2026-07-14T07:59:00Z",
          messageCount: 2,
        })),
        scannedProjects: 1,
        scannedSessions: 2,
      }),
      fetchImpl: fetchMock,
      loadSession,
    });

    try {
      service.start();
      await service.waitForStartupBackfill();

      expect(loadSession).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(metadataService.getMetadata("custom-session")?.customTitle).toBe(
        "Manual Title",
      );
      expect(metadataService.getMetadata("ai-session")?.aiTitle).toBe(
        "Existing AI Title",
      );
    } finally {
      service.stop();
      vi.useRealTimers();
    }
  });

  it("does not overwrite a custom title", async () => {
    await metadataService.setTitle("session-1", "Manual Title");
    const fetchMock = vi.fn();
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () => createSession(),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(metadataService.getMetadata("session-1")).toEqual({
      customTitle: "Manual Title",
    });
  });

  it("skips slash command sessions", async () => {
    const fetchMock = vi.fn();
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          title: "/commit",
          fullTitle: "/commit",
          messages: [
            {
              type: "user",
              message: { role: "user", content: "/commit" },
            },
            {
              type: "assistant",
              message: { role: "assistant", content: "Done." },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(metadataService.getMetadata("session-1")).toBeUndefined();
  });

  it("generates a title for git commit push workflow sessions", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"title":"Review and publish changes"}' } },
          ],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          provider: "codex",
          title: "$git-commit-push",
          fullTitle: "$git-commit-push",
          messages: [
            {
              type: "user",
              message: { role: "user", content: "$git-commit-push" },
            },
            {
              type: "assistant",
              message: {
                role: "assistant",
                content: "I reviewed, committed, and pushed the changes.",
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(metadataService.getMetadata("session-1")?.aiTitle).toBe(
      "Review and publish changes",
    );
  });

  it("does not skip an expanded command prompt that only contains a slash command", async () => {
    const expandedPrompt = [
      "# /bm-analyze-run-result",
      "",
      "请分析 Benchmark Run #58 的失败模式。",
    ].join("\n");
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"title":"分析 Run #58 失败模式"}' } },
          ],
        }),
        { status: 200 },
      );
    });
    const service = new SessionTitleService({
      eventBus,
      metadataService,
      apiKey: "test-key",
      minRetryIntervalMs: 0,
      fetchImpl: fetchMock,
      loadSession: async () =>
        createSession({
          title: expandedPrompt,
          fullTitle: expandedPrompt,
          messages: [
            {
              type: "user",
              message: { role: "user", content: expandedPrompt },
            },
            {
              type: "assistant",
              message: {
                role: "assistant",
                content: "已完成失败模式分析。",
              },
            },
          ],
        }),
    });

    await service.generateForSession("session-1", "project-1" as UrlProjectId);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(metadataService.getMetadata("session-1")?.aiTitle).toBe(
      "分析 Run #58 失败模式",
    );
  });
});
