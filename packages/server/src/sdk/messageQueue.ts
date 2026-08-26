import type { QueuedUserMessage, UserMessage } from "./types.js";

export const MANAGED_ATTACHMENT_MARKER = "[managed attachment]";

export interface UserPromptProjection {
  /** Provider-only prompt; may contain server-local managed paths. */
  internalPrompt: string;
  /** Plaintext prompt for history, SSE, logs, and public SDK events. */
  publicPrompt: string;
}

/** Keep the internal/public pair off the enumerable provider wire payload. */
const queuedPromptProjections = new WeakMap<object, UserPromptProjection>();

export interface MessageQueueOptions {
  /** Preserve structured uploads for providers that support native file parts. */
  preserveAttachments?: boolean;
  /** Preserve ordered skill/mention inputs for the Codex app-server adapter. */
  preserveCodexInputs?: boolean;
  /** Preserve the opaque optimistic-client ID for provider correlation. */
  preserveClientMetadata?: boolean;
}

/**
 * Detect the media type from base64 image data.
 * Supports data URLs (data:image/png;base64,...) and raw base64 with magic byte detection.
 */
function detectImageMediaType(base64Data: string): string {
  // Check for data URL format first
  const dataUrlMatch = base64Data.match(/^data:([^;]+);base64,/);
  if (dataUrlMatch?.[1]) {
    return dataUrlMatch[1];
  }

  // For raw base64, decode first few bytes and check magic bytes
  try {
    // Get the raw base64 portion (remove any data URL prefix if it wasn't matched above)
    const rawBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");
    // Decode first 16 bytes to check magic bytes
    const bytes = Buffer.from(rawBase64.slice(0, 24), "base64");

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      return "image/png";
    }

    // JPEG: FF D8 FF
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }

    // GIF: 47 49 46 38 (GIF8)
    if (
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38
    ) {
      return "image/gif";
    }

    // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF...WEBP)
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return "image/webp";
    }

    // BMP: 42 4D (BM)
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
      return "image/bmp";
    }
  } catch {
    // If decoding fails, fall back to PNG
  }

  // Default to PNG if detection fails
  return "image/png";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function safeAttachmentLabel(value: string): string {
  const leaf = value.split(/[\\/]/).at(-1) ?? value;
  return (
    leaf
      .replace(/[^\p{L}\p{N} ._()+@-]+/gu, "_")
      .trim()
      .slice(0, 160) || "attachment"
  );
}

function safeMimeLabel(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9!#$&^_.+/-]+/g, "_")
      .trim()
      .slice(0, 120) || "unknown"
  );
}

/** Construct provider-only and public views from one structured message. */
export function buildUserPromptProjection(
  message: Pick<UserMessage, "text" | "attachments" | "documents">,
): UserPromptProjection {
  let internalPrompt = message.text;
  let publicPrompt = message.text;

  if (message.attachments?.length) {
    const internalLines = message.attachments.map((file) => {
      const name = safeAttachmentLabel(file.originalName || file.name);
      const mimeType = safeMimeLabel(file.mimeType);
      return `- ${name} (${formatSize(file.size)}, ${mimeType}): ${file.path}`;
    });
    internalPrompt += `\n\nUser uploaded files:\n${internalLines.join("\n")}`;
    publicPrompt += `\n\nUser uploaded files:\n${internalLines.join("\n")}`;
  }

  if (message.documents?.length) {
    internalPrompt += `\n\nAttached documents: ${message.documents.join(", ")}`;
    publicPrompt += `\n\nAttached documents: ${message.documents.join(", ")}`;
  }

  return { internalPrompt, publicPrompt };
}

function extractQueuedText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const direct = message as { text?: unknown };
  if (typeof direct.text === "string") return direct.text;

  const content = (message as { message?: { content?: unknown } }).message
    ?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      const record = block as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Compatibility helper; attachment locations remain visible. */
export function sanitizeManagedAttachmentPrompt(text: string): string {
  return text;
}

/** Read the internal/public pair, reconstructing it after shallow clones. */
export function getUserPromptProjection(
  message: unknown,
): UserPromptProjection {
  if (message && typeof message === "object") {
    const queued = queuedPromptProjections.get(message);
    if (queued) return queued;

    const raw = message as Partial<UserMessage>;
    if (typeof raw.text === "string") {
      return buildUserPromptProjection({
        text: raw.text,
        attachments: raw.attachments,
        documents: raw.documents,
      });
    }
  }

  const internalPrompt = extractQueuedText(message);
  return { internalPrompt, publicPrompt: internalPrompt };
}

/**
 * MessageQueue provides an async generator pattern for queuing user messages
 * to be sent to providers.
 * This queue allows messages to be pushed at any time, and the generator
 * will yield them as they become available (blocking when empty).
 */
export class MessageQueue {
  private queue: UserMessage[] = [];
  private waiting: ((msg: UserMessage | null) => void) | null = null;
  private closed = false;

  constructor(private readonly options: MessageQueueOptions = {}) {}

  /**
   * Push a message onto the queue.
   * If the generator is waiting for a message, resolves immediately.
   * Otherwise, adds to the queue.
   *
   * @returns The new queue depth (0 if resolved immediately, -1 if closed)
   */
  push(message: UserMessage): number {
    if (this.closed) return -1;
    if (this.waiting) {
      this.waiting(message);
      this.waiting = null;
      return 0;
    }
    this.queue.push(message);
    return this.queue.length;
  }

  /**
   * Async generator that yields provider-neutral user messages.
   * Blocks when the queue is empty, waiting for push() to be called.
   */
  async *generator(): AsyncGenerator<QueuedUserMessage> {
    while (true) {
      const message = await this.next();
      if (!message) return;
      yield this.toSDKMessage(message);
    }
  }

  /**
   * Get the next message from the queue.
   * If the queue is empty, returns a promise that resolves when push() is called.
   */
  private next(): Promise<UserMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);

    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /**
   * Permanently stop this resident-provider queue and discard input that can no
   * longer be consumed. Returns the number of discarded messages.
   */
  close(): number {
    if (this.closed) return 0;
    this.closed = true;
    const discarded = this.queue.length;
    this.queue = [];
    if (this.waiting) {
      this.waiting(null);
      this.waiting = null;
    }
    return discarded;
  }

  /**
   * Convert a UserMessage to the provider-neutral wire format.
   */
  private toSDKMessage(msg: UserMessage): QueuedUserMessage {
    const projection = buildUserPromptProjection(msg);
    const attachments =
      this.options.preserveAttachments && msg.attachments?.length
        ? [...msg.attachments]
        : undefined;
    const codexInputs =
      this.options.preserveCodexInputs && msg.codexInputs?.length
        ? msg.codexInputs.map((input) => ({ ...input }))
        : undefined;

    // If message has images or documents, use array content format
    if (msg.images?.length || msg.documents?.length) {
      const content: Array<
        | { type: "text"; text: string }
        | {
            type: "image";
            source: { type: "base64"; media_type: string; data: string };
          }
      > = [{ type: "text", text: projection.internalPrompt }];

      // Add images as base64 content blocks
      for (const image of msg.images ?? []) {
        // Detect media type from the image data
        const mediaType = detectImageMediaType(image);
        // Strip data URL prefix if present to get raw base64
        const rawBase64 = image.replace(/^data:[^;]+;base64,/, "");
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: rawBase64,
          },
        });
      }

      const queuedMessage: QueuedUserMessage = {
        type: "user",
        uuid: msg.uuid, // Pass UUID so SDK uses the same one we emitted via SSE
        ...(this.options.preserveClientMetadata && msg.tempId
          ? { tempId: msg.tempId }
          : {}),
        ...(attachments && { attachments }),
        ...(codexInputs && { codexInputs }),
        message: {
          role: "user",
          content,
        },
      };
      queuedPromptProjections.set(queuedMessage, projection);
      return queuedMessage;
    }

    // Simple text message
    const queuedMessage: QueuedUserMessage = {
      type: "user",
      uuid: msg.uuid, // Pass UUID so SDK uses the same one we emitted via SSE
      ...(this.options.preserveClientMetadata && msg.tempId
        ? { tempId: msg.tempId }
        : {}),
      ...(attachments && { attachments }),
      ...(codexInputs && { codexInputs }),
      message: {
        role: "user",
        content: projection.internalPrompt,
      },
    };
    queuedPromptProjections.set(queuedMessage, projection);
    return queuedMessage;
  }

  /**
   * Current number of messages waiting in the queue.
   */
  get depth(): number {
    return this.queue.length;
  }

  /**
   * Whether the generator is currently waiting for a message.
   */
  get isWaiting(): boolean {
    return this.waiting !== null;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
