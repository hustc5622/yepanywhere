import { describe, expect, it } from "vitest";
import {
  SideConversationRequestSchema,
  parseSideConversationCommand,
} from "./side-conversations.js";

describe("side conversation contract", () => {
  it("recognizes only standalone command tokens and preserves multiline questions", () => {
    expect(parseSideConversationCommand(" /btw why?\nExplain ")).toEqual({
      text: "why?\nExplain",
    });
    expect(parseSideConversationCommand("/side")).toEqual({ text: "" });
    for (const text of [
      "/sidebar",
      "please use /btw",
      "`/side`",
      "/btw:ask question",
    ])
      expect(parseSideConversationCommand(text)).toBeNull();
  });
  it("rejects native thread IDs, oversized prompts and unknown actions", () => {
    expect(
      SideConversationRequestSchema.safeParse({
        action: "create",
        requestId: "c",
      }).data,
    ).toMatchObject({ context: "snapshot" });
    expect(
      SideConversationRequestSchema.safeParse({
        action: "send",
        id: "side",
        requestId: "r",
        text: "hi",
        threadId: "parent",
      }).success,
    ).toBe(false);
    expect(
      SideConversationRequestSchema.safeParse({
        action: "send",
        id: "s",
        requestId: "r",
        text: "x".repeat(32001),
      }).success,
    ).toBe(false);
    expect(
      SideConversationRequestSchema.safeParse({ action: "steer", id: "parent" })
        .success,
    ).toBe(false);
  });
});
