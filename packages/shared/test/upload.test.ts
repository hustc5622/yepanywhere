import { describe, expect, it } from "vitest";
import {
  isManagedUploadDownloadUrl,
  managedUploadRef,
  managedUploadRefFromLegacyPath,
  parseManagedUploadRef,
} from "../src/upload.js";

const FILE = "123e4567-e89b-12d3-a456-426614174000_截图.png";

describe("managed upload references", () => {
  it("round-trips a location through its reference", () => {
    const location = {
      projectId: "cHJvamVjdA",
      sessionId: "session-1",
      fileName: FILE,
    };
    expect(parseManagedUploadRef(managedUploadRef(location))).toEqual(location);
  });

  it("rejects dot-directory session segments", () => {
    expect(
      parseManagedUploadRef(
        `/api/projects/cHJvamVjdA/sessions/.derived/upload/${encodeURIComponent(FILE)}`,
      ),
    ).toBeNull();
  });

  it("maps legacy absolute upload paths and nothing else", () => {
    expect(
      managedUploadRefFromLegacyPath(
        `/Users/me/.yep-anywhere/uploads/cHJvamVjdA/session-1/${FILE}`,
      ),
    ).toBe(
      `/api/projects/cHJvamVjdA/sessions/session-1/upload/${encodeURIComponent(FILE)}`,
    );
    expect(managedUploadRefFromLegacyPath("/etc/passwd")).toBeNull();
    expect(
      managedUploadRefFromLegacyPath("relative/uploads/p/s/file.png"),
    ).toBeNull();
  });
});

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
