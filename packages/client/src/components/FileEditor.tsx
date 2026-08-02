import type { FileContentResponse } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { FileViewer } from "./FileViewer";
import { MarkdownRichEditor, type SaveState } from "./MarkdownRichEditor";

interface FileEditorProps {
  projectId: string;
  /** Relative file path within the project. */
  filePath: string;
  /** Close this editor tab. */
  onClose: () => void;
  /** Report whether there are unsaved changes (drives the tab dirty dot + unload guard). */
  onDirtyChange: (dirty: boolean) => void;
  /** Register/unregister the live save handler so the parent can save-then-close. Pass null to unregister. */
  onSaveRef?: (save: (() => Promise<void>) | null) => void;
}

function isMarkdownPath(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return ext === "md" || ext === "markdown";
}

/**
 * FileEditor — an in-page, VS Code-style file tab.
 *
 *   - .md  → MarkdownRichEditor (Tiptap WYSIWYG, click-to-edit, auto-save).
 *            No source/preview toggle, no edit-mode tab. The rich text view
 *            *is* the editor.
 *   - any other text file → FileViewer (syntax-highlighted preview) plus a
 *            line-numbered textarea for editing. Manual save (Cmd/Ctrl+S).
 *
 * Keyboard shortcuts (Win/Mac): Ctrl/Cmd+S saves in both modes.
 */
export function FileEditor(props: FileEditorProps) {
  if (isMarkdownPath(props.filePath)) {
    return <MarkdownFileEditor {...props} />;
  }
  return <TextFileEditor {...props} />;
}

// ---------------------------------------------------------------------------
// Markdown (.md) — Tiptap WYSIWYG
// ---------------------------------------------------------------------------

function MarkdownFileEditor({
  projectId,
  filePath,
  onDirtyChange,
  onSaveRef,
}: FileEditorProps) {
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });

  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  // Report dirty to the parent. "dirty" / "saving" / "error" all count as
  // having unsaved local changes; "saved" / "idle" do not.
  const dirty =
    saveState.kind === "dirty" ||
    saveState.kind === "saving" ||
    saveState.kind === "error";
  useEffect(() => {
    onDirtyChangeRef.current(dirty);
  }, [dirty]);

  return (
    <div className="file-editor">
      <div className="file-editor-body">
        <MarkdownRichEditor
          projectId={projectId}
          filePath={filePath}
          onSaveStateChange={setSaveState}
          onSaveRef={onSaveRef}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plain text / code — existing preview + textarea behavior
// ---------------------------------------------------------------------------

type EditorMode = "preview" | "edit";

function TextFileEditor({
  projectId,
  filePath,
  onClose,
  onDirtyChange,
  onSaveRef,
}: FileEditorProps) {
  const { t } = useI18n();
  const [, setFileData] = useState<FileContentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<EditorMode>("preview");
  const [draft, setDraft] = useState("");
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  // Bumping this remounts FileViewer so the preview reflects a fresh save.
  const [previewVersion, setPreviewVersion] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  const dirty = draft !== original;

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    api
      .getFile(projectId, filePath, true)
      .then((data) => {
        const content = data.content ?? "";
        setFileData(data);
        setOriginal(content);
        setDraft(content);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setLoadError(
          err instanceof Error
            ? err.message
            : (t("fileViewerLoadFailed" as never) as string),
        );
        setLoading(false);
      });
  }, [projectId, filePath, t]);

  useEffect(() => {
    load();
  }, [load]);

  // Report dirty state only when it actually changes (ref keeps the callback
  // stable so we don't notify on every parent re-render).
  useEffect(() => {
    onDirtyChangeRef.current(dirty);
  }, [dirty]);

  const handleSave = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateFile(projectId, filePath, draft);
      setOriginal(draft);
      setSavedFlash(true);
      setPreviewVersion((v) => v + 1);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, projectId, filePath, draft]);

  // Expose the latest save handler to the parent so it can "save & close" a tab.
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;
  useEffect(() => {
    if (!onSaveRef) return;
    const save = () => handleSaveRef.current();
    onSaveRef(save);
    return () => onSaveRef(null);
  }, [onSaveRef]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Ctrl/Cmd+S → save (prevent the browser "save page" dialog)
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        handleSave();
      }
    },
    [handleSave],
  );

  const syncScroll = useCallback(() => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  const lineCount = draft.split("\n").length;
  const fileName = filePath.split("/").pop() || filePath;

  if (loading) {
    return (
      <div className="file-editor-state">
        {t("fileViewerLoading" as never, { name: fileName })}
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="file-editor-state file-editor-state--error">
        {loadError}
      </div>
    );
  }

  return (
    <div className="file-editor">
      <div className="file-editor-toolbar">
        <div className="file-editor-path" title={filePath}>
          {filePath}
        </div>
        <div className="file-editor-actions">
          <div
            className="file-editor-mode-toggle"
            role="tablist"
            aria-label={t("editorMode" as never)}
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "preview"}
              className={mode === "preview" ? "is-active" : ""}
              onClick={() => setMode("preview")}
            >
              {t("editorPreview" as never)}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "edit"}
              className={mode === "edit" ? "is-active" : ""}
              onClick={() => setMode("edit")}
            >
              {t("editorEdit" as never)}
            </button>
          </div>

          {dirty && (
            <span
              className="file-editor-dirty"
              title={t("editorUnsaved" as never)}
            >
              ●
            </span>
          )}
          {savedFlash && (
            <span className="file-editor-saved">
              {t("editorSaved" as never)}
            </span>
          )}
          {saveError && (
            <span className="file-editor-save-error" title={saveError}>
              {t("editorSaveError" as never)}
            </span>
          )}

          <button
            type="button"
            className="file-editor-action"
            onClick={load}
            disabled={saving}
            title={t("editorReload" as never)}
          >
            {t("editorReload" as never)}
          </button>
          <button
            type="button"
            className="file-editor-action file-editor-save-btn"
            onClick={handleSave}
            disabled={!dirty || saving}
            title={t("editorSaveHint" as never)}
          >
            {t("editorSave" as never)}
          </button>
          <button
            type="button"
            className="file-editor-action file-editor-close"
            onClick={onClose}
            aria-label={t("editorClose" as never)}
            title={t("editorClose" as never)}
          >
            ×
          </button>
        </div>
      </div>

      <div className="file-editor-body">
        {mode === "preview" ? (
          <FileViewer
            key={previewVersion}
            projectId={projectId}
            filePath={filePath}
          />
        ) : (
          <div className="file-editor-edit">
            <div
              className="file-editor-gutter"
              ref={gutterRef}
              aria-hidden="true"
            >
              {Array.from({ length: lineCount }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: line order is stable; index key is correct for a gutter
                <div key={i} className="file-editor-line-no">
                  {i + 1}
                </div>
              ))}
            </div>
            <textarea
              ref={textareaRef}
              className="file-editor-textarea"
              value={draft}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              wrap="off"
              onChange={(e) => setDraft(e.target.value)}
              onScroll={syncScroll}
              onKeyDown={handleKeyDown}
            />
          </div>
        )}
      </div>
    </div>
  );
}
