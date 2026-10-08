import type { UploadedFile } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restorePromptAttachments } from "../restorePromptAttachments";
import {
  getUploadUrl,
  needsPromptAttachmentHydration,
  parseUserPromptContent,
} from "../userPromptContent";

const managedPath =
  "/Users/test/.yep-anywhere/uploads/cHJvamVjdA/session-1/123e4567-e89b-12d3-a456-426614174000_shot.png";

function connection() {
  return {
    fetchBlob: vi.fn(
      async () => new Blob(["original image"], { type: "image/png" }),
    ),
    upload: vi.fn(
      async (
        _projectId: string,
        _sessionId: string,
        file: File,
      ): Promise<UploadedFile> => ({
        id: "restored-image",
        originalName: file.name,
        name: `restored_${file.name}`,
        path: `/uploads/restored_${file.name}`,
        size: file.size,
        mimeType: file.type,
      }),
    ),
  };
}

describe("historical prompt attachments", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("restores a named screenshot once, retaining its position in the text", async () => {
    const parsed = parseUserPromptContent([
      {
        type: "text",
        text: `before @[shot.png] after\n\nUser uploaded files:\n- shot.png (12 KB, image/png): ${managedPath}`,
      },
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
    ]);
    const transport = connection();
    const restored = await restorePromptAttachments(
      { text: parsed.text, attachments: parsed.uploadedFiles },
      transport,
      "project",
      "session",
    );
    expect(restored.text).toBe("before @[shot.png] after");
    expect(restored.attachments).toHaveLength(1);
    expect(transport.fetchBlob).toHaveBeenCalledWith(
      "/projects/cHJvamVjdA/sessions/session-1/upload/123e4567-e89b-12d3-a456-426614174000_shot.png",
    );
    expect(transport.upload).toHaveBeenCalledWith(
      "project",
      "session",
      expect.objectContaining({ name: "shot.png", size: 14 }),
    );
  });

  it("preserves two different files sharing one filename and adds only the missing token", async () => {
    const transport = connection();
    const attachments = [
      managedPath,
      managedPath.replace("123e4567", "223e4567"),
    ].map((path) => ({
      originalName: "shot.png",
      size: "1 KB",
      mimeType: "image/png",
      path,
    }));
    const restored = await restorePromptAttachments(
      { text: "compare @[shot.png]", attachments },
      transport,
      "project",
      "session",
    );
    expect(restored.text).toBe("compare @[shot.png]  @[shot.png]  ");
    expect(restored.attachments).toHaveLength(2);
    expect(transport.upload).toHaveBeenCalledTimes(2);
  });

  it("fails the complete restoration before uploading when an image is missing", async () => {
    const transport = connection();
    transport.fetchBlob.mockRejectedValueOnce(new Error("API error: 404"));
    const parsed = parseUserPromptContent(
      `Keep screenshot\n\nUser uploaded files:\n- shot.png (12 KB, image/png): ${managedPath}`,
    );
    await expect(
      restorePromptAttachments(
        { text: parsed.text, attachments: parsed.uploadedFiles },
        transport,
        "project",
        "session",
      ),
    ).rejects.toThrow("404");
    expect(transport.upload).not.toHaveBeenCalled();
  });

  it("restores image-only provider content as an editable attachment token", async () => {
    const fetchImage = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["image"], { type: "image/png" }),
    }));
    vi.stubGlobal("fetch", fetchImage);
    const parsed = parseUserPromptContent([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
      },
    ]);
    const transport = connection();
    const restored = await restorePromptAttachments(
      { text: parsed.text, attachments: parsed.uploadedFiles },
      transport,
      "project",
      "session",
    );
    expect(fetchImage).toHaveBeenCalledWith("data:image/png;base64,aW1hZ2U=");
    expect(restored.text).toBe("@[pasted-image-1.png]  ");
    expect(restored.attachments[0]?.mimeType).toBe("image/png");
  });

  it("distinguishes deferred native images from managed images with deferred companions", () => {
    const native = parseUserPromptContent([
      { type: "input_image", deferred: true },
    ]);
    expect(needsPromptAttachmentHydration(native.uploadedFiles)).toBe(true);
    const managed = parseUserPromptContent([
      {
        type: "text",
        text: `\nUser uploaded files:\n- shot.png (12 KB, image/png): ${managedPath}`,
      },
      { type: "input_image", deferred: true },
    ]);
    expect(managed.uploadedFiles).toHaveLength(1);
    expect(needsPromptAttachmentHydration(managed.uploadedFiles)).toBe(false);
  });

  it.each([
    { type: "image", data: "", mimeType: "image/png", deferred: true },
    { type: "image", data: "  ", mimeType: "image/png" },
    { type: "input_image", image_url: "data:image/png;base64," },
    { type: "input_image", image_url: "data:image/png;base64,  " },
    {
      type: "input_image",
      image_url: "data:image/png;base64,AAAA",
      deferred: true,
    },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "" },
    },
  ])(
    "requests hydration instead of treating missing native bytes as a usable image: %j",
    (block) => {
      const deferred = parseUserPromptContent([block]);
      expect(deferred.uploadedFiles).toHaveLength(1);
      expect(deferred.uploadedFiles[0]?.previewUrl).toBeUndefined();
      expect(needsPromptAttachmentHydration(deferred.uploadedFiles)).toBe(true);
    },
  );

  it("recognizes the complete Pi image returned by hydration", async () => {
    const fetchImage = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["image"], { type: "image/png" }),
    }));
    vi.stubGlobal("fetch", fetchImage);
    const complete = parseUserPromptContent([
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ]);
    expect(needsPromptAttachmentHydration(complete.uploadedFiles)).toBe(false);
    const transport = connection();
    const restored = await restorePromptAttachments(
      { text: complete.text, attachments: complete.uploadedFiles },
      transport,
      "project",
      "session",
    );
    expect(fetchImage).toHaveBeenCalledWith("data:image/png;base64,aW1hZ2U=");
    expect(restored.attachments[0]).toMatchObject({
      size: 5,
      mimeType: "image/png",
      originalName: "pasted-image-1.png",
    });
  });

  it("rejects a zero-byte image response before uploading any attachment", async () => {
    const transport = connection();
    transport.fetchBlob.mockResolvedValueOnce(
      new Blob([], { type: "image/png" }),
    );
    await expect(
      restorePromptAttachments(
        {
          text: "keep this image",
          attachments: [
            {
              originalName: "shot.png",
              path: managedPath,
              size: "1 KB",
              mimeType: "image/png",
            },
          ],
        },
        transport,
        "project",
        "session",
      ),
    ).rejects.toThrow("Image data unavailable");
    expect(transport.upload).not.toHaveBeenCalled();
  });

  it.each([
    "/api/settings/",
    "/api/local-image?path=%2Ftmp%2Fshot.png&extra=1",
    "/api/local-image?path=relative.png",
    "/api/projects/invalid!/sessions/session-1/upload/123e4567-e89b-12d3-a456-426614174000_shot.png",
  ])(
    "rejects non-attachment API locations before reading: %s",
    async (path) => {
      const transport = connection();
      const browserFetch = vi.fn();
      vi.stubGlobal("fetch", browserFetch);
      await expect(
        restorePromptAttachments(
          {
            text: "edited",
            attachments: [
              {
                path,
                originalName: "shot.png",
                mimeType: "image/png",
                size: "1 KB",
              },
            ],
          },
          transport,
          "project",
          "session",
        ),
      ).rejects.toThrow("allowed image or upload route");
      expect(transport.fetchBlob).not.toHaveBeenCalled();
      expect(transport.upload).not.toHaveBeenCalled();
      expect(browserFetch).not.toHaveBeenCalled();
    },
  );

  it("rejects same-origin business API preview URLs without browser fetch", async () => {
    const transport = connection();
    const browserFetch = vi.fn();
    vi.stubGlobal("fetch", browserFetch);
    await expect(
      restorePromptAttachments(
        {
          text: "edited",
          attachments: [
            {
              path: "codex-inline://image/1",
              previewUrl: `${window.location.origin}/api/settings/`,
              originalName: "shot.png",
              mimeType: "image/png",
              size: "1 KB",
            },
          ],
        },
        transport,
        "project",
        "session",
      ),
    ).rejects.toThrow("allowed image or upload route");
    expect(transport.fetchBlob).not.toHaveBeenCalled();
    expect(transport.upload).not.toHaveBeenCalled();
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it.each([
    "/api/local-image?path=%2Ftmp%2Fshot.png",
    `${window.location.origin}/api/local-image?path=%2Ftmp%2Fshot.png`,
  ])(
    "restores a native image through the controlled local-image endpoint: %s",
    async (path) => {
      const transport = connection();
      await restorePromptAttachments(
        {
          text: "edited",
          attachments: [
            {
              path,
              originalName: "shot.png",
              mimeType: "image/png",
              size: "1 KB",
            },
          ],
        },
        transport,
        "project",
        "session",
      );
      expect(transport.fetchBlob).toHaveBeenCalledWith(
        "/local-image?path=%2Ftmp%2Fshot.png",
      );
      expect(transport.upload).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    managedPath.replace("cHJvamVjdA", "project?unexpected"),
    managedPath.replace("session-1", ".."),
    managedPath.replace("shot.png", "../shot.png"),
    `https://example.com${managedPath}`,
  ])(
    "does not construct an upload route from unsafe path components: %s",
    (path) => {
      expect(getUploadUrl(path)).toBeNull();
    },
  );

  it.each(["image/png", "application/json"])(
    "uses external image bytes only when the response is an image: %s",
    async (type) => {
      const browserFetch = vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(["response"], { type }),
      }));
      vi.stubGlobal("fetch", browserFetch);
      const transport = connection();
      const result = restorePromptAttachments(
        {
          text: "edited",
          attachments: [
            {
              path: "https://images.example.test/shot.png",
              originalName: "shot.png",
              mimeType: "image/png",
              size: "1 KB",
            },
          ],
        },
        transport,
        "project",
        "session",
      );
      if (type === "image/png") {
        await expect(result).resolves.toMatchObject({
          attachments: [expect.objectContaining({ mimeType: "image/png" })],
        });
      } else {
        await expect(result).rejects.toThrow("Image response unavailable");
        expect(transport.upload).not.toHaveBeenCalled();
      }
      expect(browserFetch).toHaveBeenCalledWith(
        "https://images.example.test/shot.png",
        { credentials: "omit" },
      );
    },
  );
});
