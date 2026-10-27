import { SIDE_CONVERSATION_MAX_PROMPT } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalToastContext } from "../contexts/ToastContext";
import { useComposer } from "../hooks/useComposer";
import { useComposerUploads } from "../hooks/useComposerUploads";
import { useConnection } from "../hooks/useConnection";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import type { useSideConversation } from "../hooks/useSideConversation";
import { useI18n } from "../i18n";
import { getCurrentInstallId } from "../lib/storageKeys";
import { ComposerEditor } from "./ComposerEditor";
import { ComposerToolbar } from "./ComposerToolbar";
import { TextBlock } from "./blocks/TextBlock";
import "../styles/side-conversation.css";

/** Side questions have no `/` commands: Yep owns the side control plane. */
const NO_COMMANDS: never[] = [];

export function SideConversationPanel({
  side,
  projectId,
  sessionId,
  parentStatus,
  visible,
  mobile,
  onClose,
  onBringBack,
}: {
  side: ReturnType<typeof useSideConversation>;
  /** Project of the parent session; side images upload into its session. */
  projectId?: string;
  sessionId: string;
  parentStatus: string;
  visible: boolean;
  mobile: boolean;
  onClose(): void;
  onBringBack(text: string): void;
}) {
  const { t, locale } = useI18n();
  const { conversation, busy, error } = side;
  const [context, setContext] = useState<"snapshot" | "empty">("snapshot");
  const draftKey = `side-draft-${getCurrentInstallId() ?? location.host}-${sessionId}-${conversation?.id ?? "new"}`;
  const [draft, setDraft, controls] = useDraftPersistence(draftKey);
  const panelRef = useRef<HTMLElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const running =
    conversation?.status === "running" || conversation?.status === "stopping";
  const ended = conversation?.status === "closed";
  const canSend = side.supported && side.availability === "ready";
  const toast = useOptionalToastContext();
  const connection = useConnection();
  const canAttachImages =
    side.capabilities.images && !!projectId && !!sessionId && !ended;
  const uploads = useComposerUploads({
    projectId,
    sessionId,
    onError: useCallback(
      (file: File, uploadError: unknown) =>
        toast?.showToast(
          t("sideChatUploadFailed", {
            file: file.name,
            message:
              uploadError instanceof Error
                ? uploadError.message
                : String(uploadError),
          }),
          "error",
        ),
      [toast, t],
    ),
  });
  const submitRef = useRef<() => void>(() => {});
  const composer = useComposer({
    text: draft,
    setText: setDraft,
    attachments: uploads.composerAttachments,
    describeAttachment: (attachment) => attachment,
    getClipboardSource: (attachment) => {
      const apiPath = attachment.apiPath;
      if (!apiPath) return null;
      return {
        name: attachment.name,
        mimeType: attachment.mimeType,
        read: () => connection.fetchBlob(apiPath.slice("/api".length)),
        reference: apiPath,
      };
    },
    canAttach: canAttachImages,
    // Side providers read images only; other files stay out of the draft.
    acceptFile: (file) => file.type.startsWith("image/"),
    onRejectFiles: (files) =>
      toast?.showToast(
        t("sideChatImagesOnly", {
          names: files.map((file) => file.name).join(", "),
        }),
        "error",
      ),
    disabled: ended,
    onAttach: uploads.attach,
    onRemove: uploads.remove,
    onRestore: uploads.restore,
    commandConfigs: NO_COMMANDS,
    onSubmit: () => submitRef.current(),
  });
  const tooLong = draft.length > SIDE_CONVERSATION_MAX_PROMPT;
  const availabilityLabel =
    side.availability === "checking"
      ? "sideChatChecking"
      : side.availability === "unsupported"
        ? "sideChatNeedsUpdate"
        : side.availability === "connection_error"
          ? "sideChatConnectionError"
          : "sideChatNotReady";
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus only when the panel opens.
  useEffect(() => {
    if (!visible) return;
    const previous = document.activeElement;
    composer.editorRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [visible]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scroll when a new side snapshot changes the transcript height.
  useEffect(() => {
    if (visible && follow.current && logRef.current)
      logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [visible, conversation?.version]);
  const submit = async () => {
    if (busy || running || ended || !canSend || tooLong) return;
    if (uploads.hasPendingUploads) {
      toast?.showToast(t("sideChatUploading"), "info");
      return;
    }
    const text = composer.takeText().trim();
    if (!text) return;
    const images = uploads.attachments.map((file) => ({
      path: file.path,
      name: file.originalName,
      mimeType: file.mimeType,
    }));
    // Flush/record the submitted draft before creation changes the side ID.
    controls.clearInput();
    if (await side.send(text, context, images)) {
      uploads.clear();
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* Storage may be unavailable. */
      }
      if (!controls.getText?.()) controls.clearDraft();
    } else if (!controls.getText?.()) controls.setText(text);
  };
  submitRef.current = () => {
    void submit();
  };
  return (
    <aside
      id="side-conversation-panel"
      ref={panelRef}
      className={`side-conversation ${mobile ? "side-conversation--mobile" : ""}`}
      hidden={!visible}
      role={mobile ? "dialog" : "complementary"}
      aria-modal={mobile ? true : undefined}
      aria-labelledby="side-conversation-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
        if (mobile && event.key === "Tab") {
          const nodes = panelRef.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]",
          );
          const first = nodes?.[0];
          const last = nodes?.[nodes.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <header className="side-conversation-header">
        <h2 id="side-conversation-title">{t("sideChatTitle")}</h2>
        <button type="button" onClick={onClose}>
          {t(mobile ? "sideChatReturn" : "sideChatHide")}
        </button>
      </header>
      <button
        type="button"
        className="side-conversation-parent"
        onClick={onClose}
      >
        {t("sideChatMainStatus", { status: parentStatus })}
      </button>
      <div className="side-conversation-context">
        {conversation ? (
          <>
            <span>
              {conversation.context === "snapshot"
                ? t("sideChatSnapshot", {
                    time: new Date(conversation.capturedAt).toLocaleTimeString(
                      locale,
                      { hour: "2-digit", minute: "2-digit" },
                    ),
                  })
                : t("sideChatEmptyContext")}
            </span>
            <span>
              {t("sideChatReadOnly")}
              {conversation.model ? ` · ${conversation.model}` : ""}
            </span>
          </>
        ) : (
          <p>{t("sideChatIntro")}</p>
        )}
      </div>
      <div
        ref={logRef}
        className="side-conversation-messages"
        onScroll={() => {
          const el = logRef.current;
          if (el)
            follow.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {conversation?.messages.map((message) => (
          <article
            key={message.id}
            className={`side-conversation-message side-conversation-message--${message.role}`}
          >
            <span className="side-conversation-role">
              {t(message.role === "user" ? "sideChatYou" : "sideChatAssistant")}
            </span>
            <TextBlock text={message.text} augmentHtml={message.html} />
            {message.attachments && message.attachments.length > 0 && (
              <ul className="side-conversation-attachments">
                {message.attachments.map((attachment, index) => (
                  <li key={`${attachment.name}-${index}`}>{attachment.name}</li>
                ))}
              </ul>
            )}
            {message.role === "assistant" && message.text && !running && (
              <button
                className="side-conversation-handoff"
                type="button"
                onClick={() => onBringBack(message.text)}
              >
                {t("sideChatBringBack")}
              </button>
            )}
          </article>
        ))}
        {running && (
          <p className="side-conversation-status" role="status">
            {conversation.activity
              ? t("sideChatReading", { tool: conversation.activity })
              : t(
                  conversation.status === "stopping"
                    ? "sideChatStopping"
                    : "sideChatThinking",
                )}
          </p>
        )}
        {(error || conversation?.error) && (
          <p className="side-conversation-error" role="alert">
            {error || conversation?.error}
          </p>
        )}
        {ended && <p>{t("sideChatEnded")}</p>}
      </div>
      <form
        className="side-conversation-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {!conversation && (
          <label className="side-conversation-setting">
            {t("sideChatContextLabel")}
            <select
              value={context}
              onChange={(event) =>
                setContext(event.target.value as "snapshot" | "empty")
              }
              disabled={busy}
            >
              <option value="snapshot">{t("sideChatCurrentContext")}</option>
              <option value="empty">{t("sideChatEmptyContext")}</option>
            </select>
          </label>
        )}
        <ComposerEditor
          composer={composer}
          containerClassName="side-conversation-editor"
          placeholder={t("sideChatInput")}
          disabled={ended}
          rows={3}
        />
        {tooLong && (
          <p className="side-conversation-availability" role="alert">
            {t("sideChatTooLong", { max: SIDE_CONVERSATION_MAX_PROMPT })}
          </p>
        )}
        {!canSend && (
          <p
            id="side-conversation-availability"
            className="side-conversation-availability"
            role="status"
          >
            {t(availabilityLabel)}
          </p>
        )}
        <ComposerToolbar
          variant="session"
          className="side-conversation-toolbar"
          attach={
            side.capabilities.images
              ? {
                  onClick: composer.openFilePicker,
                  disabled: !canAttachImages,
                  title: canAttachImages
                    ? t("sideChatAttachImages")
                    : t("sideChatAttachUnsupported"),
                  count: uploads.attachments.length,
                }
              : null
          }
          copy={{
            onCopy: composer.document.copyAll,
            disabled: !draft.trim() && uploads.composerAttachments.length === 0,
          }}
          voice={{ ...composer.voice, disabled: ended }}
          actionsClassName="side-conversation-actions"
          actions={
            <>
              {conversation && (
                <button
                  type="button"
                  disabled={busy || running}
                  onClick={() => {
                    if (ended) void side.startNew(context);
                    else void side.close();
                  }}
                >
                  {t(ended ? "sideChatNew" : "sideChatEnd")}
                </button>
              )}
              {running ? (
                <button
                  type="button"
                  disabled={busy || conversation.status === "stopping"}
                  onClick={() => {
                    void side.interrupt();
                  }}
                >
                  {t("sideChatStop")}
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={
                    busy ||
                    !canSend ||
                    ended ||
                    tooLong ||
                    uploads.hasPendingUploads ||
                    !draft.trim()
                  }
                >
                  {t(busy ? "sideChatStarting" : "sideChatSend")}
                </button>
              )}
            </>
          }
        />
      </form>
    </aside>
  );
}
