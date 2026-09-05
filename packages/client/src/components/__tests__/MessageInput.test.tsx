import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { MessageInput } from "../MessageInput";

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: { current: "test", capabilities: [] },
    loading: false,
    error: null,
    refetch: vi.fn(),
    refetchFresh: vi.fn(),
  }),
}));

function renderMessageInput(
  props: Partial<React.ComponentProps<typeof MessageInput>> = {},
) {
  const onSend = vi.fn();

  render(
    <I18nProvider>
      <MessageInput
        onSend={onSend}
        draftKey={`message-input-test-${crypto.randomUUID()}`}
        supportsPermissionMode={false}
        supportsThinkingToggle={false}
        {...props}
      />
    </I18nProvider>,
  );

  return {
    onSend,
    textarea: screen.getByRole("textbox") as HTMLTextAreaElement,
  };
}

function typeInTextarea(textarea: HTMLTextAreaElement, value: string) {
  textarea.focus();
  fireEvent.change(textarea, { target: { value } });
  textarea.setSelectionRange(value.length, value.length);
  fireEvent.keyUp(textarea);
}

describe("MessageInput", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "(pointer: coarse)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each(["Queue", "Insert now"])(
    "routes the %s button to its own submission callback",
    (choice) => {
      const onQueue = vi.fn();
      const onStop = vi.fn();
      const { textarea, onSend } = renderMessageInput({
        isRunning: true,
        isThinking: true,
        onQueue,
        onStop,
      });
      const queueButton = screen.getByRole("button", {
        name: "Queue",
      }) as HTMLButtonElement;
      const insertButton = screen.getByRole("button", {
        name: "Insert now",
      }) as HTMLButtonElement;
      expect(queueButton.disabled).toBe(true);
      expect(insertButton.disabled).toBe(true);

      typeInTextarea(textarea, "Follow up");
      expect(queueButton.disabled).toBe(false);
      expect(insertButton.disabled).toBe(false);
      expect(screen.getByRole("button", { name: "Stop" })).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: choice }));
      expect(choice === "Queue" ? onQueue : onSend).toHaveBeenCalledWith(
        "Follow up",
      );
      expect(choice === "Queue" ? onSend : onQueue).not.toHaveBeenCalled();
      expect(onStop).not.toHaveBeenCalled();
      expect(textarea.value).toBe("");
      expect(queueButton.disabled).toBe(true);
      expect(insertButton.disabled).toBe(true);
    },
  );

  it("keeps Enter for direct insertion and Ctrl+Enter for the deferred queue", () => {
    const onQueue = vi.fn();
    const { textarea, onSend } = renderMessageInput({
      isRunning: true,
      isThinking: true,
      onQueue,
    });
    typeInTextarea(textarea, "Next turn");
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(onQueue).toHaveBeenCalledWith("Next turn");
    expect(onSend).not.toHaveBeenCalled();

    typeInTextarea(textarea, "Current turn");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("Current turn");
    expect(onQueue).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "honors disabled=%s for attachment-only submissions",
    (disabled) => {
      const onQueue = vi.fn();
      const { onSend } = renderMessageInput({
        isRunning: true,
        isThinking: true,
        onQueue,
        disabled,
        attachments: [
          {
            id: "attachment-1",
            name: "attachment-1_image.png",
            originalName: "image.png",
            mimeType: "image/png",
            size: 1024,
            path: "/tmp/image.png",
          },
        ],
      });
      for (const name of ["Queue", "Insert now"]) {
        const button = screen.getByRole("button", {
          name,
        }) as HTMLButtonElement;
        expect(button.disabled).toBe(disabled);
        fireEvent.click(button);
      }
      expect(onQueue).toHaveBeenCalledTimes(disabled ? 0 : 1);
      expect(onSend).toHaveBeenCalledTimes(disabled ? 0 : 1);
    },
  );

  it("keeps ordinary Send when the session has no active turn", () => {
    renderMessageInput();
    expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Insert now" })).toBeNull();
  });

  it("offers both send choices with visible Chinese labels", async () => {
    localStorage.setItem("yep-anywhere-locale", "zh-CN");
    renderMessageInput({ isRunning: true, isThinking: true, onQueue: vi.fn() });
    expect(
      (await screen.findByRole("button", { name: "排队" })).textContent,
    ).toBe("排队");
    expect(
      (await screen.findByRole("button", { name: "直接插入" })).textContent,
    ).toContain("直接插入");
  });

  it("shows and inserts Claude slash commands only for '/' tokens", () => {
    const { textarea } = renderMessageInput({
      commandPrefix: "/",
      commandLabel: "Slash commands",
      commands: ["deep-research", "model"],
    });

    typeInTextarea(textarea, "/de");

    const listbox = screen.getByRole("listbox", { name: "Slash commands" });
    expect(
      within(listbox).getByRole("option", { name: "/deep-research" }),
    ).toBeDefined();

    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("/deep-research ");

    typeInTextarea(textarea, "$mo");
    expect(
      screen.queryByRole("listbox", { name: "Slash commands" }),
    ).toBeNull();
  });

  it("completes Codex slash commands and skills in separate namespaces", () => {
    const { textarea } = renderMessageInput({
      commandPrefix: "/",
      commandLabel: "Codex commands",
      commands: ["compact", "model"],
      commandButtons: [
        {
          prefix: "/",
          label: "Codex commands",
          showButton: true,
          commands: ["compact", "model"],
        },
        {
          prefix: "$",
          label: "Skills",
          showButton: true,
          commands: ["openai-docs"],
        },
      ],
    });

    typeInTextarea(textarea, "$op");

    const listbox = screen.getByRole("listbox", { name: "Skills" });
    expect(
      within(listbox).getByRole("option", { name: "$openai-docs" }),
    ).toBeDefined();

    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("$openai-docs ");

    typeInTextarea(textarea, "/co");
    expect(
      within(screen.getByRole("listbox", { name: "Codex commands" })).getByRole(
        "option",
        { name: "/compact" },
      ),
    ).toBeDefined();
  });

  it("uses the active provider prefix in the toolbar command menu", () => {
    const { textarea } = renderMessageInput({
      commandPrefix: "/",
      commandLabel: "Codex commands",
      commands: ["model", "review"],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Show codex commands" }),
    );

    const menu = screen.getByRole("menu", { name: "Codex commands" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "/model" }));

    expect(textarea.value).toBe("/model ");
  });

  it("renders separate slash-command and skill toolbar buttons", () => {
    const { textarea } = renderMessageInput({
      commandPrefix: "$",
      commandLabel: "Codex commands",
      commands: ["model"],
      commandButtons: [
        {
          prefix: "/",
          label: "Codex commands",
          showButton: true,
          commands: ["model"],
        },
        {
          prefix: "$",
          label: "Skills",
          showButton: true,
          commands: ["openai-docs"],
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Show skills" }));
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Skills" })).getByRole(
        "menuitem",
        { name: "$openai-docs" },
      ),
    );

    expect(textarea.value).toBe("$openai-docs ");
  });

  it("keeps the toolbar command button stable while commands are loading", () => {
    renderMessageInput({
      commandPrefix: "/",
      commandLabel: "Slash commands",
      commands: [],
      showCommandButton: true,
    });

    const button = screen.getByRole("button", {
      name: "Show slash commands",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.click(button);
    expect(screen.queryByRole("menu", { name: "Slash commands" })).toBeNull();
  });

  it("does not show the toolbar command button when provider flags disable it", () => {
    renderMessageInput({
      commandPrefix: "/",
      commandLabel: "Slash commands",
      commands: [],
      showCommandButton: false,
    });

    expect(
      screen.queryByRole("button", { name: "Show slash commands" }),
    ).toBeNull();
  });

  it("keeps custom slash commands from handling Codex dollar commands", () => {
    const onCustomCommand = vi.fn(() => true);
    const { textarea } = renderMessageInput({
      commandPrefix: "$",
      commandLabel: "Skills",
      commands: ["openai-docs"],
      onCustomCommand,
    });

    typeInTextarea(textarea, "$op");
    fireEvent.keyDown(textarea, { key: "Tab" });

    expect(onCustomCommand).not.toHaveBeenCalled();
    expect(textarea.value).toBe("$openai-docs ");
  });

  it("still routes custom slash commands through the slash handler", () => {
    const onCustomCommand = vi.fn(() => true);
    const { textarea } = renderMessageInput({
      commandPrefix: "/",
      commandLabel: "Slash commands",
      commands: ["model"],
      onCustomCommand,
    });

    typeInTextarea(textarea, "/mo");
    fireEvent.keyDown(textarea, { key: "Tab" });

    expect(onCustomCommand).toHaveBeenCalledWith("model");
    expect(textarea.value).toBe("");
  });

  it("submits an exact slash command instead of forcing completion", () => {
    const { textarea, onSend } = renderMessageInput({
      commandPrefix: "/",
      commandLabel: "Slash commands",
      commands: ["deep-research"],
    });

    typeInTextarea(textarea, "/deep-research");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("/deep-research");
    expect(textarea.value).toBe("");
  });

  it("pastes a copied user input as text plus all image attachments", () => {
    const onAttach = vi.fn();
    const { textarea } = renderMessageInput({
      projectId: "project",
      sessionId: "session",
      onAttach,
    });
    typeInTextarea(textarea, "prefix suffix");
    textarea.setSelectionRange(7, 7);

    fireEvent.paste(textarea, {
      clipboardData: {
        items: [],
        getData: (type: string) => {
          if (type === "text/plain") return "review both ";
          if (type === "text/html") {
            return `<div data-yep-anywhere-user-input="1">
              <img src="data:image/png;base64,Zmlyc3Q=" data-yep-anywhere-attachment-name="first.png">
              <img src="data:image/png;base64,c2Vjb25k" data-yep-anywhere-attachment-name="second.png">
            </div>`;
          }
          return "";
        },
      },
    });

    expect(textarea.value).toBe("prefix review both suffix");
    expect(onAttach).toHaveBeenCalledTimes(1);
    const attached = onAttach.mock.calls[0]?.[0] as File[];
    expect(attached.map((file) => file.name)).toEqual([
      "first.png",
      "second.png",
    ]);
  });
});
