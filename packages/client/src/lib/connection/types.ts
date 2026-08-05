import type {
  DeviceServerMessage,
  RemoteClientMessage,
  TerminalServerMessage,
  UploadedFile,
} from "@yep-anywhere/shared";

/**
 * WebSocket close codes that indicate non-retryable errors.
 * The client should not attempt to reconnect for these codes.
 */
export const NON_RETRYABLE_CLOSE_CODES = [
  4001, // Authentication required
  4003, // Forbidden (invalid origin)
] as const;

/**
 * Custom error for WebSocket close events that preserves the close code and reason.
 */
export class WebSocketCloseError extends Error {
  readonly code: number;
  readonly reason: string;

  constructor(code: number, reason: string) {
    const message = reason || `WebSocket closed with code ${code}`;
    super(message);
    this.name = "WebSocketCloseError";
    this.code = code;
    this.reason = reason;
  }

  /**
   * Check if this error indicates a non-retryable condition.
   */
  isNonRetryable(): boolean {
    return (NON_RETRYABLE_CLOSE_CODES as readonly number[]).includes(this.code);
  }
}

/**
 * Error for subscription-level failures (e.g., 404 "No active process for session").
 * Distinguished from transport-level errors so callers can decide whether to retry.
 */
export class SubscriptionError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SubscriptionError";
    this.status = status;
  }
}

/**
 * Check if an error is non-retryable (retrying won't help).
 */
export function isNonRetryableError(error: unknown): boolean {
  // Subscription 4xx errors (e.g., 404 "No active process") won't resolve by retrying.
  // The activity stream will trigger a fresh subscription when the process starts.
  if (
    error instanceof SubscriptionError &&
    error.status >= 400 &&
    error.status < 500
  ) {
    return true;
  }
  return error instanceof WebSocketCloseError && error.isNonRetryable();
}

/**
 * Handle for an active event subscription.
 */
export interface Subscription {
  /** Stop receiving events and close the connection */
  close(): void;
}

/**
 * Handlers for stream events (session or activity).
 */
export interface StreamHandlers {
  /** Called for each event with type, optional ID, and data */
  onEvent: (
    eventType: string,
    eventId: string | undefined,
    data: unknown,
  ) => void;
  /** Called when connection opens */
  onOpen?: () => void;
  /** Called on error (will attempt reconnect for recoverable errors) */
  onError?: (error: Error) => void;
  /** Called when stream ends. Error is provided if transport closed unexpectedly. */
  onClose?: (error?: Error) => void;
}

/**
 * Options for file upload.
 */
export interface UploadOptions {
  /** Progress callback with bytes uploaded so far */
  onProgress?: (bytesUploaded: number) => void;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Chunk size in bytes (default 64KB) */
  chunkSize?: number;
}

/**
 * Connection abstraction for client-server communication.
 *
 * Implementations:
 * - DirectConnection: Uses native fetch for REST, WebSocket for uploads (localhost)
 * - WebSocketConnection: Multiplexes everything over a single WebSocket (localhost subscriptions)
 *
 * The interface abstracts HTTP requests, WebSocket subscriptions, and file uploads
 * so they can be routed through different transports.
 */
export interface Connection {
  /** Connection mode identifier */
  readonly mode: "direct";

  /**
   * Make a JSON API request.
   *
   * @param path - Request path (e.g., "/sessions")
   * @param init - Fetch options (method, body, headers, etc.)
   * @returns Parsed JSON response
   * @throws Error with status property on HTTP errors
   */
  fetch<T>(path: string, init?: RequestInit): Promise<T>;

  /**
   * Fetch binary data (images, files) and return as Blob.
   *
   * @param path - Request path (e.g., "/projects/.../upload/image.png")
   * @returns Blob containing the binary data
   * @throws Error on HTTP errors
   */
  fetchBlob(path: string): Promise<Blob>;

  /**
   * Subscribe to session events via WebSocket.
   *
   * Events include: message, status, connected, error, complete, heartbeat,
   * markdown-augment, pending, edit-augment, session-id-changed, etc.
   *
   * @param sessionId - Session to subscribe to
   * @param handlers - Event callbacks
   * @param lastEventId - Resume from this event ID (optional)
   * @param lastMessageId - Replay only session messages after this message ID (optional)
   * @returns Subscription handle with close() method
   */
  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
    lastMessageId?: string,
  ): Subscription;

  /**
   * Subscribe to activity events via WebSocket.
   *
   * Events include: file-change, session-status-changed, session-created,
   * session-updated, session-seen, process-state-changed, etc.
   *
   * @param handlers - Event callbacks
   * @returns Subscription handle with close() method
   */
  subscribeActivity(handlers: StreamHandlers): Subscription;

  /**
   * Subscribe to focused file-change events for a specific session file.
   *
   * Used by session detail UI for non-owned sessions to get reliable, targeted
   * updates without depending on broad activity-tree file watching behavior.
   *
   * @param sessionId - Session to watch
   * @param handlers - Event callbacks
   * @param options - Optional project/provider hints for server-side resolution
   * @returns Subscription handle with close() method
   */
  subscribeSessionWatch(
    sessionId: string,
    handlers: StreamHandlers,
    options?: {
      projectId?: string;
      provider?: string;
    },
  ): Subscription;

  /**
   * Subscribe to recursive file-change events for a project's working
   * directory, so the repository file tree can refresh in real time.
   *
   * @param projectId - Project ID (URL-encoded format)
   * @param handlers - Event callbacks (eventType "project-files-changed")
   * @returns Subscription handle with close() method
   */
  subscribeProjectFiles(
    projectId: string,
    handlers: StreamHandlers,
  ): Subscription;

  /**
   * Upload a file to a session.
   *
   * @param projectId - Project ID (URL-encoded format)
   * @param sessionId - Session ID
   * @param file - File to upload
   * @param options - Upload options (progress, abort signal)
   * @returns Uploaded file metadata
   */
  upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile>;

  /**
   * Send a raw protocol message (bypassing REST).
   * Used for emulator signaling messages.
   * Optional - only WebSocket-based connections support this.
   */
  sendMessage?(msg: RemoteClientMessage): void;

  /**
   * Register a handler for emulator signaling messages from the server.
   * Returns an unsubscribe function.
   * Optional - only WebSocket-based connections support this.
   */
  onDeviceMessage?(handler: (msg: DeviceServerMessage) => void): () => void;

  /**
   * Register a handler for terminal output and lifecycle messages from the
   * server. Returns an unsubscribe function.
   * Optional - only WebSocket-based connections support this.
   */
  onTerminalMessage?(handler: (msg: TerminalServerMessage) => void): () => void;
}
