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
});
