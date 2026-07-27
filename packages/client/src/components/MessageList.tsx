import { useVirtualizer } from "@tanstack/react-virtual";
import type { MarkdownAugment } from "@yep-anywhere/shared";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ActiveToolApproval,
  isPlanProgressItem,
  preprocessMessages,
} from "../lib/preprocessMessages";
import type { Message } from "../types";
import type { RenderItem } from "../types/renderItems";
import { getMessageId } from "../utils";
import { MessageActions } from "./MessageActions";
import { ProcessingIndicator } from "./ProcessingIndicator";
import { RenderItemComponent } from "./RenderItemComponent";
import {
  type DeferredMessage,
  type MessageRow,
  type PendingMessage,
  buildMessageRows,
  getBranchId,
  getRowKey,
} from "./messageRows";

/**
 * Above this many rows, mount only a windowed slice of the list.
 * Short sessions (the overwhelming majority) stay on the plain, fully-rendered
 * path so their scroll/anchor behavior is byte-for-byte identical to before.
 */
const VIRTUALIZE_ROW_THRESHOLD = 80;
/** Rough per-row height guess used before a row has been measured. */
const ESTIMATED_ROW_HEIGHT = 320;

interface Props {
  messages: Message[];
  /** Preprocessed items shared with parent computations. Falls back to messages. */
  preprocessedItems?: RenderItem[];
  provider?: string;
  isStreaming?: boolean;
  isProcessing?: boolean;
  /** Latest event received for the active session. */
  lastActivityAt?: string | null;
  /** True when context is being compressed */
  isCompacting?: boolean;
  /** Increment this to force scroll to bottom (e.g., when user sends a message) */
  scrollTrigger?: number;
  /** Messages waiting for server confirmation (shown as "Sending...") */
  pendingMessages?: PendingMessage[];
  /** Deferred messages queued server-side (shown as "Queued") */
  deferredMessages?: DeferredMessage[];
  /** Callback to cancel a deferred message */
  onCancelDeferred?: (tempId: string) => void;
  /** Pre-rendered markdown HTML from server (keyed by message ID) */
  markdownAugments?: Record<string, MarkdownAugment>;
  /** Active tool approval - prevents matching orphaned tool from showing as interrupted */
  activeToolApproval?: ActiveToolApproval;
  /** Whether there are older messages not yet loaded */
  hasOlderMessages?: boolean;
  /** Whether there are newer messages not yet loaded */
  hasNewerMessages?: boolean;
  /** Whether older messages are currently being loaded */
  loadingOlder?: boolean;
  /** Whether newer messages are currently being loaded */
  loadingNewer?: boolean;
  /** Whether a target-message window is currently being loaded */
  loadingTargetMessage?: boolean;
  /** Callback to load the next chunk of older messages */
  onLoadOlderMessages?: () => void;
  /** Callback to load the next chunk of newer messages */
  onLoadNewerMessages?: () => void;
  /** Callback to load a bounded window around a target message */
  onLoadTargetMessage?: (messageId: string) => Promise<boolean> | boolean;
  /** Reports whether user scrolling is following the live transcript tail. */
  onFollowingBottomChange?: (followingBottom: boolean) => void;
  /** Edit/rewind a past user prompt (forks the session from that point) */
  onEditUserPrompt?: (args: {
    text: string;
    uuid: string;
    parentUuid: string | null;
  }) => void;
  /** Switch the rendered derived branch. */
  onSelectBranch?: (branchId: string) => void;
  /** Branch prompt to bring back into view after switching. */
  focusBranchId?: string | null;
  /** Called after the selected branch prompt has been focused. */
  onBranchFocused?: () => void;
  /** Message id to scroll to and highlight (e.g. from a search deep-link). */
  targetMessageId?: string | null;
  /** Called after the target message has been focused. */
  onTargetFocused?: () => void;
}

export const MessageList = memo(function MessageList({
  messages,
  preprocessedItems,
  provider,
  isStreaming = false,
  isProcessing = false,
  lastActivityAt = null,
  isCompacting = false,
  scrollTrigger = 0,
  pendingMessages = [],
  deferredMessages = [],
  onCancelDeferred,
  markdownAugments,
  activeToolApproval,
  hasOlderMessages = false,
  hasNewerMessages = false,
  loadingOlder = false,
  loadingNewer = false,
  loadingTargetMessage = false,
  onLoadOlderMessages,
  onLoadNewerMessages,
  onLoadTargetMessage,
  onFollowingBottomChange,
  onEditUserPrompt,
  onSelectBranch,
  focusBranchId,
  onBranchFocused,
  targetMessageId,
  onTargetFocused,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const focusedBranchRef = useRef<HTMLDivElement | null>(null);
  const targetMessageRef = useRef<HTMLDivElement | null>(null);
  const requestedTargetMessageRef = useRef<string | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const onFollowingBottomChangeRef = useRef(onFollowingBottomChange);
  onFollowingBottomChangeRef.current = onFollowingBottomChange;
  const isInitialLoadRef = useRef(true);
  const isProgrammaticScrollRef = useRef(false);
  const lastHeightRef = useRef(0);
  const followUpScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Virtualization plumbing. scrollToBottom binds once (deps []) so it reads the
  // live virtualizer + row count through refs instead of closing over them.
  const virtualizerRef = useRef<ReturnType<
    typeof useVirtualizer<HTMLElement, Element>
  > | null>(null);
  const virtualizeEnabledRef = useRef(false);
  const rowCountRef = useRef(0);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  const setFollowingBottom = useCallback((followingBottom: boolean) => {
    if (shouldAutoScrollRef.current === followingBottom) return;
    shouldAutoScrollRef.current = followingBottom;
    onFollowingBottomChangeRef.current?.(followingBottom);
  }, []);

  // Scroll to bottom, marking it as programmatic so scroll handler ignores it
  const scrollToBottom = useCallback((container: HTMLElement) => {
    // In virtualized mode the true bottom may not be measured yet, so defer to
    // the virtualizer which re-measures and converges on the last row.
    const scrollToLastRow = () => {
      const virtualizer = virtualizerRef.current;
      const lastIndex = rowCountRef.current - 1;
      if (virtualizer && lastIndex >= 0) {
        virtualizer.scrollToIndex(lastIndex, { align: "end" });
      } else {
        container.scrollTop = container.scrollHeight - container.clientHeight;
      }
    };

    isProgrammaticScrollRef.current = true;
    if (virtualizeEnabledRef.current) {
      scrollToLastRow();
    } else {
      container.scrollTop = container.scrollHeight - container.clientHeight;
    }
    lastHeightRef.current = container.scrollHeight;

    // Clear programmatic flag after scroll events have fired
    requestAnimationFrame(() => {
      isProgrammaticScrollRef.current = false;
    });

    // Schedule a follow-up scroll to catch any async rendering (markdown, syntax highlighting)
    if (followUpScrollRef.current !== null) {
      clearTimeout(followUpScrollRef.current);
    }
    followUpScrollRef.current = setTimeout(() => {
      followUpScrollRef.current = null;
      if (shouldAutoScrollRef.current) {
        isProgrammaticScrollRef.current = true;
        if (virtualizeEnabledRef.current) {
          scrollToLastRow();
        } else {
          container.scrollTop = container.scrollHeight - container.clientHeight;
        }
        lastHeightRef.current = container.scrollHeight;
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
      }
    }, 50);
  }, []);

  // Preprocess messages into render items and group into turns
  const renderItems = useMemo(
    () =>
      preprocessedItems ??
      preprocessMessages(messages, {
        markdown: markdownAugments,
        activeToolApproval,
      }),
    [preprocessedItems, messages, markdownAugments, activeToolApproval],
  );
  const visibleRenderItems = useMemo(
    () => renderItems.filter((item) => !isPlanProgressItem(item)),
    [renderItems],
  );
  const focusedBranchItemId = useMemo(() => {
    if (!focusBranchId) return null;
    return (
      visibleRenderItems.find((item) => getBranchId(item) === focusBranchId)
        ?.id ?? null
    );
  }, [focusBranchId, visibleRenderItems]);

  // Render item that contains the deep-link target message (search results).
  const targetItemId = useMemo(() => {
    if (!targetMessageId) return null;
    return (
      visibleRenderItems.find((item) =>
        item.sourceMessages.some((m) => getMessageId(m) === targetMessageId),
      )?.id ?? null
    );
  }, [targetMessageId, visibleRenderItems]);

  // Flatten everything (turns + header/footer blocks) into one row model so the
  // list can be rendered — and later virtualized — as a single sequence.
  const rows = useMemo(
    () =>
      buildMessageRows({
        items: visibleRenderItems,
        hasOlderMessages,
        hasNewerMessages,
        pendingMessages,
        deferredMessages,
        isCompacting,
        focusedBranchItemId,
        targetItemId,
      }),
    [
      visibleRenderItems,
      hasOlderMessages,
      hasNewerMessages,
      pendingMessages,
      deferredMessages,
      isCompacting,
      focusedBranchItemId,
      targetItemId,
    ],
  );

  // Only the assistant turn at the live transcript tail belongs to the
  // currently running request. A pending/user row at the tail means the new
  // turn has not produced an assistant update yet, so the previous answer must
  // keep its original timestamp.
  const activeAssistantTurnKey = useMemo(() => {
    if (!isProcessing || hasNewerMessages) return null;

    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (!row) continue;
      if (row.kind === "assistant-turn") return row.key;
      if (row.kind === "user-prompt" || row.kind === "pending") return null;
    }

    return null;
  }, [hasNewerMessages, isProcessing, rows]);

  // Only window long lists, and never while a branch/target focus is pending —
  // those flows scroll to and highlight a specific DOM node, which must be
  // mounted. Both flags are transient (cleared by onBranchFocused /
  // onTargetFocused), so virtualization re-engages right after.
  const shouldVirtualize =
    rows.length > VIRTUALIZE_ROW_THRESHOLD &&
    !focusBranchId &&
    !targetMessageId;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => containerRef.current?.parentElement ?? null,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 6,
    // Stable per-row keys keep measured heights when rows are prepended
    // (load-older), so the scroll-anchor delta stays accurate.
    getItemKey: (index) => getRowKey(rows[index] as MessageRow),
    enabled: shouldVirtualize,
  });
  virtualizerRef.current = virtualizer;
  virtualizeEnabledRef.current = shouldVirtualize;
  rowCountRef.current = rows.length;

  const toggleThinkingExpanded = useCallback(() => {
    setThinkingExpanded((prev) => !prev);
  }, []);

  // Load older messages with scroll position preservation
  const handleLoadOlder = useCallback(() => {
    if (!onLoadOlderMessages) return;
    const container = containerRef.current?.parentElement;
    if (!container) {
      onLoadOlderMessages();
      return;
    }
    // Capture scroll state before prepending older messages
    const scrollHeightBefore = container.scrollHeight;
    const scrollTopBefore = container.scrollTop;
    onLoadOlderMessages();
    // Restore scroll position after React re-renders with prepended messages
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scrollHeightAfter = container.scrollHeight;
        const heightDelta = scrollHeightAfter - scrollHeightBefore;
        isProgrammaticScrollRef.current = true;
        container.scrollTop = scrollTopBefore + heightDelta;
        lastHeightRef.current = container.scrollHeight;
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
      });
    });
  }, [onLoadOlderMessages]);

  const handleLoadNewer = useCallback(() => {
    onLoadNewerMessages?.();
  }, [onLoadNewerMessages]);

  // Mirror the auto-load state into a ref so handleScroll (which only binds
  // once for the lifetime of the listener) can read the latest values without
  // re-attaching the listener on every prop change.
  const loadOlderStateRef = useRef({
    hasOlderMessages,
    loadingOlder,
    loadOlder: handleLoadOlder,
  });
  loadOlderStateRef.current = {
    hasOlderMessages,
    loadingOlder,
    loadOlder: handleLoadOlder,
  };

  // Track scroll position to determine if user is near bottom.
  // Ignore programmatic scrolls - only user-initiated scrolls should affect auto-scroll state.
  // Also auto-trigger "load older" when the user nears the top of the
  // scrollable area — gives WhatsApp/Telegram-style infinite scroll instead
  // of forcing them to hunt for a button on a long, slow-loading session.
  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;

    const container = containerRef.current?.parentElement;
    if (!container) return;

    const threshold = 100; // pixels from bottom
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    setFollowingBottom(distanceFromBottom < threshold);

    // Top-of-list auto-load. handleLoadOlder anchors scroll position via the
    // pre-/post-render scrollHeight delta, so the user's view stays put — no
    // visible "jump" when the prepended chunk lands.
    const TOP_LOAD_THRESHOLD = 200;
    const {
      hasOlderMessages: hasOlder,
      loadingOlder: loading,
      loadOlder,
    } = loadOlderStateRef.current;
    if (
      hasOlder &&
      !loading &&
      loadOlder &&
      container.scrollTop < TOP_LOAD_THRESHOLD
    ) {
      loadOlder();
    }
  }, [setFollowingBottom]);

  // Attach scroll listener to parent container
  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;

    container.addEventListener("scroll", handleScroll);

    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [handleScroll]);

  // Use ResizeObserver to detect content height changes (handles async markdown rendering)
  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;

    const scrollContainer = container;
    lastHeightRef.current = scrollContainer.scrollHeight;

    const resizeObserver = new ResizeObserver(() => {
      const newHeight = scrollContainer.scrollHeight;
      const heightIncreased = newHeight > lastHeightRef.current;

      // Auto-scroll when content height increases and auto-scroll is enabled
      if (heightIncreased && shouldAutoScrollRef.current) {
        scrollToBottom(scrollContainer);
      } else {
        // Update height tracking even when not scrolling
        lastHeightRef.current = newHeight;
      }
    });

    // Observe the inner container (message-list) since that's what changes size
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
      // Clean up any pending scroll on unmount
      if (followUpScrollRef.current !== null) {
        clearTimeout(followUpScrollRef.current);
      }
    };
  }, [scrollToBottom]);

  // Force scroll to bottom when scrollTrigger changes (user sent a message)
  useEffect(() => {
    if (scrollTrigger > 0) {
      setFollowingBottom(true);
      const container = containerRef.current?.parentElement;
      if (container) {
        scrollToBottom(container);
      }
    }
  }, [scrollTrigger, scrollToBottom, setFollowingBottom]);

  // Initial scroll to bottom on first render
  useEffect(() => {
    if (isInitialLoadRef.current && renderItems.length > 0) {
      const container = containerRef.current?.parentElement;
      if (container) {
        scrollToBottom(container);
      }
      isInitialLoadRef.current = false;
    }
  }, [renderItems.length, scrollToBottom]);

  useEffect(() => {
    if (!focusBranchId || !focusedBranchItemId) return;
    const target = focusedBranchRef.current;
    const container = containerRef.current?.parentElement;
    if (!target || !container) return;

    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      isProgrammaticScrollRef.current = true;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.focus({ preventScroll: true });
      lastHeightRef.current = container.scrollHeight;
      requestAnimationFrame(() => {
        isProgrammaticScrollRef.current = false;
      });
      onBranchFocused?.();
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [focusBranchId, focusedBranchItemId, onBranchFocused]);

  // Scroll to + highlight a deep-linked target message (e.g. search result).
  // If it is not in the current window, ask the server for a bounded window
  // centered on that exact message. This avoids blind repeated pagination.
  useEffect(() => {
    if (!targetMessageId) {
      requestedTargetMessageRef.current = null;
      return;
    }

    // Found in the current window — scroll and highlight it.
    if (targetItemId) {
      requestedTargetMessageRef.current = null;
      const target = targetMessageRef.current;
      const container = containerRef.current?.parentElement;
      if (!target || !container) return;

      let cancelled = false;
      const raf = requestAnimationFrame(() => {
        if (cancelled) return;
        isProgrammaticScrollRef.current = true;
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        lastHeightRef.current = container.scrollHeight;
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
        // Self-clearing highlight: the CSS animation removes itself on end, so
        // it survives the re-render triggered by onTargetFocused() below.
        target.classList.remove("message-target-highlight");
        target.addEventListener(
          "animationend",
          () => target.classList.remove("message-target-highlight"),
          { once: true },
        );
        // Force reflow so re-adding the class restarts the animation.
        void target.offsetWidth;
        target.classList.add("message-target-highlight");
        onTargetFocused?.();
      });

      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
      };
    }

    if (
      onLoadTargetMessage &&
      !loadingTargetMessage &&
      requestedTargetMessageRef.current !== targetMessageId
    ) {
      requestedTargetMessageRef.current = targetMessageId;
      let cancelled = false;

      void Promise.resolve(onLoadTargetMessage(targetMessageId)).then(
        (found) => {
          if (cancelled) return;
          if (!found && requestedTargetMessageRef.current === targetMessageId) {
            requestedTargetMessageRef.current = null;
            onTargetFocused?.();
          }
        },
      );

      return () => {
        cancelled = true;
      };
    }
  }, [
    targetMessageId,
    targetItemId,
    loadingTargetMessage,
    onLoadTargetMessage,
    onTargetFocused,
  ]);

  const renderRow = (row: MessageRow) => {
    switch (row.kind) {
      case "load-older":
        return (
          <div className="load-older-messages">
            <button
              type="button"
              className="load-older-button"
              onClick={handleLoadOlder}
              disabled={loadingOlder}
            >
              {loadingOlder ? (
                <>
                  <span className="spinning">&#x21BB;</span> Loading...
                </>
              ) : (
                "Load older messages"
              )}
            </button>
          </div>
        );
      case "user-prompt": {
        // User prompts render directly without timeline wrapper
        const { item, shouldFocusBranch, isTarget } = row;
        const renderedItem = (
          <RenderItemComponent
            item={item}
            isStreaming={isStreaming}
            thinkingExpanded={thinkingExpanded}
            toggleThinkingExpanded={toggleThinkingExpanded}
            sessionProvider={provider}
            onEditUserPrompt={onEditUserPrompt}
            onSelectBranch={onSelectBranch}
          />
        );
        if (!shouldFocusBranch && !isTarget) return renderedItem;
        return (
          <div
            ref={(node) => {
              if (shouldFocusBranch) focusedBranchRef.current = node;
              if (isTarget) targetMessageRef.current = node;
            }}
            className={
              shouldFocusBranch ? "codex-branch-focus-target" : undefined
            }
            tabIndex={shouldFocusBranch ? -1 : undefined}
          >
            {renderedItem}
          </div>
        );
      }
      case "assistant-turn": {
        // Assistant items wrapped in timeline container
        const isActiveAssistantTurn = row.key === activeAssistantTurnKey;
        return (
          <div
            className="assistant-turn"
            ref={row.turnHasTarget ? targetMessageRef : undefined}
          >
            {row.items.map((item) => (
              <RenderItemComponent
                key={item.id}
                item={item}
                isStreaming={isStreaming}
                thinkingExpanded={thinkingExpanded}
                toggleThinkingExpanded={toggleThinkingExpanded}
                sessionProvider={provider}
                onSelectBranch={onSelectBranch}
              />
            ))}
            <MessageActions
              timestamp={
                isActiveAssistantTurn
                  ? getLatestTimestamp(
                      row.turnTimestamp,
                      row.turnUpdatedAt,
                      lastActivityAt,
                    )
                  : row.turnTimestamp
              }
              timestampIsLastUpdate={isActiveAssistantTurn}
              copyText={row.turnCopyText}
            />
          </div>
        );
      }
      case "load-newer":
        return (
          <div className="load-older-messages">
            <button
              type="button"
              className="load-older-button"
              onClick={handleLoadNewer}
              disabled={loadingNewer}
            >
              {loadingNewer ? (
                <>
                  <span className="spinning">&#x21BB;</span> Loading...
                </>
              ) : (
                "Load newer messages"
              )}
            </button>
          </div>
        );
      case "pending":
        // Shown as "Uploading..." or "Sending..." until server confirms
        return (
          <div className="pending-message">
            <div className="message-user-prompt pending-message-bubble">
              {row.pending.content}
            </div>
            <div className="pending-message-status">
              {row.pending.status || "Sending..."}
            </div>
          </div>
        );
      case "deferred":
        // Queued server-side, waiting for agent turn to end
        return (
          <div className="deferred-message">
            <div className="message-user-prompt deferred-message-bubble">
              {row.deferred.content}
            </div>
            <div className="deferred-message-footer">
              <span className="deferred-message-status">
                {row.index === 0
                  ? "Queued (next)"
                  : `Queued (#${row.index + 1})`}
              </span>
              {row.deferred.tempId && onCancelDeferred && (
                <button
                  type="button"
                  className="deferred-message-cancel"
                  onClick={() =>
                    onCancelDeferred(row.deferred.tempId as string)
                  }
                  aria-label="Cancel queued message"
                >
                  ×
                </button>
              )}
            </div>
          </div>
        );
      case "compacting":
        // Shown when context is being compressed
        return (
          <div className="system-message system-message-compacting">
            <span className="system-message-icon spinning">⟳</span>
            <span className="system-message-text">Compacting context...</span>
          </div>
        );
      case "processing":
        return <ProcessingIndicator isProcessing={isProcessing} />;
    }
  };

  if (shouldVirtualize) {
    const virtualItems = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();
    const firstItem = virtualItems[0];
    const lastItem = virtualItems[virtualItems.length - 1];
    const paddingTop = firstItem ? firstItem.start : 0;
    const paddingBottom = lastItem ? totalSize - lastItem.end : 0;
    return (
      <div className="message-list" ref={containerRef}>
        {paddingTop > 0 && <div style={{ height: paddingTop }} aria-hidden />}
        {virtualItems.map((vItem) => {
          const row = rows[vItem.index];
          if (!row) return null;
          return (
            <div
              key={vItem.key}
              data-index={vItem.index}
              ref={virtualizer.measureElement}
            >
              {renderRow(row)}
            </div>
          );
        })}
        {paddingBottom > 0 && (
          <div style={{ height: paddingBottom }} aria-hidden />
        )}
      </div>
    );
  }

  return (
    <div className="message-list" ref={containerRef}>
      {rows.map((row) => (
        <Fragment key={getRowKey(row)}>{renderRow(row)}</Fragment>
      ))}
    </div>
  );
});

function getLatestTimestamp(
  ...timestamps: Array<string | null | undefined>
): string | undefined {
  let latestTimestamp: string | undefined;
  let latestTimestampMs = Number.NEGATIVE_INFINITY;

  for (const timestamp of timestamps) {
    if (!timestamp) continue;
    const timestampMs = Date.parse(timestamp);
    if (Number.isNaN(timestampMs) || timestampMs <= latestTimestampMs) continue;
    latestTimestamp = timestamp;
    latestTimestampMs = timestampMs;
  }

  return latestTimestamp;
}
