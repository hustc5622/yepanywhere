import { useCallback, useEffect, useRef } from "react";
import {
  type Subscription,
  connectionManager,
  getWebSocketConnection,
  isNonRetryableError,
} from "../lib/connection";
import { subscribeProjectFilesChanged } from "../lib/projectFileWatch";

/**
 * Subscribe to real-time file-change events for a project's repository and
 * call `onChange` (debounced) whenever something changes.
 *
 * Sources covered:
 *  - In-app editor saves (optimistic emit via `emitProjectFilesChanged`)
 *  - AI agent writes, terminal/external edits (server-side fs.watch → WS)
 *
 * The subscription is reference-counted server-side and re-established on
 * WebSocket reconnect.
 */
export function useProjectFileWatch(
  projectId: string | null,
  onChange: () => void,
): void {
  const wsSubRef = useRef<Subscription | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleaningUpRef = useRef(false);

  const trigger = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onChangeRef.current();
    }, 250);
  }, []);

  // Optimistic refresh from in-app editor saves.
  useEffect(() => {
    if (!projectId) return;
    return subscribeProjectFilesChanged(projectId, () => trigger());
  }, [projectId, trigger]);

  const connect = useCallback(() => {
    if (!projectId) return;
    if (wsSubRef.current) return;

    const connection = getWebSocketConnection();
    let sub: Subscription | null = null;
    const isStale = () => sub !== null && wsSubRef.current !== sub;

    const handlers = {
      onEvent: (
        eventType: string,
        _eventId: string | undefined,
        _data: unknown,
      ) => {
        connectionManager.recordEvent();
        if (eventType === "heartbeat") {
          connectionManager.recordHeartbeat();
          return;
        }
        if (eventType === "project-files-changed") {
          trigger();
        }
      },
      onOpen: () => {
        if (isStale()) return;
        connectionManager.markConnected();
      },
      onError: (error: Error) => {
        if (isStale()) return;
        wsSubRef.current = null;
        if (isNonRetryableError(error)) {
          console.warn(
            "[useProjectFileWatch] Non-retryable error, not reconnecting:",
            error.message,
          );
          return;
        }
        connectionManager.handleError(error);
      },
      onClose: () => {
        if (cleaningUpRef.current) return;
        if (isStale()) return;
        wsSubRef.current = null;
      },
    };

    sub = connection.subscribeProjectFiles(projectId, handlers);
    wsSubRef.current = sub;
  }, [projectId, trigger]);

  useEffect(() => {
    return connectionManager.on("stateChange", (state) => {
      if (state === "reconnecting" || state === "disconnected") {
        if (wsSubRef.current) {
          const old = wsSubRef.current;
          wsSubRef.current = null;
          old.close();
        }
      }
      if (state === "connected" && projectId && !wsSubRef.current) {
        connect();
      }
    });
  }, [projectId, connect]);

  useEffect(() => {
    connect();
    return () => {
      cleaningUpRef.current = true;
      wsSubRef.current?.close();
      wsSubRef.current = null;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      cleaningUpRef.current = false;
    };
  }, [connect]);
}
