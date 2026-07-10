import { describe, expect, it } from "vitest";
import { getCodexSubagentMetadata } from "../../src/codex/subagent.js";

describe("getCodexSubagentMetadata", () => {
  it("normalizes rollout JSONL subagent metadata", () => {
    expect(
      getCodexSubagentMetadata({
        id: "child-thread",
        session_id: "parent-thread",
        parent_thread_id: "parent-thread",
        thread_source: "subagent",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "parent-thread",
              depth: 1,
              agent_path: "/root/review_runtime",
              agent_nickname: "Laplace",
              agent_role: "reviewer",
            },
          },
        },
      }),
    ).toEqual({
      isSubagent: true,
      parentThreadId: "parent-thread",
      agentPath: "/root/review_runtime",
      agentNickname: "Laplace",
      agentRole: "reviewer",
      depth: 1,
    });
  });

  it("normalizes app-server camelCase thread metadata", () => {
    expect(
      getCodexSubagentMetadata({
        id: "child-thread",
        parentThreadId: "parent-thread",
        threadSource: "subagent",
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "parent-thread",
              depth: 2,
              agent_path: "/root/review/nested",
              agent_nickname: "Noether",
              agent_role: null,
            },
          },
        },
        agentNickname: "Noether",
      }),
    ).toMatchObject({
      isSubagent: true,
      parentThreadId: "parent-thread",
      agentPath: "/root/review/nested",
      agentNickname: "Noether",
      depth: 2,
    });
  });

  it("does not classify an ordinary user fork as a subagent", () => {
    expect(
      getCodexSubagentMetadata({
        id: "fork-thread",
        forked_from_id: "original-thread",
        source: "vscode",
        thread_source: "user",
      }),
    ).toEqual({
      isSubagent: false,
      parentThreadId: undefined,
      agentPath: undefined,
      agentNickname: undefined,
      agentRole: undefined,
      depth: undefined,
    });
  });

  it("recognizes non-thread-spawn internal subagent sources", () => {
    expect(
      getCodexSubagentMetadata({ source: { subAgent: "review" } }),
    ).toMatchObject({ isSubagent: true });
  });
});
