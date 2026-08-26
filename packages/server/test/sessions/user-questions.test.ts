import { describe, expect, it } from "vitest";
import { createSessionQuestion } from "../../src/sessions/user-questions.js";

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
});
