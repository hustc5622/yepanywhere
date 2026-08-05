/**
 * Wire protocol types for the local WebSocket connection.
 *
 * This protocol multiplexes HTTP-like requests, SSE-style event subscriptions,
 * and file uploads over a single WebSocket connection.
 */

import type { OriginMetadata } from "./connection.js";
import type {
  DeviceICECandidate,
  DeviceICECandidateEvent,
  DeviceSessionState,
  DeviceStreamProfileEvent,
  DeviceStreamStart,
  DeviceStreamStop,
  DeviceWebRTCAnswer,
  DeviceWebRTCOffer,
} from "./devices.js";
import type {
  TerminalClose,
  TerminalError,
  TerminalExit,
  TerminalInput,
  TerminalOpen,
  TerminalOpened,
  TerminalOutput,
  TerminalResize,
} from "./terminal.js";
import type { UploadedFile } from "./upload.js";

// Re-export OriginMetadata for convenience
export type { OriginMetadata } from "./connection.js";

// ============================================================================
// Request/Response (HTTP-like)
// ============================================================================

/** HTTP method for wire requests */
export type WireHttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/** Client -> Server: HTTP-like request */
export interface WireRequest {
  type: "request";
  /** UUID for matching response */
  id: string;
  /** HTTP method */
  method: WireHttpMethod;
  /** Request path, e.g., "/api/sessions" */
  path: string;
  /** Optional headers */
  headers?: Record<string, string>;
  /** Optional request body (JSON-serializable) */
  body?: unknown;
}

/** Server -> Client: HTTP-like response */
export interface WireResponse {
  type: "response";
  /** Matches request.id */
  id: string;
  /** HTTP status code */
  status: number;
  /** Optional headers */
  headers?: Record<string, string>;
  /** Response body (JSON-serializable) */
  body?: unknown;
}

// ============================================================================
// Event Subscriptions (SSE replacement)
// ============================================================================

/** Subscription channel types */
export type WireSubscriptionChannel =
  | "session"
  | "activity"
  | "session-watch"
  | "project-files";

/** Client -> Server: Subscribe to events */
export interface WireSubscribe {
  type: "subscribe";
  /** Client-generated ID for this subscription (used to unsubscribe) */
  subscriptionId: string;
  /** Channel to subscribe to */
  channel: WireSubscriptionChannel;
  /** Required for channel: "session" */
  sessionId?: string;
  /** Required for channels: "session-watch" and "project-files" */
  projectId?: string;
  /** Optional provider hint for channel: "session-watch" */
  provider?: string;
  /** Last event ID for resumption */
  lastEventId?: string;
  /** Last replayable session message ID received by the client */
  lastMessageId?: string;
  /** Browser profile identifier for connection tracking (stored in localStorage, shared across tabs) */
  browserProfileId?: string;
  /** Origin metadata for connection tracking */
  originMetadata?: OriginMetadata;
}

/** Client -> Server: Unsubscribe from events */
export interface WireUnsubscribe {
  type: "unsubscribe";
  /** The subscriptionId from the subscribe message */
  subscriptionId: string;
}

/** Server -> Client: Event pushed to subscriber */
export interface WireEvent {
  type: "event";
  /** The subscriptionId this event belongs to */
  subscriptionId: string;
  /** Event type, e.g., "message", "status", "stream_event" */
  eventType: string;
  /** Event ID for resumption */
  eventId?: string;
  /** Event payload */
  data: unknown;
}

// ============================================================================
// Keepalive Ping/Pong
// ============================================================================

/** Client -> Server: Keepalive ping to verify connection is alive */
export interface ClientPing {
  type: "ping";
  /** Client-generated ID to correlate with pong response */
  id: string;
}

/** Server -> Client: Keepalive pong response */
export interface ServerPong {
  type: "pong";
  /** Echoed from the ping request */
  id: string;
}

// ============================================================================
// Client Capabilities (Phase 3 - Compression negotiation)
// ============================================================================

import type { BinaryFormatValue } from "./binary-framing.js";

/**
 * Client -> Server: Declare supported binary formats.
 *
 * Sent on connect before application messages. Server records supported formats
 * and uses them for outgoing messages. If no capabilities message is received,
 * server assumes only format 0x01 (JSON).
 */
export interface ClientCapabilities {
  type: "client_capabilities";
  /** Supported format bytes (e.g., [0x01, 0x02, 0x03]) */
  formats: BinaryFormatValue[];
}

/**
 * Type guard for ClientCapabilities messages.
 */
export function isClientCapabilities(msg: unknown): msg is ClientCapabilities {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: unknown }).type === "client_capabilities" &&
    Array.isArray((msg as { formats?: unknown }).formats)
  );
}

// ============================================================================
// File Upload
// ============================================================================

/** Client -> Server: Start a file upload */
export interface WireUploadStart {
  type: "upload_start";
  /** Client-generated upload ID */
  uploadId: string;
  /** Project ID (URL-encoded) */
  projectId: string;
  /** Session ID */
  sessionId: string;
  /** Original filename */
  filename: string;
  /** Total file size in bytes */
  size: number;
  /** MIME type */
  mimeType: string;
}

/** Client -> Server: Upload chunk */
export interface WireUploadChunk {
  type: "upload_chunk";
  /** Upload ID from upload_start */
  uploadId: string;
  /** Byte offset of this chunk */
  offset: number;
  /** Base64-encoded chunk data */
  data: string;
}

/** Client -> Server: End upload (all chunks sent) */
export interface WireUploadEnd {
  type: "upload_end";
  /** Upload ID from upload_start */
  uploadId: string;
}

/** Server -> Client: Upload progress update */
export interface WireUploadProgress {
  type: "upload_progress";
  /** Upload ID */
  uploadId: string;
  /** Total bytes received so far */
  bytesReceived: number;
}

/** Server -> Client: Upload completed successfully */
export interface WireUploadComplete {
  type: "upload_complete";
  /** Upload ID */
  uploadId: string;
  /** Uploaded file metadata */
  file: UploadedFile;
}

/** Server -> Client: Upload failed */
export interface WireUploadError {
  type: "upload_error";
  /** Upload ID */
  uploadId: string;
  /** Error message */
  error: string;
}

// ============================================================================
// Union Types
// ============================================================================

/** All messages from phone/browser -> yepanywhere server */
export type RemoteClientMessage =
  | WireRequest
  | WireSubscribe
  | WireUnsubscribe
  | WireUploadStart
  | WireUploadChunk
  | WireUploadEnd
  | ClientCapabilities
  | ClientPing
  // Device bridge signaling
  | DeviceStreamStart
  | DeviceStreamStop
  | DeviceWebRTCAnswer
  | DeviceICECandidate
  // Remote terminal
  | TerminalOpen
  | TerminalInput
  | TerminalResize
  | TerminalClose;

/** All messages from yepanywhere server -> phone/browser */
export type YepMessage =
  | WireResponse
  | WireEvent
  | WireUploadProgress
  | WireUploadComplete
  | WireUploadError
  | ServerPong
  // Device bridge signaling
  | DeviceWebRTCOffer
  | DeviceICECandidateEvent
  | DeviceSessionState
  | DeviceStreamProfileEvent
  // Remote terminal
  | TerminalOpened
  | TerminalOutput
  | TerminalExit
  | TerminalError;

/** All wire protocol messages */
export type WireMessage = RemoteClientMessage | YepMessage;
