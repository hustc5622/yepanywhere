import { describe, expect, it } from "vitest";
import { isLocalManagementRequest } from "../../src/auth/localManagement.js";

describe("isLocalManagementRequest", () => {
  it.each([
    ["http://localhost:8022/api/auth/status", "127.0.0.1", true],
    ["http://127.0.0.1:8022/api/auth/status", "::ffff:127.0.0.1", true],
    ["http://[::1]:8022/api/auth/status", "::1", true],
    ["https://example.test/api/auth/status", "127.0.0.1", false],
    ["http://192.168.1.10:8022/api/auth/status", "127.0.0.1", false],
    ["http://localhost:8022/api/auth/status", "192.168.1.20", false],
  ])("classifies %s from %s", (rawUrl, address, expected) => {
    expect(isLocalManagementRequest(new URL(rawUrl), address)).toBe(expected);
  });

  it("uses only the URL and direct peer address", () => {
    const forwardedHeaders = {
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-proto": "http",
    };

    expect(
      isLocalManagementRequest(
        new URL("https://example.test/api/auth/status"),
        "192.168.1.20",
      ),
    ).toBe(false);
    expect(forwardedHeaders).not.toHaveProperty("remoteAddress");
  });
});
