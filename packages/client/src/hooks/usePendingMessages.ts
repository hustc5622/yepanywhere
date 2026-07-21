import { useCallback, useEffect, useState } from "react";
import { generateUUID } from "../lib/uuid";
import type { Message } from "../types";

/** Pending message waiting for server confirmation */
export interface PendingMessage {
  tempId: string;
  content: string;
  timestamp: string;
  /** Display status text (e.g. "Uploading...", "Sending..."). Defaults to "Sending..." */
  status?: string;
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
): boolean {
  const tempId = (message as { tempId?: unknown }).tempId;
  if (typeof tempId === "string" && tempId === pending.tempId) {
    return true;
  }

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
  /** Raw setter, for stream handlers that reconcile echoes by content. */
  setPendingMessages: React.Dispatch<React.SetStateAction<PendingMessage[]>>;
  /** Add to the pending queue; returns the generated tempId. */
  addPendingMessage: (content: string) => string;
  /** Remove a pending message by tempId (server confirmed or send failed). */
  removePendingMessage: (tempId: string) => void;
  /** Update a pending message's fields (e.g. status text). */
  updatePendingMessage: (
    tempId: string,
    updates: Partial<PendingMessage>,
  ) => void;
}

/**
 * Owns the optimistic pending-message queue and its reconciliation against the
 * authoritative message list. Extracted from useSession to shrink that hook and
 * isolate a self-contained concern.
 */
export function usePendingMessages(
  messages: Message[],
): UsePendingMessagesResult {
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);

  useEffect(() => {
    setPendingMessages((prev) =>
      reconcilePendingMessagesWithConfirmedMessages(prev, messages),
    );
  }, [messages]);

  // Add a message to the pending queue.
  // Generates a tempId that will be sent to the server and echoed back in stream.
  const addPendingMessage = useCallback((content: string): string => {
    const tempId = `temp-${generateUUID()}`;
    setPendingMessages((prev) => [
      ...prev,
      { tempId, content, timestamp: new Date().toISOString() },
    ]);
    return tempId;
  }, []);

  const removePendingMessage = useCallback((tempId: string) => {
    setPendingMessages((prev) => prev.filter((p) => p.tempId !== tempId));
  }, []);

  const updatePendingMessage = useCallback(
    (tempId: string, updates: Partial<PendingMessage>) => {
      setPendingMessages((prev) =>
        prev.map((p) => (p.tempId === tempId ? { ...p, ...updates } : p)),
      );
    },
    [],
  );

  return {
    pendingMessages,
    setPendingMessages,
    addPendingMessage,
    removePendingMessage,
    updatePendingMessage,
  };
}
