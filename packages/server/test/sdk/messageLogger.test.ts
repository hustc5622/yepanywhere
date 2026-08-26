import { describe, expect, it } from "vitest";
import { sanitizeSDKMessageForLog } from "../../src/sdk/messageLogger.js";

describe("SDK message logger safety", () => {
  it("retains structured Codex paths and names", () => {
    const safe = sanitizeSDKMessageForLog({
      type: "user",
      codexInputs: [
        {
          type: "skill",
          name: "skill-creator",
          path: "/managed/workspace/.codex/skills/skill-creator/SKILL.md",
        },
        {
          type: "mention",
          name: "github",
          path: "app://github/private-installation",
        },
      ],
    });

    expect(safe).toEqual({
      type: "user",
      codexInputs: [
        {
          type: "skill",
          name: "skill-creator",
          path: "/managed/workspace/.codex/skills/skill-creator/SKILL.md",
        },
        {
          type: "mention",
          name: "github",
          path: "app://github/private-installation",
        },
      ],
    });
    expect(JSON.stringify(safe)).toContain("/managed/workspace");
    expect(JSON.stringify(safe)).toContain("private-installation");
  });

  it("retains managed attachment and local-media paths", () => {
    const safe = sanitizeSDKMessageForLog({
      type: "user",
      message: {
        role: "user",
        content:
          "inspect\n\nUser uploaded files:\n- report.pdf (2.0 KB, application/pdf): C:\\managed\\folder: confidential\\report.pdf",
      },
      attachments: [
        {
          id: "attachment-1",
          originalName: "report.pdf",
          size: 2048,
          mimeType: "application/pdf",
          path: "/managed/private/report.pdf",
        },
      ],
      input: [
        { type: "localImage", path: "/managed/private/image.png" },
        { type: "localAudio", path: "C:\\managed\\voice.wav" },
      ],
    });

    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("[managed attachment]");
    expect(serialized).toContain("/managed/private");
    expect(serialized).toContain("C:\\\\managed");
    expect(serialized).toContain("folder: confidential");
  });

  it("retains Codex image-view paths in tool and canonical shapes", () => {
    const managedPath = "/managed/workspace/screenshots/result.png";
    const safe = sanitizeSDKMessageForLog([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "image-1",
              name: "ViewImage",
              input: { path: managedPath },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "image-1",
              content: `Viewed image: ${managedPath}`,
            },
          ],
        },
      },
      {
        type: "system",
        codexThreadItem: {
          type: "imageView",
          id: "image-1",
          path: managedPath,
        },
      },
    ]);

    expect(safe).toMatchObject([
      {
        message: {
          content: [{ input: { path: managedPath } }],
        },
      },
      {
        message: {
          content: [{ content: `Viewed image: ${managedPath}` }],
        },
      },
      {
        codexThreadItem: { path: managedPath },
      },
    ]);
    expect(JSON.stringify(safe)).toContain(managedPath);
  });

  it("does not rewrite ordinary assistant text that quotes the marker", () => {
    const content =
      "Example:\nUser uploaded files:\n- report.pdf (2 KB, application/pdf): /example/not-a-managed-upload";
    expect(
      sanitizeSDKMessageForLog({
        type: "assistant",
        message: { role: "assistant", content },
      }),
    ).toEqual({
      type: "assistant",
      message: { role: "assistant", content },
    });
  });
});
