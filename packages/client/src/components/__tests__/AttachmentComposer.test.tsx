import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import {
  AttachmentComposer,
  type AttachmentComposerHandle,
  type ComposerAttachment,
  serializeComposerContent,
} from "../AttachmentComposer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});

const attachments: ComposerAttachment[] = [
  {
    id: "first",
    name: "shot.png",
    previewUrl: "blob:first",
    mimeType: "image/png",
  },
  {
    id: "second",
    name: "shot.png",
    previewUrl: "blob:second",
    mimeType: "image/png",
  },
];

function setup(value = "before @[shot.png] between @[shot.png] after") {
  const handle = createRef<AttachmentComposerHandle>();
  const onPreview = vi.fn();
  const onRemove = vi.fn();
  const onChange = vi.fn();
  const onKeyDown = vi.fn();
  function Controlled() {
    const [text, setText] = useState(value);
    return (
      <AttachmentComposer
        ref={handle}
        value={text}
        attachments={attachments}
        onChange={(event) => {
          onChange(event);
          setText(event.target.value);
        }}
        onPreview={onPreview}
        onRemove={onRemove}
        onKeyDown={onKeyDown}
        placeholder="Write a message"
      />
    );
  }
  const result = render(
    <I18nProvider>
      <Controlled />
    </I18nProvider>,
  );
  return {
    ...result,
    handle,
    editor: screen.getByRole("textbox"),
    onPreview,
    onRemove,
    onChange,
    onKeyDown,
  };
}

describe("AttachmentComposer", () => {
  it("uses real atomic cards and preserves the original token order", () => {
    const { editor, handle, onPreview, onRemove, onKeyDown } = setup();
    const cards = editor.querySelectorAll<HTMLElement>("[data-attachment-id]");
    expect(Array.from(cards, (card) => card.dataset.attachmentId)).toEqual([
      "first",
      "second",
    ]);
    expect(cards[0]?.contentEditable).toBe("false");
    expect(
      cards[0]?.querySelector(".attachment-composer-name")?.textContent,
    ).toBe("shot.png");
    expect(
      Array.from(editor.querySelectorAll("img"), (image) =>
        image.getAttribute("src"),
      ),
    ).toEqual(["blob:first", "blob:second"]);
    expect(handle.current?.value).toBe(
      "before @[shot.png] between @[shot.png] after",
    );
    const secondPreview = cards[1]?.querySelector<HTMLButtonElement>(
      ".attachment-composer-preview",
    );
    const firstRemove = cards[0]?.querySelector<HTMLButtonElement>(
      ".attachment-composer-remove",
    );
    if (!secondPreview || !firstRemove) throw new Error("Missing card buttons");
    fireEvent.click(secondPreview);
    fireEvent.click(firstRemove);
    expect(onPreview).toHaveBeenCalledWith("second");
    expect(onRemove).toHaveBeenCalledWith("first");
    fireEvent.keyDown(secondPreview, { key: "Enter" });
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it("maps string selections around attachments without selecting their labels", () => {
    const { handle, editor } = setup();
    act(() => {
      handle.current?.focus();
      handle.current?.setSelectionRange(7, 18);
    });
    expect(handle.current?.selectionStart).toBe(7);
    expect(handle.current?.selectionEnd).toBe(18);
    expect(handle.current?.getSelectedAttachmentIds()).toEqual(["first"]);
    const selected = window.getSelection()?.getRangeAt(0).cloneContents();
    expect(
      selected
        ?.querySelector("[data-attachment-id]")
        ?.getAttribute("data-attachment-id"),
    ).toBe("first");
    expect(document.activeElement).toBe(editor);
  });

  it("keeps native DOM on input echoes and reports exactly which same-name card was deleted", () => {
    const { handle, editor, onChange } = setup();
    const originalTextNode = editor.firstChild;
    if (!originalTextNode) throw new Error("Missing text");
    originalTextNode.textContent = "hello ";
    act(() => handle.current?.setSelectionRange(6, 6));
    fireEvent.input(editor);
    expect(editor.firstChild).toBe(originalTextNode);
    expect(onChange.mock.lastCall?.[0].target.value).toBe(
      "hello @[shot.png] between @[shot.png] after",
    );

    editor.querySelector('[data-attachment-id="second"]')?.remove();
    fireEvent.input(editor);
    expect(onChange.mock.lastCall?.[0].target.removedAttachmentIds).toEqual([
      "second",
    ]);
    expect(onChange.mock.lastCall?.[0].target.value).toBe(
      "hello @[shot.png] between  after",
    );
  });

  it.each([
    ["first<div>second</div>", "first\nsecond"],
    ["<div>first</div><div><br></div><div>third</div>", "first\n\nthird"],
    ["first<div><br></div>", "first\n"],
    ["first<br>second<br><br>", "first\nsecond\n"],
    ["<br>", ""],
    ["<p>first</p><p>second</p>", "first\nsecond"],
  ])("serializes native line structure %s", (html, expected) => {
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(serializeComposerContent(root)).toBe(expected);
  });

  it("inserts plain clipboard text into the selection instead of rich HTML", () => {
    const { editor, handle, onChange } = setup("before after");
    act(() => {
      handle.current?.focus();
      handle.current?.setSelectionRange(7, 7);
    });
    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) =>
          type === "text/plain" ? "line 1\nline 2 " : "<b>rich</b>",
      },
    });
    expect(onChange.mock.lastCall?.[0].target.value).toBe(
      "before line 1\nline 2 after",
    );
    expect(editor.querySelector("b")).toBeNull();
    expect(handle.current?.selectionStart).toBe(21);
  });

  it("copies canonical tokens and cuts the selected attachment by id", () => {
    const { editor, handle, onChange } = setup();
    act(() => {
      handle.current?.focus();
      handle.current?.setSelectionRange(7, 18);
    });
    const setData = vi.fn();
    fireEvent.copy(editor, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", "@[shot.png]");
    fireEvent.cut(editor, { clipboardData: { setData } });
    expect(onChange.mock.lastCall?.[0].target.value).toBe(
      "before  between @[shot.png] after",
    );
    expect(onChange.mock.lastCall?.[0].target.removedAttachmentIds).toEqual([
      "first",
    ]);
  });

  it("defers attachment DOM refresh until composition ends", () => {
    const onChange = vi.fn();
    const handle = createRef<AttachmentComposerHandle>();
    const renderEditor = (files: ComposerAttachment[]) => (
      <I18nProvider>
        <AttachmentComposer
          ref={handle}
          value="@[shot.png] 中文"
          attachments={files}
          onChange={onChange}
        />
      </I18nProvider>
    );
    const { rerender } = render(
      renderEditor([
        {
          ...(attachments[0] as ComposerAttachment),
          pending: true,
          progress: 10,
        },
      ]),
    );
    const editor = screen.getByRole("textbox");
    const originalTextNode = editor.lastChild;
    fireEvent.compositionStart(editor);
    rerender(
      renderEditor([
        {
          ...(attachments[0] as ComposerAttachment),
          pending: true,
          progress: 42,
        },
      ]),
    );
    expect(editor.lastChild).toBe(originalTextNode);
    expect(
      editor.querySelector(".attachment-composer-progress")?.textContent,
    ).toBe("10%");
    fireEvent.compositionEnd(editor);
    expect(
      editor.querySelector(".attachment-composer-progress")?.textContent,
    ).toBe("42%");
    expect(handle.current?.value).toBe("@[shot.png] 中文");
  });

  it("applies external values while retaining a valid insertion point", () => {
    const handle = createRef<AttachmentComposerHandle>();
    const onChange = vi.fn();
    const renderEditor = (value: string, disabled = false) => (
      <I18nProvider>
        <AttachmentComposer
          ref={handle}
          value={value}
          disabled={disabled}
          attachments={[]}
          onChange={onChange}
          placeholder="Message"
        />
      </I18nProvider>
    );
    const { rerender } = render(renderEditor("original text"));
    act(() => {
      handle.current?.focus();
      handle.current?.setSelectionRange(8, 8);
    });
    rerender(renderEditor("new"));
    expect(handle.current?.value).toBe("new");
    expect(handle.current?.selectionStart).toBe(3);
    rerender(renderEditor("", true));
    const editor = screen.getByRole("textbox");
    expect(editor.getAttribute("contenteditable")).toBe("false");
    expect(editor.getAttribute("data-empty")).toBe("true");
    expect(editor.getAttribute("data-placeholder")).toBe("Message");
    fireEvent.input(editor);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("retains the native composing text node while Chinese input changes", () => {
    const { editor, handle } = setup("draft ");
    const textNode = editor.firstChild;
    if (!textNode) throw new Error("Missing editable text");
    fireEvent.compositionStart(editor);
    textNode.textContent = "draft 中文";
    fireEvent.input(editor, { isComposing: true });
    expect(editor.firstChild).toBe(textNode);
    fireEvent.compositionEnd(editor);
    expect(editor.firstChild).toBe(textNode);
    expect(handle.current?.value).toBe("draft 中文");
  });

  it("enables image preview in place without replacing text, card buttons or the caret", () => {
    const handle = createRef<AttachmentComposerHandle>();
    const renderEditor = (previewUrl: string) => (
      <I18nProvider>
        <AttachmentComposer
          ref={handle}
          value="before @[shot.png] after"
          attachments={[
            { ...(attachments[0] as ComposerAttachment), previewUrl },
          ]}
          onChange={vi.fn()}
          onPreview={vi.fn()}
        />
      </I18nProvider>
    );
    const { rerender } = render(renderEditor(""));
    const editor = screen.getByRole("textbox");
    const text = editor.lastChild;
    const button = editor.querySelector("button");
    const card = editor.querySelector("[data-attachment-id]");
    expect(button?.disabled).toBe(true);
    act(() => {
      handle.current?.focus();
      handle.current?.setSelectionRange(22, 22);
    });
    const caretNode = window.getSelection()?.anchorNode;
    rerender(renderEditor("blob:updated"));
    expect(editor.lastChild).toBe(text);
    expect(editor.querySelector("button")).toBe(button);
    expect(editor.querySelector("[data-attachment-id]")).toBe(card);
    expect(button?.disabled).toBe(false);
    expect(editor.querySelector("img")?.getAttribute("src")).toBe(
      "blob:updated",
    );
    expect(window.getSelection()?.anchorNode).toBe(caretNode);
    expect(handle.current?.selectionStart).toBe(22);
  });

  it("falls back to the icon after a thumbnail fails without changing the document or caret", () => {
    const { editor, handle, onChange, onPreview } = setup();
    act(() => {
      handle.current?.focus();
      handle.current?.setSelectionRange(0, 0);
    });
    const image = editor.querySelector("img");
    const card = editor.querySelector("[data-attachment-id]");
    if (!image || !card) throw new Error("Missing attachment thumbnail");
    const before = handle.current?.value;
    fireEvent.load(image);
    expect(image.dataset.loaded).toBe("true");
    fireEvent.error(image);
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector(".attachment-thumbnail")).not.toBeNull();
    expect(handle.current?.value).toBe(before);
    expect(handle.current?.selectionStart).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(card.querySelector("button") as HTMLButtonElement);
    expect(onPreview).toHaveBeenCalledWith("first");
  });

  it("keeps uploads removable and restricts preview to available images", () => {
    const onRemove = vi.fn();
    render(
      <I18nProvider>
        <AttachmentComposer
          value="@[upload.png] @[notes.txt]"
          attachments={[
            {
              id: "upload",
              name: "upload.png",
              mimeType: "image/png",
              pending: true,
              progress: 42,
            },
            {
              id: "notes",
              name: "notes.txt",
              mimeType: "text/plain",
              apiPath: "/notes.txt",
            },
          ]}
          onChange={vi.fn()}
          onRemove={onRemove}
          onPreview={vi.fn()}
        />
      </I18nProvider>,
    );
    const editor = screen.getByRole("textbox");
    const previews = editor.querySelectorAll<HTMLButtonElement>(
      ".attachment-composer-preview",
    );
    expect(Array.from(previews, (button) => button.disabled)).toEqual([
      true,
      true,
    ]);
    expect(
      editor.querySelector(".attachment-composer-progress")?.textContent,
    ).toBe("42%");
    const remove = editor.querySelector<HTMLButtonElement>(
      ".attachment-composer-remove",
    );
    if (!remove) throw new Error("Missing upload removal");
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledWith("upload");
  });

  it.each([false, true])(
    "reports native undo restoration only for completed attachments (pending=%s)",
    (pending) => {
      const onChange = vi.fn();
      const file = { ...(attachments[0] as ComposerAttachment), pending };
      function Controlled() {
        const [value, setValue] = useState("before @[shot.png] after");
        const [files, setFiles] = useState([file]);
        return (
          <AttachmentComposer
            value={value}
            attachments={files}
            onChange={(event) => {
              onChange(event);
              if (event.target.removedAttachmentIds?.length) setFiles([]);
              if (event.target.restoredAttachmentIds?.length) setFiles([file]);
              setValue(event.target.value);
            }}
          />
        );
      }
      render(
        <I18nProvider>
          <Controlled />
        </I18nProvider>,
      );
      const editor = screen.getByRole("textbox");
      const card = editor.querySelector<HTMLElement>("[data-attachment-id]");
      if (!card) throw new Error("Missing card");
      const after = card.nextSibling;
      card.remove();
      fireEvent.input(editor, { inputType: "deleteContentBackward" });
      expect(onChange.mock.lastCall?.[0].target.removedAttachmentIds).toEqual([
        "first",
      ]);
      // Undo restores the actual noneditable node from the browser's history.
      editor.insertBefore(card, after);
      fireEvent.input(editor, { inputType: "historyUndo" });
      expect(onChange.mock.lastCall?.[0].target.restoredAttachmentIds).toEqual(
        pending ? [] : ["first"],
      );
      expect(serializeComposerContent(editor)).toBe("before @[shot.png] after");
      expect(editor.querySelector("[data-attachment-id]")).toBe(
        pending ? null : card,
      );
      if (!pending) {
        card.remove();
        fireEvent.input(editor, { inputType: "historyRedo" });
        expect(onChange.mock.lastCall?.[0].target.removedAttachmentIds).toEqual(
          ["first"],
        );
      }
    },
  );

  it("reuses the card and text when an upload receives its completed attachment id", () => {
    const renderEditor = (file: ComposerAttachment) => (
      <I18nProvider>
        <AttachmentComposer
          value="before @[shot.png] after"
          attachments={[file]}
          onChange={vi.fn()}
        />
      </I18nProvider>
    );
    const { rerender } = render(
      renderEditor({ id: "pending", name: "shot.png", pending: true }),
    );
    const editor = screen.getByRole("textbox");
    const before = editor.firstChild;
    const card = editor.querySelector<HTMLElement>("[data-attachment-id]");
    rerender(renderEditor(attachments[0] as ComposerAttachment));
    expect(editor.firstChild).toBe(before);
    expect(editor.querySelector("[data-attachment-id]")).toBe(card);
    expect(card?.dataset.attachmentId).toBe("first");
  });

  it("round trips selection offsets through the browser's multiline editing DOM", () => {
    const { editor, handle } = setup("");
    editor.innerHTML =
      "<div>first</div><div><br></div><div>third<br>fourth</div>";
    expect(serializeComposerContent(editor)).toBe("first\n\nthird\nfourth");
    for (let offset = 0; offset <= 18; offset += 1) {
      act(() => handle.current?.setSelectionRange(offset, offset));
      expect(handle.current?.selectionStart).toBe(offset);
      expect(handle.current?.selectionEnd).toBe(offset);
    }
  });

  it("does not override copying a page selection outside the editor", () => {
    const { editor, handle } = setup("draft text");
    act(() => handle.current?.setSelectionRange(0, 5));
    const outside = document.createElement("p");
    outside.textContent = "transcript selection";
    document.body.append(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const setData = vi.fn();
    expect(fireEvent.copy(editor, { clipboardData: { setData } })).toBe(true);
    expect(setData).not.toHaveBeenCalled();
    outside.remove();
  });
});
