import type {
  ClientPing,
  DeviceServerMessage,
  RemoteClientMessage,
  ServerPong,
  TerminalServerMessage,
  UploadedFile,
  WireEvent,
  WireRequest,
  WireResponse,
  WireSubscribe,
  WireUnsubscribe,
  WireUploadComplete,
  WireUploadEnd,
  WireUploadError,
  WireUploadProgress,
  WireUploadStart,
  YepMessage,
} from "@yep-anywhere/shared";
import { getOrCreateBrowserProfileId } from "../storageKeys";
import { generateUUID } from "../uuid";
import type { StreamHandlers, Subscription, UploadOptions } from "./types";
import { SubscriptionError } from "./types";

/**
 * Transport callbacks injected by the owning connection class.
 * These abstract the difference between plain WS and encrypted WS.
 */
export interface WireTransport {
  sendMessage(msg: RemoteClientMessage): void;
  sendUploadChunk(uploadId: string, offset: number, chunk: Uint8Array): void;
  ensureConnected(): Promise<void>;
  isConnected(): boolean;
}

export type EmulatorMessageHandler = (msg: DeviceServerMessage) => void;
export type TerminalMessageHandler = (msg: TerminalServerMessage) => void;

export interface WireProtocolOptions {
  debugEnabled?: () => boolean;
  logPrefix?: string;
  onPong?: (id: string) => void;
}

function generateId(): string {
  return generateUUID();
}

function isActivityDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Window & { __ACTIVITY_DEBUG__?: boolean };
  if (w.__ACTIVITY_DEBUG__ === true) return true;
  try {
    return localStorage.getItem("yep-anywhere-activity-debug") === "true";
  } catch {
    return false;
  }
}

/** Default chunk size for file uploads (64KB) */
const DEFAULT_CHUNK_SIZE = 64 * 1024;

interface PendingRequest {
  resolve: (response: WireResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  startTime?: number;
  method?: string;
  path?: string;
}

interface PendingUpload {
  resolve: (file: UploadedFile) => void;
  reject: (error: Error) => void;
  onProgress?: (bytesUploaded: number) => void;
}

/**
 * Shared wire protocol logic for routing messages, managing subscriptions,
 * and coordinating request/response correlation.
 *
 * WebSocketConnection composes this class, providing transport-specific
 * send/receive via WireTransport callbacks.
 */
export class WireProtocol {
  readonly pendingRequests = new Map<string, PendingRequest>();
  readonly pendingUploads = new Map<string, PendingUpload>();
  readonly subscriptions = new Map<string, StreamHandlers>();
  /** Recently-closed subscription IDs — suppresses warnings for in-flight events */
  private recentlyClosed = new Set<string>();
  /** Registered handlers for emulator signaling messages */
  private emulatorHandlers = new Set<EmulatorMessageHandler>();
  /** Registered handlers for terminal output / lifecycle messages */
  private terminalHandlers = new Set<TerminalMessageHandler>();

  private transport: WireTransport;
  private options: WireProtocolOptions;

  constructor(transport: WireTransport, options: WireProtocolOptions = {}) {
    this.transport = transport;
    this.options = options;
  }

  private get logPrefix(): string {
    return this.options.logPrefix ?? "[WireProtocol]";
  }

  private get debugEnabled(): boolean {
    return this.options.debugEnabled?.() ?? false;
  }

  /**
   * Send a keepalive ping to verify the connection is alive.
   * Throws if the transport is not connected.
   */
  sendPing(id: string): void {
    const msg: ClientPing = { type: "ping", id };
    this.transport.sendMessage(msg);
  }

  /**
   * Set the callback for pong responses.
   */
  setOnPong(cb: (id: string) => void): void {
    this.options.onPong = cb;
  }

  /**
   * Route an incoming message to the appropriate handler.
   */
  routeMessage(msg: YepMessage): void {
    switch (msg.type) {
      case "response":
        this.handleResponse(msg);
        break;
      case "event":
        this.handleEvent(msg);
        break;
      case "upload_progress":
        this.handleUploadProgress(msg);
        break;
      case "upload_complete":
        this.handleUploadComplete(msg);
        break;
      case "upload_error":
        this.handleUploadError(msg);
        break;
      case "pong":
        this.options.onPong?.(msg.id);
        break;
      // Emulator signaling messages (server → client push)
      case "device_webrtc_offer":
      case "device_ice_candidate_event":
      case "device_session_state":
      case "device_stream_profile_event":
        this.handleEmulatorMessage(msg as DeviceServerMessage);
        break;
      // Remote terminal messages (server → client push)
      case "terminal_opened":
      case "terminal_output":
      case "terminal_exit":
      case "terminal_error":
        this.handleTerminalMessage(msg as TerminalServerMessage);
        break;
      default:
        console.warn(
          `${this.logPrefix} Unknown message type:`,
          (msg as { type?: string }).type,
        );
    }
  }

  private handleEmulatorMessage(msg: DeviceServerMessage): void {
    for (const handler of this.emulatorHandlers) {
      handler(msg);
    }
  }

  /**
   * Register a handler for emulator signaling messages.
   * Returns an unsubscribe function.
   */
  onDeviceMessage(handler: EmulatorMessageHandler): () => void {
    this.emulatorHandlers.add(handler);
    return () => {
      this.emulatorHandlers.delete(handler);
    };
  }

  private handleTerminalMessage(msg: TerminalServerMessage): void {
    for (const handler of this.terminalHandlers) {
      handler(msg);
    }
  }

  /**
   * Register a handler for terminal output / lifecycle messages.
   * Returns an unsubscribe function.
   */
  onTerminalMessage(handler: TerminalMessageHandler): () => void {
    this.terminalHandlers.add(handler);
    return () => {
      this.terminalHandlers.delete(handler);
    };
  }

  private handleEvent(event: WireEvent): void {
    const handlers = this.subscriptions.get(event.subscriptionId);
    const logEventDebug = this.debugEnabled || isActivityDebugEnabled();

    if (logEventDebug) {
      console.log(
        `${this.logPrefix} Received event:`,
        event.eventType,
        `sub=${event.subscriptionId}`,
        event.data,
      );
    }

    if (!handlers) {
      // Suppress warnings for subscriptions that were recently closed — the
      // server may still send a few events before it processes our unsubscribe.
      if (!this.recentlyClosed.has(event.subscriptionId)) {
        console.warn(
          `${this.logPrefix} Received event for unknown subscription: ${event.subscriptionId} (${event.eventType})`,
        );
      }
      return;
    }

    if (event.eventType === "connected") {
      handlers.onOpen?.();
    }

    handlers.onEvent(event.eventType, event.eventId, event.data);
  }

  private handleResponse(response: WireResponse): void {
    // Check if this is a subscription error response.
    // When a session subscription fails (e.g., 404 for no active process),
    // the server sends a response with id=subscriptionId.
    const subscriptionHandlers = this.subscriptions.get(response.id);
    if (subscriptionHandlers && response.status >= 400) {
      const errorMessage =
        typeof response.body === "object" &&
        response.body !== null &&
        "error" in response.body
          ? String((response.body as { error: unknown }).error)
          : `Subscription failed with status ${response.status}`;
      console.log(
        `${this.logPrefix} Subscription ${response.id} failed: ${errorMessage}`,
      );
      this.subscriptions.delete(response.id);
      subscriptionHandlers.onError?.(
        new SubscriptionError(response.status, errorMessage),
      );
      return;
    }

    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.warn(
        `${this.logPrefix} Received response for unknown request:`,
        response.id,
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    if (this.debugEnabled && pending.startTime != null) {
      const duration = Date.now() - pending.startTime;
      const statusIcon = response.status >= 400 ? "\u2717" : "\u2190";
      const responseSize = JSON.stringify(response.body).length;
      console.log(
        `[WS] ${statusIcon} ${pending.method} ${pending.path} ${response.status} (${duration}ms, ${responseSize} bytes)`,
      );
    }

    pending.resolve(response);
  }

  private handleUploadProgress(msg: WireUploadProgress): void {
    const pending = this.pendingUploads.get(msg.uploadId);
    if (pending?.onProgress) {
      pending.onProgress(msg.bytesReceived);
    }
  }

  private handleUploadComplete(msg: WireUploadComplete): void {
    const pending = this.pendingUploads.get(msg.uploadId);
    if (pending) {
      this.pendingUploads.delete(msg.uploadId);
      pending.resolve(msg.file);
    }
  }

  private handleUploadError(msg: WireUploadError): void {
    const pending = this.pendingUploads.get(msg.uploadId);
    if (pending) {
      this.pendingUploads.delete(msg.uploadId);
      pending.reject(new Error(msg.error));
    }
  }

  /**
   * Make a JSON API request over the WebSocket transport.
   */
  async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    await this.transport.ensureConnected();

    const id = generateId();
    const method = (init?.method ?? "GET") as WireRequest["method"];

    let body: unknown;
    if (init?.body) {
      if (typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      } else {
        body = init.body;
      }
    }

    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          headers[key] = value;
        }
      } else {
        Object.assign(headers, init.headers);
      }
    }

    headers["Content-Type"] = "application/json";
    headers["X-Yep-Anywhere"] = "true";

    const request: WireRequest = {
      type: "request",
      id,
      method,
      path: path.startsWith("/api") ? path : `/api${path}`,
      headers,
      body,
    };

    const startTime = Date.now();

    if (this.debugEnabled) {
      console.log(`[WS] \u2192 ${method} ${request.path}`);
    }

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.debugEnabled) {
          const duration = Date.now() - startTime;
          console.log(
            `[WS] \u2717 ${method} ${request.path} TIMEOUT (${duration}ms)`,
          );
        }
        this.pendingRequests.delete(id);
        reject(new Error("Request timeout"));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (response: WireResponse) => {
          if (response.status >= 400) {
            const error = new Error(
              `API error: ${response.status}`,
            ) as Error & { status: number; setupRequired?: boolean };
            error.status = response.status;
            if (response.headers?.["X-Setup-Required"] === "true") {
              error.setupRequired = true;
            }
            reject(error);
          } else {
            resolve(response.body as T);
          }
        },
        reject,
        timeout,
        startTime,
        method,
        path: request.path,
      });

      try {
        this.transport.sendMessage(request);
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Fetch binary data and return as Blob.
   */
  async fetchBlob(path: string): Promise<Blob> {
    await this.transport.ensureConnected();

    const id = generateId();
    const method = "GET";

    const request: WireRequest = {
      type: "request",
      id,
      method,
      path: path.startsWith("/api") ? path : `/api${path}`,
      headers: { "X-Yep-Anywhere": "true" },
    };

    const startTime = Date.now();

    if (this.debugEnabled) {
      console.log(`[WS] \u2192 ${method} ${request.path} (blob)`);
    }

    return new Promise<Blob>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.debugEnabled) {
          const duration = Date.now() - startTime;
          console.log(
            `[WS] \u2717 ${method} ${request.path} TIMEOUT (${duration}ms)`,
          );
        }
        this.pendingRequests.delete(id);
        reject(new Error("Request timeout"));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (response: WireResponse) => {
          if (response.status >= 400) {
            reject(new Error(`API error: ${response.status}`));
            return;
          }

          const body = response.body as { _binary?: boolean; data?: string };
          if (body?._binary && typeof body.data === "string") {
            const binary = atob(body.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            const contentType =
              response.headers?.["content-type"] ||
              response.headers?.["Content-Type"] ||
              "application/octet-stream";
            resolve(new Blob([bytes], { type: contentType }));
          } else {
            reject(new Error("Expected binary response"));
          }
        },
        reject,
        timeout,
        startTime,
        method,
        path: request.path,
      });

      try {
        this.transport.sendMessage(request);
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Subscribe to session events.
   */
  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
    lastMessageId?: string,
  ): Subscription {
    const subscriptionId = generateId();

    this.subscriptions.set(subscriptionId, handlers);

    this.transport
      .ensureConnected()
      .then(() => {
        const msg: WireSubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "session",
          sessionId,
          lastEventId,
          lastMessageId,
        };
        this.transport.sendMessage(msg);
      })
      .catch((err) => {
        handlers.onError?.(err);
        this.subscriptions.delete(subscriptionId);
      });

    return {
      close: () => {
        this.subscriptions.delete(subscriptionId);
        this.trackRecentlyClosed(subscriptionId);
        if (this.transport.isConnected()) {
          const msg: WireUnsubscribe = {
            type: "unsubscribe",
            subscriptionId,
          };
          try {
            this.transport.sendMessage(msg);
          } catch {
            // Ignore send errors on close
          }
        }
        handlers.onClose?.();
      },
    };
  }

  /**
   * Subscribe to activity events.
   */
  subscribeActivity(handlers: StreamHandlers): Subscription {
    const subscriptionId = generateId();
    const browserProfileId = getOrCreateBrowserProfileId();
    const logEventDebug = this.debugEnabled || isActivityDebugEnabled();

    const originMetadata = {
      origin: window.location.origin,
      scheme: window.location.protocol.replace(":", ""),
      hostname: window.location.hostname,
      port: window.location.port
        ? Number.parseInt(window.location.port, 10)
        : null,
      userAgent: navigator.userAgent,
    };

    this.subscriptions.set(subscriptionId, handlers);

    this.transport
      .ensureConnected()
      .then(() => {
        const msg: WireSubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "activity",
          browserProfileId,
          originMetadata,
        };
        if (logEventDebug) {
          console.log(
            `${this.logPrefix} Sending activity subscribe:`,
            subscriptionId,
          );
        }
        this.transport.sendMessage(msg);
      })
      .catch((err) => {
        handlers.onError?.(err);
        this.subscriptions.delete(subscriptionId);
      });

    return {
      close: () => {
        this.subscriptions.delete(subscriptionId);
        this.trackRecentlyClosed(subscriptionId);
        if (logEventDebug) {
          console.log(
            `${this.logPrefix} Closing activity subscribe:`,
            subscriptionId,
          );
        }
        if (this.transport.isConnected()) {
          const msg: WireUnsubscribe = {
            type: "unsubscribe",
            subscriptionId,
          };
          try {
            this.transport.sendMessage(msg);
          } catch {
            // Ignore send errors on close
          }
        }
        handlers.onClose?.();
      },
    };
  }

  /**
   * Subscribe to focused file-change events for a specific session.
   */
  subscribeSessionWatch(
    sessionId: string,
    handlers: StreamHandlers,
    options?: {
      projectId?: string;
      provider?: string;
    },
  ): Subscription {
    const subscriptionId = generateId();

    this.subscriptions.set(subscriptionId, handlers);

    this.transport
      .ensureConnected()
      .then(() => {
        const msg: WireSubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "session-watch",
          sessionId,
          projectId: options?.projectId,
          provider: options?.provider,
        };
        this.transport.sendMessage(msg);
      })
      .catch((err) => {
        handlers.onError?.(err);
        this.subscriptions.delete(subscriptionId);
      });

    return {
      close: () => {
        this.subscriptions.delete(subscriptionId);
        this.trackRecentlyClosed(subscriptionId);
        if (this.transport.isConnected()) {
          const msg: WireUnsubscribe = {
            type: "unsubscribe",
            subscriptionId,
          };
          try {
            this.transport.sendMessage(msg);
          } catch {
            // Ignore send errors on close
          }
        }
        handlers.onClose?.();
      },
    };
  }

  /**
   * Subscribe to recursive file-change events for a project's working dir.
   */
  subscribeProjectFiles(
    projectId: string,
    handlers: StreamHandlers,
  ): Subscription {
    const subscriptionId = generateId();

    this.subscriptions.set(subscriptionId, handlers);

    this.transport
      .ensureConnected()
      .then(() => {
        const msg: WireSubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "project-files",
          projectId,
        };
        this.transport.sendMessage(msg);
      })
      .catch((err) => {
        handlers.onError?.(err);
        this.subscriptions.delete(subscriptionId);
      });

    return {
      close: () => {
        this.subscriptions.delete(subscriptionId);
        this.trackRecentlyClosed(subscriptionId);
        if (this.transport.isConnected()) {
          const msg: WireUnsubscribe = {
            type: "unsubscribe",
            subscriptionId,
          };
          try {
            this.transport.sendMessage(msg);
          } catch {
            // Ignore send errors on close
          }
        }
        handlers.onClose?.();
      },
    };
  }

  /**
   * Upload a file via the WebSocket transport.
   */
  async upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile> {
    await this.transport.ensureConnected();

    const uploadId = generateId();
    const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;

    const uploadPromise = new Promise<UploadedFile>((resolve, reject) => {
      this.pendingUploads.set(uploadId, {
        resolve,
        reject,
        onProgress: options?.onProgress,
      });

      if (options?.signal) {
        options.signal.addEventListener("abort", () => {
          this.pendingUploads.delete(uploadId);
          reject(new Error("Upload aborted"));
        });
      }
    });

    try {
      const startMsg: WireUploadStart = {
        type: "upload_start",
        uploadId,
        projectId,
        sessionId,
        filename: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
      };
      this.transport.sendMessage(startMsg);

      let offset = 0;
      const reader = file.stream().getReader();

      while (true) {
        if (options?.signal?.aborted) {
          reader.cancel();
          throw new Error("Upload aborted");
        }

        const { done, value } = await reader.read();
        if (done) break;

        let chunkOffset = 0;
        while (chunkOffset < value.length) {
          const chunkEnd = Math.min(chunkOffset + chunkSize, value.length);
          const chunk = value.slice(chunkOffset, chunkEnd);

          this.transport.sendUploadChunk(uploadId, offset, chunk);

          offset += chunk.length;
          chunkOffset = chunkEnd;
        }
      }

      const endMsg: WireUploadEnd = {
        type: "upload_end",
        uploadId,
      };
      this.transport.sendMessage(endMsg);

      return await uploadPromise;
    } catch (err) {
      this.pendingUploads.delete(uploadId);
      throw err;
    }
  }

  /**
   * Reject all pending requests and uploads with the given error.
   */
  rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }

    for (const [id, pending] of this.pendingUploads) {
      pending.reject(error);
      this.pendingUploads.delete(id);
    }
  }

  /**
   * Track a subscription ID as recently closed so in-flight events are
   * silently ignored instead of triggering warnings.
   */
  private trackRecentlyClosed(id: string): void {
    this.recentlyClosed.add(id);
    setTimeout(() => this.recentlyClosed.delete(id), 5_000);
  }

  /**
   * Notify all subscriptions that the connection closed, then clear them.
   */
  notifySubscriptionsClosed(error?: Error): void {
    for (const [id, handlers] of this.subscriptions) {
      this.trackRecentlyClosed(id);
      if (error) {
        handlers.onError?.(error);
      }
      handlers.onClose?.(error);
    }
    this.subscriptions.clear();
  }

  /**
   * Clean shutdown: reject all pending, notify subscriptions, clear state.
   */
  close(): void {
    const closeError = new Error("Connection closed");

    for (const [id, handlers] of this.subscriptions) {
      this.trackRecentlyClosed(id);
      handlers.onClose?.();
    }
    this.subscriptions.clear();

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(closeError);
    }
    this.pendingRequests.clear();

    for (const pending of this.pendingUploads.values()) {
      pending.reject(closeError);
    }
    this.pendingUploads.clear();
  }
}
