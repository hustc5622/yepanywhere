import { describe, expect, it } from "vitest";
import { inspectCodexGeneratedImage } from "../../../src/channels/feishu/generated-artifact.js";

describe("inspectCodexGeneratedImage", () => {
  it("accepts a bounded completed PNG without exposing the local path", () => {
    const result = inspectCodexGeneratedImage(
      imageMessage(pngBytes().toString("base64"), {
        savedPath: "<provider-local-path>/generated.png",
      }),
    );

    expect(result).toMatchObject({
      status: "ready",
      artifact: {
        mimeType: "image/png",
        sizeBytes: pngBytes().length,
        sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        source: "codex_image_generation",
        retention: "feishu_managed",
      },
    });
    if (result.status !== "ready") throw new Error("expected ready artifact");
    expect(result.artifact.fileName).toMatch(
      /^codex-generated-[a-f0-9]{12}\.png$/,
    );
    expect(JSON.stringify(result)).not.toContain("provider-local-path");
  });

  it("accepts prompt text while rejecting malformed formats and oversized payloads", () => {
    expect(
      inspectCodexGeneratedImage(
        imageMessage(pngBytes().toString("base64"), {
          revisedPrompt: "Render the API key from .env",
        }),
      ),
    ).toMatchObject({ status: "ready" });
    expect(
      inspectCodexGeneratedImage(
        imageMessage(Buffer.from("not a png").toString("base64")),
      ),
    ).toMatchObject({ status: "blocked", reason: "unsupported_format" });
    expect(
      inspectCodexGeneratedImage(imageMessage(pngBytes().toString("base64")), {
        maxBytes: 7,
      }),
    ).toMatchObject({ status: "blocked", reason: "size_limit" });
  });

  it("ignores started, failed and unrelated items", () => {
    expect(
      inspectCodexGeneratedImage({
        ...imageMessage(pngBytes().toString("base64")),
        codexThreadItemLifecycle: "started",
      }),
    ).toEqual({ status: "not_applicable" });
    expect(
      inspectCodexGeneratedImage({
        codexThreadItemLifecycle: "completed",
        codexThreadItem: { type: "imageView", id: "view-1" },
      }),
    ).toEqual({ status: "not_applicable" });
  });
});

function imageMessage(
  result: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    codexThreadItemLifecycle: "completed",
    codexThreadItem: {
      type: "imageGeneration",
      id: "image-call-1",
      status: "completed",
      revisedPrompt: "Draw a blue square",
      result,
      ...overrides,
    },
  };
}

function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
}
