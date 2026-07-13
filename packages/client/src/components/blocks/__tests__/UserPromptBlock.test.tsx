import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n";
import type { ContentBlock } from "../../../types";
import { UserPromptBlock } from "../UserPromptBlock";

describe("UserPromptBlock", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it("shows detailed request errors for uploaded image attachments", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "File not found" }), {
          status: 404,
          statusText: "Not Found",
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const content =
      "Check this image.\n\nUser uploaded files:\n- screenshot.jpg (1 KB, image/jpeg): /Users/test/.yep-anywhere/uploads/project-id/session-id/76285622-cb0a-47e3-a0d9-ffcdae95af9b_screenshot.jpg";

    render(
      <I18nProvider>
        <UserPromptBlock content={content} />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /screenshot\.jpg/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "HTTP 404 Not Found",
      );
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Content-Type: application/json",
    );
    expect(screen.getByRole("alert").textContent).toContain("File not found");
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
});
