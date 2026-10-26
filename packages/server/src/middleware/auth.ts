/**
 * Authentication middleware for API routes.
 *
 * Validates session cookies and returns 401 for unauthenticated requests.
 * Skips auth for /api/auth/* paths (login, setup, etc).
 *
 * Auth is only enforced when:
 * 1. authService.isEnabled() returns true (enabled in settings)
 * 2. authDisabled is false (not bypassed via --auth-disable flag)
 *
 * Desktop token (DESKTOP_AUTH_TOKEN set):
 * Acts as a minimum auth floor. The token is always accepted as valid auth.
 * If the user has also set up password auth, cookie sessions still work too.
 * Internal websocket requests are always allowed. The token prevents
 * unauthenticated access when no other auth is configured.
 */

import * as crypto from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AuthService } from "../auth/AuthService.js";
import { SESSION_COOKIE_NAME } from "../auth/routes.js";
import { WS_INTERNAL_AUTHENTICATED } from "./internal-auth.js";

export interface AuthMiddlewareOptions {
  authService: AuthService;
  /** Whether auth is disabled by env var (--auth-disable). Bypasses all auth. */
  authDisabled?: boolean;
  /** Desktop auth token from Tauri app. Acts as minimum auth floor when no other auth is configured. */
  desktopAuthToken?: string;
}

/**
 * Constant-time comparison of two strings.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Check if the request carries a valid desktop auth token
 * (via X-Desktop-Token header or desktop_token query param).
 */
function hasValidDesktopToken(
  c: Parameters<MiddlewareHandler>[0],
  desktopAuthToken: string,
): boolean {
  // Check header (used by fetchJSON API calls)
  const headerToken = c.req.header("x-desktop-token");
  if (headerToken && timingSafeEqual(headerToken, desktopAuthToken)) {
    return true;
  }
  // Check query param (used by WebSocket upgrade, which can't set headers)
  const url = new URL(c.req.url);
  const queryToken = url.searchParams.get("desktop_token");
  if (queryToken && timingSafeEqual(queryToken, desktopAuthToken)) {
    return true;
  }
  return false;
}

/**
 * Create auth middleware that validates session cookies.
 */
export function createAuthMiddleware(
  options: AuthMiddlewareOptions,
): MiddlewareHandler {
  const { authService, authDisabled = false, desktopAuthToken } = options;

  return async (c, next) => {
    const path = c.req.path;

    // Skip auth for health check (always open for readiness probes)
    if (path === "/health") {
      await next();
      return;
    }

    // Desktop token: always accepted when present and valid.
    if (desktopAuthToken && hasValidDesktopToken(c, desktopAuthToken)) {
      c.set("authenticated", true);
      await next();
      return;
    }

    // If auth is disabled by env var, always pass through
    if (authDisabled) {
      c.set("authenticated", true);
      await next();
      return;
    }

    // Skip local password auth for requests from the trusted local websocket.
    // The websocket handler sets this Symbol when routing requests through app.fetch().
    // Using a Symbol ensures this cannot be forged by external HTTP requests.
    if (c.env[WS_INTERNAL_AUTHENTICATED]) {
      c.set("authenticated", true);
      await next();
      return;
    }

    // If auth is not enabled in settings, the desktop token acts as a floor:
    // when set, require it (unless localhostOpen is enabled); otherwise pass through.
    if (!authService.isEnabled()) {
      if (desktopAuthToken && !authService.isLocalhostOpen()) {
        // Desktop token is set but request didn't have it (checked above).
        // Allow auth status so the UI can detect state.
        if (path === "/api/auth/status") {
          await next();
          return;
        }
        return c.json({ error: "Authentication required" }, 401);
      }
      c.set("authenticated", true);
      await next();
      return;
    }

    // Skip auth for /api/auth/* paths
    if (path.startsWith("/api/auth/") || path === "/api/auth") {
      await next();
      return;
    }

    // Check if account exists (shouldn't happen if enabled via enableAuth)
    if (!authService.hasAccount()) {
      c.header("X-Setup-Required", "true");
      return c.json(
        {
          error: "Authentication required",
          setupRequired: true,
        },
        401,
      );
    }

    // Validate session cookie
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (!sessionId) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const valid = await authService.validateSession(sessionId);
    if (!valid) {
      return c.json({ error: "Session expired" }, 401);
    }

    // Mark request as authenticated (for downstream handlers if needed)
    c.set("authenticated", true);
    c.set("authenticatedViaSession", true);

    await next();
  };
}
