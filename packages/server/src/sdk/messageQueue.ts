import type { QueuedUserMessage, UserMessage } from "./types.js";

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

/**
 * MessageQueue provides an async generator pattern for queuing user messages
 * to be sent to providers.
 * This queue allows messages to be pushed at any time, and the generator
 * will yield them as they become available (blocking when empty).
 */
export class MessageQueue {
  private queue: UserMessage[] = [];
  private waiting: ((msg: UserMessage) => void) | null = null;

  /**
   * Push a message onto the queue.
   * If the generator is waiting for a message, resolves immediately.
   * Otherwise, adds to the queue.
   *
   * @returns The new queue depth (0 if resolved immediately)
   */
  push(message: UserMessage): number {
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
      yield this.toSDKMessage(message);
    }
  }

  /**
   * Get the next message from the queue.
   * If the queue is empty, returns a promise that resolves when push() is called.
   */
  private next(): Promise<UserMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /**
   * Format file size in human-readable form.
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  /**
   * Convert a UserMessage to the provider-neutral wire format.
   */
  private toSDKMessage(msg: UserMessage): QueuedUserMessage {
    let text = msg.text;

    // Append attachment paths for agent to access via Read tool
    if (msg.attachments?.length) {
      const lines = msg.attachments.map(
        (f) =>
          `- ${f.originalName} (${this.formatSize(f.size)}, ${f.mimeType}): ${f.path}`,
      );
      text += `\n\nUser uploaded files:\n${lines.join("\n")}`;
    }

    // If message has images or documents, use array content format
    if (msg.images?.length || msg.documents?.length) {
      const content: Array<
        | { type: "text"; text: string }
        | {
            type: "image";
            source: { type: "base64"; media_type: string; data: string };
          }
      > = [{ type: "text", text }];

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

      // Documents would need similar handling
      // For now, we'll just include them in text
      if (msg.documents?.length) {
        content[0] = {
          type: "text",
          text: `${text}\n\nAttached documents: ${msg.documents.join(", ")}`,
        };
      }

      return {
        type: "user",
        uuid: msg.uuid, // Pass UUID so SDK uses the same one we emitted via SSE
        message: {
          role: "user",
          content,
        },
      };
    }

    // Simple text message
    return {
      type: "user",
      uuid: msg.uuid, // Pass UUID so SDK uses the same one we emitted via SSE
      message: {
        role: "user",
        content: text,
      },
    };
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
}
