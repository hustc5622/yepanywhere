import { gunzipSync } from "node:zlib";
import type { RemoteClientMessage } from "@yep-anywhere/shared";
import {
  BinaryFormat,
  BinaryFrameError,
  decodeCompressedJsonFrame,
  isBinaryData,
} from "@yep-anywhere/shared";
import type { UploadManager } from "../uploads/manager.js";
import type {
  ConnectionState,
  HandleMessageOptions,
  SendFn,
  WSAdapter,
  WsUploadState,
} from "./ws-handlers.js";

const MAX_INFLATED_JSON_FRAME_BYTES = 32 * 1024 * 1024;

interface DecodeFrameDeps {
  uploads: Map<string, WsUploadState>;
  send: SendFn;
  uploadManager: UploadManager;
  handleBinaryUploadChunk: (
    uploads: Map<string, WsUploadState>,
    payload: Uint8Array,
    send: SendFn,
    uploadManager: UploadManager,
  ) => Promise<void>;
}

/**
 * Decode a WS frame into a parsed client message.
 *
 * Binary frames carry a leading format byte (JSON or upload chunk); text
 * frames are JSON. Returns null when the frame was fully handled (e.g. an
 * upload chunk) or could not be parsed.
 */
export async function decodeFrameToParsedMessage(
  ws: WSAdapter,
  data: unknown,
  options: HandleMessageOptions,
  connState: ConnectionState,
  deps: DecodeFrameDeps,
): Promise<unknown | null> {
  const { uploads, send, uploadManager, handleBinaryUploadChunk } = deps;

  const isFrameBinary = options.isBinary ?? isBinaryData(data);

  if (isFrameBinary) {
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
      bytes = data;
    } else {
      console.warn("[WS] Binary frame has unexpected data type");
      return null;
    }

    if (bytes.length === 0) {
      console.warn("[WS] Empty binary frame");
      return null;
    }

    try {
      const format = bytes[0] as number;
      if (
        format !== BinaryFormat.JSON &&
        format !== BinaryFormat.BINARY_UPLOAD &&
        format !== BinaryFormat.COMPRESSED_JSON
      ) {
        throw new BinaryFrameError(
          `Unknown format byte: 0x${format.toString(16).padStart(2, "0")}`,
          "UNKNOWN_FORMAT",
        );
      }
      const payload = bytes.slice(1);
      connState.useBinaryFrames = true;

      if (format === BinaryFormat.BINARY_UPLOAD) {
        await handleBinaryUploadChunk(uploads, payload, send, uploadManager);
        return null;
      }

      if (format === BinaryFormat.COMPRESSED_JSON) {
        connState.useCompressedJsonFrames = true;
        const compressedPayload = decodeCompressedJsonFrame(bytes);
        // Bounded so a small hostile frame cannot inflate into a long
        // synchronous decompression or an out-of-memory crash.
        const json = gunzipSync(compressedPayload, {
          maxOutputLength: MAX_INFLATED_JSON_FRAME_BYTES,
        }).toString("utf-8");
        return JSON.parse(json);
      }

      const decoder = new TextDecoder("utf-8", { fatal: true });
      const json = decoder.decode(payload);
      return JSON.parse(json);
    } catch (err) {
      if (err instanceof BinaryFrameError) {
        console.warn(`[WS] Binary frame error (${err.code}):`, err.message);
        if (err.code === "UNKNOWN_FORMAT") {
          ws.close(4002, err.message);
        }
      } else {
        console.warn("[WS] Failed to decode binary frame:", err);
      }
      return null;
    }
  }

  let textData: string;
  if (typeof data === "string") {
    textData = data;
  } else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
    textData = Buffer.from(data).toString("utf-8");
  } else {
    console.warn("[WS] Ignoring unknown message type");
    return null;
  }

  try {
    return JSON.parse(textData);
  } catch {
    console.warn("[WS] Failed to parse message:", textData);
    return null;
  }
}

interface MessageRouteHandlers {
  onRequest: (msg: RemoteClientMessage & { type: "request" }) => Promise<void>;
  onSubscribe: (
    msg: RemoteClientMessage & { type: "subscribe" },
  ) => Promise<void> | void;
  onUnsubscribe: (
    msg: RemoteClientMessage & { type: "unsubscribe" },
  ) => Promise<void> | void;
  onUploadStart: (
    msg: RemoteClientMessage & { type: "upload_start" },
  ) => Promise<void>;
  onUploadChunk: (
    msg: RemoteClientMessage & { type: "upload_chunk" },
  ) => Promise<void>;
  onUploadEnd: (
    msg: RemoteClientMessage & { type: "upload_end" },
  ) => Promise<void>;
  onPing: (msg: RemoteClientMessage & { type: "ping" }) => Promise<void> | void;
  onTerminalMessage?: (msg: RemoteClientMessage) => Promise<void> | void;
}

function getMessageId(msg: RemoteClientMessage): string | undefined {
  switch (msg.type) {
    case "request":
      return msg.id;
    case "subscribe":
      return msg.subscriptionId;
    case "upload_start":
    case "upload_chunk":
    case "upload_end":
      return msg.uploadId;
    case "terminal_open":
    case "terminal_input":
    case "terminal_resize":
    case "terminal_close":
      return (msg as { terminalId?: string }).terminalId;
    default:
      return undefined;
  }
}

/**
 * Route a parsed client message and normalize error responses.
 */
export async function routeClientMessageSafely(
  msg: RemoteClientMessage,
  send: SendFn,
  handlers: MessageRouteHandlers,
): Promise<void> {
  try {
    switch (msg.type) {
      case "request":
        await handlers.onRequest(msg);
        break;
      case "subscribe":
        await handlers.onSubscribe(msg);
        break;
      case "unsubscribe":
        await handlers.onUnsubscribe(msg);
        break;
      case "upload_start":
        await handlers.onUploadStart(msg);
        break;
      case "upload_chunk":
        await handlers.onUploadChunk(msg);
        break;
      case "upload_end":
        await handlers.onUploadEnd(msg);
        break;
      case "ping":
        await handlers.onPing(msg);
        break;
      case "terminal_open":
      case "terminal_input":
      case "terminal_resize":
      case "terminal_close":
        if (handlers.onTerminalMessage) {
          await handlers.onTerminalMessage(msg);
        } else {
          console.warn("[WS] Terminal message received but no handler");
        }
        break;
      default:
        console.warn(
          "[WS] Unknown message type:",
          (msg as { type?: string }).type,
        );
    }
  } catch (err) {
    const messageId = getMessageId(msg);
    console.error(
      `[WS] Unhandled error in routeMessage (type=${msg.type}, id=${messageId}):`,
      err,
    );
    if (messageId) {
      try {
        send({
          type: "response",
          id: messageId,
          status: 500,
          body: { error: "Internal server error" },
        });
      } catch (sendErr) {
        console.warn("[WS] Failed to send error response:", sendErr);
      }
    }
  }
}
