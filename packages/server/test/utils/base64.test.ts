import { describe, expect, it } from "vitest";
import { isStandardBase64 } from "../../src/utils/base64.js";

describe("isStandardBase64", () => {
  it.each(["", "YQ==", "YWI=", "YWJj", "+/8=", "AAAA"])(
    "accepts %j",
    (value) => {
      expect(isStandardBase64(value)).toBe(true);
    },
  );
  it.each([
    "A",
    "AAA",
    "====",
    "A===",
    "AA=A",
    "AA==AAAA",
    "AA-_",
    "AAA\n",
    "ＡAAA",
  ])("rejects %j", (value) => {
    expect(isStandardBase64(value)).toBe(false);
  });
  it("checks the entire large body, including malformed tail characters", () => {
    const body = "A".repeat(12 * 1024 * 1024);
    expect(isStandardBase64(body)).toBe(true);
    expect(isStandardBase64(`${body.slice(0, -1)}!`)).toBe(false);
  });
});
