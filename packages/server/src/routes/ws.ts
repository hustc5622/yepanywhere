import { randomUUID } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";
import type { Context, Hono } from "hono";
import type { WSEvents } from "hono/ws";
import type { WebSocket as RawWebSocket } from "ws";
import type { DeviceBridgeService } from "../device/DeviceBridgeService.js";
import { getLogger } from "../logging/logger.js";
import { isAllowedOrigin } from "../middleware/allowed-hosts.js";
import type {
  BrowserProfileService,
  ConnectedBrowsersService,
} from "../services/index.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { TerminalService } from "../terminal/TerminalService.js";
import type { UploadManager } from "../uploads/manager.js";
import type {
  EventBus,
  FocusedSessionWatchManager,
  ProjectFileWatchManager,
} from "../watcher/index.js";
import {
  type ConnectionState,
  type WSAdapter,
  type WsHandlerDeps,
  type WsUploadState,
  cleanupConnectionState,
  cleanupDeviceSessions,
  cleanupSubscriptions,
  cleanupTerminalAttachments,
  cleanupUploads,
  createConnectionState,
  createSendFn,
  handleMessage,
} from "./ws-handlers.js";

// biome-ignore lint/suspicious/noExplicitAny: Complex third-party type from @hono/node-ws
type UpgradeWebSocketFn = (createEvents: (c: Context) => WSEvents) => any;

export interface WsRoutesDeps {
  upgradeWebSocket: UpgradeWebSocketFn;
  /** The main Hono app to route requests through */
  app: Hono<{ Bindings: HttpBindings }>;
  /** Base URL for internal requests (e.g., "http://localhost:3400") */
  baseUrl: string;
  /**
   * Reverse-proxy URL prefix to prepend to tunneled request paths
   * before they reach the Hono router. See WsHandlerDeps.basePath.
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
 * Create the WebSocket route for the local `/api/ws` endpoint.
 *
 * This endpoint allows clients to send HTTP-like requests over WebSocket,
 * which are then routed to the existing Hono handlers and responses returned.
 *
 * Supports:
 * - request/response
 * - subscriptions for session and activity events
 * - file uploads
 */
export function createWsRoutes(
  deps: WsRoutesDeps,
): ReturnType<typeof deps.upgradeWebSocket> {
  const {
    upgradeWebSocket,
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager,
    connectedBrowsers,
    browserProfileService,
    focusedSessionWatchManager,
    projectFileWatchManager,
    deviceBridgeService,
    terminalService,
  } = deps;

  // Build handler dependencies
  const handlerDeps: WsHandlerDeps = {
    app,
    baseUrl,
    basePath: deps.basePath,
    supervisor,
    eventBus,
    uploadManager,
    connectedBrowsers,
    browserProfileService,
    focusedSessionWatchManager,
    projectFileWatchManager,
    deviceBridgeService,
    terminalService,
  };

  // Return the WebSocket handler with origin validation
  return upgradeWebSocket((c) => {
    // Check origin before upgrading
    const origin = c.req.header("origin");
    if (!isAllowedOrigin(origin)) {
      console.warn(`[WS] Rejected connection from origin: ${origin}`);
      // Return empty handlers - connection will be closed immediately
      return {
        onOpen(_evt, ws) {
          ws.close(4003, "Forbidden: Invalid origin");
        },
      };
    }

    // Track active subscriptions for this connection
    const subscriptions = new Map<string, () => void>();
    // Track active uploads for this connection
    const uploads = new Map<string, WsUploadState>();
    // Track active emulator streaming sessions for this connection
    const deviceSessions = new Set<string>();
    // Per-connection identifier for terminal attachments (used to detach all
    // terminals on disconnect; server-owned PTY keeps running for reattach).
    const terminalAttachId = `attach-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    // Message queue to serialize async message handling
    let messageQueue: Promise<void> = Promise.resolve();
    // Per-connection state
    const connState: ConnectionState = createConnectionState({
      useCompressedJsonFrames: c.req.query("compression") === "gzip",
    });
    // Ping interval for dead connection detection (set in onOpen, cleared in onClose)
    let pingInterval: ReturnType<typeof setInterval> | null = null;
    const connectionId = randomUUID();
    let connectedAt: number | undefined;
    // Send function (created on open, captures connState)
    let send: ReturnType<typeof createSendFn>;
    // WSAdapter wrapper
    let wsAdapter: WSAdapter;

    return {
      onOpen(_evt, ws) {
        connectedAt = Date.now();
        getLogger().info(
          {
            event: "ws_client_connected",
            connectionId,
          },
          "WebSocket client connected",
        );
        // Create WSAdapter wrapper for Hono's WSContext
        wsAdapter = {
          send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void {
            try {
              ws.send(data);
            } catch {
              // Socket closed or closing — handled by onClose
            }
          },
          close(code?: number, reason?: string): void {
            try {
              ws.close(code, reason);
            } catch {
              // Already closed
            }
          },
        };
        // Create the send function that captures this connection's state
        send = createSendFn(wsAdapter, connState);

        // Start WebSocket ping every 30s for dead connection detection
        const rawWs = ws.raw as RawWebSocket | undefined;
        if (rawWs?.ping) {
          pingInterval = setInterval(() => {
            try {
              if (rawWs.readyState === rawWs.OPEN) rawWs.ping();
            } catch {
              if (pingInterval) clearInterval(pingInterval);
            }
          }, 30_000);
        }
      },

      onMessage(evt, _ws) {
        // Queue messages for sequential processing
        messageQueue = messageQueue.then(() =>
          handleMessage(
            wsAdapter,
            subscriptions,
            uploads,
            connState,
            send,
            evt.data,
            handlerDeps,
            {},
            deviceSessions,
            terminalAttachId,
          ).catch((err) => {
            getLogger().error(
              {
                event: "ws_client_error",
                connectionId,
                error: err instanceof Error ? err.message : String(err),
              },
              "Unexpected WebSocket message error",
            );
          }),
        );
      },

      onClose(evt, _ws) {
        if (pingInterval) clearInterval(pingInterval);
        cleanupConnectionState(connState);

        // Clean up all uploads
        cleanupUploads(uploads, uploadManager).catch((err) => {
          console.error("[WS] Error cleaning up uploads:", err);
        });

        // Clean up emulator streaming sessions
        cleanupDeviceSessions(deviceSessions, deviceBridgeService);

        // Detach (but don't kill) any terminals attached over this connection
        cleanupTerminalAttachments(terminalAttachId, terminalService);

        // Clean up all subscriptions
        cleanupSubscriptions(subscriptions);
        const closeEvent = evt as { code?: number; reason?: string };
        getLogger().info(
          {
            event: "ws_client_disconnected",
            connectionId,
            durationMs:
              connectedAt === undefined
                ? 0
                : Math.max(0, Date.now() - connectedAt),
            closeCode: closeEvent.code,
            closeReason: closeEvent.reason || undefined,
          },
          "WebSocket client disconnected",
        );
      },

      onError(evt, _ws) {
        getLogger().error(
          {
            event: "ws_client_error",
            connectionId,
            error: evt instanceof Error ? evt.message : String(evt),
          },
          "WebSocket client error",
        );
      },
    };
  });
}
