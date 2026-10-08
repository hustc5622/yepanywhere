import {
  type CSSProperties,
  type ClipboardEvent,
  type ClipboardEventHandler,
  type KeyboardEventHandler,
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n";
import { getAttachmentThumbnailSrc } from "../lib/attachmentThumbnail";
import {
  matchTokenToAttachment,
  splitByAttachmentTokens,
} from "../lib/attachmentTokens";

export interface ComposerAttachment {
  id: string;
  name: string;
  previewUrl?: string;
  apiPath?: string;
  mimeType?: string;
  pending?: boolean;
  progress?: number;
}

export interface AttachmentComposerHandle {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  getSelectedAttachmentIds(): string[];
  scrollTop: number;
  readonly scrollHeight: number;
}

export interface AttachmentComposerChangeEvent {
  target: {
    value: string;
    selectionStart: number;
    removedAttachmentIds?: string[];
    restoredAttachmentIds?: string[];
  };
}

interface Props {
  value: string;
  onChange: (event: AttachmentComposerChangeEvent) => void;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  onKeyUp?: () => void;
  onClick?: () => void;
  onSelect?: () => void;
  onPaste?: ClipboardEventHandler<HTMLElement>;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  className?: string;
  attachments: ComposerAttachment[];
  onPreview?: (id: string) => void;
  onRemove?: (id: string) => void;
}

type Point = { node: Node; offset: number };
type Run = { start: number; end: number; before: Point; after: Point };
type EditorSnapshot = {
  text: string;
  runs: Run[];
  boundaries: Map<Node, number[]>;
};

const BLOCK_ELEMENTS = new Set(["DIV", "P", "LI", "PRE"]);

/** Read native editing DOM without treating card labels/buttons as message text. */
function readContent(root: HTMLElement): EditorSnapshot {
  let text = "";
  const runs: Run[] = [];
  const boundaries = new Map<Node, number[]>();
  const append = (value: string, before: Point, after: Point) => {
    const start = text.length;
    text += value;
    runs.push({ start, end: text.length, before, after });
  };

  const visit = (parent: Node) => {
    const offsets: number[] = [text.length];
    boundaries.set(parent, offsets);
    const children = Array.from(parent.childNodes);
    for (const [index, child] of children.entries()) {
      const previous = children[index - 1];
      const isBlock = BLOCK_ELEMENTS.has(child.nodeName);
      const wasBlock = previous && BLOCK_ELEMENTS.has(previous.nodeName);
      if (index > 0 && (isBlock || wasBlock) && previous?.nodeName !== "BR") {
        append(
          "\n",
          { node: parent, offset: index },
          { node: child, offset: 0 },
        );
      }

      if (child.nodeType === Node.TEXT_NODE) {
        append(
          child.textContent ?? "",
          { node: child, offset: 0 },
          { node: child, offset: child.textContent?.length ?? 0 },
        );
      } else if (child instanceof HTMLElement) {
        const token = child.dataset.attachmentToken;
        if (token !== undefined) {
          boundaries.set(child, [text.length, text.length + token.length]);
          append(
            token,
            { node: parent, offset: index },
            { node: parent, offset: index + 1 },
          );
        } else if (child.tagName === "BR") {
          // Browsers keep one terminal BR as a caret placeholder, including
          // the BR inside the empty DIV created by Enter at the end of a line.
          if (index !== children.length - 1) {
            append(
              "\n",
              { node: parent, offset: index },
              { node: parent, offset: index + 1 },
            );
          }
        } else {
          visit(child);
        }
      }
      offsets[index + 1] = text.length;
    }
  };
  visit(root);
  return { text, runs, boundaries };
}

export function serializeComposerContent(root: HTMLElement): string {
  return readContent(root).text;
}

function pointOffset(
  snapshot: EditorSnapshot,
  point: Point,
  edge: "start" | "end",
): number {
  if (point.node.nodeType === Node.TEXT_NODE) {
    const run = snapshot.runs.find(
      (candidate) =>
        candidate.before.node === point.node &&
        candidate.after.node === point.node,
    );
    if (run) return Math.min(run.end, run.start + point.offset);
  }
  const element =
    point.node instanceof Element ? point.node : point.node.parentElement;
  const card = element?.closest<HTMLElement>("[data-attachment-token]");
  if (card) {
    const offsets = snapshot.boundaries.get(card);
    if (offsets)
      return offsets[edge === "start" ? 0 : 1] ?? snapshot.text.length;
  }
  return (
    snapshot.boundaries.get(point.node)?.[point.offset] ?? snapshot.text.length
  );
}

function offsetPoint(
  root: HTMLElement,
  snapshot: EditorSnapshot,
  offset: number,
): Point {
  const position = Math.max(0, Math.min(offset, snapshot.text.length));
  for (const run of snapshot.runs) {
    if (position < run.start || position > run.end) continue;
    if (
      run.before.node === run.after.node &&
      run.before.node.nodeType === Node.TEXT_NODE
    ) {
      return { node: run.before.node, offset: position - run.start };
    }
    // Attachments are atomic: offsets inside their serialized token snap to
    // the closest edge, never into a filename or a button's DOM text.
    return position - run.start < (run.end - run.start) / 2
      ? run.before
      : run.after;
  }
  return { node: root, offset: root.childNodes.length };
}

function readSelection(root: HTMLElement): [number, number] | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  ) {
    return null;
  }
  const snapshot = readContent(root);
  return [
    pointOffset(
      snapshot,
      {
        node: range.startContainer,
        offset: range.startOffset,
      },
      "start",
    ),
    pointOffset(
      snapshot,
      {
        node: range.endContainer,
        offset: range.endOffset,
      },
      "end",
    ),
  ];
}

function writeSelection(root: HTMLElement, start: number, end: number) {
  const snapshot = readContent(root);
  const from = offsetPoint(root, snapshot, Math.min(start, end));
  const to = offsetPoint(root, snapshot, Math.max(start, end));
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Native text/caret plus actual noneditable attachments, with a token wire format. */
export const AttachmentComposer = forwardRef<AttachmentComposerHandle, Props>(
  function AttachmentComposer(props, forwardedRef) {
    const { t } = useI18n();
    const {
      value,
      attachments,
      disabled = false,
      placeholder,
      rows = 3,
      className = "",
    } = props;
    const rootRef = useRef<HTMLDivElement>(null);
    const propsRef = useRef(props);
    propsRef.current = props;
    const composingRef = useRef(false);
    const selectionRef = useRef<[number, number]>([value.length, value.length]);
    const renderedIdsRef = useRef(new Set<string>());
    const removedIdsRef = useRef(new Set<string>());
    const seenAttachmentsRef = useRef(new Map<string, ComposerAttachment>());
    for (const attachment of attachments) {
      seenAttachmentsRef.current.set(attachment.id, attachment);
    }
    const renderedSignatureRef = useRef("");
    const [compositionRevision, setCompositionRevision] = useState(0);

    const rememberSelection = () => {
      const root = rootRef.current;
      const current = root && readSelection(root);
      if (current) selectionRef.current = current;
      return selectionRef.current;
    };

    useImperativeHandle(forwardedRef, () => ({
      get value() {
        return rootRef.current ? serializeComposerContent(rootRef.current) : "";
      },
      get selectionStart() {
        return rememberSelection()[0];
      },
      get selectionEnd() {
        return rememberSelection()[1];
      },
      focus() {
        const root = rootRef.current;
        if (!root || propsRef.current.disabled) return;
        const current = readSelection(root);
        root.focus();
        if (!current) writeSelection(root, ...selectionRef.current);
      },
      setSelectionRange(start, end) {
        selectionRef.current = [start, end];
        if (rootRef.current) writeSelection(rootRef.current, start, end);
      },
      getSelectedAttachmentIds() {
        const root = rootRef.current;
        if (!root) return [];
        const [start, end] = rememberSelection();
        if (start === end) return [];
        const snapshot = readContent(root);
        return Array.from(
          root.querySelectorAll<HTMLElement>("[data-attachment-id]"),
        ).flatMap((card) => {
          const offsets = snapshot.boundaries.get(card);
          return offsets && start < (offsets[1] ?? 0) && end > (offsets[0] ?? 0)
            ? [card.dataset.attachmentId ?? ""]
            : [];
        });
      },
      get scrollTop() {
        return rootRef.current?.scrollTop ?? 0;
      },
      set scrollTop(top) {
        if (rootRef.current) rootRef.current.scrollTop = top;
      },
      get scrollHeight() {
        return rootRef.current?.scrollHeight ?? 0;
      },
    }));

    const names = attachments.map((attachment) => attachment.name);
    const segments = splitByAttachmentTokens(value, names);
    const occurrences = new Map<string, number>();
    const cards = segments.flatMap((segment) => {
      if (segment.type !== "token") return [];
      const occurrence = occurrences.get(segment.name) ?? 0;
      occurrences.set(segment.name, occurrence + 1);
      const attachment = matchTokenToAttachment(
        attachments,
        (candidate) => candidate.name,
        segment.name,
        occurrence,
      );
      return attachment ? [{ segment, attachment }] : [];
    });
    const signature = JSON.stringify({
      cards: cards.map(({ segment, attachment }) => ({
        token: segment.raw,
        ...attachment,
        previewLabel: t("composerAttachmentPreview", { name: attachment.name }),
        removeLabel: t("composerAttachmentRemove", { name: attachment.name }),
      })),
      disabled,
      preview: !!props.onPreview,
      remove: !!props.onRemove,
    });

    // React never owns the editable children. Ordinary controlled echoes and
    // IME updates leave native DOM, selection, and the browser's undo intact.
    // biome-ignore lint/correctness/useExhaustiveDependencies: signature includes all card data and translations; compositionRevision flushes a deferred sync.
    useLayoutEffect(() => {
      const root = rootRef.current;
      if (!root || composingRef.current) return;
      const currentValue = serializeComposerContent(root);
      const selection = readSelection(root);
      const scrollTop = root.scrollTop;
      const existingCards = Array.from(
        root.querySelectorAll<HTMLElement>("[data-attachment-id]"),
      );
      const canUpdateCards =
        currentValue === value &&
        existingCards.length === cards.length &&
        cards.every(
          ({ segment }, index) =>
            existingCards[index]?.dataset.attachmentToken === segment.raw,
        );
      if (
        canUpdateCards &&
        renderedSignatureRef.current === signature &&
        cards.every(
          ({ attachment }, index) =>
            existingCards[index]?.dataset.attachmentId === attachment.id,
        )
      )
        return;
      const fragment = document.createDocumentFragment();
      let cardIndex = 0;
      const ids = new Set<string>();
      for (const segment of segments) {
        if (segment.type === "text") {
          fragment.append(document.createTextNode(segment.value));
          continue;
        }
        const card = cards[cardIndex++];
        if (!card) continue;
        const { attachment } = card;
        ids.add(attachment.id);
        const chip = document.createElement("span");
        chip.className = "attachment-composer-card";
        chip.dataset.kind = attachment.mimeType?.startsWith("image/")
          ? "image"
          : "file";
        chip.contentEditable = "false";
        chip.dataset.attachmentId = attachment.id;
        chip.dataset.attachmentToken = segment.raw;
        if (attachment.pending) chip.dataset.pending = "true";
        const preview = document.createElement("button");
        preview.type = "button";
        preview.className = "attachment-composer-preview";
        preview.dataset.attachmentAction = "preview";
        preview.disabled =
          disabled ||
          !props.onPreview ||
          !!attachment.pending ||
          !attachment.mimeType?.startsWith("image/") ||
          !(attachment.previewUrl || attachment.apiPath);
        preview.setAttribute(
          "aria-label",
          t("composerAttachmentPreview", { name: attachment.name }),
        );
        preview.title = attachment.name;
        const icon = document.createElement("span");
        icon.className = attachment.mimeType?.startsWith("image/")
          ? "attachment-thumbnail"
          : "attachment-composer-icon";
        icon.setAttribute("aria-hidden", "true");
        const thumbnailSrc = getAttachmentThumbnailSrc(attachment);
        if (thumbnailSrc) {
          const thumbnail = document.createElement("img");
          thumbnail.src = thumbnailSrc;
          thumbnail.alt = "";
          thumbnail.loading = "lazy";
          thumbnail.decoding = "async";
          thumbnail.draggable = false;
          thumbnail.onload = () => {
            thumbnail.dataset.loaded = "true";
          };
          thumbnail.onerror = () => thumbnail.remove();
          icon.append(thumbnail);
        }
        preview.append(icon);
        const name = document.createElement("span");
        name.className = "attachment-composer-name";
        name.textContent = attachment.name;
        preview.append(name);
        if (attachment.pending && attachment.progress !== undefined) {
          const progress = document.createElement("span");
          progress.className = "attachment-composer-progress";
          progress.textContent = `${Math.round(attachment.progress)}%`;
          preview.append(progress);
        }
        chip.append(preview);
        if (props.onRemove) {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "attachment-composer-remove";
          remove.dataset.attachmentAction = "remove";
          remove.disabled = disabled;
          const label = t("composerAttachmentRemove", {
            name: attachment.name,
          });
          remove.setAttribute("aria-label", label);
          remove.title = label;
          chip.append(remove);
        }
        fragment.append(chip);
      }
      // Empty text boundaries let the native caret sit on either side of a
      // card without adding invisible characters to the submitted prompt.
      if (fragment.firstChild?.nodeType !== Node.TEXT_NODE) {
        fragment.prepend(document.createTextNode(""));
      }
      if (fragment.lastChild?.nodeType !== Node.TEXT_NODE) {
        fragment.append(document.createTextNode(""));
      }
      // A terminal BR gives the caret a rendered line box after an attachment
      // (or a trailing newline); an empty text node alone has no visual box.
      if (segments.at(-1)?.type === "token" || value.endsWith("\n")) {
        fragment.append(document.createElement("br"));
      }
      if (canUpdateCards) {
        // Upload progress and preview availability are metadata. Leave native
        // editable text nodes and their undo/selection history in place.
        const newCards = fragment.querySelectorAll<HTMLElement>(
          "[data-attachment-id]",
        );
        for (const [index, existing] of existingCards.entries()) {
          const replacement = newCards[index];
          if (!replacement) continue;
          existing.dataset.attachmentId = replacement.dataset.attachmentId;
          existing.dataset.kind = replacement.dataset.kind;
          existing.toggleAttribute(
            "data-pending",
            replacement.hasAttribute("data-pending"),
          );
          for (const action of ["preview", "remove"]) {
            const selector = `button[data-attachment-action="${action}"]`;
            const current = existing.querySelector<HTMLButtonElement>(selector);
            const next = replacement.querySelector<HTMLButtonElement>(selector);
            if (current && next) {
              current.disabled = next.disabled;
              current.title = next.title;
              current.setAttribute(
                "aria-label",
                next.getAttribute("aria-label") ?? "",
              );
              current.replaceChildren(...next.childNodes);
            } else if (next) {
              existing.append(next);
            } else {
              current?.remove();
            }
          }
        }
      } else {
        root.replaceChildren(fragment);
        if (selection) writeSelection(root, ...selection);
      }
      root.dataset.empty = String(value.length === 0);
      renderedIdsRef.current = ids;
      renderedSignatureRef.current = signature;
      root.scrollTop = scrollTop;
    }, [value, signature, compositionRevision]);

    const publishInput = () => {
      const root = rootRef.current;
      if (!root || disabled) return;
      const nextValue = serializeComposerContent(root);
      const ids = new Set(
        Array.from(
          root.querySelectorAll<HTMLElement>("[data-attachment-id]"),
        ).map((card) => card.dataset.attachmentId ?? ""),
      );
      const removedAttachmentIds = [...renderedIdsRef.current].filter(
        (id) => !ids.has(id),
      );
      for (const id of removedAttachmentIds) removedIdsRef.current.add(id);
      const restoredAttachmentIds = [...ids].filter(
        (id) =>
          removedIdsRef.current.has(id) &&
          !seenAttachmentsRef.current.get(id)?.pending,
      );
      for (const id of restoredAttachmentIds) removedIdsRef.current.delete(id);
      renderedIdsRef.current = ids;
      root.dataset.empty = String(nextValue.length === 0);
      propsRef.current.onChange({
        target: {
          value: nextValue,
          selectionStart: rememberSelection()[0],
          removedAttachmentIds,
          restoredAttachmentIds,
        },
      });
    };

    const replaceSelection = (replacement: string) => {
      const root = rootRef.current;
      if (!root) return;
      root.focus();
      if (!readSelection(root)) writeSelection(root, ...selectionRef.current);
      // Keep native undo where the editing API is available. DOM Range is a
      // fallback for environments that don't implement execCommand.
      const command = replacement ? "insertText" : "delete";
      if (
        typeof document.execCommand === "function" &&
        document.execCommand(command, false, replacement)
      ) {
        publishInput();
        return;
      }
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      if (replacement) {
        const node = document.createTextNode(replacement);
        range.insertNode(node);
        range.setStartAfter(node);
      }
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      publishInput();
    };

    const copySelection = (
      event: ClipboardEvent<HTMLElement>,
      cut: boolean,
    ) => {
      const root = rootRef.current;
      if (!root) return;
      const selected = readSelection(root);
      // A page selection can remain outside a focused editor. Do not replace
      // copied transcript text with this editor's previously cached selection.
      if (!selected) return;
      const [start, end] = selected;
      if (start === end) return;
      event.preventDefault();
      event.clipboardData.setData(
        "text/plain",
        serializeComposerContent(root).slice(start, end),
      );
      if (cut && !disabled) replaceSelection("");
    };

    return (
      <div
        ref={rootRef}
        className={`attachment-composer ${className}`.trim()}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder}
        aria-disabled={disabled}
        aria-readonly={disabled}
        tabIndex={disabled ? -1 : 0}
        data-placeholder={placeholder}
        style={{ "--composer-rows": rows } as CSSProperties}
        onInput={publishInput}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          publishInput();
          setCompositionRevision((revision) => revision + 1);
        }}
        onKeyDown={(event) => {
          if (!(event.target as Element).closest("button")) {
            props.onKeyDown?.(event);
          }
        }}
        onKeyUp={() => {
          rememberSelection();
          props.onKeyUp?.();
        }}
        onSelect={() => {
          rememberSelection();
          props.onSelect?.();
        }}
        onBlur={rememberSelection}
        onMouseDown={(event) => {
          // Pointer interaction with card actions should retain the insertion
          // point. Keyboard users can still Tab to each real button.
          if ((event.target as Element).closest("button"))
            event.preventDefault();
        }}
        onClick={(event) => {
          const button = (event.target as Element).closest<HTMLButtonElement>(
            "button[data-attachment-action]",
          );
          const card = button?.closest<HTMLElement>("[data-attachment-id]");
          if (card?.dataset.attachmentId && !disabled && !button?.disabled) {
            if (button?.dataset.attachmentAction === "remove") {
              props.onRemove?.(card.dataset.attachmentId);
            } else {
              props.onPreview?.(card.dataset.attachmentId);
            }
          }
          rememberSelection();
          props.onClick?.();
        }}
        onPaste={(event) => {
          if (disabled) {
            event.preventDefault();
            return;
          }
          props.onPaste?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain");
          if (text) replaceSelection(text);
        }}
        onDrop={(event) => {
          // Native rich drops would bypass the attachment upload flow and
          // introduce HTML/images that cannot be represented by the prompt.
          event.preventDefault();
        }}
        onCopy={(event) => copySelection(event, false)}
        onCut={(event) => copySelection(event, true)}
      />
    );
  },
);
