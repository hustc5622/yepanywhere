import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeSessionEntry, UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preprocessMessages } from "../../../client/src/lib/preprocessMessages.ts";
import { encodeProjectId } from "../../src/projects/paths.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import {
  SessionReader,
  computeCompactionOverhead,
} from "../../src/sessions/reader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures", "agents");

function messageText(message: { message?: { content?: unknown } }): string {
  const content = message.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      return "text" in block && typeof block.text === "string"
        ? block.text
        : "";
    })
    .join("\n");
}

describe("SessionReader", () => {
  let testDir: string;
  let reader: SessionReader;

  beforeEach(async () => {
    testDir = join(tmpdir(), `claude-reader-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    reader = new SessionReader({ sessionDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("title extraction", () => {
    it.each(["isSynthetic", "isMeta", "isCompactSummary"])(
      "skips Claude user entries marked %s when choosing the title and questions",
      async (metadataFlag) => {
        const sessionId = `test-session-${metadataFlag}`;
        const internalUuid = randomUUID();
        const userUuid = randomUUID();
        const assistantUuid = randomUUID();
        const jsonl = [
          {
            type: "user",
            uuid: internalUuid,
            parentUuid: null,
            message: { content: "Internal Claude context" },
            [metadataFlag]: true,
          },
          {
            type: "user",
            uuid: userUuid,
            parentUuid: internalUuid,
            message: { content: "Actual user request" },
          },
          {
            type: "assistant",
            uuid: assistantUuid,
            parentUuid: userUuid,
            message: { content: "Actual assistant response" },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n");
        await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

        const summary = await reader.getSessionSummary(
          sessionId,
          "test-project" as UrlProjectId,
        );
        const session = await reader.getSession(
          sessionId,
          "test-project" as UrlProjectId,
        );

        expect(summary?.title).toBe("Actual user request");
        expect(
          summary?.userQuestions?.map((question) => question.text),
        ).toEqual(["Actual user request"]);
        expect(
          session?.branchState?.branches.map((branch) => branch.prompt),
        ).toEqual(["Actual user request"]);
      },
    );

    it("only lists sessions whose jsonl cwd matches the requested project", async () => {
      const projectOne = "/Users/test/code/project-one";
      const projectTwo = "/Users/test/code/project-two";
      await writeFile(
        join(testDir, "one.jsonl"),
        `${JSON.stringify({
          type: "user",
          cwd: projectOne,
          message: { content: "Project one" },
          uuid: "msg-one",
          timestamp: new Date().toISOString(),
        })}\n`,
      );
      await writeFile(
        join(testDir, "two.jsonl"),
        `${JSON.stringify({
          type: "user",
          cwd: projectTwo,
          message: { content: "Project two" },
          uuid: "msg-two",
          timestamp: new Date().toISOString(),
        })}\n`,
      );

      const sessions = await reader.listSessions(encodeProjectId(projectOne));
      expect(sessions.map((session) => session.id)).toEqual(["one"]);
      await expect(
        reader.getSessionSummary("two", encodeProjectId(projectOne)),
      ).resolves.toBeNull();
    });

    it("skips ide_opened_file blocks and uses actual message", async () => {
      const sessionId = "test-session-1";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<ide_opened_file>The user opened the file /path/to/file.ts in the IDE. This may or may not be related.</ide_opened_file>",
            },
            {
              type: "text",
              text: "What does this function do?",
            },
          ],
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );
      expect(summary?.title).toBe("What does this function do?");
    });

    it("skips ide_selection blocks and uses actual message", async () => {
      const sessionId = "test-session-2";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<ide_selection>The user selected lines 1-10 from /path/file.ts:\nfunction foo() { }</ide_selection>",
            },
            {
              type: "text",
              text: "Can you explain this code?",
            },
          ],
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      expect(summary?.title).toBe("Can you explain this code?");
    });

    it("handles messages with only IDE metadata", async () => {
      const sessionId = "test-session-3";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<ide_opened_file>The user opened the file /path/to/file.ts in the IDE.</ide_opened_file>",
            },
          ],
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      // When all blocks are IDE metadata, title is null (empty content)
      expect(summary?.title).toBeNull();
    });

    it("handles mixed IDE metadata and regular text in single block", async () => {
      const sessionId = "test-session-4";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content:
            "<ide_opened_file>The user opened file.ts in the IDE.</ide_opened_file>What is this?",
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      expect(summary?.title).toBe("What is this?");
    });

    it("strips bridge system context and timestamp from titles", async () => {
      const sessionId = "test-session-bridge-context";
      const userInput =
        "https://vrfi1sk8a0.feishu.cn/wiki/BzXJwNJgfiHYKSksrNjcHV45nUh分析一下文档写一份测试点";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: `[System Context] | User OpenID: ou_31154c68aa8af9fda1131980e4ac8b2d | Chat ID: oc_f756f60110c80e36dd6588374e1ddc49 | Chat Type: p2p | [/System Context]\n[2026/6/2 10:57:43] ${userInput}`,
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      expect(summary?.title).toBe(userInput);
      expect(summary?.fullTitle).toBe(userInput);
    });

    it("returns null title for bridge messages without user input", async () => {
      const sessionId = "test-session-bridge-context-only";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content:
            "[System Context]\nplatform: wechat\nuser_id: user-1\ntime: 2026/6/2 10:57:43\n[/System Context]\n[2026/6/2 10:57:43] ",
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      expect(summary?.title).toBeNull();
      expect(summary?.fullTitle).toBeNull();
    });

    it("truncates long titles to 120 chars with ellipsis", async () => {
      const sessionId = "test-session-5";
      const longMessage =
        "This is a very long message that should be truncated because it exceeds the maximum title length which is now 120 characters so we need an even longer test string here";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: longMessage,
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      expect(summary?.title?.length).toBe(120);
      expect(summary?.title?.endsWith("...")).toBe(true);
    });

    it("preserves short titles without truncation", async () => {
      const sessionId = "test-session-6";
      const shortMessage = "Short message";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: shortMessage,
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      expect(summary?.title).toBe("Short message");
    });

    it("returns null title for sessions with no user messages", async () => {
      const sessionId = "test-session-7";
      const jsonl = JSON.stringify({
        type: "assistant",
        message: {
          content: "Hello!",
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      expect(summary?.title).toBeNull();
    });

    it("handles multiple IDE metadata blocks followed by message", async () => {
      const sessionId = "test-session-8";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<ide_opened_file>The user opened file1.ts in the IDE.</ide_opened_file>",
            },
            {
              type: "text",
              text: "<ide_opened_file>The user opened file2.ts in the IDE.</ide_opened_file>",
            },
            {
              type: "text",
              text: "<ide_selection>Selected code here</ide_selection>",
            },
            {
              type: "text",
              text: "Help me refactor these files",
            },
          ],
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );
      expect(summary?.title).toBe("Help me refactor these files");
    });
  });

  describe("runtime config extraction", () => {
    it("extracts service tier from the latest assistant usage speed", async () => {
      const sessionId = "runtime-config-session";
      const now = new Date().toISOString();
      const lines = [
        JSON.stringify({
          type: "user",
          message: { content: "Hello" },
          uuid: "msg-1",
          timestamp: now,
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-2",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-5-20251101",
            content: [{ type: "text", text: "Older response" }],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              service_tier: "standard",
            },
          },
          uuid: "msg-2",
          timestamp: now,
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-3",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-5-20251101",
            content: [{ type: "text", text: "Latest response" }],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              speed: "fast",
              service_tier: "standard",
            },
          },
          uuid: "msg-3",
          timestamp: now,
        }),
      ];
      await writeFile(
        join(testDir, `${sessionId}.jsonl`),
        `${lines.join("\n")}\n`,
      );

      const summary = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );
      expect(summary?.model).toBe("claude-opus-4-5-20251101");
      expect(summary?.serviceTier).toBe("fast");
    });
  });

  describe("DAG handling", () => {
    it("returns only active branch messages, filtering dead branches", async () => {
      const sessionId = "dag-test-1";
      // Structure:
      // a -> b -> c (dead branch, earlier lineIndex)
      //   \-> d -> e (active branch, later lineIndex)
      const jsonl = [
        JSON.stringify({
          type: "user",
          uuid: "a",
          parentUuid: null,
          message: { content: "First" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "b",
          parentUuid: "a",
          message: { content: "Dead branch response" },
        }),
        JSON.stringify({
          type: "user",
          uuid: "c",
          parentUuid: "b",
          message: { content: "Dead branch follow-up" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "d",
          parentUuid: "a",
          message: { content: "Active branch response" },
        }),
        JSON.stringify({
          type: "user",
          uuid: "e",
          parentUuid: "d",
          message: { content: "Active branch follow-up" },
        }),
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const loadedSession = await reader.getSession(
        sessionId,
        "test-project" as UrlProjectId,
      );
      const session = loadedSession ? normalizeSession(loadedSession) : null;

      expect(session?.messages).toHaveLength(3); // a, d, e (not b, c)
      expect(session?.messages.map((m) => m.uuid)).toEqual(["a", "d", "e"]);
    });

    it("projects Claude prompt branches and annotates sibling choices", async () => {
      const sessionId = "dag-branch-test";
      const entries: ClaudeSessionEntry[] = [
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "2024-01-01T00:00:01Z",
          message: { role: "user", content: "q1" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: "2024-01-01T00:00:02Z",
          message: { role: "assistant", content: "a1" },
        },
        {
          type: "user",
          uuid: "u2-old",
          parentUuid: "a1",
          timestamp: "2024-01-01T00:00:03Z",
          message: { role: "user", content: "q2 old" },
        },
        {
          type: "assistant",
          uuid: "a2-old",
          parentUuid: "u2-old",
          timestamp: "2024-01-01T00:00:04Z",
          message: { role: "assistant", content: "a2 old" },
        },
        {
          type: "user",
          uuid: "u3-old",
          parentUuid: "a2-old",
          timestamp: "2024-01-01T00:00:05Z",
          message: { role: "user", content: "q3 old" },
        },
        {
          type: "assistant",
          uuid: "a3-old",
          parentUuid: "u3-old",
          timestamp: "2024-01-01T00:00:06Z",
          message: { role: "assistant", content: "a3 old" },
        },
        {
          type: "user",
          uuid: "u2-new",
          parentUuid: "a1",
          timestamp: "2024-01-01T00:00:10Z",
          message: { role: "user", content: "q2 new" },
        },
        {
          type: "assistant",
          uuid: "a2-new",
          parentUuid: "u2-new",
          timestamp: "2024-01-01T00:00:11Z",
          message: { role: "assistant", content: "a2 new" },
        },
      ];
      const jsonl = entries.map((entry) => JSON.stringify(entry)).join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const activeLoaded = await reader.getSession(
        sessionId,
        "test-project" as UrlProjectId,
      );
      const activeSession = activeLoaded
        ? normalizeSession(activeLoaded)
        : null;

      expect(activeSession?.messages.map(messageText)).toEqual([
        "q1",
        "a1",
        "q2 new",
        "a2 new",
      ]);
      expect(activeSession?.branchState?.activeBranchId).toBe("u2-new");
      expect(activeSession?.branchState?.selectedBranchId).toBe("u2-new");
      const activePrompt = activeSession?.messages.find(
        (message) => message.uuid === "u2-new",
      );
      expect(activePrompt?.branch).toMatchObject({
        branchId: "u2-new",
        siblingIndex: 2,
        siblingCount: 2,
      });
      expect(
        activePrompt?.branch?.alternatives.map((branch) => branch.id),
      ).toEqual(["u2-old", "u2-new"]);

      const oldLoaded = await reader.getSession(
        sessionId,
        "test-project" as UrlProjectId,
        undefined,
        { branchId: "u2-old" },
      );
      const oldSession = oldLoaded ? normalizeSession(oldLoaded) : null;

      expect(oldSession?.messages.map(messageText)).toEqual([
        "q1",
        "a1",
        "q2 old",
        "a2 old",
        "q3 old",
        "a3 old",
      ]);
      expect(oldSession?.branchState?.activeBranchId).toBe("u2-new");
      expect(oldSession?.branchState?.selectedBranchId).toBe("u2-old");
      const oldPrompt = oldSession?.messages.find(
        (message) => message.uuid === "u2-old",
      );
      expect(oldPrompt?.branch).toMatchObject({
        branchId: "u2-old",
        siblingIndex: 1,
        siblingCount: 2,
      });
    });

    it("marks orphaned tool calls with orphanedToolUseIds", async () => {
      const sessionId = "dag-test-2";
      const jsonl = [
        JSON.stringify({
          type: "assistant",
          uuid: "a",
          parentUuid: null,
          message: {
            content: [
              { type: "tool_use", id: "tool-1", name: "Read", input: {} },
            ],
          },
        }),
        // No tool_result for tool-1 (orphaned - process killed)
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const loadedSession = await reader.getSession(
        sessionId,
        "test-project" as UrlProjectId,
        undefined,
        {
          includeOrphans: true,
        },
      );
      const session = loadedSession ? normalizeSession(loadedSession) : null;

      expect(session?.messages).toHaveLength(1);
      expect(session?.messages[0]?.orphanedToolUseIds).toEqual(["tool-1"]);
    });

    it("does not mark completed tools as orphaned", async () => {
      const sessionId = "dag-test-3";
      const jsonl = [
        JSON.stringify({
          type: "assistant",
          uuid: "a",
          parentUuid: null,
          message: {
            content: [
              { type: "tool_use", id: "tool-1", name: "Read", input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "b",
          parentUuid: "a",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: "file contents",
              },
            ],
          },
        }),
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const loadedSession = await reader.getSession(
        sessionId,
        "test-project" as UrlProjectId,
        undefined,
        {
          includeOrphans: true,
        },
      );
      const session = loadedSession ? normalizeSession(loadedSession) : null;

      expect(session?.messages).toHaveLength(2);
      // First message has tool_use but it has a result, so no orphanedToolUseIds
      expect(session?.messages[0]?.orphanedToolUseIds).toBeUndefined();
    });

    it("handles mix of completed and orphaned tools", async () => {
      const sessionId = "dag-test-4";
      const jsonl = [
        JSON.stringify({
          type: "assistant",
          uuid: "a",
          parentUuid: null,
          message: {
            content: [
              { type: "tool_use", id: "tool-1", name: "Read", input: {} },
              { type: "tool_use", id: "tool-2", name: "Bash", input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "b",
          parentUuid: "a",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: "result for tool-1",
              },
              // No result for tool-2 (orphaned)
            ],
          },
        }),
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const loadedSession = await reader.getSession(
        sessionId,
        "test-project",
        undefined,
        {
          includeOrphans: true,
        },
      );
      const session = loadedSession ? normalizeSession(loadedSession) : null;

      expect(session?.messages).toHaveLength(2);
      // tool-2 is orphaned but tool-1 is not
      expect(session?.messages[0]?.orphanedToolUseIds).toEqual(["tool-2"]);
    });

    it("finds tool_results on sibling branches for parallel tool calls", async () => {
      // This tests the parallel tool call structure observed in real sessions.
      // When Claude makes parallel tool calls, the SDK writes them as a chain
      // where each tool_use is a child of the previous one. Tool_results are
      // written as children of their corresponding tool_use, creating branches.
      //
      // Structure:
      //   tool_use #1 (Read file A)
      //   ├── tool_use #2 (Read file B)
      //   │   └── tool_result for B → continues to tip
      //   └── tool_result for A (sibling branch, no children - "dead branch")
      //
      // The tool_result for A is on a dead branch but is still valid!
      const sessionId = "dag-parallel-tools";
      const jsonl = [
        JSON.stringify({
          type: "assistant",
          uuid: "tool-use-1",
          parentUuid: null,
          message: {
            content: [
              { type: "tool_use", id: "read-file-a", name: "Read", input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "tool-use-2",
          parentUuid: "tool-use-1",
          message: {
            content: [
              { type: "tool_use", id: "read-file-b", name: "Read", input: {} },
            ],
          },
        }),
        // Tool result for file A - has same parent as tool-use-2, creating a branch
        JSON.stringify({
          type: "user",
          uuid: "result-a",
          parentUuid: "tool-use-1",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "read-file-a",
                content: "contents of file A",
              },
            ],
          },
        }),
        // Tool result for file B - child of tool-use-2, on the "winning" branch
        JSON.stringify({
          type: "user",
          uuid: "result-b",
          parentUuid: "tool-use-2",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "read-file-b",
                content: "contents of file B",
              },
            ],
          },
        }),
        // Conversation continues from result-b
        JSON.stringify({
          type: "assistant",
          uuid: "response",
          parentUuid: "result-b",
          message: {
            content: [{ type: "text", text: "Here are the file contents..." }],
          },
        }),
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const loadedSession = await reader.getSession(
        sessionId,
        "test-project" as UrlProjectId,
        undefined,
        { includeOrphans: true },
      );
      const session = loadedSession ? normalizeSession(loadedSession) : null;

      // Active branch: tool-use-1 -> tool-use-2 -> result-b -> response
      // result-a is on a sibling branch but is now INCLUDED in the output
      // (inserted after its parent tool-use-1) so the client can pair it
      expect(session?.messages).toHaveLength(5);
      expect(session?.messages.map((m) => m.uuid)).toEqual([
        "tool-use-1",
        "result-a", // sibling tool result, inserted after parent
        "tool-use-2",
        "result-b",
        "response",
      ]);

      // CRITICAL: Both tool_uses should NOT be marked as orphaned
      // because we scan ALL messages for tool_results, not just the active branch
      expect(session?.messages[0]?.orphanedToolUseIds).toBeUndefined();
      expect(session?.messages[2]?.orphanedToolUseIds).toBeUndefined(); // tool-use-2 is now at index 2
    });

    it("renders completed branch before later progress-resumed conversation", async () => {
      const sessionId = "dag-progress-resume-order";
      const jsonl = [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          parentUuid: null,
          message: { content: "test 123. hello." },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          message: {
            content: [
              { type: "text", text: "Hello! How can I help you today?" },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "u2",
          parentUuid: "a1",
          message: {
            content: "edit a sample file in the repo just for testing.",
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "thinking",
          parentUuid: "u2",
          message: {
            content: [{ type: "thinking", thinking: "Let me think briefly." }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "read-msg",
          parentUuid: "thinking",
          message: {
            content: [
              {
                type: "text",
                text: "Let me find a small file to make a test edit on.",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "read-tool",
          parentUuid: "read-msg",
          message: {
            content: [
              { type: "tool_use", id: "read-id", name: "Read", input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "read-result",
          parentUuid: "read-tool",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "read-id",
                content: "read done",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "edit-msg",
          parentUuid: "read-result",
          message: {
            content: [
              { type: "tool_use", id: "edit-id", name: "Edit", input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "edit-result",
          parentUuid: "edit-msg",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "edit-id",
                content: "edit done",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "edit-final",
          parentUuid: "edit-result",
          message: {
            content: [
              {
                type: "text",
                text: "Done — added a `<!-- test edit -->` comment on line 6 of `README.md`.",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "progress",
          uuid: "p1",
          parentUuid: "read-tool",
        }),
        JSON.stringify({
          type: "progress",
          uuid: "p2",
          parentUuid: "p1",
        }),
        JSON.stringify({
          type: "user",
          uuid: "thanks",
          parentUuid: "p2",
          message: { content: "very good. thank you." },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "welcome",
          parentUuid: "thanks",
          message: { content: [{ type: "text", text: "You're welcome!" }] },
        }),
        JSON.stringify({
          type: "user",
          uuid: "launch",
          parentUuid: "welcome",
          message: {
            content:
              "please launch a subagent that will remove that test edit by editing it out.",
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "agent-msg",
          parentUuid: "launch",
          message: {
            content: [
              { type: "tool_use", id: "agent-id", name: "Agent", input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "agent-result",
          parentUuid: "agent-msg",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "agent-id",
                content: "agent done",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "removed",
          parentUuid: "agent-result",
          message: {
            content: [
              {
                type: "text",
                text: "Done — the test edit has been removed. README.md is back to its original state.",
              },
            ],
          },
        }),
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const loadedSession = await reader.getSession(
        sessionId,
        "test-project" as UrlProjectId,
      );
      const session = loadedSession ? normalizeSession(loadedSession) : null;
      const renderItems = session ? preprocessMessages(session.messages) : [];

      expect(session?.messages.map((message) => message.uuid)).toEqual([
        "u1",
        "a1",
        "u2",
        "thinking",
        "read-msg",
        "read-tool",
        "read-result",
        "edit-msg",
        "edit-result",
        "edit-final",
        "thanks",
        "welcome",
        "launch",
        "agent-msg",
        "agent-result",
        "removed",
      ]);

      expect(
        renderItems.map((item) =>
          item.type === "tool_call"
            ? `${item.type}:${item.toolName}`
            : item.type === "text"
              ? `${item.type}:${item.text}`
              : item.type === "user_prompt"
                ? `${item.type}:${typeof item.content === "string" ? item.content : ""}`
                : item.type,
        ),
      ).toEqual([
        "user_prompt:test 123. hello.",
        "text:Hello! How can I help you today?",
        "user_prompt:edit a sample file in the repo just for testing.",
        "thinking",
        "text:Let me find a small file to make a test edit on.",
        "tool_call:Read",
        "tool_call:Edit",
        "text:Done — added a `<!-- test edit -->` comment on line 6 of `README.md`.",
        "user_prompt:very good. thank you.",
        "text:You're welcome!",
        "user_prompt:please launch a subagent that will remove that test edit by editing it out.",
        "tool_call:Agent",
        "text:Done — the test edit has been removed. README.md is back to its original state.",
      ]);
    });
  });

  describe("getAgentSession", () => {
    it("reads agent JSONL file and returns messages", async () => {
      // Copy fixture to test directory
      const fixtureContent = await readFile(
        join(fixturesDir, "agent-completed.jsonl"),
        "utf-8",
      );
      await writeFile(join(testDir, "agent-test123.jsonl"), fixtureContent);

      const result = await reader.getAgentSession("test123");

      // Should have messages (system, user, assistant messages + result)
      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.status).toBe("completed");
    });

    it("returns empty for missing agent file", async () => {
      const result = await reader.getAgentSession("nonexistent");

      expect(result.messages).toHaveLength(0);
      expect(result.status).toBe("pending");
    });

    it("infers completed status from result message", async () => {
      const fixtureContent = await readFile(
        join(fixturesDir, "agent-completed.jsonl"),
        "utf-8",
      );
      await writeFile(
        join(testDir, "agent-completed-test.jsonl"),
        fixtureContent,
      );

      const result = await reader.getAgentSession("completed-test");

      expect(result.status).toBe("completed");
    });

    it("infers failed status from error result", async () => {
      const fixtureContent = await readFile(
        join(fixturesDir, "agent-failed.jsonl"),
        "utf-8",
      );
      await writeFile(join(testDir, "agent-failed-test.jsonl"), fixtureContent);

      const result = await reader.getAgentSession("failed-test");

      expect(result.status).toBe("failed");
    });

    it("infers running status from incomplete session", async () => {
      const fixtureContent = await readFile(
        join(fixturesDir, "agent-running.jsonl"),
        "utf-8",
      );
      await writeFile(
        join(testDir, "agent-running-test.jsonl"),
        fixtureContent,
      );

      const result = await reader.getAgentSession("running-test");

      expect(result.status).toBe("running");
    });

    it("returns pending for empty agent file", async () => {
      await writeFile(join(testDir, "agent-empty.jsonl"), "");

      const result = await reader.getAgentSession("empty");

      expect(result.messages).toHaveLength(0);
      expect(result.status).toBe("pending");
    });

    it("applies DAG filtering to agent messages", async () => {
      // Create agent with branching structure
      const jsonl = [
        JSON.stringify({
          type: "user",
          uuid: "a",
          parentUuid: null,
          message: { content: "First" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "b",
          parentUuid: "a",
          message: { content: "Dead branch" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "c",
          parentUuid: "a",
          message: { content: "Active branch" },
        }),
        JSON.stringify({
          type: "result",
          uuid: "d",
          parentUuid: "c",
        }),
      ].join("\n");
      await writeFile(join(testDir, "agent-dag-test.jsonl"), jsonl);

      const result = await reader.getAgentSession("dag-test");

      // Should only have a, c, d (not b - dead branch)
      expect(result.messages).toHaveLength(3);
      expect(result.messages.map((m) => m.uuid)).toEqual(["a", "c", "d"]);
      expect(result.status).toBe("completed");
    });

    it("includes completed sibling tool branches in agent sessions for reload rendering", async () => {
      const jsonl = [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          parentUuid: null,
          message: { content: "Apply the refactor." },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "edit-1-msg",
          parentUuid: "user-1",
          message: {
            content: [
              {
                type: "tool_use",
                id: "edit-1",
                name: "Edit",
                input: {
                  file_path: "src/a.ts",
                  old_string: "a",
                  new_string: "b",
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "edit-2-msg",
          parentUuid: "edit-1-msg",
          message: {
            content: [
              {
                type: "tool_use",
                id: "edit-2",
                name: "Edit",
                input: {
                  file_path: "src/b.ts",
                  old_string: "x",
                  new_string: "y",
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "edit-1-result",
          parentUuid: "edit-1-msg",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "edit-1",
                content: "File modified.",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "edit-2-result",
          parentUuid: "edit-2-msg",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "edit-2",
                content: "File modified.",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-final",
          parentUuid: "edit-1-result",
          message: {
            content: [{ type: "text", text: "Applied both edits." }],
          },
        }),
        JSON.stringify({
          type: "result",
          uuid: "agent-result",
          parentUuid: "assistant-final",
        }),
      ].join("\n");
      await writeFile(join(testDir, "agent-render-branches.jsonl"), jsonl);

      const result = await reader.getAgentSession("render-branches");

      expect(result.messages.map((m) => m.uuid)).toEqual([
        "user-1",
        "edit-1-msg",
        "edit-2-msg",
        "edit-2-result",
        "edit-1-result",
        "assistant-final",
        "agent-result",
      ]);

      const renderItems = preprocessMessages(result.messages);
      const editCalls = renderItems.filter(
        (item) => item.type === "tool_call" && item.toolName === "Edit",
      );

      expect(editCalls).toHaveLength(2);
      expect(result.status).toBe("completed");
    });
  });

  describe("getAgentMappings", () => {
    it("returns mappings of toolUseId to agentId", async () => {
      // Create agent files with parent_tool_use_id
      const agent1 = [
        JSON.stringify({
          type: "system",
          uuid: "sys-1",
          parent_tool_use_id: "tool-use-abc",
        }),
        JSON.stringify({
          type: "user",
          uuid: "msg-1",
          message: { content: "Hello" },
        }),
      ].join("\n");
      await writeFile(join(testDir, "agent-abc123.jsonl"), agent1);

      const agent2 = [
        JSON.stringify({
          type: "system",
          uuid: "sys-2",
          parent_tool_use_id: "tool-use-def",
        }),
        JSON.stringify({
          type: "user",
          uuid: "msg-2",
          message: { content: "World" },
        }),
      ].join("\n");
      await writeFile(join(testDir, "agent-def456.jsonl"), agent2);

      const mappings = await reader.getAgentMappings();

      expect(mappings).toHaveLength(2);
      expect(mappings).toContainEqual({
        toolUseId: "tool-use-abc",
        agentId: "abc123",
      });
      expect(mappings).toContainEqual({
        toolUseId: "tool-use-def",
        agentId: "def456",
      });
    });

    it("returns empty array when no agent files exist", async () => {
      const mappings = await reader.getAgentMappings();
      expect(mappings).toHaveLength(0);
    });

    it("includes agents without parent_tool_use_id using agentId as placeholder", async () => {
      // Agent file without parent_tool_use_id (new SDK format)
      const agent1 = [
        JSON.stringify({
          type: "system",
          uuid: "sys-1",
        }),
        JSON.stringify({
          type: "user",
          uuid: "msg-1",
          message: { content: "Hello" },
        }),
      ].join("\n");
      await writeFile(join(testDir, "agent-noparent.jsonl"), agent1);

      // Agent file with parent_tool_use_id (legacy format)
      const agent2 = [
        JSON.stringify({
          type: "system",
          uuid: "sys-2",
          parent_tool_use_id: "tool-use-xyz",
        }),
      ].join("\n");
      await writeFile(join(testDir, "agent-hasparent.jsonl"), agent2);

      const mappings = await reader.getAgentMappings();

      expect(mappings).toHaveLength(2);
      expect(mappings).toContainEqual({
        toolUseId: "tool-use-xyz",
        agentId: "hasparent",
      });
      // New SDK: agentId used as placeholder toolUseId
      expect(mappings).toContainEqual({
        toolUseId: "noparent",
        agentId: "noparent",
      });
    });

    it("handles empty agent files", async () => {
      await writeFile(join(testDir, "agent-empty.jsonl"), "");

      const mappings = await reader.getAgentMappings();
      expect(mappings).toHaveLength(0);
    });

    it("ignores non-agent JSONL files", async () => {
      // Create a regular session file
      const session = [
        JSON.stringify({
          type: "user",
          uuid: "msg-1",
          parent_tool_use_id: "should-be-ignored",
          message: { content: "Hello" },
        }),
      ].join("\n");
      await writeFile(join(testDir, "session123.jsonl"), session);

      const mappings = await reader.getAgentMappings();
      expect(mappings).toHaveLength(0);
    });

    it("finds parent_tool_use_id even if not on first line", async () => {
      // parent_tool_use_id on third line
      const agent = [
        JSON.stringify({
          type: "system",
          uuid: "sys-1",
        }),
        JSON.stringify({
          type: "config",
          uuid: "cfg-1",
        }),
        JSON.stringify({
          type: "init",
          uuid: "init-1",
          parent_tool_use_id: "tool-use-later",
        }),
      ].join("\n");
      await writeFile(join(testDir, "agent-later.jsonl"), agent);

      const mappings = await reader.getAgentMappings();

      expect(mappings).toHaveLength(1);
      expect(mappings[0]).toEqual({
        toolUseId: "tool-use-later",
        agentId: "later",
      });
    });
  });

  describe("getAgentMappings — SDK 0.2.76+ (subagents/ dir)", () => {
    it("finds agent files in subagents/ directory", async () => {
      const subagentsDir = join(testDir, "subagents");
      await mkdir(subagentsDir, { recursive: true });

      // New SDK format: no parent_tool_use_id, has agentId and isSidechain
      const agent = [
        JSON.stringify({
          type: "user",
          uuid: "msg-1",
          agentId: "abc123",
          isSidechain: true,
          sessionId: "parent-session",
          message: { content: "Hello" },
        }),
      ].join("\n");
      await writeFile(join(subagentsDir, "agent-abc123.jsonl"), agent);

      const mappings = await reader.getAgentMappings();
      expect(mappings).toHaveLength(1);
      // New SDK: uses agentId as placeholder toolUseId
      expect(mappings[0]).toEqual({
        toolUseId: "abc123",
        agentId: "abc123",
      });
    });

    it("reads agentType from meta.json", async () => {
      const subagentsDir = join(testDir, "subagents");
      await mkdir(subagentsDir, { recursive: true });

      const agent = [
        JSON.stringify({
          type: "user",
          uuid: "msg-1",
          agentId: "explore1",
          isSidechain: true,
          message: { content: "Hello" },
        }),
      ].join("\n");
      await writeFile(join(subagentsDir, "agent-explore1.jsonl"), agent);
      await writeFile(
        join(subagentsDir, "agent-explore1.meta.json"),
        JSON.stringify({ agentType: "Explore" }),
      );

      const mappings = await reader.getAgentMappings();
      expect(mappings).toHaveLength(1);
      expect(mappings[0]).toEqual({
        toolUseId: "explore1",
        agentId: "explore1",
        agentType: "Explore",
      });
    });

    it("deduplicates across subagents/ and root dirs", async () => {
      const subagentsDir = join(testDir, "subagents");
      await mkdir(subagentsDir, { recursive: true });

      const agentContent = JSON.stringify({
        type: "user",
        uuid: "msg-1",
        agentId: "dedup1",
        isSidechain: true,
        message: { content: "Hello" },
      });

      // Same agent in both locations
      await writeFile(join(subagentsDir, "agent-dedup1.jsonl"), agentContent);
      await writeFile(join(testDir, "agent-dedup1.jsonl"), agentContent);

      const mappings = await reader.getAgentMappings();
      expect(mappings).toHaveLength(1);
    });

    it("returns agentType with legacy parent_tool_use_id mapping", async () => {
      const subagentsDir = join(testDir, "subagents");
      await mkdir(subagentsDir, { recursive: true });

      const agent = [
        JSON.stringify({
          type: "system",
          uuid: "sys-1",
          parent_tool_use_id: "tool-use-legacy",
        }),
      ].join("\n");
      await writeFile(join(subagentsDir, "agent-legacy1.jsonl"), agent);
      await writeFile(
        join(subagentsDir, "agent-legacy1.meta.json"),
        JSON.stringify({ agentType: "Plan" }),
      );

      const mappings = await reader.getAgentMappings();
      expect(mappings).toHaveLength(1);
      expect(mappings[0]).toEqual({
        toolUseId: "tool-use-legacy",
        agentId: "legacy1",
        agentType: "Plan",
      });
    });
  });

  describe("getAgentSession — SDK 0.2.76+ (subagents/ dir)", () => {
    it("loads agent from subagents/ directory", async () => {
      const subagentsDir = join(testDir, "subagents");
      await mkdir(subagentsDir, { recursive: true });

      const agent = [
        JSON.stringify({
          type: "user",
          uuid: "msg-1",
          agentId: "sub1",
          isSidechain: true,
          message: { content: "Research task" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "msg-2",
          parentUuid: "msg-1",
          agentId: "sub1",
          isSidechain: true,
          message: { content: [{ type: "text", text: "Found info" }] },
        }),
        JSON.stringify({
          type: "result",
          uuid: "msg-3",
          parentUuid: "msg-2",
        }),
      ].join("\n");
      await writeFile(join(subagentsDir, "agent-sub1.jsonl"), agent);

      const session = await reader.getAgentSession("sub1");
      expect(session.messages).toHaveLength(3);
      expect(session.status).toBe("completed");
    });

    it("reads agentType from meta.json", async () => {
      const subagentsDir = join(testDir, "subagents");
      await mkdir(subagentsDir, { recursive: true });

      const agent = [
        JSON.stringify({
          type: "user",
          uuid: "msg-1",
          message: { content: "Task" },
        }),
        JSON.stringify({
          type: "result",
          uuid: "msg-2",
          parentUuid: "msg-1",
        }),
      ].join("\n");
      await writeFile(join(subagentsDir, "agent-typed1.jsonl"), agent);
      await writeFile(
        join(subagentsDir, "agent-typed1.meta.json"),
        JSON.stringify({ agentType: "Explore" }),
      );

      const session = await reader.getAgentSession("typed1");
      expect(session.status).toBe("completed");
      expect(session.agentType).toBe("Explore");
    });

    it("returns undefined agentType when no meta.json", async () => {
      const subagentsDir = join(testDir, "subagents");
      await mkdir(subagentsDir, { recursive: true });

      const agent = JSON.stringify({
        type: "user",
        uuid: "msg-1",
        message: { content: "Task" },
      });
      await writeFile(join(subagentsDir, "agent-notype.jsonl"), agent);

      const session = await reader.getAgentSession("notype");
      expect(session.agentType).toBeUndefined();
    });

    it("prefers subagents/ over root dir", async () => {
      const subagentsDir = join(testDir, "subagents");
      await mkdir(subagentsDir, { recursive: true });

      // Root dir has different content
      await writeFile(
        join(testDir, "agent-pref1.jsonl"),
        JSON.stringify({
          type: "user",
          uuid: "root-msg",
          message: { content: "Root version" },
        }),
      );
      // subagents/ dir has different content
      await writeFile(
        join(subagentsDir, "agent-pref1.jsonl"),
        [
          JSON.stringify({
            type: "user",
            uuid: "sub-msg",
            message: { content: "Subagents version" },
          }),
          JSON.stringify({
            type: "result",
            uuid: "sub-result",
            parentUuid: "sub-msg",
          }),
        ].join("\n"),
      );

      const session = await reader.getAgentSession("pref1");
      // Should load from subagents/ (checked first)
      expect(session.messages).toHaveLength(2);
      expect(session.status).toBe("completed");
    });
  });

  describe("context usage with compaction", () => {
    /** Helper to create an assistant message with usage data */
    function assistantMsg(
      uuid: string,
      parentUuid: string | null,
      inputTokens: number,
      cacheRead = 0,
      cacheCreate = 0,
    ) {
      return JSON.stringify({
        type: "assistant",
        uuid,
        parentUuid,
        message: {
          content: [{ type: "text", text: "response" }],
          model: "claude-opus-4-5-20251101",
          usage: {
            input_tokens: inputTokens,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheCreate,
            output_tokens: 100,
          },
        },
        timestamp: new Date().toISOString(),
      });
    }

    /** Helper to create a user message */
    function userMsg(uuid: string, parentUuid: string | null) {
      return JSON.stringify({
        type: "user",
        uuid,
        parentUuid,
        message: { content: "question" },
        timestamp: new Date().toISOString(),
      });
    }

    /** Helper to create a compact_boundary entry */
    function compactBoundary(
      uuid: string,
      logicalParentUuid: string,
      preTokens: number,
    ) {
      return JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        uuid,
        parentUuid: null,
        logicalParentUuid,
        content: "Conversation compacted",
        compactMetadata: { trigger: "auto", preTokens },
        timestamp: new Date().toISOString(),
      });
    }

    /** Helper to create a compact summary user message */
    function compactSummary(uuid: string, parentUuid: string) {
      return JSON.stringify({
        type: "user",
        uuid,
        parentUuid,
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { content: "Summary of previous conversation..." },
        timestamp: new Date().toISOString(),
      });
    }

    it("reports correct percentage without compaction", async () => {
      const sessionId = "ctx-no-compact";
      const jsonl = [
        userMsg("u1", null),
        // 80K tokens out of 200K = 40%
        assistantMsg("a1", "u1", 1, 60000, 20000),
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );
      expect(summary?.contextUsage?.percentage).toBe(40);
      expect(summary?.contextUsage?.inputTokens).toBe(80001);
    });

    it("adjusts percentage after single compaction using preTokens overhead", async () => {
      const sessionId = "ctx-single-compact";
      // Pre-compaction: assistant at 160K tokens
      // Compaction triggers at preTokens=167K (overhead = 167K - 160K = 7K)
      // Post-compaction: assistant at 50K tokens
      // Adjusted: 50K + 7K = 57K → 29%
      const jsonl = [
        userMsg("u1", null),
        assistantMsg("a1", "u1", 1, 150000, 10000), // 160001 tokens
        compactBoundary("cb1", "a1", 167000),
        compactSummary("summary1", "cb1"),
        assistantMsg("a2", "summary1", 1, 40000, 10000), // 50001 tokens raw
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );
      // overhead = 167000 - 160001 = 6999
      // adjusted = 50001 + 6999 = 57000
      // percentage = round(57000 / 200000 * 100) = 28%
      expect(summary?.contextUsage?.inputTokens).toBe(57000);
      expect(summary?.contextUsage?.percentage).toBe(28);
    });

    it("adjusts percentage after multiple compactions", async () => {
      const sessionId = "ctx-multi-compact";
      // First compaction: assistant at 160K, preTokens=167K (overhead=7K)
      // After first compaction: assistant grows to 89K
      // Second compaction: preTokens=168K (new overhead = 168K - 89K = 79K)
      // After second compaction: assistant at 50K
      // Adjusted: 50K + 79K = 129K → 65%
      const t = () => new Date().toISOString();
      const jsonl = [
        userMsg("u1", null),
        assistantMsg("a1", "u1", 1, 150000, 10000), // 160001
        compactBoundary("cb1", "a1", 167000),
        compactSummary("s1", "cb1"),
        assistantMsg("a2", "s1", 1, 79000, 10000), // 89001 raw
        userMsg("u2", "a2"),
        assistantMsg("a3", "u2", 1, 79000, 10000), // 89001
        compactBoundary("cb2", "a3", 168000),
        compactSummary("s2", "cb2"),
        assistantMsg("a4", "s2", 1, 40000, 10000), // 50001 raw
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );
      // Uses LAST compaction: overhead = 168000 - 89001 = 78999
      // adjusted = 50001 + 78999 = 129000
      // percentage = round(129000 / 200000 * 100) = 65%
      expect(summary?.contextUsage?.inputTokens).toBe(129000);
      expect(summary?.contextUsage?.percentage).toBe(65);
    });
  });

  describe("computeCompactionOverhead", () => {
    function makeAssistant(
      inputTokens: number,
      cacheRead = 0,
      cacheCreate = 0,
    ): ClaudeSessionEntry {
      return {
        type: "assistant",
        message: {
          usage: {
            input_tokens: inputTokens,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheCreate,
          },
        },
      } as ClaudeSessionEntry;
    }

    function makeCompactBoundary(preTokens: number): ClaudeSessionEntry {
      return {
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "auto", preTokens },
      } as ClaudeSessionEntry;
    }

    it("returns 0 with no compaction", () => {
      const messages: ClaudeSessionEntry[] = [
        { type: "user" } as ClaudeSessionEntry,
        makeAssistant(1, 50000, 10000),
      ];
      expect(computeCompactionOverhead(messages)).toBe(0);
    });

    it("computes overhead from last compaction", () => {
      const messages = [
        makeAssistant(1, 150000, 10000), // 160001 total
        makeCompactBoundary(167000), // preTokens=167000
        { type: "user" } as ClaudeSessionEntry,
        makeAssistant(1, 40000, 10000), // post-compaction
      ];
      // overhead = 167000 - 160001 = 6999
      expect(computeCompactionOverhead(messages)).toBe(6999);
    });

    it("uses only the LAST compaction boundary", () => {
      const messages = [
        makeAssistant(1, 150000, 10000), // 160001
        makeCompactBoundary(167000), // first compaction
        makeAssistant(1, 79000, 10000), // 89001 post-first
        makeCompactBoundary(168000), // second compaction
        makeAssistant(1, 40000, 10000), // post-second
      ];
      // Uses last compaction: overhead = 168000 - 89001 = 78999
      expect(computeCompactionOverhead(messages)).toBe(78999);
    });

    it("returns 0 when compact_boundary has no compactMetadata", () => {
      const messages = [
        makeAssistant(1, 150000, 10000),
        { type: "system", subtype: "compact_boundary" } as ClaudeSessionEntry, // no metadata
        makeAssistant(1, 40000, 10000),
      ];
      expect(computeCompactionOverhead(messages)).toBe(0);
    });

    it("returns 0 when no assistant before compaction", () => {
      const messages = [
        makeCompactBoundary(167000),
        makeAssistant(1, 40000, 10000),
      ];
      expect(computeCompactionOverhead(messages)).toBe(0);
    });

    it("clamps negative overhead to 0", () => {
      const messages = [
        makeAssistant(1, 170000, 10000), // 180001 > preTokens
        makeCompactBoundary(167000),
        makeAssistant(1, 40000, 10000),
      ];
      expect(computeCompactionOverhead(messages)).toBe(0);
    });
  });
});
