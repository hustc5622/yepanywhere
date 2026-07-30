import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Subscription,
  connectionManager,
  getWebSocketConnection,
  isNonRetryableError,
} from "../lib/connection";

interface UseSessionStreamOptions {
  onMessage: (data: { eventType: string; [key: string]: unknown }) => void;
  onError?: (error: Event) => void;
  onOpen?: () => void;
}

function getReplayCursorMessageId(
  eventType: string,
  data: unknown,
): string | null {
  if (eventType !== "message" || !data || typeof data !== "object") {
    return null;
  }

  const message = data as Record<string, unknown>;
  if (message.type === "stream_event") {
    return null;
  }

  const uuid = message.uuid;
  if (typeof uuid === "string" && uuid.length > 0) {
    return uuid;
  }

  const id = message.id;
  if (typeof id === "string" && id.length > 0) {
    return id;
  }

  return null;
}

export function useSessionStream(
  sessionId: string | null,
  options: UseSessionStreamOptions,
) {
  const [connected, setConnected] = useState(false);
  const wsSubscriptionRef = useRef<Subscription | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const cursorSessionIdRef = useRef<string | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Track connected sessionId to skip StrictMode double-mount (not reset in cleanup)
  const mountedSessionIdRef = useRef<string | null>(null);
  // True during intentional cleanup — suppresses reconnect in onClose handler
  const cleaningUpRef = useRef(false);

  const connect = useCallback(() => {
    if (!sessionId) {
      // Reset tracking when sessionId becomes null so we can reconnect later
      // (e.g., when status goes idle → owned again for the same session)
      mountedSessionIdRef.current = null;
      cursorSessionIdRef.current = null;
      lastEventIdRef.current = null;
      lastMessageIdRef.current = null;
      return;
    }

    if (cursorSessionIdRef.current !== sessionId) {
      cursorSessionIdRef.current = sessionId;
      lastEventIdRef.current = null;
      lastMessageIdRef.current = null;
    }

    // Don't create duplicate connections
    if (wsSubscriptionRef.current) return;

    // Skip StrictMode double-mount (same sessionId, already connected once)
    if (mountedSessionIdRef.current === sessionId) return;
    mountedSessionIdRef.current = sessionId;

    connectWithConnection(sessionId, getWebSocketConnection());
  }, [sessionId]);

  /**
   * Connect using the local WebSocket connection.
   */
  const connectWithConnection = useCallback(
    (
      sessionId: string,
      connection: {
        subscribeSession: (
          sessionId: string,
          handlers: {
            onEvent: (
              eventType: string,
              eventId: string | undefined,
              data: unknown,
            ) => void;
            onOpen?: () => void;
            onError?: (err: Error) => void;
            onClose?: () => void;
          },
          lastEventId?: string,
          lastMessageId?: string,
        ) => Subscription;
      },
    ) => {
      // Close any existing subscription before creating a new one.
      // Clear ref BEFORE close() so isStale() returns true for the old
      // subscription's handlers if they fire synchronously during close.
      if (wsSubscriptionRef.current) {
        const old = wsSubscriptionRef.current;
        wsSubscriptionRef.current = null;
        old.close();
      }

      // Track this specific subscription instance for staleness detection.
      // When ConnectionManager reconnects, a new subscription replaces this one.
      // Without this guard, the old subscription's late-firing onClose would
      // clear the new subscription's state (wsSubscriptionRef, mountedSessionIdRef).
      let sub: Subscription | null = null;
      const isStale = () => sub !== null && wsSubscriptionRef.current !== sub;

      const handlers = {
        onEvent: (
          eventType: string,
          eventId: string | undefined,
          data: unknown,
        ) => {
          connectionManager.recordEvent();
          if (eventType === "heartbeat") {
            connectionManager.recordHeartbeat();
            return;
          }
          if (eventId) {
            lastEventIdRef.current = eventId;
          }
          const replayCursorMessageId = getReplayCursorMessageId(
            eventType,
            data,
          );
          if (replayCursorMessageId) {
            lastMessageIdRef.current = replayCursorMessageId;
          }
          optionsRef.current.onMessage({
            ...(data as Record<string, unknown>),
            eventType,
          });
        },
        onOpen: () => {
          if (isStale()) return;
          setConnected(true);
          connectionManager.markConnected();
          optionsRef.current.onOpen?.();
        },
        onError: (error: Error) => {
          if (isStale()) return;
          setConnected(false);
          wsSubscriptionRef.current = null;
          mountedSessionIdRef.current = null;
          optionsRef.current.onError?.(new Event("error"));

          // Don't signal ConnectionManager for subscription-level 404s
          if (isNonRetryableError(error)) {
            console.warn(
              "[useSessionStream] Non-retryable error, not reconnecting:",
              error.message,
            );
            return;
          }
          connectionManager.handleError(error);
        },
        onClose: () => {
          if (cleaningUpRef.current) return;
          if (isStale()) return;
          setConnected(false);
          wsSubscriptionRef.current = null;
          mountedSessionIdRef.current = null;
          // Treat clean close as a potential stall — trigger error recovery
          // so the caller can check server metadata and recover processState.
          optionsRef.current.onError?.(new Event("close"));
        },
      };

      sub = connection.subscribeSession(
        sessionId,
        handlers,
        lastEventIdRef.current ?? undefined,
        lastMessageIdRef.current ?? undefined,
      );
      wsSubscriptionRef.current = sub;
    },
    [],
  );

  // Listen for ConnectionManager state changes to re-subscribe
  useEffect(() => {
    return connectionManager.on("stateChange", (state) => {
      if (state === "reconnecting" || state === "disconnected") {
        // Proactively tear down the session subscription. Without this,
        // the "connected" stateChange can fire before the old subscription's
        // onClose, causing the !wsSubscriptionRef.current guard to skip
        // reconnection — leaving the session stream permanently disconnected
        // while the underlying transport is fine.
        if (wsSubscriptionRef.current) {
          const old = wsSubscriptionRef.current;
          wsSubscriptionRef.current = null;
          old.close();
        }
        setConnected(false);
        mountedSessionIdRef.current = null;
      }
      if (state === "connected" && sessionId && !wsSubscriptionRef.current) {
        connect();
      }
    });
  }, [sessionId, connect]);

  // Force reconnect (e.g., after process restart)
  const reconnect = useCallback(() => {
    if (!sessionId) return;
    if (wsSubscriptionRef.current) {
      const old = wsSubscriptionRef.current;
      wsSubscriptionRef.current = null;
      old.close();
    }
    mountedSessionIdRef.current = null;
    setConnected(false);
    // Defer so the close completes before reconnecting
    setTimeout(() => connect(), 50);
  }, [sessionId, connect]);

  useEffect(() => {
    connect();

    return () => {
      // Set flag BEFORE close() so onClose handler doesn't schedule a ghost reconnect
      cleaningUpRef.current = true;
      wsSubscriptionRef.current?.close();
      wsSubscriptionRef.current = null;
      // Reset mountedSessionIdRef so the next mount can connect
      // This is needed for StrictMode where cleanup runs between mounts
      mountedSessionIdRef.current = null;
      cleaningUpRef.current = false;
    };
  }, [connect]);

  return { connected, reconnect };
}
