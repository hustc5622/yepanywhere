import {
  type ContextUsage,
  type ProviderName,
  getModelContextWindow,
} from "@yep-anywhere/shared";
import type { Message, Session } from "../types";
import { getMessageContent } from "./mergeMessages";

interface SessionContextInfo {
  provider?: string;
  model?: string;
  contextUsage?: ContextUsage;
}

function isCodexProvider(provider?: string): provider is ProviderName {
  return provider === "codex" || provider === "codex-oss";
}

function getMessageRole(message: Message): string | undefined {
  const nestedRole = (message.message as { role?: unknown } | undefined)?.role;
  if (nestedRole === "user" || nestedRole === "assistant") {
    return nestedRole;
  }
  if (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "system"
  ) {
    return message.role;
  }
  return undefined;
}

function isUserPromptMessage(message: Message): boolean {
  if (message.type !== "user" && getMessageRole(message) !== "user") {
    return false;
  }

  const content = getMessageContent(message);
  if (!Array.isArray(content)) {
    return true;
  }

  return !content.every(
    (block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "tool_result",
  );
}

function usageField(
  usage: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = usage?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function extractCodexTurnContextUsage(
  message: Message,
  session: SessionContextInfo | Session | null | undefined,
  providerOverride?: string,
): ContextUsage | undefined {
  const provider = session?.provider ?? providerOverride;
  if (!isCodexProvider(provider)) {
    return undefined;
  }
  if (
    message.type !== "system" ||
    (message.subtype !== "turn_usage" && message.subtype !== "turn_complete")
  ) {
    return undefined;
  }

  const usage =
    message.usage && typeof message.usage === "object"
      ? (message.usage as Record<string, unknown>)
      : undefined;
  const inputTokens = usageField(usage, "input_tokens");
  if (!inputTokens || inputTokens <= 0) {
    return undefined;
  }

  const reportedWindow = usageField(usage, "model_context_window");
  const contextWindow =
    reportedWindow && reportedWindow > 0
      ? reportedWindow
      : (session?.contextUsage?.contextWindow ??
        getModelContextWindow(session?.model, provider));

  const result: ContextUsage = {
    inputTokens,
    percentage: Math.min(100, Math.round((inputTokens / contextWindow) * 100)),
    contextWindow,
  };

  const outputTokens = usageField(usage, "output_tokens");
  if (outputTokens && outputTokens > 0) {
    result.outputTokens = outputTokens;
  }
  const cachedInputTokens = usageField(usage, "cached_input_tokens");
  if (cachedInputTokens && cachedInputTokens > 0) {
    result.cacheReadTokens = cachedInputTokens;
  }

  return result;
}

export function applyContextUsageToLatestUserPrompt(
  messages: Message[],
  contextUsage: ContextUsage,
): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || !isUserPromptMessage(message)) {
      continue;
    }

    if (
      message.contextBefore?.inputTokens === contextUsage.inputTokens &&
      message.contextBefore?.contextWindow === contextUsage.contextWindow
    ) {
      return messages;
    }

    const next = [...messages];
    next[i] = {
      ...message,
      contextBefore: contextUsage,
    };
    return next;
  }

  return messages;
}
