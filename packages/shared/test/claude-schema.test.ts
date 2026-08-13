import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ClaudeSessionEntrySchema } from "../src/claude-sdk-schema/index.js";

describe("ClaudeSessionEntrySchema", () => {
  it("preserves the SDK isSynthetic user-message marker", () => {
    const parsed = ClaudeSessionEntrySchema.parse({
      type: "user",
      isSidechain: false,
      isSynthetic: true,
      userType: "external",
      cwd: "/test",
      sessionId: randomUUID(),
      version: "test",
      uuid: randomUUID(),
      parentUuid: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Internal Claude context" },
    });

    expect("isSynthetic" in parsed && parsed.isSynthetic).toBe(true);
  });
});
