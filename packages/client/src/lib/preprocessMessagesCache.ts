import type { MarkdownAugment } from "@yep-anywhere/shared";
import type { Message } from "../types";
import type { RenderItem } from "../types/renderItems";
import { getMessageId } from "./mergeMessages";
import {
  type ActiveToolApproval,
  type PreprocessAugments,
  collapsePlanProgressItems,
  preprocessMessages,
} from "./preprocessMessages";

export interface PreprocessMessagesCache {
  messages: Message[];
  renderItems: RenderItem[];
  markdown?: Record<string, MarkdownAugment>;
  activeToolApproval?: ActiveToolApproval;
}

export interface PreprocessMessagesCacheResult {
  renderItems: RenderItem[];
  cache: PreprocessMessagesCache;
}

export function preprocessMessagesCached(
  messages: Message[],
  augments?: PreprocessAugments,
  previous?: PreprocessMessagesCache | null,
): PreprocessMessagesCacheResult {
  const renderItems = tryPreprocessStreamingTail(messages, augments, previous);
  if (renderItems) {
    return {
      renderItems,
      cache: {
        messages,
        renderItems,
        markdown: augments?.markdown,
        activeToolApproval: augments?.activeToolApproval,
      },
    };
  }

  const fullRenderItems = preprocessMessages(messages, augments);
  return {
    renderItems: fullRenderItems,
    cache: {
      messages,
      renderItems: fullRenderItems,
      markdown: augments?.markdown,
      activeToolApproval: augments?.activeToolApproval,
    },
  };
}

function tryPreprocessStreamingTail(
  messages: Message[],
  augments?: PreprocessAugments,
  previous?: PreprocessMessagesCache | null,
): RenderItem[] | null {
  if (!previous || !hasSameAugments(previous, augments)) {
    return null;
  }

  const nextTail = messages[messages.length - 1];
  if (!nextTail || !isStreamingAssistantMessage(nextTail)) {
    return null;
  }

  if (
    previous.messages.length === messages.length - 1 &&
    hasSameMessagePrefix(previous.messages, messages, previous.messages.length)
  ) {
    return collapsePlanProgressItems([
      ...previous.renderItems,
      ...preprocessMessages([nextTail], augments),
    ]);
  }

  if (
    previous.messages.length === messages.length &&
    previous.messages.length > 0 &&
    hasSameMessagePrefix(previous.messages, messages, messages.length - 1)
  ) {
    const previousTail = previous.messages[previous.messages.length - 1];
    if (
      !previousTail ||
      !isStreamingAssistantMessage(previousTail) ||
      getMessageId(previousTail) !== getMessageId(nextTail)
    ) {
      return null;
    }

    const prefixItems = withoutTailSourceItems(
      previous.renderItems,
      previousTail,
    );
    if (!prefixItems) {
      return null;
    }

    return collapsePlanProgressItems([
      ...prefixItems,
      ...preprocessMessages([nextTail], augments),
    ]);
  }

  return null;
}

function hasSameAugments(
  previous: PreprocessMessagesCache,
  augments?: PreprocessAugments,
): boolean {
  return (
    previous.markdown === augments?.markdown &&
    previous.activeToolApproval === augments?.activeToolApproval
  );
}

function hasSameMessagePrefix(
  previous: Message[],
  next: Message[],
  length: number,
): boolean {
  for (let index = 0; index < length; index++) {
    if (previous[index] !== next[index]) {
      return false;
    }
  }
  return true;
}

function isStreamingAssistantMessage(message: Message): boolean {
  if (!message._isStreaming) {
    return false;
  }
  const role =
    (message.message as { role?: unknown } | undefined)?.role ?? message.role;
  return message.type === "assistant" || role === "assistant";
}

function withoutTailSourceItems(
  renderItems: RenderItem[],
  message: Message,
): RenderItem[] | null {
  const messageId = getMessageId(message);
  if (!messageId) {
    return null;
  }

  let firstTailIndex = renderItems.length;
  let foundTailSource = false;
  for (let index = renderItems.length - 1; index >= 0; index--) {
    const item = renderItems[index];
    if (item && hasSourceMessage(item, messageId)) {
      if (
        item.sourceMessages.some((source) => getMessageId(source) !== messageId)
      ) {
        return null;
      }
      firstTailIndex = index;
      foundTailSource = true;
      continue;
    }
    if (foundTailSource) {
      break;
    }
  }

  if (!foundTailSource) {
    return renderItems;
  }

  for (let index = 0; index < firstTailIndex; index++) {
    const item = renderItems[index];
    if (item && hasSourceMessage(item, messageId)) {
      return null;
    }
  }

  return renderItems.slice(0, firstTailIndex);
}

function hasSourceMessage(item: RenderItem, messageId: string): boolean {
  return item.sourceMessages.some(
    (source) => getMessageId(source) === messageId,
  );
}
