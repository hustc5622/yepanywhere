import { useVirtualizer } from "@tanstack/react-virtual";
import type { MarkdownAugment } from "@yep-anywhere/shared";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOptionalI18n } from "../i18n";
import { hasActiveTextSelectionWithin } from "../lib/clipboard";
import {
  type ActiveToolApproval,
  isSessionInspectorOnlyItem,
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
  createStickyTurnKeyResolver,
  getBranchId,
  getRowKey,
  pruneTurnKeyRegistry,
} from "./messageRows";

/**
 * Above this many rows, mount only a windowed slice of the list.
 * Short sessions (the overwhelming majority) stay on the plain, fully-rendered
 * path so their scroll/anchor behavior is byte-for-byte identical to before.
 */
const VIRTUALIZE_ROW_THRESHOLD = 80;
/** Rough per-row height guess used before a row has been measured. */
const ESTIMATED_ROW_HEIGHT = 320;
/** Distance from the top of the scroller that auto-loads the previous chunk. */
const TOP_LOAD_THRESHOLD = 200;
/**
 * Height growth that counts as "the prepended chunk landed". Sub-pixel and
 * one-pixel reflows happen constantly (timestamps, spinners) and must not
 * consume the reading-position anchor.
 */
const PREPEND_MIN_HEIGHT_GROWTH = 8;

/**
 * Topmost row that is still (partly) in view, used as the anchor when older
 * rows are prepended above it. The load-older row is skipped: it stays above
 * every prepended row, so it never moves and would measure a zero delta.
 */
function findTopmostVisibleRow(
  list: HTMLElement,
  scrollTop: number,
): HTMLElement | null {
  for (const child of Array.from(list.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (
      child.classList.contains("load-older-messages") ||
      child.querySelector(".load-older-messages")
    ) {
      continue;
    }
    if (child.offsetTop + child.offsetHeight > scrollTop) return child;
  }
  return null;
}

/**
 * Element to keep visually still while older messages are prepended.
 *
 * The deepest element at the top edge of the viewport is preferred: load-older
 * also prepends items *inside* the turn that sits at the top of the window, and
 * a row-level anchor cannot see that part of the inserted height (measured on a
 * real session: 1.2k of 21.7k prepended pixels landed inside the anchor row).
 */
function findPrependAnchorElement(
  list: HTMLElement,
  container: HTMLElement,
): HTMLElement | null {
  const viewport = container.getBoundingClientRect();
  if (viewport.width > 0 && viewport.height > 0) {
    // Probe below the load-older row: it is above every prepended row, so
    // anchoring on it would measure no movement at all (visible at scrollTop 0).
    const loadOlderRow = list.querySelector(".load-older-messages");
    const loadOlderBottom = loadOlderRow
      ? loadOlderRow.getBoundingClientRect().bottom
      : Number.NEGATIVE_INFINITY;
    const probeY = Math.round(
      Math.min(
        Math.max(viewport.top + 8, loadOlderBottom + 2),
        viewport.bottom - 8,
      ),
    );
    let deepestElement: HTMLElement | null = null;
    let deepestDepth = -1;
    // The gutter can hit an outer wrapper, so sample across the row width.
    for (const fraction of [0.5, 0.25, 0.75]) {
      try {
        const probe = document.elementFromPoint(
          Math.round(viewport.left + viewport.width * fraction),
          probeY,
        );
        // The list itself is never a usable anchor: its top edge does not move
        // when children are prepended, so it always measures a zero delta.
        if (!(probe instanceof HTMLElement) || probe === list) continue;
        if (!list.contains(probe)) continue;
        if (probe.closest(".load-older-messages")) continue;
        let depth = 0;
        for (
          let node: HTMLElement | null = probe;
          node && node !== list;
          node = node.parentElement
        ) {
          depth += 1;
        }
        if (depth > deepestDepth) {
          deepestElement = probe;
          deepestDepth = depth;
        }
      } catch {
        // elementFromPoint is not implemented in jsdom; fall back to rows.
        break;
      }
    }
    if (deepestElement) return deepestElement;
  }
  return findTopmostVisibleRow(list, container.scrollTop);
}

interface Props {
  messages: Message[];
  /** Preprocessed items shared with parent computations. Falls back to messages. */
  preprocessedItems?: RenderItem[];
  provider?: string;
  isStreaming?: boolean;
  isProcessing?: boolean;
  /** Latest stream or authoritative session activity timestamp. */
  lastActivityAt?: string | null;
  /**
   * Keep the latest assistant turn in last-update mode even when this page
   * does not own a running process. Provider-native child sessions use their
   * authoritative session updatedAt because their work runs inside the parent.
   */
  latestTurnUsesUpdateTime?: boolean;
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
  onLoadOlderMessages?: () => void | Promise<void>;
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
  /**
   * Identity of the rendered transcript (session + branch). Turn keys are
   * sticky per transcript, so this resets them when the route swaps sessions
   * without remounting the component.
   */
  transcriptKey?: string;
}

export const MessageList = memo(function MessageList({
  messages,
  preprocessedItems,
  provider,
  isStreaming = false,
  isProcessing = false,
  lastActivityAt = null,
  latestTurnUsesUpdateTime = false,
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
  transcriptKey,
}: Props) {
  const i18n = useOptionalI18n();
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
  // Sticky turn identity. A turn must keep its React key when older messages are
  // prepended, otherwise React unmounts the whole turn subtree and the browser
  // re-homes any in-progress text selection on the list container.
  const turnKeyRegistryRef = useRef<Map<string, string>>(new Map());
  const transcriptKeyRef = useRef<string | undefined>(transcriptKey);
  // Selection safety for auto-pagination.
  const isPointerSelectingRef = useRef(false);
  const pendingAutoLoadOlderRef = useRef(false);
  // Reading-position anchor captured when a load-older request is issued.
  const prependAnchorRef = useRef<{
    element: HTMLElement | null;
    rectTop: number;
    offsetTop: number;
    scrollTop: number;
    scrollHeight: number;
  } | null>(null);
  const [expandedThinkingItemIds, setExpandedThinkingItemIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  // Mirrors "the user currently has a selection inside the transcript", used to
  // keep row identity stable while they select and copy.
  const [hasActiveSelection, setHasActiveSelection] = useState(false);

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
    () => renderItems.filter((item) => !isSessionInspectorOnlyItem(item)),
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

  // Flatten everything (turns + header/footer blocks) into one flat row model so
  // the list can be rendered — and later virtualized — as a single sequence.
  //
  // Turn keys come from a sticky registry (item id → turn key) instead of the
  // window-relative `turn-<first item id>`: load-older prepends items into the
  // turn that sits at the top of the window, and a changed key would remount
  // that entire subtree (destroying selections and scroll anchors).
  const rows = useMemo(() => {
    const registry = turnKeyRegistryRef.current;
    if (transcriptKeyRef.current !== transcriptKey) {
      transcriptKeyRef.current = transcriptKey;
      registry.clear();
    }

    const resolveTurnKey = createStickyTurnKeyResolver(registry);
    const builtRows = buildMessageRows({
      items: visibleRenderItems,
      hasOlderMessages,
      hasNewerMessages,
      pendingMessages,
      deferredMessages,
      isCompacting,
      focusedBranchItemId,
      targetItemId,
      resolveTurnKey,
    });

    pruneTurnKeyRegistry(registry, visibleRenderItems);

    return builtRows;
  }, [
    visibleRenderItems,
    hasOlderMessages,
    hasNewerMessages,
    pendingMessages,
    deferredMessages,
    isCompacting,
    focusedBranchItemId,
    targetItemId,
    transcriptKey,
  ]);

  // Only the assistant turn at the transcript tail can use last-update
  // semantics. Normally that means the locally running request. A
  // provider-native child session can opt in after completion too because its
  // authoritative session updatedAt represents work performed inside the
  // parent process. A pending/user row at the tail means no assistant update
  // exists yet, so the previous answer must keep its original timestamp.
  const lastUpdatedAssistantTurnKey = useMemo(() => {
    if ((!isProcessing && !latestTurnUsesUpdateTime) || hasNewerMessages) {
      return null;
    }

    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (!row) continue;
      if (row.kind === "assistant-turn") return row.key;
      if (row.kind === "user-prompt" || row.kind === "pending") return null;
    }

    return null;
  }, [hasNewerMessages, isProcessing, latestTurnUsesUpdateTime, rows]);

  // Only window long lists, and never while a branch/target focus is pending —
  // those flows scroll to and highlight a specific DOM node, which must be
  // mounted. Both flags are transient (cleared by onBranchFocused /
  // onTargetFocused), so virtualization re-engages right after.
  const wantsVirtualization =
    rows.length > VIRTUALIZE_ROW_THRESHOLD &&
    !focusBranchId &&
    !targetMessageId;

  // Never flip virtualization on or off while the user holds a selection: either
  // direction remounts every row and destroys the range they are dragging, and
  // load-older can push a transcript over the threshold mid-selection.
  const shouldVirtualize = hasActiveSelection
    ? virtualizeEnabledRef.current
    : wantsVirtualization;

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

  const toggleThinkingExpanded = useCallback((itemId: string) => {
    setExpandedThinkingItemIds((previousIds) => {
      const nextIds = new Set(previousIds);
      if (nextIds.has(itemId)) {
        nextIds.delete(itemId);
      } else {
        nextIds.add(itemId);
      }
      return nextIds;
    });
  }, []);

  // Snapshot where the reading position currently is, so a prepend can restore
  // it. Re-measured whenever the user keeps scrolling during an in-flight
  // request, so the correction never fights the user's own scrolling.
  const capturePrependAnchor = useCallback(() => {
    const container = containerRef.current?.parentElement;
    const list = containerRef.current;
    if (!container || !list) return;
    const anchorElement = findPrependAnchorElement(list, container);
    prependAnchorRef.current = {
      element: anchorElement,
      rectTop: anchorElement?.getBoundingClientRect().top ?? 0,
      offsetTop: anchorElement?.offsetTop ?? 0,
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
    };
  }, []);

  // Load older messages, keeping the reading position stable.
  //
  // The request resolves asynchronously, so the correction can only run once the
  // prepended rows are committed (see the prepend anchor effect below). The
  // anchor records where an on-screen element sits; the correction then moves the
  // scroller by however far that element drifted. Being relative to the live
  // scroll position makes it a no-op when the browser's own scroll anchoring
  // already did the work (Chrome does, unless scrollTop is 0; WebKit never does).
  const handleLoadOlder = useCallback(() => {
    if (!onLoadOlderMessages) return;
    const container = containerRef.current?.parentElement;
    const list = containerRef.current;
    if (!container || !list) {
      onLoadOlderMessages();
      return;
    }
    capturePrependAnchor();
    const result = onLoadOlderMessages();
    if (!result || typeof result.then !== "function") return;
    void result.catch(() => {
      prependAnchorRef.current = null;
    });
  }, [capturePrependAnchor, onLoadOlderMessages]);

  // Apply the prepend correction in the commit that added the older rows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows is the commit trigger, not a read dependency
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor) return;
    const container = containerRef.current?.parentElement;
    if (!container) return;
    if (
      container.scrollHeight - anchor.scrollHeight <
      PREPEND_MIN_HEIGHT_GROWTH
    ) {
      // Nothing landed yet. A large chunk can take several frames (or seconds)
      // to render, so keep waiting while the request is in flight and only drop
      // the snapshot once it settled — otherwise later growth (streaming, late
      // images) would be mistaken for a prepend.
      if (!loadingOlder) prependAnchorRef.current = null;
      return;
    }
    prependAnchorRef.current = null;

    const anchorElement = anchor.element;
    const resolveScrollDelta = () => {
      if (anchorElement?.isConnected) {
        const rect = anchorElement.getBoundingClientRect();
        if (rect.height > 0 || rect.top !== 0) return rect.top - anchor.rectTop;
        // jsdom (and display:none) report empty rects: use layout bookkeeping.
        return (
          anchor.scrollTop +
          (anchorElement.offsetTop - anchor.offsetTop) -
          container.scrollTop
        );
      }
      return (
        anchor.scrollTop +
        (container.scrollHeight - anchor.scrollHeight) -
        container.scrollTop
      );
    };

    const scrollDelta = resolveScrollDelta();
    if (Math.abs(scrollDelta) <= 1) return;

    isProgrammaticScrollRef.current = true;
    container.scrollTop += scrollDelta;
    lastHeightRef.current = container.scrollHeight;
    requestAnimationFrame(() => {
      // Late layout (fonts, images) can still shift the anchor element.
      const followUpDelta = resolveScrollDelta();
      if (Math.abs(followUpDelta) > 1) container.scrollTop += followUpDelta;
      lastHeightRef.current = container.scrollHeight;
      isProgrammaticScrollRef.current = false;
    });
  }, [rows, loadingOlder]);

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

    // A load-older request may still be in flight. Re-anchor on what the user is
    // looking at *now*, so the correction preserves their latest position
    // instead of undoing the scrolling they did while waiting.
    if (prependAnchorRef.current) capturePrependAnchor();

    const threshold = 100; // pixels from bottom
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    setFollowingBottom(distanceFromBottom < threshold);

    // Top-of-list auto-load. handleLoadOlder anchors the reading position, so the
    // user's view stays put — no visible "jump" when the prepended chunk lands.
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
      // Prepending rows while the user is selecting text destroys the selection:
      // the turn that owns the range gains items, and any DOM churn makes the
      // browser re-anchor the range at the list container — the copy then
      // silently includes everything above. Defer the load instead.
      if (
        isPointerSelectingRef.current ||
        hasActiveTextSelectionWithin(container)
      ) {
        pendingAutoLoadOlderRef.current = true;
        return;
      }
      pendingAutoLoadOlderRef.current = false;
      loadOlder();
    }
  }, [capturePrependAnchor, setFollowingBottom]);

  // Retry a deferred auto-load once the selection is released/cleared.
  const flushPendingAutoLoadOlder = useCallback(() => {
    if (!pendingAutoLoadOlderRef.current) return;
    const container = containerRef.current?.parentElement;
    if (!container) return;
    if (
      isPointerSelectingRef.current ||
      hasActiveTextSelectionWithin(container)
    ) {
      return;
    }
    pendingAutoLoadOlderRef.current = false;
    if (container.scrollTop >= TOP_LOAD_THRESHOLD) return;
    const {
      hasOlderMessages: hasOlder,
      loadingOlder: loading,
      loadOlder,
    } = loadOlderStateRef.current;
    if (!hasOlder || loading || !loadOlder) return;
    loadOlder();
  }, []);

  // Track mouse/pen drags so auto-pagination can stay out of the way while a
  // selection is being made. Touch is excluded on purpose: a touch scroll always
  // holds a pointer down, so gating on it would disable mobile infinite scroll.
  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch" || event.button !== 0) return;
      isPointerSelectingRef.current = true;
    };
    const handlePointerRelease = () => {
      if (!isPointerSelectingRef.current) return;
      isPointerSelectingRef.current = false;
      flushPendingAutoLoadOlder();
    };

    const handleSelectionChange = () => {
      setHasActiveSelection(hasActiveTextSelectionWithin(container));
      flushPendingAutoLoadOlder();
    };

    container.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("pointerup", handlePointerRelease);
    document.addEventListener("pointercancel", handlePointerRelease);
    document.addEventListener("selectionchange", handleSelectionChange);

    return () => {
      container.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("pointerup", handlePointerRelease);
      document.removeEventListener("pointercancel", handlePointerRelease);
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [flushPendingAutoLoadOlder]);

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
            thinkingExpanded={expandedThinkingItemIds.has(item.id)}
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
        const usesLastUpdateTimestamp = row.key === lastUpdatedAssistantTurnKey;
        return (
          <div
            className={`assistant-turn${row.resumedAfterQuestion ? " assistant-turn-resumed" : ""}`}
            ref={row.turnHasTarget ? targetMessageRef : undefined}
          >
            {row.resumedAfterQuestion && (
              <div className="assistant-turn-resume-boundary">
                <span aria-hidden="true">↳</span>
                <span>
                  {i18n?.t("messageContinuedAfterAnswer") ??
                    "Continued after your answer"}
                </span>
              </div>
            )}
            {row.items.map((item) => {
              const renderedItem =
                item.type === "text" &&
                item.phase === undefined &&
                row.progressTextItemIds.includes(item.id)
                  ? { ...item, phase: "commentary" as const }
                  : item;
              return (
                <RenderItemComponent
                  key={item.id}
                  item={renderedItem}
                  isStreaming={isStreaming}
                  thinkingExpanded={expandedThinkingItemIds.has(item.id)}
                  toggleThinkingExpanded={toggleThinkingExpanded}
                  sessionProvider={provider}
                  onSelectBranch={onSelectBranch}
                />
              );
            })}
            <MessageActions
              timestamp={
                usesLastUpdateTimestamp
                  ? getLatestTimestamp(
                      row.turnTimestamp,
                      row.turnUpdatedAt,
                      lastActivityAt,
                    )
                  : row.turnTimestamp
              }
              timestampIsLastUpdate={usesLastUpdateTimestamp}
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
