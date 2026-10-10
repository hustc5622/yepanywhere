import { useEffect, useRef, useState } from "react";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import type { useSideConversation } from "../hooks/useSideConversation";
import { useI18n } from "../i18n";
import { getCurrentInstallId } from "../lib/storageKeys";
import { TextBlock } from "./blocks/TextBlock";
import "../styles/side-conversation.css";

export function SideConversationPanel({
  side,
  sessionId,
  parentStatus,
  visible,
  mobile,
  onClose,
  onBringBack,
}: {
  side: ReturnType<typeof useSideConversation>;
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const running =
    conversation?.status === "running" || conversation?.status === "stopping";
  const ended = conversation?.status === "closed";
  useEffect(() => {
    if (!visible) return;
    const previous = document.activeElement;
    inputRef.current?.focus();
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
    const text = draft.trim();
    if (!text || busy || running || ended) return;
    // Flush/record the submitted draft before creation changes the side ID.
    controls.clearInput();
    if (await side.send(text, context)) {
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* Storage may be unavailable. */
      }
      if (!controls.getText?.()) controls.clearDraft();
    } else if (!controls.getText?.()) controls.setText(text);
  };
  return (
    <aside
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
        {!side.supported && <p>{t("sideChatUnavailable")}</p>}
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
        <textarea
          ref={inputRef}
          aria-label={t("sideChatInput")}
          placeholder={t("sideChatInput")}
          value={draft}
          maxLength={32000}
          rows={3}
          disabled={!side.supported || ended}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="side-conversation-actions">
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
              disabled={busy || !side.supported || ended || !draft.trim()}
            >
              {t(busy ? "sideChatStarting" : "sideChatSend")}
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}
