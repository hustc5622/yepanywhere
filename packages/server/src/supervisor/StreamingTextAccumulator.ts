import { streamBlockIndex } from "../utils/streamBlockIndex.js";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

export interface StreamingTextSnapshot {
  messageId: string;
  /** Legacy markdown subscriptions consume the concatenated text. */
  text: string;
  /** Display subscriptions need block, turn and phase identity as well. */
  message: RecordValue;
}

/** Owned by the process, independent of subscribers and the short replay buffer. */
export class StreamingTextAccumulator {
  private id: string | undefined;
  private metadata: RecordValue = {};
  private blocks: Array<{ type: "text"; text: string }> = [];
  private index = 0;
  private streaming = false;
  private closed = new Set<string>();

  private rememberClosed(id: string): void {
    this.closed.add(id);
    if (this.closed.size > 256) {
      const oldest = this.closed.values().next().value;
      if (oldest) this.closed.delete(oldest);
    }
  }

  clear(): void {
    if (this.id) this.rememberClosed(this.id);
    this.id = undefined;
    this.metadata = {};
    this.blocks = [];
    this.streaming = false;
  }

  private begin(id: string, message: RecordValue): void {
    if (this.id === id) return;
    this.clear();
    this.id = id;
    for (const key of [
      "timestamp",
      "turnId",
      "codexTurnId",
      "codexThreadId",
      "codexCorrelationKey",
      "codexMessagePhase",
      "codexAsyncMessage",
    ]) {
      if (message[key] !== undefined) this.metadata[key] = message[key];
    }
    this.index = 0;
    this.streaming = true;
  }

  track(message: RecordValue, sessionId?: string): void {
    if (
      message.isSubagent ||
      message.isSidechain ||
      message.parent_tool_use_id ||
      message.parentToolUseId ||
      (sessionId &&
        typeof message.codexThreadId === "string" &&
        message.codexThreadId !== sessionId)
    )
      return;

    const run = message.codexTurnId ?? message.turnId;
    if (
      message.type === "result" ||
      message.subtype === "turn_complete" ||
      (message.type === "error" && message.willRetry !== true)
    ) {
      const activeRun = this.metadata.codexTurnId ?? this.metadata.turnId;
      if (!run || !activeRun || run === activeRun) this.clear();
      return;
    }

    if (message.type === "assistant") {
      const content = record(message.message)?.content ?? message.content;
      const id = message.codexTurnId
        ? (message.uuid ?? message.id)
        : (record(message.message)?.id ?? message.uuid ?? message.id);
      if (typeof id === "string" && this.closed.has(id)) return;
      // Codex item/started carries an empty assistant instead of message_start.
      if (message.codexTurnId && content === "" && typeof id === "string") {
        if (!this.closed.has(id)) this.begin(id, message);
      } else if (
        typeof content === "string" ||
        (Array.isArray(content) &&
          content.some((block) => record(block)?.type === "text"))
      ) {
        this.clear();
        if (typeof id === "string") this.rememberClosed(id);
      }
      return;
    }
    if (message.type !== "stream_event") return;
    const event = record(message.event);
    if (!event) return;
    if (event.type === "message_start") {
      const id = record(event.message)?.id;
      if (typeof id === "string" && !this.closed.has(id))
        this.begin(id, message);
      return;
    }
    const id = message.codexTurnId ? (message.uuid ?? message.id) : this.id;
    if (typeof id !== "string" || this.closed.has(id)) return;
    if (event.type === "message_stop") {
      if (this.id === id) this.clear();
      return;
    }
    if (event.type === "content_block_stop") {
      if (this.id === id) this.streaming = false;
      return;
    }
    const start = event.type === "content_block_start";
    const block = record(event.content_block);
    const delta = record(event.delta);
    if (start && block?.type !== "text") {
      if (this.id === id) this.streaming = false;
      return;
    }
    const text =
      start && block?.type === "text"
        ? (block.text ?? "")
        : event.type === "content_block_delta" && delta?.type === "text_delta"
          ? delta.text
          : undefined;
    if (typeof text !== "string") return;
    if (this.id === id && !this.streaming && !start) return;
    this.begin(id, message);
    const index = streamBlockIndex(event.index);
    while (this.blocks.length <= index)
      this.blocks.push({ type: "text", text: "" });
    const previous = this.blocks[index]?.text ?? "";
    this.blocks[index] = { type: "text", text: (start ? "" : previous) + text };
    this.index = index;
    this.streaming = true;
  }

  snapshot(): StreamingTextSnapshot | null {
    const text = this.blocks.map((block) => block.text).join("");
    if (!this.id || !text) return null;
    return {
      messageId: this.id,
      text,
      message: {
        ...this.metadata,
        type: "assistant",
        uuid: this.id,
        _isStreaming: this.streaming,
        _isStreamingPlaceholder: true,
        _streamingBlockIndex: this.index,
        message: {
          id: this.id,
          role: "assistant",
          content: this.blocks.map((block) => ({ ...block })),
        },
      },
    };
  }
}
