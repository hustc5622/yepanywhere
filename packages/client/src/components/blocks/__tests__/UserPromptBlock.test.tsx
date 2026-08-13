import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../i18n";
import type { ContentBlock } from "../../../types";
import { UserPromptBlock } from "../UserPromptBlock";

describe("UserPromptBlock", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders Codex input_image blocks as uploaded file metadata", () => {
    const content: ContentBlock[] = [
      {
        type: "text",
        text: "Please review this screenshot.\n<image>\nThanks.",
      },
      {
        type: "input_image",
        image_url: "data:image/png;base64,AAAA",
      },
    ];

    render(
      <I18nProvider>
        <UserPromptBlock content={content} />
      </I18nProvider>,
    );

    expect(screen.getByText(/Please review this screenshot\./)).toBeDefined();
    expect(screen.getByText(/Thanks\./)).toBeDefined();
    expect(screen.queryByText("<image>")).toBeNull();
    expect(screen.getByText(/pasted-image-1\.png/)).toBeDefined();
    expect(screen.queryByText(/data:image\/png;base64/i)).toBeNull();
  });

  it("opens preview modal for Codex inline input_image attachments", () => {
    const content: ContentBlock[] = [
      {
        type: "text",
        text: '<image name=[Image #1] path="/Users/test/Desktop/screenshot.png"></image>[Image #1] Please review this screenshot.',
      },
      {
        type: "input_image",
        image_url: "data:image/png;base64,AAAA",
      },
    ];

    render(
      <I18nProvider>
        <UserPromptBlock content={content} />
      </I18nProvider>,
    );

    const attachmentButton = screen.getByRole("button", {
      name: /pasted-image-1\.png/i,
    });
    expect(screen.queryByText(/<image/i)).toBeNull();
    expect(screen.queryByText(/<\/image>/i)).toBeNull();

    fireEvent.click(attachmentButton);

    expect(
      screen.getByRole("img", { name: /pasted-image-1\.png/i }),
    ).toBeDefined();
  });

  it("uses file_path name for Codex input_image attachments", () => {
    const content: ContentBlock[] = [
      {
        type: "text",
        text: "Annotated image:\n<image>",
      },
      {
        type: "input_image",
        file_path: "/tmp/codex-images/annotated-shot.jpg",
      },
    ];

    render(
      <I18nProvider>
        <UserPromptBlock content={content} />
      </I18nProvider>,
    );

    expect(screen.getByText(/Annotated image:/)).toBeDefined();
    expect(screen.queryByText("<image>")).toBeNull();
    expect(screen.getByText(/annotated-shot\.jpg/)).toBeDefined();
  });

  it("renders injected skill blocks as clickable skill references", () => {
    const content = `<skill>
<name>git-commit-push</name>
<path>/Users/yueyuan/.codex/skills/git-commit-push/SKILL.md</path>
---
name: git-commit-push
description: Review repository changes and push them.
---

# Git Commit Push

Commit and push current changes.
</skill>`;

    render(
      <I18nProvider>
        <UserPromptBlock content={content} />
      </I18nProvider>,
    );

    expect(screen.queryByText(/<skill>/)).toBeNull();
    const skillLink = screen.getByRole("button", {
      name: /Skill git-commit-push/i,
    });
    expect(skillLink).toBeDefined();

    fireEvent.click(skillLink);

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText("Skill: git-commit-push")).toBeDefined();
    expect(
      screen.getByText("/Users/yueyuan/.codex/skills/git-commit-push/SKILL.md"),
    ).toBeDefined();
    expect(
      screen.getByText("Review repository changes and push them."),
    ).toBeDefined();
    expect(screen.getByText(/# Git Commit Push/)).toBeDefined();
  });

  it("renders a file-only Codex Desktop prompt without provider wrapper text", () => {
    const content = `# Files mentioned by the user:

## E1089999.BIN: F:/DCOLYMP/E1089999.BIN

<in-app-browser-context source="ambient-ui-state">
hidden browser state
</in-app-browser-context>

## My request:
`;

    render(
      <I18nProvider>
        <UserPromptBlock content={content} />
      </I18nProvider>,
    );

    expect(screen.getByText(/E1089999\.BIN/)).toBeDefined();
    expect(screen.queryByText(/Files mentioned by the user/)).toBeNull();
    expect(screen.queryByText(/in-app-browser-context/)).toBeNull();
    expect(screen.queryByText(/My request/)).toBeNull();
  });
});
