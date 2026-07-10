import { randomUUID } from "node:crypto";
import type { UrlProjectId } from "@yep-anywhere/shared";
import type { PermissionMode, UserMessage } from "../sdk/types.js";
import type { EventBus } from "../watcher/EventBus.js";
import type { ModelSettings } from "./Supervisor.js";

/** Type of queued request */
export type QueuedRequestType = "new-session" | "resume-session";

/** Result when a queued request is processed */
export type QueuedRequestResult =
  | { status: "started"; processId: string }
  | { status: "cancelled"; reason: string };

/** Entry in the worker queue */
export interface QueuedRequest {
  id: string;
  type: QueuedRequestType;
  projectPath: string;
  projectId: UrlProjectId;
  sessionId?: string; // For resume-session requests
  message: UserMessage;
  permissionMode?: PermissionMode;
  modelSettings?: ModelSettings;
  queuedAt: Date;
  /** Resolver to call when request is processed or cancelled */
  resolve: (result: QueuedRequestResult) => void;
}

/** Info about a queued request (for API responses) */
export interface QueuedRequestInfo {
  id: string;
  type: QueuedRequestType;
  projectId: UrlProjectId;
  sessionId?: string;
  position: number;
  queuedAt: string;
}

/** Status returned when request is queued instead of started immediately */
export interface QueuedResponse {
  queued: true;
  queueId: string;
  position: number;
}

/** Result when enqueue fails due to queue being full */
export interface QueueFullError {
  error: "queue_full";
  maxQueueSize: number;
}

/** Result of enqueue operation */
export type EnqueueResult =
  | { queueId: string; position: number; promise: Promise<QueuedRequestResult> }
  | QueueFullError;

/**
 * Type guard to check if enqueue result is an error
 */
export function isQueueFullError(
  result: EnqueueResult,
): result is QueueFullError {
  return "error" in result && result.error === "queue_full";
}

export interface WorkerQueueOptions {
  eventBus?: EventBus;
  /** Maximum queue size. 0 = unlimited (default) */
  maxQueueSize?: number;
}

export class WorkerQueue {
  private queue: QueuedRequest[] = [];
  private eventBus?: EventBus;
  private maxQueueSize: number;

  constructor(options: WorkerQueueOptions = {}) {
    this.eventBus = options.eventBus;
    this.maxQueueSize = options.maxQueueSize ?? 0;
  }

  /**
   * Add a request to the queue.
   * Returns queue ID, position, and a promise that resolves when the request is started or cancelled.
   * Returns QueueFullError if the queue is at capacity.
   */
  enqueue(params: {
    type: QueuedRequestType;
    projectPath: string;
    projectId: UrlProjectId;
    sessionId?: string;
    message: UserMessage;
    permissionMode?: PermissionMode;
    modelSettings?: ModelSettings;
  }): EnqueueResult {
    // Check queue size limit
    if (this.maxQueueSize > 0 && this.queue.length >= this.maxQueueSize) {
      return { error: "queue_full", maxQueueSize: this.maxQueueSize };
    }

    const queueId = randomUUID();

    let resolvePromise!: (result: QueuedRequestResult) => void;

    const promise = new Promise<QueuedRequestResult>((resolve) => {
      resolvePromise = resolve;
    });

    const request: QueuedRequest = {
      id: queueId,
      type: params.type,
      projectPath: params.projectPath,
      projectId: params.projectId,
      sessionId: params.sessionId,
      message: params.message,
      permissionMode: params.permissionMode,
      modelSettings: params.modelSettings,
      queuedAt: new Date(),
      resolve: resolvePromise,
    };

    this.queue.push(request);
    const position = this.queue.length;

    this.emitQueueAdded(request, position);

    return { queueId, position, promise };
  }

  /**
   * Get the next request from the queue (FIFO).
   */
  dequeue(): QueuedRequest | undefined {
    const request = this.queue.shift();

    if (request) {
      // Emit position updates for remaining items
      this.emitPositionUpdates();
    }

    return request;
  }

  /**
   * Cancel a queued request by ID.
   * Returns true if found and cancelled.
   */
  cancel(queueId: string): boolean {
    const index = this.queue.findIndex((r) => r.id === queueId);
    if (index === -1) return false;

    const removed = this.queue.splice(index, 1)[0];
    if (!removed) return false;

    removed.resolve({ status: "cancelled", reason: "User cancelled" });

    this.emitQueueRemoved(removed, "cancelled");
    this.emitPositionUpdates();

    return true;
  }

  /** Cancel every queued request without allowing it to start. */
  cancelAll(reason = "Runtime shutting down"): number {
    const queued = this.queue.splice(0);
    for (const request of queued) {
      request.resolve({ status: "cancelled", reason });
      this.emitQueueRemoved(request, "cancelled");
    }
    return queued.length;
  }

  /**
   * Find a queued request for a specific session.
   * Used to consolidate multiple messages to the same session.
   */
  findBySessionId(sessionId: string): QueuedRequest | undefined {
    return this.queue.find((r) => r.sessionId === sessionId);
  }

  /**
   * Get queue info for API responses.
   */
  getQueueInfo(): QueuedRequestInfo[] {
    return this.queue.map((r, i) => ({
      id: r.id,
      type: r.type,
      projectId: r.projectId,
      sessionId: r.sessionId,
      position: i + 1,
      queuedAt: r.queuedAt.toISOString(),
    }));
  }

  /**
   * Get position for a specific queue ID.
   * Returns undefined if not found.
   */
  getPosition(queueId: string): number | undefined {
    const index = this.queue.findIndex((r) => r.id === queueId);
    return index >= 0 ? index + 1 : undefined;
  }

  /**
   * Peek at the next request without removing it.
   */
  peek(): QueuedRequest | undefined {
    return this.queue[0];
  }

  get length(): number {
    return this.queue.length;
  }

  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  private emitQueueAdded(request: QueuedRequest, position: number): void {
    this.eventBus?.emit({
      type: "queue-request-added",
      queueId: request.id,
      sessionId: request.sessionId,
      projectId: request.projectId,
      position,
      timestamp: new Date().toISOString(),
    });
  }

  private emitQueueRemoved(
    request: QueuedRequest,
    reason: "started" | "cancelled",
  ): void {
    this.eventBus?.emit({
      type: "queue-request-removed",
      queueId: request.id,
      sessionId: request.sessionId,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  private emitPositionUpdates(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const request = this.queue[i];
      if (!request) continue;
      this.eventBus?.emit({
        type: "queue-position-changed",
        queueId: request.id,
        sessionId: request.sessionId,
        position: i + 1,
        timestamp: new Date().toISOString(),
      });
    }
  }
}
