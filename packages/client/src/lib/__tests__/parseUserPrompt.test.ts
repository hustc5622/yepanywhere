import { describe, expect, it } from "vitest";
import { parseUserPrompt } from "../parseUserPrompt";

describe("parseUserPrompt", () => {
  it("turns Feishu transport manifests into a safe display summary", () => {
    const content = `![image](img_v3_fixture)
怎么回复

<feishu_context_manifest>
mode: current
effective_mode: current
messages: 1
attachments: 1
operator: ou_private
complete: true
warnings: none
</feishu_context_manifest>

<feishu_attachment_manifest>
- private_feishu-1.image | kind=image | mime=image/png | bytes=21777 | sha256=private | ref=upload:private | status=downloaded
</feishu_attachment_manifest>

User uploaded files:
- feishu-1.image (21.3 KB, image/png): /api/projects/project/sessions/session/upload/123e4567-e89b-12d3-a456-426614174000_feishu-1.image`;

    const parsed = parseUserPrompt(content);

    expect(parsed.text).toBe("怎么回复");
    expect(parsed.text).not.toContain("ou_private");
    expect(parsed.text).not.toContain("sha256");
    expect(parsed.feishu).toEqual({
      messageCount: 1,
      attachmentCount: 1,
      contextMode: "current",
      complete: true,
      hasWarnings: false,
    });
    expect(parsed.uploadedFiles).toEqual([
      {
        originalName: "feishu-1.image",
        size: "21.3 KB",
        mimeType: "image/png",
        path: "/api/projects/project/sessions/session/upload/123e4567-e89b-12d3-a456-426614174000_feishu-1.image",
      },
    ]);
  });

  it("cleans Feishu framing while retaining document links", () => {
    const content = `## 飞书消息 1/2

**任务说明**
请查看 [项目文档](https://example.test/doc)

<feishu_context_manifest>
mode: current+quoted
effective_mode: current+quoted
messages: 2
attachments: 0
complete: false
warnings: QUOTED_MESSAGE_UNAVAILABLE
</feishu_context_manifest>`;

    const parsed = parseUserPrompt(content);

    expect(parsed.text).toBe(
      "任务说明\n请查看 [项目文档](https://example.test/doc)",
    );
    expect(parsed.feishu).toEqual({
      messageCount: 2,
      attachmentCount: 0,
      contextMode: "current+quoted",
      complete: false,
      hasWarnings: true,
    });
  });

  it("extracts complete skill blocks from user prompt text", () => {
    const content = `Please use this.

<skill>
<name>git-commit-push</name>
<path>/Users/yueyuan/.codex/skills/git-commit-push/SKILL.md</path>
---
name: git-commit-push
description: Review repository changes and push them.
---

# Git Commit Push

Commit and push current changes.
</skill>

Thanks.`;

    const parsed = parseUserPrompt(content);

    expect(parsed.text).toContain("Please use this.");
    expect(parsed.text).toContain("Thanks.");
    expect(parsed.text).not.toContain("<skill>");
    expect(parsed.skills).toEqual([
      {
        name: "git-commit-push",
        path: "/Users/yueyuan/.codex/skills/git-commit-push/SKILL.md",
        description: "Review repository changes and push them.",
        markdown: `---
name: git-commit-push
description: Review repository changes and push them.
---

# Git Commit Push

Commit and push current changes.`,
        raw: `<skill>
<name>git-commit-push</name>
<path>/Users/yueyuan/.codex/skills/git-commit-push/SKILL.md</path>
---
name: git-commit-push
description: Review repository changes and push them.
---

# Git Commit Push

Commit and push current changes.
</skill>`,
      },
    ]);
  });

  it("leaves incomplete skill examples in the visible text", () => {
    const content = `Do not show this as raw text:
<skill>
<name>git-commit-push</name>`;

    const parsed = parseUserPrompt(content);

    expect(parsed.text).toContain("<skill>");
    expect(parsed.text).toContain("<name>git-commit-push</name>");
    expect(parsed.skills).toHaveLength(0);
  });
});
