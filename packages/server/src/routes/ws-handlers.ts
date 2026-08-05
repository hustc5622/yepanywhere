/**
 * Shared WebSocket handler logic for the local `/api/ws` endpoint.
 *
 * Clients send HTTP-like requests, subscriptions, and uploads over a single
 * WebSocket. Messages are plaintext (JSON text frames or binary format frames);
 * the connection is trusted at the HTTP-upgrade layer (cookie/local policy).
 */

import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { HttpBindings } from "@hono/node-server";
import type {
  RemoteClientMessage,
  UrlProjectId,
  WireRequest,
  WireSubscribe,
  WireUnsubscribe,
  WireUploadChunk,
  WireUploadEnd,
  WireUploadStart,
  YepMessage,
} from "@yep-anywhere/shared";
import {
  BinaryFormat,
  UploadChunkError,
  decodeUploadChunkPayload,
  encodeCompressedJsonFrame,
} from "@yep-anywhere/shared";
import type { Hono } from "hono";
import type { DeviceBridgeService } from "../device/DeviceBridgeService.js";
import { getLogger } from "../logging/logger.js";
import { WS_INTERNAL_AUTHENTICATED } from "../middleware/internal-auth.js";
import type {
  BrowserProfileService,
  ConnectedBrowsersService,
} from "../services/index.js";
import {
  createActivitySubscription,
  createSessionSubscription,
} from "../subscriptions.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { TerminalService } from "../terminal/TerminalService.js";
import type { UploadManager } from "../uploads/manager.js";
import type {
  EventBus,
  FocusedSessionWatchManager,
  ProjectFileWatchManager,
} from "../watcher/index.js";
import {
  decodeFrameToParsedMessage,
  routeClientMessageSafely,
} from "./ws-message-router.js";

/** Progress report interval in bytes (64KB) */
export const PROGRESS_INTERVAL = 64 * 1024;
export const WS_JSON_COMPRESSION_THRESHOLD_BYTES = 16 * 1024;

const textEncoder = new TextEncoder();
const gzipAsync = promisify(gzip);

/** Per-connection state for the WebSocket connection. */
export interface ConnectionState {
  /** Whether outbound JSON messages should use binary frames. */
  useBinaryFrames: boolean;
  /** Whether the peer advertised support for compressed JSON frames. */
  useCompressedJsonFrames: boolean;
}

/** Tracks an active upload over the WebSocket */
export interface WsUploadState {
  /** Client-provided upload ID */
  clientUploadId: string;
  /** Server-generated upload ID from UploadManager */
  serverUploadId: string;
  /** Expected total size */
  expectedSize: number;
  /** Bytes received (for offset validation) */
  bytesReceived: number;
  /** Last progress report sent */
  lastProgressReport: number;
  /** Pending chunk write promises (awaited before completing upload) */
  pendingWrites: Promise<void>[];
}

/**
 * Adapter interface for WebSocket send/close operations.
 * Both Hono's WSContext and raw ws.WebSocket can be adapted to this interface.
 * Note: Hono's WSContext.send uses Uint8Array<ArrayBuffer> (not ArrayBufferLike)
 */
export interface WSAdapter {
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

/**
 * Encryption-aware send function type.
 * Created per-connection, captures connection state for automatic encryption.
 */
export type SendFn = (msg: YepMessage) => void;

/**
 * Dependencies for the WebSocket handlers.
 */
export interface WsHandlerDeps {
  /** The main Hono app to route requests through */
  app: Hono<{ Bindings: HttpBindings }>;
  /** Base URL for internal requests (e.g., "http://localhost:3400") */
  baseUrl: string;
  /**
   * Reverse-proxy URL prefix to prepend to tunneled request paths before
   * they hit the Hono app. Clients send protocol-level paths like
   * "/api/foo" that are agnostic of the deploy prefix; we apply the
   * prefix here so the wrapped Hono routes (`${basePath}/api/foo`) match.
   */
  basePath?: string;
  /** Supervisor for subscribing to session events */
  supervisor: Supervisor;
  /** Event bus for subscribing to activity events */
  eventBus: EventBus;
  /** Upload manager for handling file uploads */
  uploadManager: UploadManager;
  /** Connected browsers service for tracking WS connections (optional) */
  connectedBrowsers?: ConnectedBrowsersService;
  /** Browser profile service for tracking connection origins (optional) */
  browserProfileService?: BrowserProfileService;
  /** Focused session watch manager for per-session targeted file watching (optional) */
  focusedSessionWatchManager?: FocusedSessionWatchManager;
  /** Per-project repository file watcher for real-time repo tree updates (optional) */
  projectFileWatchManager?: ProjectFileWatchManager;
  /** Emulator bridge service for Android emulator streaming (optional) */
  deviceBridgeService?: DeviceBridgeService;
  /** Terminal service for remote shell sessions (optional) */
  terminalService?: TerminalService;
}

/**
 * Create an initial connection state.
 */
export function createConnectionState(options?: {
  useCompressedJsonFrames?: boolean;
}): ConnectionState {
  return {
    useBinaryFrames: true,
    useCompressedJsonFrames: options?.useCompressedJsonFrames ?? false,
  };
}

export function cleanupConnectionState(_connState: ConnectionState): void {
  // No per-connection resources to release for plaintext local connections.
}

/**
 * Create a send function for a connection.
 * Uses binary JSON frames by default while preserving text-frame input support.
 */
export function createSendFn(
  ws: WSAdapter,
  connState: ConnectionState,
): SendFn {
  let sendQueue = Promise.resolve();
  let sendFailed = false;

  const sendOne = async (msg: YepMessage): Promise<void> => {
    if (sendFailed) return;

    try {
      if (connState.useBinaryFrames) {
        ws.send(
          await encodeJsonMessageFrame(msg, connState.useCompressedJsonFrames),
        );
      } else {
        ws.send(JSON.stringify(msg));
      }
    } catch (err) {
      sendFailed = true;
      console.warn("[WS] Failed to send message, closing socket:", err);
      try {
        ws.close(1011, "Send failed");
      } catch {
        // Socket already closing/closed
      }
    }
  };

  return (msg: YepMessage) => {
    sendQueue = sendQueue.then(
      () => sendOne(msg),
      () => sendOne(msg),
    );
  };
}

async function encodeJsonMessageFrame(
  msg: YepMessage,
  allowCompression: boolean,
): Promise<ArrayBuffer> {
  const jsonBytes = textEncoder.encode(JSON.stringify(msg));

  if (
    allowCompression &&
    jsonBytes.length >= WS_JSON_COMPRESSION_THRESHOLD_BYTES
  ) {
    try {
      const compressed = await gzipAsync(jsonBytes);
      if (compressed.length < jsonBytes.length) {
        return encodeCompressedJsonFrame(compressed);
      }
    } catch (err) {
      console.warn("[WS] Failed to compress JSON frame:", err);
    }
  }

  const buffer = new ArrayBuffer(1 + jsonBytes.length);
  const view = new Uint8Array(buffer);
  view[0] = BinaryFormat.JSON;
  view.set(jsonBytes, 1);
  return buffer;
}

/**
 * Handle a WireRequest by routing it through the Hono app.
 */
export async function handleRequest(
  request: WireRequest,
  send: SendFn,
  app: Hono<{ Bindings: HttpBindings }>,
  baseUrl: string,
  basePath = "",
): Promise<void> {
  try {
    // Clients send logical paths (e.g. "/api/foo") that do not know
    // about reverse-proxy prefixes; prepend the deploy basePath so the
    // request matches the routes registered on the Hono app.
    const prefixed = basePath
      ? `${basePath}${request.path.startsWith("/") ? "" : "/"}${request.path}`
      : request.path;
    const url = new URL(prefixed, baseUrl);
    const headers = new Headers(request.headers);
    headers.set("X-Yep-Anywhere", "true");
    headers.set("X-Ws-Internal", "true");
    if (request.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const fetchInit: RequestInit = {
      method: request.method,
      headers,
    };

    if (
      request.body !== undefined &&
      request.method !== "GET" &&
      request.method !== "DELETE"
    ) {
      fetchInit.body = JSON.stringify(request.body);
    }

    const fetchRequest = new Request(url.toString(), fetchInit);
    // Local WS connections are trusted at the HTTP-upgrade layer, so mark
    // routed API requests as internally authenticated to skip cookie re-checks.
    const internalEnv = { [WS_INTERNAL_AUTHENTICATED]: true };
    const response = await app.fetch(fetchRequest, internalEnv);

    let body: unknown;
    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        body = await response.json();
      } catch {
        body = null;
      }
    } else if (
      contentType.startsWith("image/") ||
      contentType.startsWith("audio/") ||
      contentType.startsWith("video/") ||
      contentType === "application/octet-stream"
    ) {
      // Binary content: read as ArrayBuffer and encode as base64
      const arrayBuffer = await response.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const base64 = Buffer.from(bytes).toString("base64");
      body = { _binary: true, data: base64 };
    } else {
      const text = await response.text();
      body = text || null;
    }

    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of response.headers.entries()) {
      if (
        key.toLowerCase().startsWith("x-") ||
        key.toLowerCase() === "content-type" ||
        key.toLowerCase() === "etag"
      ) {
        responseHeaders[key] = value;
      }
    }

    send({
      type: "response",
      id: request.id,
      status: response.status,
      headers:
        Object.keys(responseHeaders).length > 0 ? responseHeaders : undefined,
      body,
    });
  } catch (err) {
    console.error("[WS] Request error:", err);
    send({
      type: "response",
      id: request.id,
      status: 500,
      body: { error: "Internal server error" },
    });
  }
}

/**
 * Handle a session subscription.
 * Subscribes to process events, computes augments, and forwards them as WireEvent messages.
 */
export function handleSessionSubscribe(
  subscriptions: Map<string, () => void>,
  msg: WireSubscribe,
  send: SendFn,
  supervisor: Supervisor,
): void {
  const { subscriptionId, sessionId } = msg;

  if (!sessionId) {
    send({
      type: "response",
      id: subscriptionId,
      status: 400,
      body: { error: "sessionId required for session channel" },
    });
    return;
  }

  const process = supervisor.getProcessForSession(sessionId);
  if (!process) {
    send({
      type: "response",
      id: subscriptionId,
      status: 404,
      body: { error: "No active process for session" },
    });
    return;
  }

  let eventId = 0;
  const sendEvent = (eventType: string, data: unknown) => {
    send({
      type: "event",
      subscriptionId,
      eventType,
      eventId: String(eventId++),
      data,
    });
  };

  const { cleanup } = createSessionSubscription(process, sendEvent, {
    replayAfterMessageId: msg.lastMessageId,
    onError: (err) => {
      console.error("[WS] Error in session subscription:", err);
    },
  });

  subscriptions.set(subscriptionId, cleanup);

  console.log(`[WS] Subscribed to session ${sessionId} (${subscriptionId})`);
}

/**
 * Handle an activity subscription.
 * Subscribes to event bus and forwards events as WireEvent messages.
 */
export function handleActivitySubscribe(
  subscriptions: Map<string, () => void>,
  msg: WireSubscribe,
  send: SendFn,
  eventBus: EventBus,
  connectedBrowsers?: ConnectedBrowsersService,
  browserProfileService?: BrowserProfileService,
): void {
  const { subscriptionId, browserProfileId, originMetadata } = msg;

  // Track connection if we have the service and a browserProfileId
  let connectionId: number | undefined;
  if (connectedBrowsers && browserProfileId) {
    connectionId = connectedBrowsers.connect(browserProfileId, "ws");
  }

  // Record origin metadata if available
  if (browserProfileService && browserProfileId && originMetadata) {
    browserProfileService
      .recordConnection(browserProfileId, originMetadata)
      .catch((err) => {
        console.warn("[WS] Failed to record browser profile origin:", err);
      });
  }

  let eventId = 0;
  const sendEvent = (eventType: string, data: unknown) => {
    send({
      type: "event",
      subscriptionId,
      eventType,
      eventId: String(eventId++),
      data,
    });
  };

  const { cleanup } = createActivitySubscription(eventBus, sendEvent, {
    logLabel: subscriptionId,
    onError: (err) => {
      console.error("[WS] Error in activity subscription:", err);
    },
  });

  subscriptions.set(subscriptionId, () => {
    cleanup();
    if (connectionId !== undefined && connectedBrowsers) {
      connectedBrowsers.disconnect(connectionId);
    }
  });

  getLogger().debug(`[WS] Subscribed to activity (${subscriptionId})`);
}

/**
 * Handle a focused session-watch subscription.
 * Subscribes to targeted file-change events for a single session file.
 */
export function handleSessionWatchSubscribe(
  subscriptions: Map<string, () => void>,
  msg: WireSubscribe,
  send: SendFn,
  focusedSessionWatchManager?: FocusedSessionWatchManager,
): void {
  const { subscriptionId, sessionId, projectId, provider } = msg;

  if (!focusedSessionWatchManager) {
    send({
      type: "response",
      id: subscriptionId,
      status: 503,
      body: { error: "Session watch service unavailable" },
    });
    return;
  }

  if (!sessionId || !projectId) {
    send({
      type: "response",
      id: subscriptionId,
      status: 400,
      body: {
        error: "sessionId and projectId required for session-watch channel",
      },
    });
    return;
  }

  let eventId = 0;
  const sendEvent = (eventType: string, data: unknown) => {
    send({
      type: "event",
      subscriptionId,
      eventType,
      eventId: String(eventId++),
      data,
    });
  };

  sendEvent("connected", { timestamp: new Date().toISOString() });

  const heartbeatInterval = setInterval(() => {
    sendEvent("heartbeat", { timestamp: new Date().toISOString() });
  }, 30_000);

  const cleanupFocusedWatch = focusedSessionWatchManager.subscribe(
    {
      sessionId,
      projectId: projectId as UrlProjectId,
      providerHint: provider,
    },
    (event) => {
      sendEvent("session-watch-change", event);
    },
  );

  subscriptions.set(subscriptionId, () => {
    clearInterval(heartbeatInterval);
    cleanupFocusedWatch();
  });

  getLogger().debug(
    `[WS] Subscribed to session-watch ${sessionId} (${subscriptionId})`,
  );
}

/**
 * Handle a project-repo file-change subscription.
 * Subscribes to recursive file-change events for a project's working
 * directory so the client can refresh its repository file tree in real time.
 */
export function handleProjectFilesSubscribe(
  subscriptions: Map<string, () => void>,
  msg: WireSubscribe,
  send: SendFn,
  projectFileWatchManager?: ProjectFileWatchManager,
): void {
  const { subscriptionId, projectId } = msg;

  if (!projectFileWatchManager) {
    send({
      type: "response",
      id: subscriptionId,
      status: 503,
      body: { error: "Project file watch service unavailable" },
    });
    return;
  }

  if (!projectId) {
    send({
      type: "response",
      id: subscriptionId,
      status: 400,
      body: { error: "projectId required for project-files channel" },
    });
    return;
  }

  let eventId = 0;
  const sendEvent = (eventType: string, data: unknown) => {
    send({
      type: "event",
      subscriptionId,
      eventType,
      eventId: String(eventId++),
      data,
    });
  };

  sendEvent("connected", { timestamp: new Date().toISOString() });

  const heartbeatInterval = setInterval(() => {
    sendEvent("heartbeat", { timestamp: new Date().toISOString() });
  }, 30_000);

  const cleanupWatch = projectFileWatchManager.subscribe(
    projectId as UrlProjectId,
    (event) => {
      sendEvent("project-files-changed", event);
    },
  );

  subscriptions.set(subscriptionId, () => {
    clearInterval(heartbeatInterval);
    cleanupWatch();
  });

  getLogger().debug(
    `[WS] Subscribed to project-files ${projectId} (${subscriptionId})`,
  );
}

/**
 * Handle a subscribe message.
 */
export function handleSubscribe(
  subscriptions: Map<string, () => void>,
  msg: WireSubscribe,
  send: SendFn,
  supervisor: Supervisor,
  eventBus: EventBus,
  focusedSessionWatchManager?: FocusedSessionWatchManager,
  connectedBrowsers?: ConnectedBrowsersService,
  browserProfileService?: BrowserProfileService,
  projectFileWatchManager?: ProjectFileWatchManager,
): void {
  const { subscriptionId, channel } = msg;

  if (subscriptions.has(subscriptionId)) {
    send({
      type: "response",
      id: subscriptionId,
      status: 400,
      body: { error: "Subscription ID already in use" },
    });
    return;
  }

  switch (channel) {
    case "session":
      handleSessionSubscribe(subscriptions, msg, send, supervisor);
      break;

    case "activity":
      handleActivitySubscribe(
        subscriptions,
        msg,
        send,
        eventBus,
        connectedBrowsers,
        browserProfileService,
      );
      break;

    case "session-watch":
      handleSessionWatchSubscribe(
        subscriptions,
        msg,
        send,
        focusedSessionWatchManager,
      );
      break;

    case "project-files":
      handleProjectFilesSubscribe(
        subscriptions,
        msg,
        send,
        projectFileWatchManager,
      );
      break;

    default:
      send({
        type: "response",
        id: subscriptionId,
        status: 400,
        body: { error: `Unknown channel: ${channel}` },
      });
  }
}

/**
 * Handle an unsubscribe message.
 */
export function handleUnsubscribe(
  subscriptions: Map<string, () => void>,
  msg: WireUnsubscribe,
): void {
  const { subscriptionId } = msg;
  const cleanup = subscriptions.get(subscriptionId);
  if (cleanup) {
    cleanup();
    subscriptions.delete(subscriptionId);
    getLogger().debug(`[WS] Unsubscribed (${subscriptionId})`);
  }
}

/**
 * Handle upload_start message.
 */
export async function handleUploadStart(
  uploads: Map<string, WsUploadState>,
  msg: WireUploadStart,
  send: SendFn,
  uploadManager: UploadManager,
): Promise<void> {
  const { uploadId, projectId, sessionId, filename, size, mimeType } = msg;

  if (uploads.has(uploadId)) {
    send({
      type: "upload_error",
      uploadId,
      error: "Upload ID already in use",
    });
    return;
  }

  try {
    const { uploadId: serverUploadId } = await uploadManager.startUpload(
      projectId,
      sessionId,
      filename,
      size,
      mimeType,
    );

    uploads.set(uploadId, {
      clientUploadId: uploadId,
      serverUploadId,
      expectedSize: size,
      bytesReceived: 0,
      lastProgressReport: 0,
      pendingWrites: [],
    });

    send({ type: "upload_progress", uploadId, bytesReceived: 0 });

    console.log(
      `[WS] Upload started: ${uploadId} (${filename}, ${size} bytes)`,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to start upload";
    send({ type: "upload_error", uploadId, error: message });
  }
}

/**
 * Handle upload_chunk message.
 */
export async function handleUploadChunk(
  uploads: Map<string, WsUploadState>,
  msg: WireUploadChunk,
  send: SendFn,
  uploadManager: UploadManager,
): Promise<void> {
  const { uploadId, offset, data } = msg;

  const state = uploads.get(uploadId);
  if (!state) {
    send({ type: "upload_error", uploadId, error: "Upload not found" });
    return;
  }

  if (offset !== state.bytesReceived) {
    send({
      type: "upload_error",
      uploadId,
      error: `Invalid offset: expected ${state.bytesReceived}, got ${offset}`,
    });
    return;
  }

  // Track this write so handleUploadEnd can wait for it
  let writeResolve!: () => void;
  const writeTracker = new Promise<void>((resolve) => {
    writeResolve = resolve;
  });
  state.pendingWrites.push(writeTracker);

  try {
    const chunk = Buffer.from(data, "base64");
    const bytesReceived = await uploadManager.writeChunk(
      state.serverUploadId,
      chunk,
    );

    state.bytesReceived = bytesReceived;

    if (
      bytesReceived - state.lastProgressReport >= PROGRESS_INTERVAL ||
      bytesReceived === state.expectedSize
    ) {
      send({ type: "upload_progress", uploadId, bytesReceived });
      state.lastProgressReport = bytesReceived;
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to write chunk";
    send({ type: "upload_error", uploadId, error: message });
    uploads.delete(uploadId);
    try {
      await uploadManager.cancelUpload(state.serverUploadId);
    } catch {
      // Ignore cleanup errors
    }
  } finally {
    writeResolve?.();
  }
}

/**
 * Handle binary upload chunk (format 0x02).
 * Payload format: [16 bytes UUID][8 bytes offset big-endian][chunk data]
 */
export async function handleBinaryUploadChunk(
  uploads: Map<string, WsUploadState>,
  payload: Uint8Array,
  send: SendFn,
  uploadManager: UploadManager,
): Promise<void> {
  let uploadId: string;
  let offset: number;
  let data: Uint8Array;
  try {
    ({ uploadId, offset, data } = decodeUploadChunkPayload(payload));
  } catch (e) {
    const message =
      e instanceof UploadChunkError
        ? `Invalid upload chunk: ${e.message}`
        : "Invalid binary upload chunk format";
    console.warn(`[WS] ${message}`, e);
    send({
      type: "response",
      id: "binary-upload-error",
      status: 400,
      body: { error: message },
    });
    return;
  }

  const state = uploads.get(uploadId);
  if (!state) {
    send({ type: "upload_error", uploadId, error: "Upload not found" });
    return;
  }

  if (offset !== state.bytesReceived) {
    send({
      type: "upload_error",
      uploadId,
      error: `Invalid offset: expected ${state.bytesReceived}, got ${offset}`,
    });
    return;
  }

  // Track this write so handleUploadEnd can wait for it
  let writeResolve!: () => void;
  const writeTracker = new Promise<void>((resolve) => {
    writeResolve = resolve;
  });
  state.pendingWrites.push(writeTracker);

  try {
    const bytesReceived = await uploadManager.writeChunk(
      state.serverUploadId,
      Buffer.from(data),
    );

    state.bytesReceived = bytesReceived;

    if (
      bytesReceived - state.lastProgressReport >= PROGRESS_INTERVAL ||
      bytesReceived === state.expectedSize
    ) {
      send({ type: "upload_progress", uploadId, bytesReceived });
      state.lastProgressReport = bytesReceived;
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to write chunk";
    send({ type: "upload_error", uploadId, error: message });
    uploads.delete(uploadId);
    try {
      await uploadManager.cancelUpload(state.serverUploadId);
    } catch {
      // Ignore cleanup errors
    }
  } finally {
    writeResolve?.();
  }
}

/**
 * Handle upload_end message.
 */
export async function handleUploadEnd(
  uploads: Map<string, WsUploadState>,
  msg: WireUploadEnd,
  send: SendFn,
  uploadManager: UploadManager,
): Promise<void> {
  const { uploadId } = msg;

  const state = uploads.get(uploadId);
  if (!state) {
    send({ type: "upload_error", uploadId, error: "Upload not found" });
    return;
  }

  // Wait for any pending chunk writes to complete before finalizing
  await Promise.all(state.pendingWrites);

  try {
    const file = await uploadManager.completeUpload(state.serverUploadId);
    uploads.delete(uploadId);
    send({ type: "upload_complete", uploadId, file });
    getLogger().debug(`[WS] Upload complete: ${uploadId} (${file.size} bytes)`);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to complete upload";
    send({ type: "upload_error", uploadId, error: message });
    uploads.delete(uploadId);
    try {
      await uploadManager.cancelUpload(state.serverUploadId);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Clean up all active uploads for a connection.
 */
export async function cleanupUploads(
  uploads: Map<string, WsUploadState>,
  uploadManager: UploadManager,
): Promise<void> {
  for (const [clientId, state] of uploads) {
    try {
      await uploadManager.cancelUpload(state.serverUploadId);
      console.log(`[WS] Cancelled upload on disconnect: ${clientId}`);
    } catch (err) {
      console.error(`[WS] Error cancelling upload ${clientId}:`, err);
    }
  }
  uploads.clear();
}

/**
 * Options for handleMessage.
 */
export interface HandleMessageOptions {
  /**
   * Whether the message was received as a binary frame.
   * If provided, this takes precedence over isBinaryData() check.
   * Required for raw ws connections where all data arrives as Buffers.
   */
  isBinary?: boolean;
}

/**
 * Handle incoming WebSocket messages.
 * Supports both text frames (JSON) and binary frames (format byte + payload or encrypted envelope).
 */
export async function handleMessage(
  ws: WSAdapter,
  subscriptions: Map<string, () => void>,
  uploads: Map<string, WsUploadState>,
  connState: ConnectionState,
  send: SendFn,
  data: unknown,
  deps: WsHandlerDeps,
  options: HandleMessageOptions,
  deviceSessions?: Set<string>,
  terminalAttachId?: string,
): Promise<void> {
  const { app, baseUrl, supervisor, eventBus, uploadManager } = deps;

  // Debug: log incoming data type and preview
  // Check Buffer BEFORE Uint8Array since Buffer extends Uint8Array
  const dataType =
    data === null
      ? "null"
      : data === undefined
        ? "undefined"
        : typeof data === "string"
          ? `string(${data.length})`
          : Buffer.isBuffer(data)
            ? `Buffer(${data.length})`
            : data instanceof ArrayBuffer
              ? `ArrayBuffer(${data.byteLength})`
              : data instanceof Uint8Array
                ? `Uint8Array(${data.length})`
                : `unknown(${typeof data})`;
  const preview =
    typeof data === "string"
      ? data.slice(0, 100)
      : data instanceof Uint8Array || Buffer.isBuffer(data)
        ? `[${Array.from(data.slice(0, 20))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(" ")}...]`
        : String(data).slice(0, 100);
  getLogger().debug(
    `[WS] handleMessage: type=${dataType}, isBinary=${options.isBinary}, preview=${preview}`,
  );

  const routeClientMessage = async (msg: RemoteClientMessage): Promise<void> =>
    routeClientMessageSafely(msg, send, {
      onRequest: async (requestMsg) =>
        handleRequest(requestMsg, send, app, baseUrl, deps.basePath),
      onSubscribe: async (subscribeMsg) =>
        handleSubscribe(
          subscriptions,
          subscribeMsg,
          send,
          supervisor,
          eventBus,
          deps.focusedSessionWatchManager,
          deps.connectedBrowsers,
          deps.browserProfileService,
          deps.projectFileWatchManager,
        ),
      onUnsubscribe: async (unsubscribeMsg) =>
        handleUnsubscribe(subscriptions, unsubscribeMsg),
      onUploadStart: async (uploadStartMsg) =>
        handleUploadStart(uploads, uploadStartMsg, send, uploadManager),
      onUploadChunk: async (uploadChunkMsg) =>
        handleUploadChunk(uploads, uploadChunkMsg, send, uploadManager),
      onUploadEnd: async (uploadEndMsg) =>
        handleUploadEnd(uploads, uploadEndMsg, send, uploadManager),
      onPing: async (pingMsg) => send({ type: "pong", id: pingMsg.id }),
      onDeviceMessage: deps.deviceBridgeService
        ? (() => {
            const bridge = deps.deviceBridgeService;
            return async (emulatorMsg: RemoteClientMessage) => {
              switch (emulatorMsg.type) {
                case "device_stream_start":
                  deviceSessions?.add(emulatorMsg.sessionId);
                  await bridge.startStream(emulatorMsg, send);
                  break;
                case "device_stream_stop":
                  deviceSessions?.delete(emulatorMsg.sessionId);
                  bridge.stopStream(emulatorMsg);
                  break;
                case "device_webrtc_answer":
                  bridge.handleAnswer(emulatorMsg);
                  break;
                case "device_ice_candidate":
                  bridge.handleICE(emulatorMsg);
                  break;
              }
            };
          })()
        : undefined,
      onTerminalMessage:
        deps.terminalService && terminalAttachId
          ? (() => {
              const svc = deps.terminalService;
              const attachId = terminalAttachId;
              return async (msg: RemoteClientMessage) => {
                switch (msg.type) {
                  case "terminal_open":
                  case "terminal_input":
                  case "terminal_resize":
                  case "terminal_close":
                    await svc.handleMessage(msg, attachId, send);
                    break;
                }
              };
            })()
          : undefined,
    });

  const parsed = await decodeFrameToParsedMessage(
    ws,
    data,
    options,
    connState,
    {
      uploads,
      send,
      uploadManager,
      handleBinaryUploadChunk,
    },
  );
  if (parsed === null) {
    return;
  }

  await routeClientMessage(parsed as RemoteClientMessage);
}

/**
 * Clean up emulator streaming sessions on connection close.
 */
export function cleanupDeviceSessions(
  deviceSessions: Set<string>,
  deviceBridgeService?: DeviceBridgeService,
): void {
  if (!deviceBridgeService || deviceSessions.size === 0) return;
  for (const sessionId of deviceSessions) {
    try {
      deviceBridgeService.stopStream({
        type: "device_stream_stop",
        sessionId,
      });
    } catch (err) {
      console.error(
        `[WS] Error cleaning up emulator session ${sessionId}:`,
        err,
      );
    }
  }
  deviceSessions.clear();
}

/**
 * Detach all terminals attached over this connection. The server-side PTYs
 * keep running (server-owned process model) and will be GC'd after the
 * idle timeout if no other client reattaches.
 */
export function cleanupTerminalAttachments(
  terminalAttachId: string | undefined,
  terminalService?: TerminalService,
): void {
  if (!terminalAttachId || !terminalService) return;
  try {
    terminalService.detachAll(terminalAttachId);
  } catch (err) {
    console.error("[WS] Error detaching terminals:", err);
  }
}

/**
 * Clean up subscriptions on connection close.
 */
export function cleanupSubscriptions(
  subscriptions: Map<string, () => void>,
): void {
  for (const [id, cleanup] of subscriptions) {
    try {
      cleanup();
    } catch (err) {
      console.error(`[WS] Error cleaning up subscription ${id}:`, err);
    }
  }
  subscriptions.clear();
}
