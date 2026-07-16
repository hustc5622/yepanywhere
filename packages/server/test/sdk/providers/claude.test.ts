import { describe, expect, it } from "vitest";
import { safeAttachmentName } from "../../../src/sdk/providers/claude.js";

describe("remote Claude provider", () => {
  it("keeps attachment names inside one bounded path component", () => {
    const name = safeAttachmentName("../../message/id", "../unsafe file.png");

    expect(name).toBe("______message_id-unsafe_file.png");
    expect(name).not.toContain("/");
    expect(name.length).toBeLessThanOrEqual(241);
  });
});
