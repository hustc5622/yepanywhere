import { describe, expect, it } from "vitest";
import {
  MAX_PI_COMPACT_INSTRUCTIONS_LENGTH,
  parsePiSlashCommand,
} from "../piInputCommands";

describe("Pi input commands", () => {
  it("recognizes /compact with optional instructions", () => {
    expect(parsePiSlashCommand("/compact")).toEqual({ kind: "compact" });
    expect(parsePiSlashCommand("  /compact  ")).toEqual({ kind: "compact" });
    expect(parsePiSlashCommand("/compact keep the API plan")).toEqual({
      kind: "compact",
      customInstructions: "keep the API plan",
    });
    expect(
      parsePiSlashCommand("/compact\nkeep:\n- decisions\n- open bugs\n"),
    ).toEqual({
      kind: "compact",
      customInstructions: "keep:\n- decisions\n- open bugs",
    });
  });

  it("leaves other text for the model", () => {
    expect(parsePiSlashCommand("/compactness")).toEqual({ kind: "none" });
    expect(parsePiSlashCommand("please /compact")).toEqual({ kind: "none" });
    expect(parsePiSlashCommand("/skill:review")).toEqual({ kind: "none" });
  });

  it("rejects oversized instructions", () => {
    expect(
      parsePiSlashCommand(
        `/compact ${"x".repeat(MAX_PI_COMPACT_INSTRUCTIONS_LENGTH + 1)}`,
      ),
    ).toEqual({ kind: "compact-instructions-too-long" });
  });
});
