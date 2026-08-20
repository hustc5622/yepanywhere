import type { Message } from "../supervisor/types.js";

interface ProjectionResult<T> {
  value: T;
  changed: boolean;
}

const DATA_IMAGE_URL = /^data:(image\/[A-Za-z0-9.+-]+);base64,([\s\S]*)$/i;

function decodedBase64Bytes(payload: string): number {
  const compact = payload.replace(/\s/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function projectUnknown(value: unknown): ProjectionResult<unknown> {
  if (Array.isArray(value)) {
    const projected = value.map(projectUnknown);
    const changed = projected.some((entry) => entry.changed);
    return {
      value: changed ? projected.map((entry) => entry.value) : value,
      changed,
    };
  }
  if (!value || typeof value !== "object") return { value, changed: false };

  const record = value as Record<string, unknown>;
  const imageUrl = record.image_url;
  if (record.type === "input_image" && typeof imageUrl === "string") {
    const match = DATA_IMAGE_URL.exec(imageUrl);
    if (match?.[1] && match[2] !== undefined) {
      const { image_url: _removed, ...rest } = record;
      return {
        value: {
          ...rest,
          omitted_image: {
            mimeType: match[1].toLowerCase(),
            byteLength: decodedBase64Bytes(match[2]),
          },
        },
        changed: true,
      };
    }
  }

  let changed = false;
  const entries = Object.entries(record).map(([key, entry]) => {
    const projected = projectUnknown(entry);
    changed ||= projected.changed;
    return [key, projected.value] as const;
  });
  return { value: changed ? Object.fromEntries(entries) : value, changed };
}

function projectToolResultContent(content: unknown): ProjectionResult<unknown> {
  if (typeof content !== "string") return projectUnknown(content);
  try {
    const projected = projectUnknown(JSON.parse(content));
    return projected.changed
      ? { value: JSON.stringify(projected.value), changed: true }
      : { value: content, changed: false };
  } catch {
    return { value: content, changed: false };
  }
}

export function projectBrowserMessages(
  messages: readonly Message[],
): Message[] {
  return messages.map((message) => {
    const content = message.message?.content;
    let projectedContent = content;
    let contentChanged = false;

    if (Array.isArray(content)) {
      projectedContent = content.map((block) => {
        if (block.type !== "tool_result") return block;

        const projected = projectToolResultContent(block.content);
        if (!projected.changed) return block;

        contentChanged = true;
        return { ...block, content: projected.value as string };
      });
    }

    const topLevelContent = message.content;
    let projectedTopLevelContent = topLevelContent;
    let topLevelContentChanged = false;

    if (Array.isArray(topLevelContent)) {
      projectedTopLevelContent = topLevelContent.map((block) => {
        if (!block || typeof block !== "object") return block;

        const record = block as Record<string, unknown>;
        if (record.type !== "tool_result") return block;

        const projected = projectToolResultContent(record.content);
        if (!projected.changed) return block;

        topLevelContentChanged = true;
        return { ...record, content: projected.value };
      });
    }

    const projectedToolUseResult = projectUnknown(message.toolUseResult);
    if (
      !contentChanged &&
      !topLevelContentChanged &&
      !projectedToolUseResult.changed
    ) {
      return message;
    }

    return {
      ...message,
      ...(contentChanged
        ? { message: { ...message.message, content: projectedContent } }
        : {}),
      ...(topLevelContentChanged ? { content: projectedTopLevelContent } : {}),
      ...(projectedToolUseResult.changed
        ? { toolUseResult: projectedToolUseResult.value }
        : {}),
    };
  });
}

export function createBrowserSessionProjection<TSession extends object>(
  session: TSession,
  messages: readonly Message[],
): { session: Omit<TSession, "messages">; messages: Message[] } {
  const projectedSession = { ...session } as TSession & { messages?: unknown };
  // biome-ignore lint/performance/noDelete: The browser projection must omit this property.
  delete projectedSession.messages;
  return {
    session: projectedSession,
    messages: projectBrowserMessages(messages),
  };
}
