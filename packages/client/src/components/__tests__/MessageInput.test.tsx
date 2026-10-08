import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { UploadedFile } from "@yep-anywhere/shared";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { serializeComposerContent } from "../AttachmentComposer";
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

vi.mock("../../hooks/useRemoteImage", () => ({
  useFetchedImage: () => ({
    url: "data:image/png;base64,aW1hZ2U=",
    loading: false,
    error: null,
  }),
}));

function imageAttachment(id: string, originalName = "image.png"): UploadedFile {
  return {
    id,
    name: `${id}_${originalName}`,
    originalName,
    mimeType: "image/png",
    size: 1024,
    path: `/tmp/${id}_${originalName}`,
  };
}

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
    composer: screen.getByRole("textbox"),
  };
}

function setTextSelection(composer: HTMLElement, start: number, end = start) {
  const textNode = composer.firstChild;
  if (!textNode) throw new Error("Expected a text node in the composer");
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.select(composer);
}

function typeInComposer(composer: HTMLElement, value: string) {
  composer.focus();
  composer.textContent = value;
  if (value) setTextSelection(composer, value.length);
  fireEvent.input(composer, { inputType: "insertText", data: value });
  fireEvent.keyUp(composer);
}

function renderAttachmentDraft(text: string, attachments: UploadedFile[]) {
  const draftKey = `attachment-draft-${crypto.randomUUID()}`;
  localStorage.setItem(draftKey, text);
  const onSend = vi.fn();
  const onRemoveAttachment = vi.fn();
  const onRestoreAttachment = vi.fn();

  function AttachmentDraft() {
    const [files, setFiles] = useState(attachments);
    return (
      <I18nProvider>
        <MessageInput
          draftKey={draftKey}
          projectId="project"
          sessionId="session"
          attachments={files}
          onSend={onSend}
          onRemoveAttachment={(id) => {
            onRemoveAttachment(id);
            setFiles((current) => current.filter((file) => file.id !== id));
          }}
          onRestoreAttachment={(file) => {
            onRestoreAttachment(file);
            setFiles((current) => [...current, file]);
          }}
          supportsPermissionMode={false}
          supportsThinkingToggle={false}
        />
      </I18nProvider>
    );
  }

  render(<AttachmentDraft />);
  return {
    composer: screen.getByRole("textbox"),
    onSend,
    onRemoveAttachment,
    onRestoreAttachment,
  };
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
      const { composer, onSend } = renderMessageInput({
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

      typeInComposer(composer, "Follow up");
      expect(queueButton.disabled).toBe(false);
      expect(insertButton.disabled).toBe(false);
      expect(screen.getByRole("button", { name: "Stop" })).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: choice }));
      expect(choice === "Queue" ? onQueue : onSend).toHaveBeenCalledWith(
        "Follow up",
      );
      expect(choice === "Queue" ? onSend : onQueue).not.toHaveBeenCalled();
      expect(onStop).not.toHaveBeenCalled();
      expect(serializeComposerContent(composer)).toBe("");
      expect(queueButton.disabled).toBe(true);
      expect(insertButton.disabled).toBe(true);
    },
  );

  it("keeps Enter for direct insertion and Ctrl+Enter for the deferred queue", () => {
    const onQueue = vi.fn();
    const { composer, onSend } = renderMessageInput({
      isRunning: true,
      isThinking: true,
      onQueue,
    });
    typeInComposer(composer, "Next turn");
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    expect(onQueue).toHaveBeenCalledWith("Next turn");
    expect(onSend).not.toHaveBeenCalled();

    typeInComposer(composer, "Current turn");
    fireEvent.keyDown(composer, { key: "Enter" });
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

  it.each(["en", "zh-CN"])(
    "offers interrupt-and-send for an owned Codex turn in %s",
    async (locale) => {
      localStorage.setItem("yep-anywhere-locale", locale);
      const onQueue = vi.fn();
      const onStop = vi.fn();
      const onInterruptSend = vi.fn();
      const { composer, onSend } = renderMessageInput({
        provider: "codex",
        isRunning: true,
        isThinking: true,
        onQueue,
        onStop,
        onInterruptSend,
      });
      const name = locale === "en" ? "Interrupt & send" : "打断并发送";
      const button = await screen.findByRole("button", { name });
      typeInComposer(composer, "New instructions");
      fireEvent.click(button);
      expect(onInterruptSend).toHaveBeenCalledWith("New instructions");
      expect(onSend).not.toHaveBeenCalled();
      expect(button.title).not.toContain("Enter");
      // One request owns interrupt-and-send; the UI must not race a separate stop.
      expect(onStop).not.toHaveBeenCalled();
      expect(onQueue).not.toHaveBeenCalled();
    },
  );

  it.each(["en", "zh-CN"])(
    "replies to a running Codex turn without interrupting in %s",
    async (locale) => {
      localStorage.setItem("yep-anywhere-locale", locale);
      const onInterruptSend = vi.fn();
      const onQueue = vi.fn();
      const onStop = vi.fn();
      const { composer, onSend } = renderMessageInput({
        provider: "codex",
        isRunning: true,
        isThinking: true,
        onInterruptSend,
        onQueue,
        onStop,
      });
      const name = locale === "en" ? "Reply & continue" : "回复并继续";
      const button = (await screen.findByRole("button", {
        name,
      })) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      typeInComposer(composer, "支持多选同行人");
      fireEvent.click(button);
      expect(onSend).toHaveBeenCalledWith("支持多选同行人");
      expect(serializeComposerContent(composer)).toBe("");

      typeInComposer(composer, "补充：记录修改人");
      fireEvent.keyDown(composer, { key: "Enter" });
      expect(onSend).toHaveBeenLastCalledWith("补充：记录修改人");
      expect(onSend).toHaveBeenCalledTimes(2);
      expect(onInterruptSend).not.toHaveBeenCalled();
      expect(onStop).not.toHaveBeenCalled();
      expect(onQueue).not.toHaveBeenCalled();

      typeInComposer(composer, "下一项任务");
      fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
      expect(onQueue).toHaveBeenCalledWith("下一项任务");
      expect(onSend).toHaveBeenCalledTimes(2);
      expect(onInterruptSend).not.toHaveBeenCalled();
    },
  );

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
    const { composer } = renderMessageInput({
      commandPrefix: "/",
      commandLabel: "Slash commands",
      commands: ["deep-research", "model"],
    });

    typeInComposer(composer, "/de");

    const listbox = screen.getByRole("listbox", { name: "Slash commands" });
    expect(
      within(listbox).getByRole("option", { name: "/deep-research" }),
    ).toBeDefined();

    fireEvent.keyDown(composer, { key: "Tab" });
    expect(serializeComposerContent(composer)).toBe("/deep-research ");

    typeInComposer(composer, "$mo");
    expect(
      screen.queryByRole("listbox", { name: "Slash commands" }),
    ).toBeNull();
  });

  it("completes Codex slash commands and skills in separate namespaces", () => {
    const { composer } = renderMessageInput({
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

    typeInComposer(composer, "$op");

    const listbox = screen.getByRole("listbox", { name: "Skills" });
    expect(
      within(listbox).getByRole("option", { name: "$openai-docs" }),
    ).toBeDefined();

    fireEvent.keyDown(composer, { key: "Tab" });
    expect(serializeComposerContent(composer)).toBe("$openai-docs ");

    typeInComposer(composer, "/co");
    expect(
      within(screen.getByRole("listbox", { name: "Codex commands" })).getByRole(
        "option",
        { name: "/compact" },
      ),
    ).toBeDefined();
  });

  it("uses the active provider prefix in the toolbar command menu", () => {
    const { composer } = renderMessageInput({
      commandPrefix: "/",
      commandLabel: "Codex commands",
      commands: ["model", "review"],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Show codex commands" }),
    );

    const menu = screen.getByRole("menu", { name: "Codex commands" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "/model" }));

    expect(serializeComposerContent(composer)).toBe("/model ");
  });

  it("renders separate slash-command and skill toolbar buttons", () => {
    const { composer } = renderMessageInput({
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

    expect(serializeComposerContent(composer)).toBe("$openai-docs ");
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
    const { composer } = renderMessageInput({
      commandPrefix: "$",
      commandLabel: "Skills",
      commands: ["openai-docs"],
      onCustomCommand,
    });

    typeInComposer(composer, "$op");
    fireEvent.keyDown(composer, { key: "Tab" });

    expect(onCustomCommand).not.toHaveBeenCalled();
    expect(serializeComposerContent(composer)).toBe("$openai-docs ");
  });

  it("still routes custom slash commands through the slash handler", () => {
    const onCustomCommand = vi.fn(() => true);
    const { composer } = renderMessageInput({
      commandPrefix: "/",
      commandLabel: "Slash commands",
      commands: ["model"],
      onCustomCommand,
    });

    typeInComposer(composer, "/mo");
    fireEvent.keyDown(composer, { key: "Tab" });

    expect(onCustomCommand).toHaveBeenCalledWith("model");
    expect(serializeComposerContent(composer)).toBe("");
  });

  it("submits an exact slash command instead of forcing completion", () => {
    const { composer, onSend } = renderMessageInput({
      commandPrefix: "/",
      commandLabel: "Slash commands",
      commands: ["deep-research"],
    });

    typeInComposer(composer, "/deep-research");
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("/deep-research");
    expect(serializeComposerContent(composer)).toBe("");
  });

  it.each([
    { key: "Enter", isComposing: true, keyCode: 13 },
    { key: "Tab", isComposing: true, keyCode: 9 },
    { key: "Enter", isComposing: false, keyCode: 229 },
    { key: "Tab", isComposing: false, keyCode: 229 },
  ])(
    "ignores IME $key with isComposing=$isComposing and keyCode=$keyCode",
    (keyboardEvent) => {
      const onCustomCommand = vi.fn(() => true);
      const { composer, onSend } = renderMessageInput({
        commands: ["model"],
        commandPrefix: "/",
        commandLabel: "Slash commands",
        onCustomCommand,
      });

      typeInComposer(composer, "/mo");
      expect(screen.getByRole("listbox")).toBeDefined();
      fireEvent.compositionStart(composer);
      fireEvent.keyDown(composer, keyboardEvent);

      expect(onCustomCommand).not.toHaveBeenCalled();
      expect(onSend).not.toHaveBeenCalled();
      expect(serializeComposerContent(composer)).toBe("/mo");

      fireEvent.compositionEnd(composer, { data: "/mo" });
      fireEvent.keyDown(composer, { key: "Tab" });
      expect(onCustomCommand).toHaveBeenCalledWith("model");
    },
  );

  it("keeps the native Chinese composition text and sends only after composition finishes", () => {
    const { composer, onSend } = renderMessageInput();
    typeInComposer(composer, "请查看");
    fireEvent.compositionStart(composer);
    const textNode = composer.firstChild;
    if (!textNode) throw new Error("Expected a native text node");
    textNode.textContent = "请查看图片";
    setTextSelection(composer, "请查看图片".length);
    fireEvent.input(composer, {
      inputType: "insertCompositionText",
      isComposing: true,
      data: "图片",
    });
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(composer.firstChild).toBe(textNode);
    expect(serializeComposerContent(composer)).toBe("请查看图片");

    fireEvent.compositionEnd(composer, { data: "图片" });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("请查看图片");
  });

  it("restores image cards in a text draft and submits the original attachment tokens", () => {
    const draft = "Please compare @[first.png] with @[second.png] carefully";
    const { composer, onSend, onRemoveAttachment } = renderAttachmentDraft(
      draft,
      [
        imageAttachment("first", "first.png"),
        imageAttachment("second", "second.png"),
      ],
    );

    expect(composer.getAttribute("contenteditable")).toBe("true");
    const cards = composer.querySelectorAll("[data-attachment-token]");
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect((card as HTMLElement).contentEditable).toBe("false");
    }
    expect(serializeComposerContent(composer)).toBe(draft);
    expect(
      screen.getByRole("button", { name: "Remove first.png" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith(draft);
    expect(onRemoveAttachment).not.toHaveBeenCalled();
    expect(serializeComposerContent(composer)).toBe("");
  });

  it("removes only the selected attachment when two files have the same name", () => {
    const { composer, onRemoveAttachment } = renderAttachmentDraft(
      "first @[image.png] second @[image.png] end",
      [imageAttachment("first"), imageAttachment("second")],
    );
    const removeButtons = screen.getAllByRole("button", {
      name: "Remove image.png",
    });
    expect(removeButtons).toHaveLength(2);
    const secondRemoveButton = removeButtons[1];
    if (!secondRemoveButton) throw new Error("Expected a second attachment");

    fireEvent.click(secondRemoveButton);

    expect(onRemoveAttachment).toHaveBeenCalledTimes(1);
    expect(onRemoveAttachment).toHaveBeenCalledWith("second");
    expect(
      composer.querySelector('[data-attachment-id="first"]'),
    ).not.toBeNull();
    expect(composer.querySelector('[data-attachment-id="second"]')).toBeNull();
    expect(serializeComposerContent(composer)).toBe(
      "first @[image.png] second end",
    );
  });

  it("removes an uploading image using its temporary upload ID", () => {
    const draftKey = "pending-image-draft";
    localStorage.setItem(draftKey, "look @[upload.png]");
    const onRemoveAttachment = vi.fn();
    const { composer, onSend } = renderMessageInput({
      draftKey,
      onRemoveAttachment,
      uploadProgress: [
        {
          fileId: "temporary-upload-id",
          fileName: "upload.png",
          mimeType: "image/png",
          bytesUploaded: 512,
          totalBytes: 1024,
          percent: 50,
        },
      ],
    });

    const preview = screen.getByRole("button", {
      name: "Preview upload.png",
    }) as HTMLButtonElement;
    expect(preview.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove upload.png" }));

    expect(onRemoveAttachment).toHaveBeenCalledTimes(1);
    expect(onRemoveAttachment).toHaveBeenCalledWith("temporary-upload-id");
    expect(onSend).not.toHaveBeenCalled();
    expect(serializeComposerContent(composer)).toBe("look");
    expect(composer.querySelector("[data-attachment-token]")).toBeNull();
  });

  it("keeps same-name attachments in selection order when the second upload finishes first", () => {
    const draftKey = "out-of-order-image-draft";
    localStorage.setItem(draftKey, "first @[image.png] second @[image.png]");
    const onRemoveAttachment = vi.fn();
    const { composer } = renderMessageInput({
      draftKey,
      attachments: [imageAttachment("completed-second")],
      uploadProgress: [
        {
          fileId: "pending-first",
          fileName: "image.png",
          mimeType: "image/png",
          bytesUploaded: 512,
          totalBytes: 1024,
          percent: 50,
        },
      ],
      attachmentOrder: ["pending-first", "completed-second"],
      onRemoveAttachment,
    });
    const cards = Array.from(
      composer.querySelectorAll<HTMLElement>("[data-attachment-id]"),
    );
    expect(cards.map((card) => card.dataset.attachmentId)).toEqual([
      "pending-first",
      "completed-second",
    ]);
    const firstCard = cards[0];
    if (!firstCard) throw new Error("Expected the first attachment card");

    fireEvent.click(
      within(firstCard).getByRole("button", { name: "Remove image.png" }),
    );

    expect(onRemoveAttachment).toHaveBeenCalledTimes(1);
    expect(onRemoveAttachment).toHaveBeenCalledWith("pending-first");
    expect(serializeComposerContent(composer)).toBe(
      "first second @[image.png]",
    );
  });

  it("inserts a new token when another file has the same name as an existing attachment", () => {
    const draftKey = "duplicate-image-draft";
    localStorage.setItem(draftKey, "@[image.png]");
    const onAttach = vi.fn();
    const { composer } = renderMessageInput({
      draftKey,
      projectId: "project",
      sessionId: "session",
      attachments: [imageAttachment("first")],
      onAttach,
    });
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("Expected a file picker input");
    const secondImage = new File(["second image"], "image.png", {
      type: "image/png",
    });

    fireEvent.change(fileInput, { target: { files: [secondImage] } });

    expect(onAttach).toHaveBeenCalledWith([secondImage]);
    expect(
      serializeComposerContent(composer).match(/@\[image\.png\]/g),
    ).toHaveLength(2);
  });

  it("anchors a new same-name image before the existing card at the native caret", () => {
    const draftKey = "insert-before-image-draft";
    localStorage.setItem(draftKey, "before @[image.png] after");
    const onAttach = vi.fn();
    const { composer } = renderMessageInput({
      draftKey,
      projectId: "project",
      sessionId: "session",
      attachments: [imageAttachment("existing-image")],
      onAttach,
    });
    const card = composer.querySelector(
      '[data-attachment-id="existing-image"]',
    );
    if (!card) throw new Error("Expected the existing image card");
    composer.focus();
    const range = document.createRange();
    range.setStartBefore(card);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.select(composer);
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("Expected a file picker input");
    const newImage = new File(["new image"], "image.png", {
      type: "image/png",
    });

    fireEvent.change(fileInput, { target: { files: [newImage] } });

    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(onAttach).toHaveBeenCalledWith([newImage], "existing-image");
    expect(serializeComposerContent(composer)).toBe(
      "before  @[image.png]  @[image.png] after",
    );
  });

  it("removes an image atomically with Backspace at the native caret", () => {
    const { composer, onRemoveAttachment } = renderAttachmentDraft(
      "before @[image.png] after",
      [imageAttachment("first")],
    );
    const card = composer.querySelector("[data-attachment-token]");
    if (!card) throw new Error("Expected an attachment card");
    composer.focus();
    const range = document.createRange();
    range.setStartAfter(card);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.select(composer);
    expect(fireEvent.keyDown(composer, { key: "Backspace" })).toBe(true);
    // jsdom cannot perform native Backspace: delete the atomic card as the
    // browser would, then publish the resulting input event.
    range.setStartBefore(card);
    range.deleteContents();
    fireEvent.input(composer, { inputType: "deleteContentBackward" });

    expect(onRemoveAttachment).toHaveBeenCalledTimes(1);
    expect(onRemoveAttachment).toHaveBeenCalledWith("first");
    expect(composer.querySelector("[data-attachment-token]")).toBeNull();
    expect(serializeComposerContent(composer)).toBe("before  after");
  });

  it("tracks attachments removed by a native selection edit", () => {
    const { composer, onRemoveAttachment } = renderAttachmentDraft(
      "before @[first.png] between @[second.png] after",
      [
        imageAttachment("first", "first.png"),
        imageAttachment("second", "second.png"),
      ],
    );
    const firstCard = composer.querySelector('[data-attachment-id="first"]');
    if (!firstCard) throw new Error("Expected the first attachment card");
    composer.focus();
    const range = document.createRange();
    range.selectNode(firstCard);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    // jsdom does not implement the browser's default contenteditable edit.
    // Apply the native DOM mutation before dispatching its input event.
    range.deleteContents();
    fireEvent.input(composer, { inputType: "deleteContentBackward" });

    expect(onRemoveAttachment).toHaveBeenCalledTimes(1);
    expect(onRemoveAttachment).toHaveBeenCalledWith("first");
    expect(
      composer.querySelector('[data-attachment-id="second"]'),
    ).not.toBeNull();
    expect(serializeComposerContent(composer)).toBe(
      "before  between @[second.png] after",
    );
  });

  it("restores the uploaded file when native undo brings its image card back", () => {
    const file = imageAttachment("undo-image");
    const { composer, onRemoveAttachment, onRestoreAttachment, onSend } =
      renderAttachmentDraft("before @[image.png] after", [file]);
    const card = composer.querySelector('[data-attachment-id="undo-image"]');
    if (!card) throw new Error("Expected the image card");
    const restoredCard = card.cloneNode(true);
    card.remove();
    fireEvent.input(composer, { inputType: "deleteContentBackward" });
    expect(onRemoveAttachment).toHaveBeenCalledWith("undo-image");

    // jsdom has no editing history; restore the browser's original atomic
    // card and dispatch the historyUndo input it would produce.
    composer.replaceChildren(
      document.createTextNode("before "),
      restoredCard,
      document.createTextNode(" after"),
    );
    fireEvent.input(composer, { inputType: "historyUndo" });

    expect(onRestoreAttachment).toHaveBeenCalledTimes(1);
    expect(onRestoreAttachment).toHaveBeenCalledWith(file);
    expect(serializeComposerContent(composer)).toBe(
      "before @[image.png] after",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("before @[image.png] after");
  });

  it("offers an accessible image preview without sending or removing the attachment", () => {
    const { composer, onSend, onRemoveAttachment } = renderAttachmentDraft(
      "look @[image.png]",
      [imageAttachment("first")],
    );
    const previewButton = screen.getByRole("button", {
      name: "Preview image.png",
    });

    fireEvent.click(previewButton);

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("img", { name: "image.png" }),
    ).toBeDefined();
    expect(onSend).not.toHaveBeenCalled();
    expect(onRemoveAttachment).not.toHaveBeenCalled();
    expect(serializeComposerContent(composer)).toBe("look @[image.png]");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pastes a copied user input as text plus all image attachments", () => {
    const onAttach = vi.fn();
    const { composer } = renderMessageInput({
      projectId: "project",
      sessionId: "session",
      onAttach,
    });
    typeInComposer(composer, "prefix suffix");
    setTextSelection(composer, 7);

    fireEvent.paste(composer, {
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

    expect(serializeComposerContent(composer)).toBe(
      "prefix review both  @[first.png]  @[second.png]  suffix",
    );
    expect(onAttach).toHaveBeenCalledTimes(1);
    const attached = onAttach.mock.calls[0]?.[0] as File[];
    expect(attached.map((file) => file.name)).toEqual([
      "first.png",
      "second.png",
    ]);
  });

  it("removes a selected image when replacing it with copied text and a new image", () => {
    const draftKey = "replace-image-draft";
    localStorage.setItem(draftKey, "before @[old.png] after");
    const onRemoveAttachment = vi.fn();
    const onAttach = vi.fn();
    const { composer } = renderMessageInput({
      draftKey,
      projectId: "project",
      sessionId: "session",
      attachments: [imageAttachment("old-image", "old.png")],
      onAttach,
      onRemoveAttachment,
    });
    const oldCard = composer.querySelector('[data-attachment-id="old-image"]');
    if (!oldCard) throw new Error("Expected the image to replace");
    composer.focus();
    const range = document.createRange();
    range.selectNode(oldCard);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.paste(composer, {
      clipboardData: {
        items: [],
        getData: (type: string) => {
          if (type === "text/plain") return "replacement @[new.png]";
          if (type === "text/html") {
            return `<div data-yep-anywhere-user-input="1">
              <img src="data:image/png;base64,bmV3" data-yep-anywhere-attachment-name="new.png">
            </div>`;
          }
          return "";
        },
      },
    });

    expect(onRemoveAttachment).toHaveBeenCalledTimes(1);
    expect(onRemoveAttachment).toHaveBeenCalledWith("old-image");
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(serializeComposerContent(composer)).toBe(
      "before replacement @[new.png] after",
    );
  });

  it("reuses tokens already present in pasted Yep clipboard text", () => {
    const onAttach = vi.fn();
    const { composer } = renderMessageInput({
      projectId: "project",
      sessionId: "session",
      onAttach,
    });

    fireEvent.paste(composer, {
      clipboardData: {
        items: [],
        getData: (type: string) => {
          if (type === "text/plain") return "@[first.png] look at this";
          if (type === "text/html") {
            return `<div data-yep-anywhere-user-input="1">
              <img src="data:image/png;base64,Zmlyc3Q=" data-yep-anywhere-attachment-name="first.png">
            </div>`;
          }
          return "";
        },
      },
    });

    // The pasted text already references the file; no duplicate token is added.
    expect(serializeComposerContent(composer)).toBe(
      "@[first.png] look at this",
    );
  });
});
