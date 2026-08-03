import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";
import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";
import { api } from "../api/client";
import { useI18n } from "../i18n";

/**
 * Save state surfaced to the parent for the dirty / saving / saved / error
 * indicator. "dirty" means there are local edits that haven't been auto-saved
 * yet. Auto-save fires 800ms after the last edit; manual save (Cmd/Ctrl+S) is
 * instant.
 */
export type SaveState =
  | { kind: "idle" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export interface MarkdownRichEditorProps {
  projectId: string;
  filePath: string;
  /**
   * Notify the parent of save-state transitions so it can render a status
   * indicator in its toolbar. The most recent state is also reported on mount
   * (idle / error if the initial load failed).
   */
  onSaveStateChange?: (state: SaveState) => void;
  /**
   * Register a save function with the parent. Called once the editor is
   * ready. Pass null to unregister on unmount. The parent uses this to
   * implement "save & close" / "save & switch" without re-mounting the
   * editor.
   */
  onSaveRef?: (save: (() => Promise<void>) | null) => void;
}

const AUTOSAVE_DELAY_MS = 800;

const lowlight = createLowlight(common);

// ===== Outline panel width (persisted, drag-resizable) =====
const OUTLINE_MIN_WIDTH = 140;
const OUTLINE_MAX_WIDTH = 400;
const OUTLINE_DEFAULT_WIDTH = 180;
const OUTLINE_STORAGE_KEY = "yep-anywhere-outline-width";

function loadOutlineWidth(): number {
  if (typeof window === "undefined") return OUTLINE_DEFAULT_WIDTH;
  const stored = localStorage.getItem(OUTLINE_STORAGE_KEY);
  if (stored === null) return OUTLINE_DEFAULT_WIDTH;
  const parsed = Number.parseInt(stored, 10);
  if (Number.isNaN(parsed)) return OUTLINE_DEFAULT_WIDTH;
  return Math.min(Math.max(parsed, OUTLINE_MIN_WIDTH), OUTLINE_MAX_WIDTH);
}

function saveOutlineWidth(width: number): void {
  try {
    localStorage.setItem(OUTLINE_STORAGE_KEY, String(width));
  } catch {
    /* ignore quota errors */
  }
}

/**
 * YAML frontmatter: a `---` delimited block at the very top of the file.
 * We strip it before handing the body to Tiptap so the metadata lines
 * (e.g. `name:`, `description:`, `触发:`) are never parsed as headings or
 * rendered as document prose — they live in their own metadata textarea.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function splitFrontmatter(md: string): {
  frontmatter: string | null;
  body: string;
} {
  const m = FRONTMATTER_RE.exec(md);
  if (!m) return { frontmatter: null, body: md };
  const body = md.slice(m[0].length).replace(/^\r?\n+/, "");
  return { frontmatter: m[1] ?? null, body };
}

function joinFrontmatter(frontmatter: string | null, body: string): string {
  if (frontmatter == null) return body;
  const fm = frontmatter.replace(/\r?\n+$/g, "").trim();
  if (!fm) return body;
  return `---\n${fm}\n---\n\n${body}`;
}

interface FrontmatterRow {
  key: string;
  value: string;
  /** How to render the value. Multi-line scalars keep their newlines; list
   *  and object literals are shown as a single muted line. */
  kind: "string" | "multiline" | "list" | "object" | "empty";
}

/**
 * Tiny YAML key-value parser used purely for display. We don't need full
 * YAML — frontmatter in markdown files is almost always a flat
 * `key: scalar` map, occasionally with multi-line scalars or inline
 * `[a, b]` lists. Anything we can't classify as "scalar" gets a single
 * muted line so the user can still see something is there.
 *
 * Exported for unit tests; consumers should treat the output as opaque
 * rows for rendering.
 */
export function parseFrontmatterRows(yaml: string): FrontmatterRow[] {
  const rows: FrontmatterRow[] = [];
  const lines = yaml.replace(/\t/g, "  ").split(/\r?\n/);
  let i = 0;
  // `lines[i]` is `string | undefined` under `noUncheckedIndexedAccess`;
  // treat the end-of-input case as an empty line so the loop terminates.
  const at = (idx: number): string => lines[idx] ?? "";
  while (i < lines.length) {
    const line = at(i);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1] ?? "";
    const raw = (m[2] ?? "").trim();
    // Empty value → look at the indented continuation lines that follow.
    if (raw === "" || raw === "|" || raw === ">") {
      const buf: string[] = [];
      i++;
      while (i < lines.length) {
        const next = at(i);
        if (next === "" || !/^\s/.test(next)) break;
        buf.push(next.replace(/^\s+/, ""));
        i++;
      }
      const text = buf.join("\n").trim();
      rows.push({
        key,
        value: text,
        kind: text ? "multiline" : "empty",
      });
      continue;
    }
    // Inline list `[a, b, c]`.
    if (/^\[.*]$/.test(raw)) {
      const inner = raw.slice(1, -1).trim();
      const items = inner
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      rows.push({ key, value: items.join(" • "), kind: "list" });
      i++;
      continue;
    }
    // Inline object / JSON-ish — show as-is in a muted line.
    if (raw.startsWith("{") || raw.startsWith("&")) {
      rows.push({ key, value: raw, kind: "object" });
      i++;
      continue;
    }
    rows.push({ key, value: raw, kind: "string" });
    i++;
  }
  return rows;
}

function slugifyHeading(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "heading";
}

/**
 * Detect markdown by extension (matches FileViewer's isMarkdownFile).
 */
function isMarkdownPath(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return ext === "md" || ext === "markdown";
}

/**
 * MarkdownRichEditor — a Tiptap-based WYSIWYG markdown editor.
 *
 * The view is always rich text: no source/preview toggle, no edit-mode tab.
 * The user clicks anywhere in the document and starts typing, exactly like
 * VS Code's markdown preview editor. Editing shortcuts (Cmd/Ctrl+B/I/K),
 * markdown input rules (#, ##, ```, >, -, 1., etc.) and Tiptap defaults
 * (Cmd/Ctrl+Z undo, drag to reorder lists, etc.) are inherited from the
 * configured extensions.
 *
 * Persistence:
 *   - Cmd/Ctrl+S: force an immediate save.
 *   - Idle 800ms after the last edit: auto-save.
 *   - On unmount or when the parent calls the registered save(): flush
 *     any pending content synchronously.
 *
 * Markdown round-trip uses `tiptap-markdown`. The serializer preserves the
 * shape the user typed (ATX headings, `-` bullets, fenced code blocks) so a
 * save→reload cycle is visually identical.
 */
export function MarkdownRichEditor({
  projectId,
  filePath,
  onSaveStateChange,
  onSaveRef,
}: MarkdownRichEditorProps) {
  const { t } = useI18n();

  // 1) Load raw markdown from the server, then feed it into Tiptap.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedMarkdown, setLoadedMarkdown] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setLoadedMarkdown(null);
    api
      .getFile(projectId, filePath, true)
      .then((data) => {
        if (cancelled) return;
        setLoadedMarkdown(data.content ?? "");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, filePath]);

  if (!isMarkdownPath(filePath)) {
    return (
      <div className="markdown-rich-editor-state">
        {t("markdownEditorWrongType" as never)}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="markdown-rich-editor-state markdown-rich-editor-state--error">
        {loadError}
      </div>
    );
  }

  if (loadedMarkdown === null) {
    return (
      <div className="markdown-rich-editor-state">
        {t("fileViewerLoading" as never, {
          name: filePath.split("/").pop() || filePath,
        })}
      </div>
    );
  }

  return (
    <MarkdownRichEditorInner
      key={filePath}
      projectId={projectId}
      filePath={filePath}
      initialMarkdown={loadedMarkdown}
      onSaveStateChange={onSaveStateChange}
      onSaveRef={onSaveRef}
    />
  );
}

interface InnerProps extends MarkdownRichEditorProps {
  initialMarkdown: string;
}

function MarkdownRichEditorInner({
  filePath,
  projectId,
  initialMarkdown,
  onSaveStateChange,
  onSaveRef,
}: InnerProps) {
  const { t } = useI18n();

  // Split the loaded file into YAML frontmatter + markdown body so the
  // metadata block isn't mis-parsed as headings or rendered as prose.
  const { frontmatter: initialFrontmatter, body: initialBody } =
    splitFrontmatter(initialMarkdown);
  const hasFrontmatter = initialFrontmatter !== null;

  // Track the "saved" baseline so we can tell whether the current editor
  // content differs from what's on disk.
  const savedMarkdownRef = useRef<string>(initialMarkdown);
  // Latest serialized markdown (full file: frontmatter + body), refreshed on
  // every Tiptap transaction or frontmatter edit.
  const currentMarkdownRef = useRef<string>(initialMarkdown);
  // Frontmatter textarea state + ref for reading latest value inside
  // callbacks without stale closures.
  const [frontmatterText, setFrontmatterText] = useState<string>(
    initialFrontmatter ?? "",
  );
  const frontmatterTextRef = useRef<string>(frontmatterText);
  frontmatterTextRef.current = frontmatterText;
  const hasFrontmatterRef = useRef<boolean>(hasFrontmatter);
  hasFrontmatterRef.current = hasFrontmatter;
  // Latest Tiptap editor handle so save() and other callbacks can serialize
  // the body without depending on the `editor` value (which can be null on
  // first render).
  const editorRef = useRef<Editor | null>(null);
  // Debounce timer for auto-save.
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // In-flight save promise so manual save can await it.
  const savingRef = useRef<Promise<void> | null>(null);
  // We notify the parent via this ref to avoid re-binding the effect on
  // every parent re-render.
  const onSaveStateChangeRef = useRef(onSaveStateChange);
  onSaveStateChangeRef.current = onSaveStateChange;
  // Local mirror of the save state so the format toolbar (rendered below)
  // can show the dirty/saving/saved/error indicator without needing the
  // parent to forward the prop.
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  // Outline panel: open by default when there are ≥2 headings.
  const [outlineOpen, setOutlineOpen] = useState<boolean>(true);
  // Latest heading outline (H1–H3). Populated from the editor doc on every
  // transaction so the right-side panel reflects the current document.
  const [headings, setHeadings] = useState<OutlineItem[]>([]);
  // Outline panel width in px (persisted to localStorage). The drag handle
  // on the panel's left edge updates this; it is clamped to the
  // [OUTLINE_MIN_WIDTH, OUTLINE_MAX_WIDTH] range.
  const [outlineWidth, setOutlineWidthState] =
    useState<number>(loadOutlineWidth);
  const [isOutlineResizing, setIsOutlineResizing] = useState(false);
  const outlineResizeStartX = useRef<number | null>(null);
  const outlineResizeStartWidth = useRef<number | null>(null);
  // Ref tracks the live width so the mouseup handler can persist it
  // without reading stale state from a closure.
  const outlineWidthLiveRef = useRef<number>(outlineWidth);
  outlineWidthLiveRef.current = outlineWidth;
  // Frontmatter view/edit toggle. Default is the read-only table view;
  // flipping to edit reveals the raw YAML textarea so the user can make
  // structural changes (e.g. add/rename keys). The textarea auto-saves
  // through `recomputeAndScheduleSave`, same as the body.
  const [frontmatterEditing, setFrontmatterEditing] = useState(false);
  const frontmatterTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const setOutlineWidth = useCallback((next: number) => {
    const clamped = Math.min(
      Math.max(next, OUTLINE_MIN_WIDTH),
      OUTLINE_MAX_WIDTH,
    );
    setOutlineWidthState(clamped);
    saveOutlineWidth(clamped);
  }, []);

  const handleOutlineResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      outlineResizeStartX.current = e.clientX;
      outlineResizeStartWidth.current = outlineWidth;
      setIsOutlineResizing(true);
    },
    [outlineWidth],
  );

  useEffect(() => {
    if (!isOutlineResizing) return;
    const handleMove = (e: MouseEvent) => {
      if (
        outlineResizeStartX.current === null ||
        outlineResizeStartWidth.current === null
      )
        return;
      // The handle sits at the panel's LEFT edge, so dragging left grows
      // the panel; width delta = (start.x - e.clientX).
      const diff = outlineResizeStartX.current - e.clientX;
      const next = outlineResizeStartWidth.current + diff;
      const clamped = Math.min(
        Math.max(next, OUTLINE_MIN_WIDTH),
        OUTLINE_MAX_WIDTH,
      );
      setOutlineWidthState(clamped);
      outlineWidthLiveRef.current = clamped;
    };
    const handleUp = () => {
      outlineResizeStartX.current = null;
      outlineResizeStartWidth.current = null;
      setIsOutlineResizing(false);
      // Persist the final width now that the drag is done.
      saveOutlineWidth(outlineWidthLiveRef.current);
    };
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    return () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
  }, [isOutlineResizing]);

  const emitState = useCallback((state: SaveState) => {
    setSaveState(state);
    onSaveStateChangeRef.current?.(state);
  }, []);

  // The save() function: serializes current content, writes to server,
  // updates the baseline, clears dirty/saving, fires "saved" briefly. Safe
  // to call concurrently — the second call awaits the first.
  const save = useCallback(async (): Promise<void> => {
    if (savingRef.current) {
      await savingRef.current;
    }
    const markdown = currentMarkdownRef.current;
    if (markdown === savedMarkdownRef.current) {
      // Nothing changed since the last successful save.
      return;
    }
    emitState({ kind: "saving" });
    const work = (async () => {
      try {
        await api.updateFile(projectId, filePath, markdown);
        savedMarkdownRef.current = markdown;
        emitState({ kind: "saved" });
        // Flash a "saved" badge for 1.5s then return to idle. We do not
        // reset to "dirty" if the user typed during the save — instead the
        // next onUpdate will set it back to dirty.
        setTimeout(() => {
          if (currentMarkdownRef.current === savedMarkdownRef.current) {
            emitState({ kind: "idle" });
          }
        }, 1500);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        emitState({ kind: "error", message });
        // Keep the editor content; user can retry. The next edit will move
        // us back to dirty.
      } finally {
        savingRef.current = null;
      }
    })();
    savingRef.current = work;
    await work;
  }, [emitState, projectId, filePath]);

  // The Tiptap editor instance. recreated on file change via the `key` on
  // the outer component.
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // CodeBlock from StarterKit is replaced by CodeBlockLowlight so we
        // get syntax highlighting; disable the default to avoid conflicts.
        codeBlock: false,
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      CodeBlockLowlight.configure({ lowlight }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      }),
      Image.configure({ inline: false, allowBase64: true }),
      Placeholder.configure({
        placeholder: t("markdownEditorPlaceholder" as never),
      }),
      // tiptap-markdown: register last so it observes the full schema.
      // `breaks: true` so a single Enter produces a hard line break, like
      // VS Code's markdown preview.
      // `linkify: true` so typed URLs become clickable links.
      // `html: true` so pasted HTML round-trips reasonably.
      // `transformPastedText: true` so paste of raw markdown is parsed.
      Markdown.configure({
        html: true,
        breaks: true,
        linkify: true,
        transformPastedText: true,
        tightLists: true,
      }),
    ],
    content: initialBody,
    autofocus: false,
    editorProps: {
      attributes: {
        class: "tiptap-editor markdown-rich-editor-surface",
        spellcheck: "false",
      },
      handleKeyDown: (_view, event) => {
        // Cmd/Ctrl+S → manual save. Tiptap doesn't ship a save handler so
        // we add it here. Cmd/Ctrl+Shift+S would re-render — we don't need
        // that for a file editor.
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          void save();
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor: ed }) => {
      editorRef.current = ed;
    },
    onUpdate: ({ editor: ed }) => {
      // tiptap-markdown stores the serialized markdown on the editor's
      // `storage.markdown` namespace. We serialize the body, then re-join
      // the frontmatter (if any) so the dirty baseline is the full file.
      const bodyMarkdown =
        (
          ed.storage as { markdown?: { getMarkdown?: () => string } }
        ).markdown?.getMarkdown?.() ?? ed.getHTML();
      const markdown = joinFrontmatter(
        hasFrontmatterRef.current ? frontmatterTextRef.current : null,
        bodyMarkdown,
      );
      currentMarkdownRef.current = markdown;
      const dirty = markdown !== savedMarkdownRef.current;
      if (dirty) {
        emitState({ kind: "dirty" });
      }
      // Debounced auto-save.
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
      }
      if (dirty) {
        autosaveTimerRef.current = setTimeout(() => {
          autosaveTimerRef.current = null;
          void save();
        }, AUTOSAVE_DELAY_MS);
      }
    },
    // Avoid SSR-related warnings (we're CSR-only but Tiptap logs if not
    // configured).
    immediatelyRender: true,
  });

  // Expose the save function to the parent. Stable per filePath.
  useEffect(() => {
    if (!onSaveRef) return;
    onSaveRef(() => save());
    return () => onSaveRef(null);
  }, [onSaveRef, save]);

  // Flush any pending save on unmount. Best-effort: if the save is
  // in-flight, we let it complete; if a debounce is pending, we fire it
  // synchronously.
  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
        // Fire-and-forget: the parent will likely remount us for a new
        // file, so the result is informational.
        if (
          currentMarkdownRef.current !== savedMarkdownRef.current &&
          !savingRef.current
        ) {
          void save();
        }
      }
    };
  }, [save]);

  // After mount: if the initial body is empty, focus the editor so
  // the placeholder disappears and the user can start typing.
  useEffect(() => {
    if (!editor) return;
    if (initialBody.length === 0) {
      editor.commands.focus("end");
    }
  }, [editor, initialBody]);

  // Collect heading outline (H1–H3) from the editor document. Re-runs on
  // every edit so the right-side panel stays in sync.
  useEffect(() => {
    if (!editor) return;
    const collect = () => setHeadings(extractHeadings(editor));
    collect();
    editor.on("update", collect);
    editor.on("create", collect);
    editor.on("selectionUpdate", collect);
    return () => {
      editor.off("update", collect);
      editor.off("create", collect);
      editor.off("selectionUpdate", collect);
    };
  }, [editor]);

  // Recompute the full markdown (frontmatter + body) and mark the editor
  // dirty. Used both by the frontmatter textarea's onChange and by save().
  const recomputeAndScheduleSave = useCallback(
    (nextFrontmatter: string) => {
      const ed = editorRef.current;
      const bodyMarkdown =
        (
          ed?.storage as
            | { markdown?: { getMarkdown?: () => string } }
            | undefined
        )?.markdown?.getMarkdown?.() ?? "";
      const markdown = joinFrontmatter(
        hasFrontmatterRef.current ? nextFrontmatter : null,
        bodyMarkdown,
      );
      currentMarkdownRef.current = markdown;
      const dirty = markdown !== savedMarkdownRef.current;
      if (dirty) emitState({ kind: "dirty" });
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
      }
      if (dirty) {
        autosaveTimerRef.current = setTimeout(() => {
          autosaveTimerRef.current = null;
          void save();
        }, AUTOSAVE_DELAY_MS);
      }
    },
    [emitState, save],
  );

  if (!editor) {
    return null;
  }

  const showOutline = headings.length >= 2;

  const handleOutlineClick = (pos: number) => {
    // Move the caret first so the DOM reflects the new selection (this
    // is what makes the heading node exist as a renderable element).
    editor.chain().focus().setTextSelection(pos).run();
    // Then on the next frame, find the heading node and scroll it so it
    // sits near the top of the visible scroll container — not at the
    // bottom (which is the ProseMirror default for `scrollIntoView()`).
    requestAnimationFrame(() => {
      try {
        const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
        // Walk up to the nearest H1–H6 if nodeDOM returned a text node.
        let heading: HTMLElement | null = dom;
        while (
          heading &&
          heading !== editor.view.dom &&
          !/^H[1-6]$/.test(heading.tagName)
        ) {
          heading = heading.parentElement;
        }
        if (!heading) {
          editor.commands.scrollIntoView();
          return;
        }
        // Find the nearest scrollable ancestor — that's the viewport
        // for the editor body. We then manually position the heading
        // near the top with a small breathing room.
        const scrollContainer =
          (heading.closest(
            ".markdown-rich-editor-body",
          ) as HTMLElement | null) ?? heading.parentElement;
        if (!scrollContainer) {
          heading.scrollIntoView({ block: "start", behavior: "smooth" });
          return;
        }
        const containerRect = scrollContainer.getBoundingClientRect();
        const headingRect = heading.getBoundingClientRect();
        // Target: heading top at ~12px from container top. delta is
        // positive when the heading is below the target.
        const targetOffset = 12;
        const delta = headingRect.top - containerRect.top - targetOffset;
        if (Math.abs(delta) < 2) return; // already in position
        scrollContainer.scrollTo({
          top: scrollContainer.scrollTop + delta,
          behavior: "smooth",
        });
        flashHeading(editor, pos);
      } catch {
        /* ignore */
      }
    });
  };

  return (
    <div className="markdown-rich-editor">
      <FormatToolbar
        editor={editor}
        saveState={saveState}
        trailing={
          showOutline ? (
            <OutlineToggleButton
              open={outlineOpen}
              onClick={() => setOutlineOpen((v) => !v)}
            />
          ) : null
        }
      />
      <div className="markdown-rich-editor-body-row">
        <div className="markdown-rich-editor-body">
          {hasFrontmatter && (
            <FrontmatterBlock
              editing={frontmatterEditing}
              value={frontmatterText}
              onToggle={() => {
                setFrontmatterEditing((v) => {
                  const next = !v;
                  // When switching into edit mode, focus the textarea on
                  // the next frame so the cursor lands at the end.
                  if (next) {
                    requestAnimationFrame(() => {
                      const ta = frontmatterTextareaRef.current;
                      if (ta) {
                        ta.focus();
                        const len = ta.value.length;
                        ta.setSelectionRange(len, len);
                      }
                    });
                  }
                  return next;
                });
              }}
              onChange={(next) => {
                setFrontmatterText(next);
                recomputeAndScheduleSave(next);
              }}
              textareaRef={frontmatterTextareaRef}
            />
          )}
          <EditorContent
            editor={editor}
            className="markdown-rich-editor-surface"
          />
        </div>
        {showOutline && outlineOpen && (
          <HeadingNav
            items={headings}
            width={outlineWidth}
            isResizing={isOutlineResizing}
            onItemClick={handleOutlineClick}
            onResizeStart={handleOutlineResizeMouseDown}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Frontmatter block
// ---------------------------------------------------------------------------

interface FrontmatterBlockProps {
  editing: boolean;
  value: string;
  onToggle: () => void;
  onChange: (next: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

/**
 * Renders the YAML frontmatter inside the editor body so it scrolls with
 * the document. Default state is a read-only key/value table styled to
 * visually recede from the main content (smaller, muted, gray). Clicking
 * the "编辑" / "完成" toggle flips to a raw YAML textarea for structural
 * edits — the textarea still auto-saves through the same path as the body.
 */
function FrontmatterBlock({
  editing,
  value,
  onToggle,
  onChange,
  textareaRef,
}: FrontmatterBlockProps) {
  const { t } = useI18n();
  const rows = parseFrontmatterRows(value);
  const toggleLabel = editing
    ? (t("editorFrontmatterDone" as never) as string)
    : (t("editorFrontmatterEdit" as never) as string);
  return (
    <section
      className={`markdown-rich-editor-frontmatter ${editing ? "is-editing" : ""}`}
      aria-label={t("editorFrontmatterLabel" as never)}
    >
      <header className="markdown-rich-editor-frontmatter-header">
        <span className="markdown-rich-editor-frontmatter-label">
          <span className="markdown-rich-editor-frontmatter-label-dot" />
          {t("editorFrontmatterLabel" as never)}
        </span>
        <button
          type="button"
          className="markdown-rich-editor-frontmatter-toggle"
          onClick={onToggle}
          aria-pressed={editing}
          title={toggleLabel}
        >
          {editing ? (
            <Icon path="M5 12l4 4L19 6" />
          ) : (
            <Icon path="M4 20h4l10-10-4-4L4 16v4zM14 5l4 4" />
          )}
          <span className="markdown-rich-editor-frontmatter-toggle-label">
            {toggleLabel}
          </span>
        </button>
      </header>
      {editing ? (
        <textarea
          ref={textareaRef}
          className="markdown-rich-editor-frontmatter-textarea"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={t("editorFrontmatterLabel" as never)}
          rows={Math.max(3, Math.min(12, value.split("\n").length + 1))}
        />
      ) : rows.length === 0 ? (
        <div className="markdown-rich-editor-frontmatter-empty">—</div>
      ) : (
        <table className="markdown-rich-editor-frontmatter-table">
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th
                  scope="row"
                  className="markdown-rich-editor-frontmatter-key"
                >
                  {row.key}
                </th>
                <td
                  className={`markdown-rich-editor-frontmatter-value kind-${row.kind}`}
                >
                  {row.kind === "empty" ? (
                    <span className="is-placeholder">—</span>
                  ) : row.kind === "multiline" ? (
                    // Multi-line scalars keep their newlines via CSS
                    // `white-space: pre-wrap` (see the value rule below).
                    <span className="markdown-rich-editor-frontmatter-value-multiline">
                      {row.value}
                    </span>
                  ) : (
                    row.value
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

interface FormatToolbarProps {
  editor: Editor;
  saveState: SaveState;
  /** Optional node rendered at the far right of the toolbar (after the
   *  save-state badge), e.g. the outline panel toggle. */
  trailing?: React.ReactNode;
}

function FormatToolbar({ editor, saveState, trailing }: FormatToolbarProps) {
  const { t } = useI18n();
  return (
    <div
      className="markdown-rich-editor-toolbar"
      role="toolbar"
      aria-label={t("editorFormat" as never)}
    >
      <ToolbarGroup>
        <ToolbarButton
          label={t("editorFormatBold" as never)}
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Icon path="M7 4h5a3 3 0 0 1 0 6H7zm0 6h6a3 3 0 0 1 0 6H7zM7 4v16" />
        </ToolbarButton>
        <ToolbarButton
          label={t("editorFormatItalic" as never)}
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Icon path="M10 4h6M8 20h6M14 4l-4 16" />
        </ToolbarButton>
        <ToolbarButton
          label={t("editorFormatStrike" as never)}
          active={editor.isActive("strike")}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <Icon path="M5 12h14M9 6.5c0-1.5 1.3-2.5 3-2.5s3 1 3 2.5M15 17.5c0 1.5-1.3 2.5-3 2.5s-3-1-3-2.5" />
        </ToolbarButton>
        <ToolbarButton
          label={t("editorFormatInlineCode" as never)}
          active={editor.isActive("code")}
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          <Icon path="M9 7l-4 5 4 5M15 7l4 5-4 5" />
        </ToolbarButton>
      </ToolbarGroup>

      <ToolbarDivider />

      <ToolbarGroup>
        {([1, 2, 3] as const).map((level) => (
          <ToolbarButton
            key={level}
            label={t(`editorFormatH${level}` as never)}
            active={editor.isActive("heading", { level })}
            onClick={() =>
              editor.chain().focus().toggleHeading({ level }).run()
            }
          >
            <span className="markdown-rich-editor-toolbar-label">H{level}</span>
          </ToolbarButton>
        ))}
      </ToolbarGroup>

      <ToolbarDivider />

      <ToolbarGroup>
        <ToolbarButton
          label={t("editorFormatBulletList" as never)}
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <Icon path="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
        </ToolbarButton>
        <ToolbarButton
          label={t("editorFormatOrderedList" as never)}
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <Icon path="M10 6h10M10 12h10M10 18h10M4 6h1v4M4 14h2v-1H5v-1h2M6 18H4v-2h2z" />
        </ToolbarButton>
        <ToolbarButton
          label={t("editorFormatQuote" as never)}
          active={editor.isActive("blockquote")}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          <Icon path="M7 7h4v6H7zM7 13c0 2 1 4 4 4M13 7h4v6h-4zM13 13c0 2 1 4 4 4" />
        </ToolbarButton>
        <ToolbarButton
          label={t("editorFormatCodeBlock" as never)}
          active={editor.isActive("codeBlock")}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        >
          <Icon path="M4 8l-2 4 2 4M20 8l2 4-2 4M14 4l-4 16" />
        </ToolbarButton>
      </ToolbarGroup>

      <ToolbarDivider />

      <ToolbarGroup>
        <ToolbarButton
          label={t("editorFormatLink" as never)}
          active={editor.isActive("link")}
          onClick={() => {
            const previous = editor.getAttributes("link").href as
              | string
              | undefined;
            const url = window.prompt(
              t("editorFormatLinkPrompt" as never),
              previous ?? "https://",
            );
            if (url === null) return;
            if (url === "") {
              editor.chain().focus().extendMarkRange("link").unsetLink().run();
              return;
            }
            editor
              .chain()
              .focus()
              .extendMarkRange("link")
              .setLink({ href: url })
              .run();
          }}
        >
          <Icon path="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
        </ToolbarButton>
        <ToolbarButton
          label={t("editorFormatImage" as never)}
          onClick={() => {
            const url = window.prompt(t("editorFormatImagePrompt" as never));
            if (!url) return;
            editor.chain().focus().setImage({ src: url }).run();
          }}
        >
          <Icon path="M3 5h18v14H3zM3 17l5-5 4 4 3-3 6 6M9 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" />
        </ToolbarButton>
      </ToolbarGroup>

      <ToolbarDivider />

      <ToolbarGroup>
        <ToolbarButton
          label={t("editorFormatUndo" as never)}
          disabled={!editor.can().undo()}
          onClick={() => editor.chain().focus().undo().run()}
        >
          <Icon path="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4" />
        </ToolbarButton>
        <ToolbarButton
          label={t("editorFormatRedo" as never)}
          disabled={!editor.can().redo()}
          onClick={() => editor.chain().focus().redo().run()}
        >
          <Icon path="M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h4" />
        </ToolbarButton>
      </ToolbarGroup>
      <div className="markdown-rich-editor-toolbar-spacer" />
      <SaveStateBadge state={saveState} />
      {trailing}
    </div>
  );
}

function ToolbarGroup({ children }: { children: React.ReactNode }) {
  return <div className="markdown-rich-editor-toolbar-group">{children}</div>;
}

function ToolbarDivider() {
  return <div className="markdown-rich-editor-toolbar-divider" />;
}

interface ToolbarButtonProps {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function ToolbarButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={`markdown-rich-editor-toolbar-btn ${active ? "is-active" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Icon({ path }: { path: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Heading outline / navigation panel
// ---------------------------------------------------------------------------

interface OutlineItem {
  pos: number;
  text: string;
  level: number;
}

function extractHeadings(editor: Editor): OutlineItem[] {
  const items: OutlineItem[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return;
    const level = Number(node.attrs.level);
    if (!Number.isFinite(level) || level < 1 || level > 3) return;
    const text = node.textContent;
    if (!text.trim()) return;
    items.push({ pos: pos + 1, text, level });
    return false;
  });
  return items;
}

function flashHeading(editor: Editor, pos: number) {
  // After scrollIntoView runs, walk up from the DOM node at `pos` to the
  // nearest <h1>-<h6> and add a brief flash class so the user sees where
  // they landed.
  requestAnimationFrame(() => {
    try {
      const { node } = editor.view.domAtPos(pos);
      let el: HTMLElement | null = node as HTMLElement;
      while (el && el !== editor.view.dom && !/^H[1-6]$/.test(el.tagName)) {
        el = el.parentElement;
      }
      if (el && /^H[1-6]$/.test(el.tagName)) {
        el.classList.add("md-heading-flash");
        window.setTimeout(() => el.classList.remove("md-heading-flash"), 1200);
      }
    } catch {
      /* ignore */
    }
  });
}

function HeadingNav({
  items,
  width,
  isResizing,
  onItemClick,
  onResizeStart,
}: {
  items: OutlineItem[];
  width: number;
  isResizing: boolean;
  onItemClick: (pos: number) => void;
  onResizeStart: (e: React.MouseEvent) => void;
}) {
  const { t } = useI18n();
  return (
    <aside
      className={`markdown-rich-editor-outline ${isResizing ? "is-resizing" : ""}`}
      style={
        { ["--outline-width" as never]: `${width}px` } as React.CSSProperties
      }
      aria-label={t("editorOutline" as never)}
    >
      <div
        className="markdown-rich-editor-outline-resize-handle"
        onMouseDown={onResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("actionResizeOutline" as never)}
        tabIndex={0}
      />
      <div className="markdown-rich-editor-outline-title">
        {t("editorOutline" as never)}
      </div>
      <ul>
        {items.map((it, idx) => (
          <li
            key={`${it.pos}-${idx}`}
            className={`markdown-rich-editor-outline-item level-${it.level}`}
          >
            <button
              type="button"
              className="markdown-rich-editor-outline-link"
              onClick={() => onItemClick(it.pos)}
              title={it.text}
            >
              {it.text}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Outline toggle button — sits in the editor area's top-right corner and
// opens/closes the right-side outline panel. Uses the same icon style as
// the sidebar's collapse/expand button for visual consistency.
// ---------------------------------------------------------------------------

function OutlineToggleButton({
  open,
  onClick,
}: {
  open: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const label = open
    ? (t("editorOutlineCollapse" as never) as string)
    : (t("editorOutlineExpand" as never) as string);
  return (
    <button
      type="button"
      className="markdown-rich-editor-outline-toggle-btn sidebar-toggle"
      onClick={onClick}
      aria-label={label}
      aria-pressed={open}
      title={label}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        {/* Line mirrors the sidebar's panel icon to the RIGHT side, since
            the outline panel sits to the right of the editor. */}
        <line x1="15" y1="3" x2="15" y2="21" />
      </svg>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Save state badge — surfaces dirty/saving/saved/error in the format toolbar.
// ---------------------------------------------------------------------------

function SaveStateBadge({ state }: { state: SaveState }) {
  const { t } = useI18n();
  switch (state.kind) {
    case "dirty":
      return (
        <span className="file-editor-dirty" title={t("editorUnsaved" as never)}>
          ●
        </span>
      );
    case "saving":
      return (
        <span className="file-editor-saving">{t("editorSaving" as never)}</span>
      );
    case "saved":
      return (
        <span className="file-editor-saved">{t("editorSaved" as never)}</span>
      );
    case "error":
      return (
        <span className="file-editor-save-error" title={state.message}>
          {t("editorSaveError" as never)}
        </span>
      );
    default:
      return null;
  }
}
