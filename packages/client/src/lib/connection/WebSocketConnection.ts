import type {
  DeviceServerMessage,
  RemoteClientMessage,
  TerminalServerMessage,
  UploadedFile,
  YepMessage,
} from "@yep-anywhere/shared";
import {
  BinaryFormat,
  BinaryFrameError,
  decodeCompressedJsonFrame,
  decodeJsonFrame,
  decompressToString,
  encodeJsonFrame,
  encodeUploadChunkFrame,
  isBinaryData,
  isCompressionSupported,
} from "@yep-anywhere/shared";
import { getDesktopAuthToken } from "../../api/client";
import { API_BASE } from "../apiPath";
import { WireProtocol } from "./WireProtocol";
import type {
  Connection,
  StreamHandlers,
  Subscription,
  UploadOptions,
} from "./types";
import { WebSocketCloseError } from "./types";

/**
 * Connection to yepanywhere server using WebSocket transport.
 *
 * Implements an HTTP-like request/response protocol over a single WebSocket
 * connection. Protocol logic (request correlation, subscriptions, uploads)
 * is delegated to WireProtocol.
 */
export class WebSocketConnection implements Connection {
  readonly mode = "direct" as const;

  private ws: WebSocket | null = null;
  private connectionPromise: Promise<void> | null = null;
  private messageQueue: Promise<void> = Promise.resolve();
  private protocol: WireProtocol;

  constructor() {
    this.protocol = new WireProtocol(
      {
        sendMessage: (msg) => this.send(msg),
        sendUploadChunk: (id, offset, chunk) => {
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket not connected");
          }
          this.ws.send(encodeUploadChunkFrame(id, offset, chunk));
        },
        ensureConnected: () => this.ensureConnected(),
        isConnected: () => this.ws?.readyState === WebSocket.OPEN,
      },
      { logPrefix: "[WebSocketConnection]" },
    );
  }

  private getWsUrl(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    // API_BASE encodes vite's BASE_URL so this works whether the server is
    // mounted at "/" or behind a reverse-proxy prefix like "/yep".
    const base = `${protocol}//${window.location.host}${API_BASE}/ws`;
    const params = new URLSearchParams();
    if (isCompressionSupported()) {
      params.set("compression", "gzip");
    }
    // Pass desktop token as query param since WebSocket can't set custom headers
    const token = getDesktopAuthToken();
    if (token) {
      params.set("desktop_token", token);
    }
    const query = params.toString();
    return query ? `${base}?${query}` : base;
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.connect();
    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.getWsUrl();
      console.log("[WebSocketConnection] Connecting to", wsUrl);

      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";

      ws.onerror = (event) => {
        console.error("[WebSocketConnection] Error:", event);
      };

      ws.onclose = (event) => {
        console.log("[WebSocketConnection] Closed:", event.code, event.reason);
        this.ws = null;

        const closeError = new WebSocketCloseError(event.code, event.reason);
        this.protocol.rejectAllPending(closeError);
        this.protocol.notifySubscriptionsClosed(closeError);
      };

      ws.onmessage = (event) => {
        this.messageQueue = this.messageQueue
          .then(() => this.handleMessage(event.data))
          .catch((err) => {
            console.warn(
              "[WebSocketConnection] Failed to handle message:",
              err,
            );
          });
      };

      const timeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
          reject(new Error("WebSocket connection timeout"));
        }
      }, 10000);

      ws.onopen = () => {
        clearTimeout(timeout);
        console.log("[WebSocketConnection] Connected");
        this.ws = ws;
        resolve();
      };
    });
  }

  /**
   * Handle incoming WebSocket messages.
   * Supports both text frames (JSON) and binary frames (format byte + payload).
   */
  private async handleMessage(data: unknown): Promise<void> {
    let msg: YepMessage;

    if (isBinaryData(data)) {
      try {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        if (bytes[0] === BinaryFormat.COMPRESSED_JSON) {
          const compressedPayload = decodeCompressedJsonFrame(bytes);
          const json = await decompressToString(compressedPayload);
          if (json === null) {
            console.warn(
              "[WebSocketConnection] Cannot decode compressed frame: compression API unavailable",
            );
            return;
          }
          msg = JSON.parse(json) as YepMessage;
        } else {
          msg = decodeJsonFrame<YepMessage>(bytes);
        }
      } catch (err) {
        if (err instanceof BinaryFrameError) {
          console.warn(
            `[WebSocketConnection] Binary frame error (${err.code}):`,
            err.message,
          );
        } else {
          console.warn(
            "[WebSocketConnection] Failed to decode binary frame:",
            err,
          );
        }
        return;
      }
    } else if (typeof data === "string") {
      try {
        msg = JSON.parse(data) as YepMessage;
      } catch {
        console.warn("[WebSocketConnection] Failed to parse message:", data);
        return;
      }
    } else {
      console.warn("[WebSocketConnection] Ignoring unknown message type");
      return;
    }

    this.protocol.routeMessage(msg);
  }

  private send(msg: import("@yep-anywhere/shared").RemoteClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    this.ws.send(encodeJsonFrame(msg));
  }

  async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    return this.protocol.fetch<T>(path, init);
  }

  async fetchBlob(path: string): Promise<Blob> {
    return this.protocol.fetchBlob(path);
  }

  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
    lastMessageId?: string,
  ): Subscription {
    return this.protocol.subscribeSession(
      sessionId,
      handlers,
      lastEventId,
      lastMessageId,
    );
  }

  subscribeActivity(handlers: StreamHandlers): Subscription {
    return this.protocol.subscribeActivity(handlers);
  }

  subscribeSessionWatch(
    sessionId: string,
    handlers: StreamHandlers,
    options?: {
      projectId?: string;
      provider?: string;
    },
  ): Subscription {
    return this.protocol.subscribeSessionWatch(sessionId, handlers, options);
  }

  subscribeProjectFiles(
    projectId: string,
    handlers: StreamHandlers,
  ): Subscription {
    return this.protocol.subscribeProjectFiles(projectId, handlers);
  }

  async upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile> {
    return this.protocol.upload(projectId, sessionId, file, options);
  }

  /**
   * Send a keepalive ping to verify the connection is alive.
   */
  sendPing(id: string): void {
    this.protocol.sendPing(id);
  }

  /**
   * Register a callback for pong responses.
   */
  setOnPong(cb: (id: string) => void): void {
    this.protocol.setOnPong(cb);
  }

  /**
   * Reconnect the WebSocket. Tears down the current connection and
   * re-establishes it. Used by ConnectionManager's reconnectFn.
   */
  async reconnect(): Promise<void> {
    const reconnectError = new Error("Connection reconnecting");
    this.protocol.rejectAllPending(reconnectError);
    // Force all stream handlers (activity/session) to transition closed so
    // higher-level consumers can re-subscribe on the new socket.
    this.protocol.notifySubscriptionsClosed(reconnectError);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.connectionPromise = null;
    await this.ensureConnected();
  }

  sendMessage(msg: RemoteClientMessage): void {
    this.send(msg);
  }

  onDeviceMessage(handler: (msg: DeviceServerMessage) => void): () => void {
    return this.protocol.onDeviceMessage(handler);
  }

  onTerminalMessage(handler: (msg: TerminalServerMessage) => void): () => void {
    return this.protocol.onTerminalMessage(handler);
  }

  close(): void {
    this.protocol.close();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

/**
 * Singleton WebSocketConnection instance.
 * Created lazily to avoid connecting until needed.
 */
let wsConnectionInstance: WebSocketConnection | null = null;

export function getWebSocketConnection(): WebSocketConnection {
  if (!wsConnectionInstance) {
    wsConnectionInstance = new WebSocketConnection();
  }
  return wsConnectionInstance;
}
