import { describe, expect, it } from "vitest";
import { isCodexSubagentViewOnly } from "../codexSubagents";

describe("isCodexSubagentViewOnly", () => {
  it.each(["codex", "codex-oss"] as const)(
    "marks persisted %s child threads as view-only",
    (provider) => {
      expect(
        isCodexSubagentViewOnly({ provider, parentSessionId: "parent" }),
      ).toBe(true);
    },
  );

  it("does not block roots or providers with independent child control", () => {
    expect(isCodexSubagentViewOnly({ provider: "codex" })).toBe(false);
    expect(
      isCodexSubagentViewOnly({
        provider: "opencode",
        parentSessionId: "parent",
      }),
    ).toBe(false);
    expect(isCodexSubagentViewOnly(undefined)).toBe(false);
  });
});
