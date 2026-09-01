import { describe, expect, it } from "vitest";
import {
  SESSION_QUESTION_MAX_LENGTH,
  compactQuestionText,
  createSessionQuestion,
} from "../../src/sessions/user-questions.js";

describe("public session questions", () => {
  it("projects managed upload scaffolding without rewriting ordinary path prose", () => {
    const managedPath = "/private/yep/uploads/summary-report.pdf";
    const question = createSessionQuestion(
      {
        id: "managed-question",
        text: `Compare /workspace/project/a.ts\n\nUser uploaded files:\n- report.pdf (2.0 KB, application/pdf): ${managedPath}`,
      },
      "fallback",
    );

    expect(question?.text).toContain("/workspace/project/a.ts");
    expect(question?.text).not.toContain("[managed attachment]");
    expect(question?.text).toContain(managedPath);
  });

  it("keeps truncated previews within the strict public schema bound", () => {
    const preview = compactQuestionText(
      "x".repeat(SESSION_QUESTION_MAX_LENGTH + 20),
    );

    expect(preview).toHaveLength(SESSION_QUESTION_MAX_LENGTH);
    expect(preview.endsWith("...")).toBe(true);
  });

  it("supports bounds shorter than the ellipsis", () => {
    expect(compactQuestionText("long question", 2)).toBe("..");
    expect(compactQuestionText("long question", 0)).toBe("");
  });
});
