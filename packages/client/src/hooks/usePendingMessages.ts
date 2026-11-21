import { useCallback, useEffect, useRef, useState } from "react";
import { generateUUID } from "../lib/uuid";
import type { Message } from "../types";

/** Pending message waiting for server confirmation */
export interface PendingMessage {
  tempId: string;
  content: string;
  timestamp: string;
  /** Display status text (e.g. "Uploading...", "Sending..."). Defaults to "Sending..." */
  status?: string;
  /**
   * Waiting on the provider rather than the network (mid-turn insert). Such an
   * entry is only released by the transcript, never by a stream echo, because
   * some providers never publish that echo as visible content.
   */
  awaitingTurn?: boolean;
}

function getUserMessageText(message: Message): string | null {
  const role =
    (message.message as { role?: unknown } | undefined)?.role ?? message.role;
  const isUserMessage = message.type === "user" || role === "user";
  if (!isUserMessage) return null;

  const content = message.message?.content ?? message.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? content : null;
  }

  if (!Array.isArray(content)) return null;

  const text = content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      return typeof block.text === "string" ? block.text : "";
    })
    .join("");
  return text.trim().length > 0 ? text : null;
}

function isPendingMessageConfirmed(
  pending: PendingMessage,
  message: Message,
  visibleAtSubmission?: ReadonlySet<string>,
): boolean {
  const tempId = (message as { tempId?: unknown }).tempId;
  if (typeof tempId === "string" && tempId) {
    return tempId === pending.tempId;
  }

  const id = message.uuid ?? message.id;
  if (typeof id === "string" && visibleAtSubmission?.has(id)) return false;

  const messageTimestampMs =
    typeof message.timestamp === "string"
      ? Date.parse(message.timestamp)
      : Number.NaN;
  const pendingTimestampMs = Date.parse(pending.timestamp);
  if (
    Number.isFinite(messageTimestampMs) &&
    Number.isFinite(pendingTimestampMs) &&
    messageTimestampMs < pendingTimestampMs - 5000
  ) {
    return false;
  }

  const pendingText = pending.content.trim();
  if (!pendingText) return false;

  const messageText = getUserMessageText(message)?.trim();
  if (!messageText) return false;

  return (
    messageText === pendingText ||
    messageText.startsWith(`${pendingText}\n\nUser uploaded files:`)
  );
}

/**
 * Drop pending (optimistic) messages once a matching confirmed message shows
 * up in the authoritative list. Matching is by echoed tempId, then by trimmed
 * content (with an attachment-expansion allowance), guarded by a timestamp
 * window so an older same-content history message can't clear a fresh pending.
 */
export function reconcilePendingMessagesWithConfirmedMessages(
  pendingMessages: PendingMessage[],
  messages: Message[],
): PendingMessage[] {
  if (pendingMessages.length === 0 || messages.length === 0) {
    return pendingMessages;
  }

  const next = pendingMessages.filter(
    (pending) =>
      !messages.some((message) => isPendingMessageConfirmed(pending, message)),
  );
  return next.length === pendingMessages.length ? pendingMessages : next;
}

export interface UsePendingMessagesResult {
  /** Messages waiting for server confirmation (shown as "Sending..."). */
  pendingMessages: PendingMessage[];
  /** Confirm at most one submission from a streamed user echo. */
  confirmPendingMessage: (message: Message) => void;
  /** Add to the pending queue; returns the generated tempId. */
  addPendingMessage: (content: string) => string;
  /** Remove a pending message by tempId (server confirmed or send failed). */
  removePendingMessage: (tempId: string) => void;
  /** Update a pending message's fields (e.g. status text). */
  updatePendingMessage: (
    tempId: string,
    updates: Partial<PendingMessage>,
  ) => void;
  /** Release mid-turn insert bubbles whose turn has settled. */
  clearAwaitingTurnMessages: () => void;
}

/**
 * Owns the optimistic pending-message queue and its reconciliation against the
 * authoritative message list and server-side deferred queue. Queue acceptance
 * confirms submission even before the message appears in the transcript or the
 * HTTP request finishes. Match queue entries by tempId only: repeated text may
 * belong to separate submissions with different attachments.
 */
export function usePendingMessages(
  messages: Message[],
  deferredMessages?: ReadonlyArray<{ tempId?: string }>,
): UsePendingMessagesResult {
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const visibleAtSubmission = useRef(new Map<string, Set<string>>());

  useEffect(() => {
    const queuedTempIds = new Set(
      deferredMessages?.flatMap((message) =>
        message.tempId ? [message.tempId] : [],
      ),
    );
    setPendingMessages((prev) => {
      const next = prev.filter((pending) => {
        if (queuedTempIds.has(pending.tempId)) {
          visibleAtSubmission.current.delete(pending.tempId);
          return false;
        }
        const confirmed = messages.some((message) =>
          isPendingMessageConfirmed(
            pending,
            message,
            visibleAtSubmission.current.get(pending.tempId),
          ),
        );
        if (confirmed) visibleAtSubmission.current.delete(pending.tempId);
        return !confirmed;
      });
      return next.length === prev.length ? prev : next;
    });
  }, [messages, deferredMessages]);

  // Add a message to the pending queue.
  // Generates a tempId that will be sent to the server and echoed back in stream.
  const addPendingMessage = useCallback((content: string): string => {
    const tempId = `temp-${generateUUID()}`;
    visibleAtSubmission.current.set(
      tempId,
      new Set(
        messagesRef.current.flatMap((message) => {
          const id = message.uuid ?? message.id;
          return typeof id === "string" ? [id] : [];
        }),
      ),
    );
    setPendingMessages((prev) => [
      ...prev,
      { tempId, content, timestamp: new Date().toISOString() },
    ]);
    return tempId;
  }, []);

  const removePendingMessage = useCallback((tempId: string) => {
    visibleAtSubmission.current.delete(tempId);
    setPendingMessages((prev) => prev.filter((p) => p.tempId !== tempId));
  }, []);

  const confirmPendingMessage = useCallback((message: Message) => {
    setPendingMessages((prev) => {
      const index = prev.findIndex(
        (pending) =>
          pending.awaitingTurn !== true &&
          isPendingMessageConfirmed(
            pending,
            message,
            visibleAtSubmission.current.get(pending.tempId),
          ),
      );
      const confirmed = prev[index];
      if (!confirmed) return prev;
      visibleAtSubmission.current.delete(confirmed.tempId);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const updatePendingMessage = useCallback(
    (tempId: string, updates: Partial<PendingMessage>) => {
      setPendingMessages((prev) =>
        prev.map((p) => (p.tempId === tempId ? { ...p, ...updates } : p)),
      );
    },
    [],
  );

  const clearAwaitingTurnMessages = useCallback(() => {
    setPendingMessages((prev) => {
      const next = prev.filter((pending) => {
        if (pending.awaitingTurn !== true) return true;
        visibleAtSubmission.current.delete(pending.tempId);
        return false;
      });
      return next.length === prev.length ? prev : next;
    });
  }, []);

  return {
    pendingMessages,
    confirmPendingMessage,
    addPendingMessage,
    removePendingMessage,
    updatePendingMessage,
    clearAwaitingTurnMessages,
  };
}
