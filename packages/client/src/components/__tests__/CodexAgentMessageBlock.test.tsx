import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { CodexNativeItemBlock } from "../blocks/codex/CodexNativeItemBlock";

describe("Codex agent handoffs", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("shows encrypted task metadata without presenting it as an empty assistant reply", () => {
    render(
      <CodexNativeItemBlock
        item={{
          type: "codex_native_item",
          id: "assignment",
          lifecycle: "completed",
          sourceMessages: [{ timestamp: "2026-10-08T01:57:26.833Z" }],
          threadItem: {
            type: "interAgentMessage",
            kind: "task",
            sender: "/root",
            recipient: "/root/review_agents_doc",
            encrypted: true,
          },
        }}
      />,
    );
    const task = screen.getByRole("region", { name: "Assigned task" });
    expect(task.textContent).toContain("Main agent → /root/review_agents_doc");
    expect(task.textContent).toContain(
      "Codex encrypted this message. Its text is unavailable.",
    );
    expect(task.querySelector("time")?.dateTime).toBe(
      "2026-10-08T01:57:26.833Z",
    );
    expect(task.textContent).not.toContain("No message text was recorded");
  });

  it("identifies a result as returned to the parent and renders its text", () => {
    render(
      <CodexNativeItemBlock
        item={{
          type: "codex_native_item",
          id: "result",
          lifecycle: "completed",
          sourceMessages: [],
          threadItem: {
            type: "interAgentMessage",
            kind: "result",
            sender: "/root/reviewer",
            recipient: "/root",
            text: "The document references were verified.",
            encrypted: false,
          },
        }}
      />,
    );
    const result = screen.getByRole("region", { name: "Returned result" });
    expect(result.textContent).toContain("/root/reviewer → Main agent");
    expect(result.textContent).toContain(
      "The document references were verified.",
    );
    expect(result.textContent).not.toContain("encrypted");
  });

  it("localizes communication and preserves nested agent addresses", async () => {
    localStorage.setItem("yep-anywhere-locale", "zh-CN");
    render(
      <I18nProvider>
        <CodexNativeItemBlock
          item={{
            type: "codex_native_item",
            id: "nested-message",
            lifecycle: "completed",
            sourceMessages: [],
            threadItem: {
              type: "interAgentMessage",
              kind: "message",
              sender: "/root/reviewer",
              recipient: "/root/reviewer/check_refs",
              encrypted: true,
            },
          }}
        />
      </I18nProvider>,
    );
    const message = await screen.findByRole("region", { name: "协作消息" });
    expect(message.textContent).toContain(
      "/root/reviewer → /root/reviewer/check_refs",
    );
    expect(message.textContent).toContain(
      "这条消息由 Codex 加密，无法显示正文。",
    );
  });
});
