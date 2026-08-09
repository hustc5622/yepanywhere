import { describe, expect, it } from "vitest";
import { buildCodexUserInput } from "../../../src/sdk/providers/codex.js";

describe("Codex native user input", () => {
  it("maps native media and ordered structured references", () => {
    const input = buildCodexUserInput(
      {
        attachments: [
          { path: "/uploads/photo.png", mimeType: "image/png" },
          { path: "/uploads/voice.ogg", mimeType: "audio/ogg" },
          { path: "/uploads/report.pdf", mimeType: "application/pdf" },
          { path: "relative/unsafe.png", mimeType: "image/png" },
        ],
        codexInputs: [
          { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
          { type: "mention", name: "guide", path: "/docs/guide.md" },
        ],
        message: {
          content: [
            { type: "text", text: "inspect these" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/webp",
                data: "AAAA",
              },
            },
          ],
        },
      },
      "inspect these\n\nUser uploaded files:\n- report.pdf: /uploads/report.pdf",
    );

    expect(input).toEqual([
      {
        type: "text",
        text: expect.stringContaining("/uploads/report.pdf"),
        text_elements: [],
      },
      { type: "image", url: "data:image/webp;base64,AAAA" },
      { type: "localImage", path: "/uploads/photo.png" },
      { type: "localAudio", path: "/uploads/voice.ogg" },
      { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
      { type: "mention", name: "guide", path: "/docs/guide.md" },
    ]);
  });
});
