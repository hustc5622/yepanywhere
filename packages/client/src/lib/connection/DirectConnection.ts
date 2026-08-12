import type { UploadedFile } from "@yep-anywhere/shared";
import { uploadFile } from "../../api/upload";
import { API_BASE } from "../apiPath";
import { authEvents } from "../authEvents";
import type {
  Connection,
  StreamHandlers,
  Subscription,
  UploadOptions,
} from "./types";

/**
 * Direct connection to yepanywhere server using native browser APIs.
 *
 * Handles REST requests (fetch/fetchBlob) and file uploads via HTTP.
 * Subscriptions (session/activity streams) are handled separately by
 * useSessionStream and ActivityBus, which always use WebSocket.
 */
export class DirectConnection implements Connection {
  readonly mode = "direct" as const;

  /**
   * Make a JSON API request.
   */
  async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Yep-Anywhere": "true",
        ...init?.headers,
      },
    });

    if (!res.ok) {
      // Signal login required for 401 errors (but not for auth endpoints)
      if (res.status === 401 && !path.startsWith("/auth/")) {
        console.log(
          "[DirectConnection] 401 response, signaling login required",
        );
        authEvents.signalLoginRequired();
      }

      const error = new Error(
        `API error: ${res.status} ${res.statusText}`,
      ) as Error & {
        status: number;
      };
      error.status = res.status;
      throw error;
    }

    return res.json();
  }

  /**
   * Fetch binary data and return as Blob.
   */
  async fetchBlob(path: string): Promise<Blob> {
    const res = await fetch(`${API_BASE}${path}`, {
      credentials: "include",
      headers: {
        "X-Yep-Anywhere": "true",
      },
    });

    if (!res.ok) {
      throw new Error(`API error: ${res.status} ${res.statusText}`);
    }

    return res.blob();
  }

  subscribeSession(
    _sessionId: string,
    _handlers: StreamHandlers,
    _lastEventId?: string,
    _lastMessageId?: string,
  ): Subscription {
    throw new Error("Use WebSocket subscriptions");
  }

  subscribeActivity(_handlers: StreamHandlers): Subscription {
    throw new Error("Use WebSocket subscriptions");
  }

  subscribeSessionWatch(
    _sessionId: string,
    _handlers: StreamHandlers,
    _options?: {
      projectId?: string;
      provider?: string;
    },
  ): Subscription {
    throw new Error("Use WebSocket subscriptions");
  }

  subscribeProjectFiles(
    _projectId: string,
    _handlers: StreamHandlers,
  ): Subscription {
    throw new Error("Use WebSocket subscriptions");
  }

  /**
   * Upload a file via WebSocket.
   */
  async upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile> {
    return uploadFile(projectId, sessionId, file, options);
  }
}

/**
 * Singleton DirectConnection instance.
 * Most apps only need one connection to the server.
 */
export const directConnection = new DirectConnection();
