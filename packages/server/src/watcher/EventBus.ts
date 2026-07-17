/**
 * Simple in-memory pub/sub event bus for file change and session status events.
 */

import type {
  AgentActivity,
  ContextCompactEvent,
  ContextCumulativeUsage,
  ContextUsage,
  PendingInputType,
  SessionLastTurnStatus,
  SessionRetryStatus,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { SessionOwnership, SessionSummary } from "../supervisor/types.js";

export type FileChangeType = "create" | "modify" | "delete";

/** Provider that owns the watched directory */
export type WatchProvider = "claude" | "gemini" | "codex" | "opencode";

export interface FileChangeEvent {
  type: "file-change";
  /** Provider that owns this file */
  provider: WatchProvider;
  path: string;
  relativePath: string;
  changeType: FileChangeType;
  timestamp: string;
  /** Parsed file type based on path */
  fileType:
    | "session"
    | "agent-session"
    | "settings"
    | "credentials"
    | "telemetry"
    | "other";
}

export interface SessionStatusEvent {
  type: "session-status-changed";
  sessionId: string;
  /** Base64url-encoded project path (UrlProjectId format) */
  projectId: UrlProjectId;
  ownership: SessionOwnership;
  timestamp: string;
}

export interface SessionCreatedEvent {
  type: "session-created";
  session: SessionSummary;
  timestamp: string;
}

/** Event emitted when a provider replaces a temporary session ID. */
export interface SessionIdChangedEvent {
  type: "session-id-changed";
  oldSessionId: string;
  newSessionId: string;
  projectId: UrlProjectId;
  executor?: string;
  timestamp: string;
}

/** Event emitted when source code changes and manual reload is needed */
export interface SourceChangeEvent {
  type: "source-change";
  target: "backend" | "frontend";
  files: string[];
  timestamp: string;
}

/** Event emitted when the backend server has restarted (for multi-tab sync) */
export interface BackendReloadedEvent {
  type: "backend-reloaded";
  timestamp: string;
}

/** Event emitted when a session is marked as seen (for cross-tab/device sync) */
export interface SessionSeenEvent {
  type: "session-seen";
  sessionId: string;
  timestamp: string;
  messageId?: string;
}

/** Event emitted when a process activity changes (in-turn vs waiting for input) */
export interface ProcessStateEvent {
  type: "process-state-changed";
  sessionId: string;
  /** Base64url-encoded project path (UrlProjectId format) */
  projectId: UrlProjectId;
  /** Current agent activity - what the agent is doing */
  activity: AgentActivity;
  /** Type of pending input (only set when activity is "waiting-input") */
  pendingInputType?: PendingInputType;
  /** Terminal status of the most recent turn (bridge-reported). */
  lastTurnStatus?: SessionLastTurnStatus;
  /** Most recent provider error message, if the last turn failed. */
  lastErrorMessage?: string;
  /** Present while the provider is retrying a failed request (OpenCode). */
  retryStatus?: SessionRetryStatus;
  timestamp: string;
}

/** Event emitted when a process terminates unexpectedly. */
export interface ProcessTerminatedEvent {
  type: "process-terminated";
  sessionId: string;
  projectId: UrlProjectId;
  processId: string;
  provider: string;
  reason: string;
  timestamp: string;
}

/** Event emitted when a request is added to the worker queue */
export interface QueueRequestAddedEvent {
  type: "queue-request-added";
  queueId: string;
  sessionId?: string;
  projectId: UrlProjectId;
  position: number;
  timestamp: string;
}

/** Event emitted when queue positions change */
export interface QueuePositionChangedEvent {
  type: "queue-position-changed";
  queueId: string;
  sessionId?: string;
  position: number;
  timestamp: string;
}

/** Event emitted when a request is removed from queue */
export interface QueueRequestRemovedEvent {
  type: "queue-request-removed";
  queueId: string;
  sessionId?: string;
  reason: "started" | "cancelled";
  timestamp: string;
}

/** Event emitted when worker activity changes (for safe restart indicator) */
export interface WorkerActivityEvent {
  type: "worker-activity-changed";
  activeWorkers: number;
  queueLength: number;
  /** True if any worker is running or waiting-input (unsafe to restart) */
  hasActiveWork: boolean;
  runtimeMode?: "embedded" | "external";
  timestamp: string;
}

/** Event emitted when session metadata changes (title, AI title, archived, starred) */
export interface SessionMetadataChangedEvent {
  type: "session-metadata-changed";
  sessionId: string;
  /** Base64url-encoded project path when known. Enables single-session refreshes. */
  projectId?: UrlProjectId;
  /** Updated title (if changed) */
  title?: string;
  /** Updated AI-generated title (if changed) */
  aiTitle?: string;
  /** Updated archived status (if changed) */
  archived?: boolean;
  /** Updated starred status (if changed) */
  starred?: boolean;
  timestamp: string;
}

/** Event emitted when a session process is aborted by this server */
export interface SessionAbortedEvent {
  type: "session-aborted";
  sessionId: string;
  projectId: UrlProjectId;
  timestamp: string;
}

/**
 * Event emitted when session content changes (title, messageCount, etc.).
 * This is different from session-metadata-changed which is for user-set metadata.
 * This event is for auto-derived values from the session JSONL file.
 */
export interface SessionUpdatedEvent {
  type: "session-updated";
  sessionId: string;
  projectId: UrlProjectId;
  /** Optional producer identity for diagnostics and downstream dedup logs. */
  trigger?: "opencode-db-reconcile";
  /** New title (derived from first user message) */
  title?: string | null;
  /** New message count */
  messageCount?: number;
  /** Updated timestamp */
  updatedAt?: string;
  /** Context window usage from the last assistant message */
  contextUsage?: ContextUsage;
  /** Cumulative token spend across the whole session, when available. */
  cumulativeUsage?: ContextCumulativeUsage;
  /** Number of context compactions recorded in the active session history. */
  compactCount?: number;
  /** Best-effort details for each recorded context compaction. */
  compactEvents?: ContextCompactEvent[];
  /** Resolved model name (e.g., "claude-sonnet-4-5-20250929") */
  model?: string;
  /** Provider-specific reasoning effort (e.g. Claude "max", Codex "xhigh") */
  reasoningEffort?: string;
  /** Provider-specific service tier / speed label (e.g. "fast") */
  serviceTier?: string;
  timestamp: string;
}

/** Event emitted when network binding configuration changes */
export interface NetworkBindingChangedEvent {
  type: "network-binding-changed";
  /** Localhost port (may have changed) */
  localhostPort: number;
  /** Network socket configuration */
  network: {
    enabled: boolean;
    host: string | null;
    port: number | null;
  } | null;
  timestamp: string;
}

/** Event emitted when a browser tab connects to the activity stream */
export interface BrowserTabConnectedEvent {
  type: "browser-tab-connected";
  browserProfileId: string;
  connectionId: number;
  transport: "ws";
  /** Total tabs connected for this browserProfileId */
  tabCount: number;
  /** Total tabs connected across all browser profiles */
  totalTabCount: number;
  timestamp: string;
}

/** Event emitted when a browser tab disconnects from the activity stream */
export interface BrowserTabDisconnectedEvent {
  type: "browser-tab-disconnected";
  browserProfileId: string;
  connectionId: number;
  /** Remaining tabs for this browserProfileId (0 = browser profile fully offline) */
  tabCount: number;
  /** Total tabs connected across all browser profiles */
  totalTabCount: number;
  timestamp: string;
}

/** Union of all event types that can be emitted through the bus */
export type BusEvent =
  | FileChangeEvent
  | SessionStatusEvent
  | SessionCreatedEvent
  | SessionIdChangedEvent
  | SourceChangeEvent
  | BackendReloadedEvent
  | SessionSeenEvent
  | ProcessStateEvent
  | ProcessTerminatedEvent
  | QueueRequestAddedEvent
  | QueuePositionChangedEvent
  | QueueRequestRemovedEvent
  | WorkerActivityEvent
  | SessionMetadataChangedEvent
  | SessionAbortedEvent
  | SessionUpdatedEvent
  | NetworkBindingChangedEvent
  | BrowserTabConnectedEvent
  | BrowserTabDisconnectedEvent;

export type EventHandler<T = BusEvent> = (event: T) => void;

export class EventBus {
  private subscribers: Set<EventHandler> = new Set();

  /**
   * Subscribe to bus events.
   * @returns Unsubscribe function
   */
  subscribe(handler: EventHandler): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /**
   * Emit an event to all subscribers.
   */
  emit(event: BusEvent): void {
    for (const handler of this.subscribers) {
      try {
        handler(event);
      } catch (error) {
        console.error("[EventBus] Handler error:", error);
      }
    }
  }

  /**
   * Get the number of active subscribers.
   */
  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
