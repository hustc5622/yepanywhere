import { describe, expect, it } from "vitest";
import { normalizeExternalHttpUrl } from "../externalUrl";

describe("normalizeExternalHttpUrl", () => {
  it("accepts HTTP(S) links", () => {
    expect(normalizeExternalHttpUrl("https://example.com/help")).toBe(
      "https://example.com/help",
    );
    expect(normalizeExternalHttpUrl("http://localhost:3400/path")).toBe(
      "http://localhost:3400/path",
    );
  });

  it("rejects executable, local, and malformed links", () => {
    expect(normalizeExternalHttpUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeExternalHttpUrl("data:text/html,unsafe")).toBeUndefined();
    expect(normalizeExternalHttpUrl("/relative/path")).toBeUndefined();
    expect(normalizeExternalHttpUrl("not a url")).toBeUndefined();
  });
});
