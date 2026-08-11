import { describe, expect, it } from "vitest";
import { isManagedUploadDownloadUrl } from "../src/upload.js";

describe("isManagedUploadDownloadUrl", () => {
  it("accepts a canonical relative managed upload route", () => {
    expect(
      isManagedUploadDownloadUrl(
        "/api/projects/cHJvamVjdA/sessions/session-1/upload/123e4567-e89b-12d3-a456-426614174000_%E6%88%AA%E5%9B%BE.png",
      ),
    ).toBe(true);
  });

  it.each([
    "https://attacker.example/image.png",
    "/api/projects/project/sessions/session/upload/not-opaque.png",
    "/api/projects/project/sessions/../upload/123e4567-e89b-12d3-a456-426614174000_image.png",
    "/api/projects/project/sessions/session/upload/123e4567-e89b-12d3-a456-426614174000_../../secret.png",
    "/api/projects/project/sessions/session/upload/123e4567-e89b-12d3-a456-426614174000_%2Fsecret.png",
    "/api/projects/%2e%2e/sessions/session/upload/123e4567-e89b-12d3-a456-426614174000_image.png",
  ])("rejects a forged or non-canonical route: %s", (url) => {
    expect(isManagedUploadDownloadUrl(url)).toBe(false);
  });
});
