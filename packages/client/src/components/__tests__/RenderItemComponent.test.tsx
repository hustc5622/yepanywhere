import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { Message } from "../../types";
import type { RenderItem } from "../../types/renderItems";
import { RenderItemComponent } from "../RenderItemComponent";

function promptItem(message: Message): RenderItem {
  return {
    id: `prompt-${message.uuid}`,
    type: "user_prompt",
    content: message.message?.content ?? "prompt",
    sourceMessages: [message],
  };
}

function renderPrompt(
  message: Message,
  provider: string,
  onEditUserPrompt = vi.fn(),
) {
  render(
    <I18nProvider>
      <RenderItemComponent
        item={promptItem(message)}
        isStreaming={false}
        thinkingExpanded={false}
        toggleThinkingExpanded={() => {}}
        sessionProvider={provider}
        onEditUserPrompt={onEditUserPrompt}
      />
    </I18nProvider>,
  );
  return onEditUserPrompt;
}

describe("RenderItemComponent OpenCode edit identity", () => {
  afterEach(() => cleanup());

  it("shows edit for a persisted OpenCode user prompt with its native ID", () => {
    const onEdit = renderPrompt(
      {
        uuid: "msg_native_user",
        type: "user",
        _source: "jsonl",
        message: { role: "user", content: "persisted prompt" },
      },
      "opencode",
    );

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    expect(onEdit).toHaveBeenCalledWith({
      text: "persisted prompt",
      uuid: "msg_native_user",
      parentUuid: null,
    });
  });

  it("hides edit for a live OpenCode echo carrying a temporary Yep UUID", () => {
    renderPrompt(
      {
        uuid: "temporary-yep-uuid",
        type: "user",
        _source: "sdk",
        message: { role: "user", content: "pending prompt" },
      },
      "opencode",
    );

    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
  });

  it("does not accidentally expose edit for unsupported providers", () => {
    renderPrompt(
      {
        uuid: "gemini-user",
        type: "user",
        _source: "jsonl",
        message: { role: "user", content: "gemini prompt" },
      },
      "gemini",
    );

    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
  });
});
