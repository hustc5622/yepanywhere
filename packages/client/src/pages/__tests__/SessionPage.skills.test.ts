import { describe, expect, it } from "vitest";
import {
  buildCodexSkillInputs,
  remainingCodexSkillAfterSuccessfulSend,
} from "../SessionPage";

describe("SessionPage Codex skill send state", () => {
  const selected = {
    name: "release-check",
    path: "/test-fixtures/codex/skills/release-check/SKILL.md",
  };

  it("builds structured skill input only for the Codex app-server provider", () => {
    expect(buildCodexSkillInputs("codex", selected)).toEqual([
      { type: "skill", ...selected },
    ]);
    expect(buildCodexSkillInputs("codex-oss", selected)).toBeUndefined();
    expect(buildCodexSkillInputs("claude", selected)).toBeUndefined();
    expect(buildCodexSkillInputs("codex", null)).toBeUndefined();
  });

  it("clears the sent selection on success but retains a newer selection", () => {
    expect(
      remainingCodexSkillAfterSuccessfulSend(selected, selected),
    ).toBeNull();
    const newer = {
      name: "review",
      path: "/test-fixtures/codex/skills/review/SKILL.md",
    };
    expect(remainingCodexSkillAfterSuccessfulSend(newer, selected)).toEqual(
      newer,
    );
    expect(remainingCodexSkillAfterSuccessfulSend(selected, null)).toEqual(
      selected,
    );
  });
});
