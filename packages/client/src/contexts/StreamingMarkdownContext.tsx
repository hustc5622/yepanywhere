import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useRef,
} from "react";
import type { AugmentEvent, PendingEvent } from "../hooks/useStreamingMarkdown";

/**
 * Handler callbacks for the streaming text block
 */
interface StreamingHandlers {
  onAugment: (augment: AugmentEvent) => void;
  onPending: (pending: PendingEvent) => void;
  onStreamEnd: () => void;
  /** Capture the current streaming HTML (for persisting when stream completes) */
  captureHtml?: () => string | null;
}

/**
 * Context value for streaming markdown events
 */
interface StreamingMarkdownContextValue {
  /**
   * Register as the current streaming text block handler.
   * Handlers are scoped to a message so subagent prose cannot steal main output.
   * Returns an unregister function.
   */
  registerStreamingHandler: (
    handlers: StreamingHandlers,
    messageId?: string,
  ) => () => void;

  /**
   * Dispatch an augment event to the current streaming handler.
   */
  dispatchAugment: (augment: AugmentEvent) => void;

  /**
   * Dispatch a pending text event to the current streaming handler.
   */
  dispatchPending: (pending: PendingEvent) => void;

  /**
   * Signal that streaming has ended.
   */
  dispatchStreamEnd: () => void;

  /**
   * Set the current streaming message ID.
   * Called when message_start event is received.
   * (Used for internal tracking, not for registration)
   */
  setCurrentMessageId: (messageId: string | null) => void;

  /**
   * Capture the current streaming HTML from the registered handler.
   * Used to persist the streaming content when the final message arrives.
   * Returns null if no handler is registered or capture fails.
   */
  captureStreamingHtml: () => string | null;
}

const StreamingMarkdownContext =
  createContext<StreamingMarkdownContextValue | null>(null);

interface StreamingMarkdownProviderProps {
  children: ReactNode;
}

/**
 * Provider for streaming markdown events.
 *
 * This context acts as an event bus between SSE events and TextBlock components.
 * When augment/pending events arrive from SSE, they're dispatched to the
 * registered streaming handler (the currently streaming TextBlock).
 */
export function StreamingMarkdownProvider({
  children,
}: StreamingMarkdownProviderProps) {
  const handlersRef = useRef(new Map<string, StreamingHandlers>());

  // Main stream identity for pending/end events that do not carry a message ID.
  const currentMessageIdRef = useRef<string | null>(null);
  const captureMessageIdRef = useRef<string | null>(null);

  const registerStreamingHandler = useCallback(
    (handlers: StreamingHandlers, messageId = ""): (() => void) => {
      if (
        typeof window !== "undefined" &&
        (window as unknown as { __STREAMING_DEBUG__?: boolean })
          .__STREAMING_DEBUG__
      ) {
        console.log("%c[CONTEXT] Handler registered", "color: #2196F3", {
          hadPreviousHandler: handlersRef.current.has(messageId),
        });
      }
      handlersRef.current.set(messageId, handlers);
      return () => {
        // Only unregister if this is still the current handler
        if (handlersRef.current.get(messageId) === handlers) {
          if (
            typeof window !== "undefined" &&
            (window as unknown as { __STREAMING_DEBUG__?: boolean })
              .__STREAMING_DEBUG__
          ) {
            console.log("%c[CONTEXT] Handler unregistered", "color: #FF5722");
          }
          handlersRef.current.delete(messageId);
        }
      };
    },
    [],
  );

  const setCurrentMessageId = useCallback((messageId: string | null) => {
    currentMessageIdRef.current = messageId;
    if (messageId) captureMessageIdRef.current = messageId;
  }, []);

  const dispatchAugment = useCallback((augment: AugmentEvent) => {
    if (
      typeof window !== "undefined" &&
      (window as unknown as { __STREAMING_DEBUG__?: boolean })
        .__STREAMING_DEBUG__
    ) {
      console.log("%c[CONTEXT] dispatchAugment called", "color: #4CAF50", {
        hasHandler: !!handlersRef.current,
        augment: { blockIndex: augment.blockIndex, type: augment.type },
      });
    }
    const id = augment.messageId ?? currentMessageIdRef.current ?? "";
    (handlersRef.current.get(id) ?? handlersRef.current.get(""))?.onAugment(
      augment,
    );
  }, []);

  const dispatchPending = useCallback((pending: PendingEvent) => {
    if (
      typeof window !== "undefined" &&
      (window as unknown as { __STREAMING_DEBUG__?: boolean })
        .__STREAMING_DEBUG__
    ) {
      console.log("%c[CONTEXT] dispatchPending called", "color: #FF9800", {
        hasHandler: !!handlersRef.current,
        htmlLength: pending.html.length,
      });
    }
    const id = pending.messageId ?? currentMessageIdRef.current ?? "";
    (handlersRef.current.get(id) ?? handlersRef.current.get(""))?.onPending(
      pending,
    );
  }, []);

  const dispatchStreamEnd = useCallback(() => {
    (
      handlersRef.current.get(currentMessageIdRef.current ?? "") ??
      handlersRef.current.get("")
    )?.onStreamEnd();
    // Clear current message ID after stream ends
    currentMessageIdRef.current = null;
  }, []);

  const captureStreamingHtml = useCallback((): string | null => {
    return (
      (
        handlersRef.current.get(captureMessageIdRef.current ?? "") ??
        handlersRef.current.get("")
      )?.captureHtml?.() ?? null
    );
  }, []);

  const value: StreamingMarkdownContextValue = {
    registerStreamingHandler,
    setCurrentMessageId,
    dispatchAugment,
    dispatchPending,
    dispatchStreamEnd,
    captureStreamingHtml,
  };

  return (
    <StreamingMarkdownContext.Provider value={value}>
      {children}
    </StreamingMarkdownContext.Provider>
  );
}

/**
 * Hook to access the streaming markdown context.
 * Returns null if not within a provider (for graceful degradation).
 */
export function useStreamingMarkdownContext(): StreamingMarkdownContextValue | null {
  return useContext(StreamingMarkdownContext);
}
