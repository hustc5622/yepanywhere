import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentContentProvider } from "../../contexts/AgentContentContext";
import { SchemaValidationProvider } from "../../contexts/SchemaValidationContext";
import { SessionMetadataProvider } from "../../contexts/SessionMetadataContext";
import { ToastProvider } from "../../contexts/ToastContext";
import type { AgentContentMap } from "../../hooks/useSession";
import { I18nProvider } from "../../i18n";
import { preprocessMessages } from "../../lib/preprocessMessages";
import type { Message } from "../../types";
import { RenderItemComponent } from "../RenderItemComponent";
import { taskRenderer } from "../renderers/tools/TaskRenderer";
import type { RenderContext } from "../renderers/types";

// Sample agent messages for testing
const sampleAgentMessages: Message[] = [
  {
    id: "msg-1",
    type: "assistant",
    role: "assistant",
    content: [{ type: "text", text: "Searching for tree files..." }],
  },
  {
    id: "msg-2",
    type: "assistant",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tool-1",
        name: "Grep",
        input: { pattern: "tree" },
      },
    ],
  },
  {
    id: "msg-3",
    type: "user",
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "Found 5 matches",
      },
    ],
  },
];

// Wrapper component with AgentContentProvider and SessionMetadataProvider
function TestWrapper({
  children,
  agentContent = {},
  toolUseToAgent = new Map(),
  toolUseToAgentIds = new Map(),
}: {
  children: React.ReactNode;
  agentContent?: AgentContentMap;
  toolUseToAgent?: Map<string, string>;
  toolUseToAgentIds?: Map<string, string[]>;
}) {
  return (
    <I18nProvider>
      <SessionMetadataProvider
        projectId="proj-1"
        projectPath="/test/project"
        sessionId="session-1"
      >
        <ToastProvider>
          <SchemaValidationProvider>
            <AgentContentProvider
              agentContent={agentContent}
              setAgentContent={() => {}}
              toolUseToAgent={toolUseToAgent}
              toolUseToAgentIds={toolUseToAgentIds}
              projectId="proj-1"
              sessionId="session-1"
            >
              {children}
            </AgentContentProvider>
          </SchemaValidationProvider>
        </ToastProvider>
      </SessionMetadataProvider>
    </I18nProvider>
  );
}

const renderCtx = (toolUseId: string): RenderContext =>
  ({ isStreaming: false, theme: "dark", toolUseId }) as RenderContext;

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => {
        store.clear();
      }),
    },
  });
});

describe("AgentContentProvider", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders children correctly", () => {
    render(
      <TestWrapper>
        <div data-testid="test-child">Hello</div>
      </TestWrapper>,
    );

    expect(screen.getByTestId("test-child")).toBeDefined();
  });

  it("provides agent content through context", () => {
    const agentContent: AgentContentMap = {
      "agent-abc123": {
        messages: sampleAgentMessages,
        status: "completed",
      },
    };

    render(
      <TestWrapper agentContent={agentContent}>
        <div>Test</div>
      </TestWrapper>,
    );

    // Provider renders without error
    expect(screen.getByText("Test")).toBeDefined();
  });

  it("provides empty content for unknown agent", () => {
    const agentContent: AgentContentMap = {};

    render(
      <TestWrapper agentContent={agentContent}>
        <div>Test</div>
      </TestWrapper>,
    );

    // Provider renders without error even with empty content
    expect(screen.getByText("Test")).toBeDefined();
  });
});

describe("AgentContent data structures", () => {
  it("tracks agent messages correctly", () => {
    const agentContent: AgentContentMap = {
      "agent-1": {
        messages: [
          { id: "m1", type: "assistant", content: "Hello" },
          { id: "m2", type: "assistant", content: "World" },
        ],
        status: "running",
      },
      "agent-2": {
        messages: [{ id: "m3", type: "assistant", content: "Done" }],
        status: "completed",
      },
    };

    expect(agentContent["agent-1"]?.messages.length).toBe(2);
    expect(agentContent["agent-2"]?.status).toBe("completed");
    expect(agentContent["agent-3"]).toBeUndefined();
  });

  it("supports different agent statuses", () => {
    const statuses = ["pending", "running", "completed", "failed"] as const;

    for (const status of statuses) {
      const content: AgentContentMap = {
        agent: { messages: [], status },
      };
      expect(content.agent?.status).toBe(status);
    }
  });
});

describe("Task rendering", () => {
  it("renders persisted Agent summaries when expanded without lazy-loaded subagent content", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Agent",
            input: {
              description: "Explore codebase for refactoring",
              prompt: "Find cleanup opportunities",
              subagent_type: "Explore",
            },
          },
        ],
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [
              {
                type: "text",
                text: "## Comprehensive Cleanup and Refactoring Opportunities Report",
              },
              {
                type: "text",
                text: "agentId: summary123\n<usage>total_tokens: 200\ntool_uses: 3\nduration_ms: 1000</usage>",
              },
            ],
          },
        ],
      },
    ];
    const [item] = preprocessMessages(messages);

    expect(item?.type).toBe("tool_call");
    if (!item || item.type !== "tool_call") {
      throw new Error("Expected a tool_call render item");
    }
    const itemWithoutAgentLookup = {
      ...item,
      toolResult: item.toolResult
        ? {
            ...item.toolResult,
            structured:
              item.toolResult.structured &&
              typeof item.toolResult.structured === "object"
                ? {
                    ...(item.toolResult.structured as Record<string, unknown>),
                    agentId: undefined,
                  }
                : item.toolResult.structured,
          }
        : item.toolResult,
    };

    render(
      <TestWrapper>
        <RenderItemComponent
          item={itemWithoutAgentLookup}
          isStreaming={false}
          thinkingExpanded={false}
          toggleThinkingExpanded={() => {}}
        />
      </TestWrapper>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Explore codebase for refactoring/i }),
    );

    expect(
      screen.getByText(/Comprehensive Cleanup and Refactoring Opportunities/i),
    ).toBeDefined();
    expect(screen.queryByText(/agentId:\s*summary123/i)).toBeNull();
  });
});

const TASK_INPUT = {
  description: "探索 api-testing 后端架构",
  prompt: "explore backend",
  subagent_type: "explore",
};

describe("TaskRenderer subagent header stats", () => {
  afterEach(() => cleanup());

  it("renders completed stats (ctx + total + tools + duration), no fake zeros", () => {
    const agentContent: AgentContentMap = {
      "agent-0": {
        messages: sampleAgentMessages,
        status: "completed",
        agentType: "explore",
        metrics: {
          toolUseCount: 33,
          stepCount: 13,
          durationMs: 265103,
          usage: { contextTokens: 66963, totalTokens: 596509 },
        },
        descriptor: {
          agentId: "agent-0",
          status: "completed",
          type: "explore",
          startedAt: new Date(0).toISOString(),
          completedAt: new Date(265103).toISOString(),
        },
      },
    };
    render(
      <TestWrapper
        agentContent={agentContent}
        toolUseToAgent={new Map([["Agent_0", "agent-0"]])}
        toolUseToAgentIds={new Map([["Agent_0", ["agent-0"]]])}
      >
        {taskRenderer.renderInline?.(
          TASK_INPUT,
          undefined,
          false,
          "complete",
          renderCtx("Agent_0"),
        )}
      </TestWrapper>,
    );
    expect(screen.getByText("4m 25s")).toBeDefined();
    expect(screen.getByText("33 tools")).toBeDefined();
    expect(screen.getByText("67K ctx")).toBeDefined();
    expect(screen.getByText("596.5K total")).toBeDefined();
    expect(screen.getByText("completed")).toBeDefined();
    // No misleading zero placeholders.
    expect(screen.queryByText(/0ms/)).toBeNull();
    expect(screen.queryByText(/0 tokens/)).toBeNull();
  });

  it("localizes stat labels in the Chinese UI", async () => {
    vi.mocked(localStorage.getItem).mockReturnValue("zh-CN");
    const agentContent: AgentContentMap = {
      "agent-0": {
        messages: [],
        status: "completed",
        metrics: {
          toolUseCount: 33,
          durationMs: 265103,
          usage: { contextTokens: 66963, totalTokens: 596509 },
        },
        descriptor: { agentId: "agent-0", status: "completed" },
      },
    };

    render(
      <TestWrapper
        agentContent={agentContent}
        toolUseToAgentIds={new Map([["Agent_0", ["agent-0"]]])}
      >
        {taskRenderer.renderInline?.(
          TASK_INPUT,
          undefined,
          false,
          "complete",
          renderCtx("Agent_0"),
        )}
      </TestWrapper>,
    );

    expect(await screen.findByText("4分 25秒")).toBeDefined();
    expect(screen.getByText("33 个工具")).toBeDefined();
    expect(screen.getByText("上下文 67K")).toBeDefined();
    expect(screen.getByText("总计 596.5K")).toBeDefined();
  });

  it("hides missing metrics instead of rendering zeros", () => {
    const agentContent: AgentContentMap = {
      "agent-0": {
        messages: [],
        status: "running",
        agentType: "explore",
        // metrics intentionally absent
        descriptor: { agentId: "agent-0", status: "running", type: "explore" },
      },
    };
    render(
      <TestWrapper
        agentContent={agentContent}
        toolUseToAgentIds={new Map([["Agent_0", ["agent-0"]]])}
      >
        {taskRenderer.renderInline?.(
          TASK_INPUT,
          undefined,
          false,
          "pending",
          renderCtx("Agent_0"),
        )}
      </TestWrapper>,
    );
    expect(screen.getByText("running")).toBeDefined();
    expect(screen.queryByText(/0 tools/)).toBeNull();
    expect(screen.queryByText(/0s/)).toBeNull();
    expect(screen.queryByText(/0 tokens/)).toBeNull();
  });

  it("renders interrupted status with a note when expanded", () => {
    const agentContent: AgentContentMap = {
      "agent-0": {
        messages: sampleAgentMessages,
        status: "failed",
        descriptor: {
          agentId: "agent-0",
          status: "interrupted",
          type: "explore",
        },
      },
    };
    render(
      <TestWrapper
        agentContent={agentContent}
        toolUseToAgentIds={new Map([["Agent_0", ["agent-0"]]])}
      >
        {taskRenderer.renderInline?.(
          TASK_INPUT,
          undefined,
          false,
          "pending",
          renderCtx("Agent_0"),
        )}
      </TestWrapper>,
    );
    expect(screen.getByText("interrupted")).toBeDefined();
  });
});

describe("TaskRenderer AgentSwarm fan-out", () => {
  afterEach(() => cleanup());

  it("uses the completed parent status while member details are loading", () => {
    render(
      <TestWrapper
        toolUseToAgentIds={new Map([["AgentSwarm_0", ["agent-0", "agent-1"]]])}
      >
        {taskRenderer.renderInline?.(
          { ...TASK_INPUT, description: "parallel explore" },
          undefined,
          false,
          "complete",
          renderCtx("AgentSwarm_0"),
        )}
      </TestWrapper>,
    );

    expect(screen.getByText("2 done")).toBeDefined();
    expect(screen.queryByText("2 running")).toBeNull();
  });

  it("renders all swarm members, not just the first child", () => {
    const agentContent: AgentContentMap = {
      "agent-0": {
        messages: [],
        status: "completed",
        agentType: "explore",
        metrics: { toolUseCount: 33, usage: { totalTokens: 596509 } },
        descriptor: {
          agentId: "agent-0",
          status: "completed",
          type: "explore",
          description: "后端探索",
          swarmIndex: 0,
        },
      },
      "agent-1": {
        messages: [],
        status: "failed",
        agentType: "explore",
        metrics: { toolUseCount: 19, usage: { totalTokens: 207971 } },
        descriptor: {
          agentId: "agent-1",
          status: "failed",
          type: "explore",
          description: "前端探索",
          swarmIndex: 1,
        },
      },
    };
    render(
      <TestWrapper
        agentContent={agentContent}
        toolUseToAgentIds={new Map([["AgentSwarm_0", ["agent-0", "agent-1"]]])}
      >
        {taskRenderer.renderInline?.(
          { ...TASK_INPUT, description: "parallel explore" },
          undefined,
          false,
          "pending",
          renderCtx("AgentSwarm_0"),
        )}
      </TestWrapper>,
    );
    // Both members visible.
    expect(screen.getByText("后端探索")).toBeDefined();
    expect(screen.getByText("前端探索")).toBeDefined();
    // Aggregate member count + per-status counts.
    expect(screen.getByText("2 agents")).toBeDefined();
    expect(screen.getByText("1 done")).toBeDefined();
    expect(screen.getByText("1 failed")).toBeDefined();
    // Both child agent ids are surfaced.
    expect(screen.getByText("agent-0")).toBeDefined();
    expect(screen.getByText("agent-1")).toBeDefined();
  });

  it("restores swarm members after reload (from loaded agentContent)", () => {
    // Simulates page reload: no live stream, content came from getAgentSession.
    const agentContent: AgentContentMap = {
      "agent-0": {
        messages: sampleAgentMessages,
        status: "completed",
        descriptor: {
          agentId: "agent-0",
          status: "completed",
          type: "explore",
        },
      },
      "agent-1": {
        messages: sampleAgentMessages,
        status: "completed",
        descriptor: {
          agentId: "agent-1",
          status: "completed",
          type: "explore",
        },
      },
    };
    render(
      <TestWrapper
        agentContent={agentContent}
        toolUseToAgentIds={new Map([["AgentSwarm_0", ["agent-0", "agent-1"]]])}
      >
        {taskRenderer.renderInline?.(
          { ...TASK_INPUT, description: "parallel explore" },
          undefined,
          false,
          "complete",
          renderCtx("AgentSwarm_0"),
        )}
      </TestWrapper>,
    );
    expect(screen.getByText("2 agents")).toBeDefined();
    expect(screen.getByText("2 done")).toBeDefined();
  });
});
