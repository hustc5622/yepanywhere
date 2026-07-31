import { describe, expect, it } from "vitest";
import type { ContentBlock } from "../../types";
import { parseAgentResultFromText } from "../preprocessMessages";

// parseAgentResultFromText handles both string and array content at runtime,
// even though the ContentBlock type only declares string for tool_result.
// Use helper to cast array-content blocks for testing.
function block(content: unknown): ContentBlock {
  return {
    type: "tool_result",
    tool_use_id: "tool-1",
    content,
  } as ContentBlock;
}

describe("parseAgentResultFromText", () => {
  it("parses agentId and usage from standard SDK output", () => {
    const result = parseAgentResultFromText(
      block([
        {
          type: "text",
          text: "agentId: a1dd713c82c78b9ed (for resuming to continue this agent's work if needed)\n<usage>total_tokens: 59286\ntool_uses: 19\nduration_ms: 42110</usage>",
        },
      ]),
    );
    expect(result).toEqual({
      agentId: "a1dd713c82c78b9ed",
      status: "completed",
      totalTokens: 59286,
      totalToolUseCount: 19,
      totalDurationMs: 42110,
    });
  });

  it("parses agentId when content is a string", () => {
    const result = parseAgentResultFromText(
      block(
        "agentId: abc123 (for resuming)\n<usage>total_tokens: 100\ntool_uses: 2\nduration_ms: 500</usage>",
      ),
    );
    expect(result).toEqual({
      agentId: "abc123",
      status: "completed",
      totalTokens: 100,
      totalToolUseCount: 2,
      totalDurationMs: 500,
    });
  });

  it("parses agentId without usage block", () => {
    const result = parseAgentResultFromText(
      block("agentId: abc123 (for resuming)"),
    );
    expect(result).toEqual({
      agentId: "abc123",
      status: "completed",
    });
  });

  it("returns undefined when no agentId present", () => {
    expect(
      parseAgentResultFromText(block("Some random tool result text")),
    ).toBeUndefined();
  });

  it("returns undefined for empty content", () => {
    expect(parseAgentResultFromText(block(""))).toBeUndefined();
  });

  it("returns undefined for empty content array", () => {
    expect(parseAgentResultFromText(block([]))).toBeUndefined();
  });

  it("handles partial usage block (only tokens)", () => {
    const result = parseAgentResultFromText(
      block("agentId: xyz789\n<usage>total_tokens: 5000</usage>"),
    );
    expect(result).toEqual({
      agentId: "xyz789",
      status: "completed",
      totalTokens: 5000,
    });
  });

  it("handles multi-block content arrays", () => {
    const result = parseAgentResultFromText(
      block([
        { type: "text", text: "agentId: multi123" },
        {
          type: "text",
          text: "<usage>total_tokens: 200\ntool_uses: 3\nduration_ms: 1000</usage>",
        },
      ]),
    );
    expect(result).toEqual({
      agentId: "multi123",
      status: "completed",
      totalTokens: 200,
      totalToolUseCount: 3,
      totalDurationMs: 1000,
    });
  });

  it("preserves human-readable agent summary content", () => {
    const result = parseAgentResultFromText(
      block([
        {
          type: "text",
          text: "## Comprehensive Cleanup and Refactoring Opportunities Report",
        },
        {
          type: "text",
          text: "agentId: summary123 (use SendMessage to continue)\n<usage>total_tokens: 200\ntool_uses: 3\nduration_ms: 1000</usage>",
        },
      ]),
    );
    expect(result).toEqual({
      agentId: "summary123",
      status: "completed",
      content: [
        {
          type: "text",
          text: "## Comprehensive Cleanup and Refactoring Opportunities Report",
        },
      ],
      totalTokens: 200,
      totalToolUseCount: 3,
      totalDurationMs: 1000,
    });
  });

  it("ignores non-text content blocks", () => {
    const result = parseAgentResultFromText(
      block([
        { type: "image", source: { data: "base64" } },
        { type: "text", text: "agentId: img123" },
      ]),
    );
    expect(result?.agentId).toBe("img123");
  });

  it("parses a completed kimi Agent result", () => {
    const result = parseAgentResultFromText(
      block(
        "agent_id: agent-1\nactual_subagent_type: explore\nstatus: completed\n\n[summary]\nbackend findings",
      ),
    );
    expect(result?.agentId).toBe("agent-1");
    expect(result?.status).toBe("completed");
  });

  it("marks an interrupted kimi Agent result as failed", () => {
    const result = parseAgentResultFromText(
      block(
        "agent_id: agent-0\nactual_subagent_type: explore\nstatus: failed\n\nsubagent error: interrupted",
      ),
    );
    expect(result?.agentId).toBe("agent-0");
    expect(result?.status).toBe("failed");
  });

  it("uses the first AgentSwarm child for the one-to-one Task renderer", () => {
    const result = parseAgentResultFromText(
      block(
        '<agent_swarm_result><subagent agent_id="agent-0" outcome="completed">frontend findings</subagent><subagent agent_id="agent-1" outcome="failed">backend error</subagent></agent_swarm_result>',
      ),
    );
    expect(result?.agentId).toBe("agent-0");
    expect(result?.status).toBe("completed");
  });

  it("marks a failed first AgentSwarm child as failed", () => {
    const result = parseAgentResultFromText(
      block(
        "<agent_swarm_result><subagent outcome='failed' agent_id='agent-0'>interrupted</subagent></agent_swarm_result>",
      ),
    );
    expect(result?.agentId).toBe("agent-0");
    expect(result?.status).toBe("failed");
  });
});
