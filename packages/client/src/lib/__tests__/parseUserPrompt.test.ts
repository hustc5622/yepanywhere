import { describe, expect, it } from "vitest";
import { parseUserPrompt } from "../parseUserPrompt";

describe("parseUserPrompt", () => {
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

  it("maps Codex Desktop prompt wrappers into visible text and existing uploads", () => {
    const content = `# Files mentioned by the user:

## report.txt: C:/Temp/report.txt

<in-app-browser-context source="ambient-ui-state">
hidden browser state
</in-app-browser-context>

## My request:
Summarize the report`;

    const parsed = parseUserPrompt(content);

    expect(parsed.text).toBe("Summarize the report");
    expect(parsed.uploadedFiles).toEqual([
      {
        originalName: "report.txt",
        size: "unknown size",
        mimeType: "application/octet-stream",
        path: "C:/Temp/report.txt",
      },
    ]);
  });
});
