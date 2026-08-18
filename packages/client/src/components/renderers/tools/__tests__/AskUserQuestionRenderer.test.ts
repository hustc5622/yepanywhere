import { describe, expect, it } from "vitest";
import { getQuestionErrorMessage } from "../AskUserQuestionRenderer";

describe("getQuestionErrorMessage", () => {
  it("shows a provider question rejection reason", () => {
    expect(
      getQuestionErrorMessage({
        state: { error: "The user dismissed this question" },
      }),
    ).toBe("The user dismissed this question");
  });

  it("falls back when the result has no readable error", () => {
    expect(getQuestionErrorMessage({})).toBe("Question failed");
  });
});
