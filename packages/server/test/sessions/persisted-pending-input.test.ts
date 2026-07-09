import { describe, expect, it } from "vitest";
import { getPersistedAskUserQuestionInputRequest } from "../../src/sessions/persisted-pending-input.js";
import type { Message } from "../../src/supervisor/types.js";

const questionInput = {
  questions: [
    {
      question: "Which flow did you mean?",
      header: "Flow",
      multiSelect: false,
      options: [
        { label: "JumpServer", description: "Use devssh" },
        { label: "MCP", description: "Use transfer tools" },
      ],
    },
  ],
};

function askUserQuestionMessage(id = "toolu-question"): Message {
  return {
    type: "assistant",
    uuid: "assistant-question",
    timestamp: "2026-06-30T01:02:03.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I need to check one thing first." },
        {
          type: "tool_use",
          id,
          name: "AskUserQuestion",
          input: questionInput,
        },
      ],
    },
  };
}

function openCodeQuestionMessage(id = "toolu-opencode-question"): Message {
  return {
    type: "assistant",
    uuid: "assistant-opencode-question",
    timestamp: "2026-07-09T01:02:03.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id,
          name: "question",
          input: {
            questions: [
              {
                question: "你想怎么修?",
                header: "修复方式",
                multiple: false,
                options: [
                  {
                    label: "加 packages 到白名单",
                    description: "允许 packages/ 下的 md 文件被列出",
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  };
}

describe("getPersistedAskUserQuestionInputRequest", () => {
  it("reconstructs an unanswered AskUserQuestion as a persisted input request", () => {
    const request = getPersistedAskUserQuestionInputRequest(
      [askUserQuestionMessage()],
      "session-1",
    );

    expect(request).toMatchObject({
      id: "toolu-question",
      sessionId: "session-1",
      type: "question",
      prompt: "Which flow did you mean?",
      toolName: "AskUserQuestion",
      toolInput: questionInput,
      timestamp: "2026-06-30T01:02:03.000Z",
      source: "persisted",
    });
  });

  it("does not return a request after the question has a tool result", () => {
    const request = getPersistedAskUserQuestionInputRequest(
      [
        askUserQuestionMessage(),
        {
          type: "user",
          uuid: "user-result",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu-question",
                content: "JumpServer",
              },
            ],
          },
        },
      ],
      "session-1",
    );

    expect(request).toBeNull();
  });

  it("reconstructs an unanswered OpenCode question tool as AskUserQuestion input", () => {
    const request = getPersistedAskUserQuestionInputRequest(
      [openCodeQuestionMessage()],
      "session-1",
    );

    expect(request).toMatchObject({
      id: "toolu-opencode-question",
      sessionId: "session-1",
      type: "question",
      prompt: "你想怎么修?",
      toolName: "AskUserQuestion",
      source: "persisted",
    });
    expect(request?.toolInput).toMatchObject({
      questions: [
        {
          question: "你想怎么修?",
          header: "修复方式",
          multiSelect: false,
          options: [
            {
              label: "加 packages 到白名单",
              description: "允许 packages/ 下的 md 文件被列出",
            },
          ],
        },
      ],
    });
  });
});
