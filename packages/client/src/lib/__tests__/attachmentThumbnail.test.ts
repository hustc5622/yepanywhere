import { afterEach, describe, expect, it, vi } from "vitest";

describe("attachment thumbnail sources", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps upload thumbnails under the configured app base without duplicating it", async () => {
    vi.stubEnv("BASE_URL", "/yep/");
    const { getAttachmentThumbnailSrc } = await import(
      "../attachmentThumbnail"
    );
    expect(
      getAttachmentThumbnailSrc({
        mimeType: "image/png",
        apiPath: "/api/projects/p/sessions/s/upload/shot.png",
      }),
    ).toBe("/yep/api/projects/p/sessions/s/upload/shot.png");
    expect(
      getAttachmentThumbnailSrc({
        mimeType: "image/png",
        apiPath: "/yep/api/projects/p/sessions/s/upload/shot.png",
      }),
    ).toBe("/yep/api/projects/p/sessions/s/upload/shot.png");
  });

  it.each([
    "blob:local",
    "data:image/png;base64,aW1hZ2U=",
    "https://example.com/image.png",
  ])("prefers an existing image preview (%s)", async (previewUrl) => {
    const { getAttachmentThumbnailSrc } = await import(
      "../attachmentThumbnail"
    );
    expect(
      getAttachmentThumbnailSrc({
        mimeType: "image/png",
        previewUrl,
        apiPath: "/api/unused",
      }),
    ).toBe(previewUrl);
  });

  it("does not turn documents or raw filesystem paths into image requests", async () => {
    const { getAttachmentThumbnailSrc } = await import(
      "../attachmentThumbnail"
    );
    expect(
      getAttachmentThumbnailSrc({
        mimeType: "application/pdf",
        previewUrl: "blob:pdf",
      }),
    ).toBeUndefined();
    expect(
      getAttachmentThumbnailSrc({
        mimeType: "image/png",
        previewUrl: "/Users/test/shot.png",
      }),
    ).toBeUndefined();
    expect(
      getAttachmentThumbnailSrc({
        mimeType: "image/png",
        previewUrl: "file:///Users/test/shot.png",
      }),
    ).toBeUndefined();
  });
});
