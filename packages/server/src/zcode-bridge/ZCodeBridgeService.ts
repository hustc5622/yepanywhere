/**
 * ZCode bridge service (v1).
 *
 * Scope: observe externally started `zcode tui` sessions through the hook
 * plugin and forward their tool-permission requests to the Yep client. It
 * deliberately does NOT take over external sessions (no app-server resume —
 * writing the shared ZCode sqlite from two processes risks conflicts); the
 * read-only zcode reader already renders their transcripts.
 *
 * Data flow:
 *   plugin hook-entry.mjs -- POST /api/zcode-bridge/hook (shared token)
 *     → SessionStart + hook keepalives maintain the external-session registry;
 *       quiet sessions expire because CLI 0.16.1 has no SessionEnd hook
 *     → PermissionRequest parks a pending input and long-polls (server side)
 *       for a client decision up to `decisionWaitMs` — strictly below the
 *       hook's `timeoutMs` so the CLI always falls back to its own dialog
 *     on timeout: the pending input is dropped and the hook returns
 *       {decision: null}, so the TUI shows its native approval popup.
 *   yep client -- GET pending-inputs / POST decision (normal client auth)
 *
 * Auth: the plugin authenticates with a shared token from
 * `~/.zcode/yep-bridge.json` (written by scripts/install-zcode-yep-plugin.sh).
 * The token and tool_input contents never enter logs.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ZCodeBridgeDecision,
  ZCodeBridgeExternalSession,
  ZCodeBridgePendingInput,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type {
  ZCodeBridgeHookPayload,
  ZCodeBridgeHookResponse,
  ZCodeBridgePermissionRequestHook,
} from "./types.js";

const log = getLogger().child({ component: "zcode-bridge" });

/** How long a PermissionRequest hook waits for a client decision. */
const DEFAULT_DECISION_WAIT_MS = 25_000;
/**
 * ZCode 0.16.1 has no SessionEnd hook. Its `Stop` hook means "assistant turn
 * stopped", not "TUI process exited", so inactive external sessions are
 * retired only after a quiet period.
 */
const DEFAULT_SESSION_STALE_MS = 10 * 60_000;

interface ZCodeBridgeConfig {
  serverUrl?: string;
  token?: string;
}

interface PendingWaiter {
  resolve: (decision: ZCodeBridgeDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ZCodeBridgeServiceOptions {
  /**
   * Bridge config file written by the install script
   * (`{serverUrl, token}`). Defaults to `~/.zcode/yep-bridge.json`.
   */
  configFile?: string;
  /** PermissionRequest decision long-poll budget (test seam). */
  decisionWaitMs?: number;
  /** Quiet period after which an observed external session is forgotten. */
  sessionStaleMs?: number;
}

export class ZCodeBridgeService {
  private readonly configFile: string;
  private readonly decisionWaitMs: number;
  private readonly sessionStaleMs: number;
  private readonly sessions = new Map<
    string,
    {
      cwd?: string;
      permissionMode?: string;
      startedAt: string;
      lastSeenAt: string;
    }
  >();
  private readonly pendingInputs = new Map<string, ZCodeBridgePendingInput>();
  private readonly waiters = new Map<string, PendingWaiter>();
  private tokenCache: { token: string | null; mtimeMs: number } | null = null;

  constructor(options: ZCodeBridgeServiceOptions = {}) {
    this.configFile =
      options.configFile ?? join(homedir(), ".zcode", "yep-bridge.json");
    this.decisionWaitMs = options.decisionWaitMs ?? DEFAULT_DECISION_WAIT_MS;
    this.sessionStaleMs = options.sessionStaleMs ?? DEFAULT_SESSION_STALE_MS;
  }

  // -------------------------------------------------------------------------
  // Plugin-facing: shared token
  // -------------------------------------------------------------------------

  /**
   * Load the installed token, cached by file mtime. A missing/unreadable
   * file means the plugin was never installed (or was removed); it is NOT
   * cached so installing later takes effect without a restart.
   */
  private async loadToken(): Promise<string | null> {
    let mtimeMs: number;
    try {
      const stat = await fs.stat(this.configFile);
      mtimeMs = stat.mtimeMs;
    } catch {
      this.tokenCache = null;
      return null;
    }
    if (this.tokenCache && this.tokenCache.mtimeMs === mtimeMs) {
      return this.tokenCache.token;
    }
    try {
      const raw = await fs.readFile(this.configFile, "utf-8");
      const parsed = JSON.parse(raw) as ZCodeBridgeConfig;
      const token =
        typeof parsed.token === "string" && parsed.token.length > 0
          ? parsed.token
          : null;
      this.tokenCache = { token, mtimeMs };
      return token;
    } catch {
      this.tokenCache = { token: null, mtimeMs };
      return null;
    }
  }

  /** Whether an installed bridge token exists at all. */
  async isConfigured(): Promise<boolean> {
    return (await this.loadToken()) !== null;
  }

  /** Validate a plugin-presented token (constant-time comparison). */
  async validateToken(candidate: string | undefined): Promise<boolean> {
    if (!candidate) return false;
    const expected = await this.loadToken();
    if (!expected) return false;
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
  }

  // -------------------------------------------------------------------------
  // Plugin-facing: hook ingestion
  // -------------------------------------------------------------------------

  async handleHook(
    payload: ZCodeBridgeHookPayload,
  ): Promise<ZCodeBridgeHookResponse | { ok: true }> {
    const eventName = payload?.hook_event_name;
    if (typeof eventName !== "string") return { ok: true };
    const sessionId = payload.session_id;
    const now = new Date().toISOString();
    this.pruneStaleSessions(Date.parse(now));

    if (eventName === "SessionStart" && sessionId) {
      this.sessions.set(sessionId, {
        ...(payload.cwd ? { cwd: payload.cwd } : {}),
        ...(payload.permission_mode
          ? { permissionMode: payload.permission_mode }
          : {}),
        startedAt: now,
        lastSeenAt: now,
      });
      log.info({ event: "zcode_bridge_session_started", sessionId });
      return { ok: true };
    }

    // Every hook, including `Stop`, doubles as a keepalive for a known
    // session. In ZCode 0.16.1 Stop is a per-turn assistant-stop hook (it
    // carries last_assistant_message/stop_hook_active), not a session-exit
    // signal, so deleting here would make every TUI disappear after one turn.
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.lastSeenAt = now;
        if (payload.permission_mode) {
          session.permissionMode = payload.permission_mode;
        }
      }
    }

    if (eventName === "PermissionRequest") {
      return this.handlePermissionRequest(
        payload as ZCodeBridgePermissionRequestHook,
        sessionId,
        now,
      );
    }

    return { ok: true };
  }

  private handlePermissionRequest(
    payload: ZCodeBridgePermissionRequestHook,
    sessionId: string | undefined,
    createdAt: string,
  ): Promise<ZCodeBridgeHookResponse> {
    const id = payload.tool_use_id ?? randomUUID();
    const pending: ZCodeBridgePendingInput = {
      id,
      kind: "permission",
      sessionId: sessionId ?? "unknown",
      ...(payload.cwd ? { cwd: payload.cwd } : {}),
      toolName:
        typeof payload.tool_name === "string" ? payload.tool_name : "unknown",
      ...(payload.tool_input !== undefined
        ? { toolInput: payload.tool_input }
        : {}),
      ...(payload.permission_suggestions !== undefined
        ? { permissionSuggestions: payload.permission_suggestions }
        : {}),
      createdAt,
    };
    this.pendingInputs.set(id, pending);
    // Log only safe fields — tool_input may carry sensitive paths/content.
    log.info(
      {
        event: "zcode_bridge_permission_requested",
        pendingId: id,
        sessionId: pending.sessionId,
        toolName: pending.toolName,
      },
      "ZCode bridge permission request queued",
    );

    return new Promise<ZCodeBridgeHookResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        // The TUI is about to show its own popup; keeping the pending input
        // around would let a late web decision conflict with it.
        this.pendingInputs.delete(id);
        log.info(
          { event: "zcode_bridge_permission_timeout", pendingId: id },
          "ZCode bridge permission request timed out",
        );
        resolve({ decision: null });
      }, this.decisionWaitMs);

      this.waiters.set(id, {
        resolve: (decision) => {
          clearTimeout(timer);
          this.waiters.delete(id);
          resolve({ decision });
        },
        timer,
      });
    });
  }

  private expirePendingForSession(sessionId: string): void {
    for (const [id, pending] of this.pendingInputs) {
      if (pending.sessionId !== sessionId) continue;
      this.pendingInputs.delete(id);
      const waiter = this.waiters.get(id);
      if (waiter) {
        waiter.resolve({ behavior: "deny", message: "session stopped" });
      }
    }
  }

  private pruneStaleSessions(now: number): void {
    for (const [sessionId, session] of this.sessions) {
      const lastSeenAt = Date.parse(session.lastSeenAt);
      if (
        Number.isFinite(lastSeenAt) &&
        now - lastSeenAt < this.sessionStaleMs
      ) {
        continue;
      }
      this.sessions.delete(sessionId);
      this.expirePendingForSession(sessionId);
      log.info({ event: "zcode_bridge_session_expired", sessionId });
    }
  }

  // -------------------------------------------------------------------------
  // Client-facing API
  // -------------------------------------------------------------------------

  listSessions(): ZCodeBridgeExternalSession[] {
    this.pruneStaleSessions(Date.now());
    return [...this.sessions.entries()].map(([sessionId, session]) => ({
      sessionId,
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.permissionMode
        ? { permissionMode: session.permissionMode }
        : {}),
      startedAt: session.startedAt,
      lastSeenAt: session.lastSeenAt,
    }));
  }

  listPendingInputs(): ZCodeBridgePendingInput[] {
    return [...this.pendingInputs.values()];
  }

  /**
   * Apply a client decision. Returns false when the pending input is unknown
   * (already timed out or decided) so the caller can surface a 409/404.
   */
  applyDecision(id: string, decision: ZCodeBridgeDecision): boolean {
    const pending = this.pendingInputs.get(id);
    if (!pending) return false;
    this.pendingInputs.delete(id);
    log.info(
      {
        event: "zcode_bridge_permission_decided",
        pendingId: id,
        behavior: decision.behavior,
      },
      "ZCode bridge permission decision applied",
    );
    this.waiters.get(id)?.resolve(decision);
    return true;
  }
}
