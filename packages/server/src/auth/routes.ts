/**
 * Authentication API routes
 */

import * as crypto from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AuthService } from "./AuthService.js";
import { PairingService } from "./PairingService.js";
import { AuthRateLimiter, type RateLimitLockout } from "./RateLimiter.js";

export const SESSION_COOKIE_NAME = "yep-anywhere-session";

export interface AuthRoutesDeps {
  authService: AuthService;
  /** Whether auth is disabled by env var (--auth-disable). Overrides settings. */
  authDisabled?: boolean;
  /** Desktop auth token (for protecting localhost-access endpoint). */
  desktopAuthToken?: string;
  /** Optional reverse-proxy prefix (e.g. "/yep") for scoping cookie path. */
  basePath?: string;
  /** Whether to trust X-Forwarded-Proto / X-Real-IP headers from a reverse proxy. */
  trustProxy?: boolean;
  /** Optional shared rate limiter instance (default created per router). */
  rateLimiter?: AuthRateLimiter;
  /** Optional shared one-time pairing service (default created per router). */
  pairingService?: PairingService;
}

interface SetupBody {
  password: string;
}

interface LoginBody {
  password: string;
  deviceLabel?: string;
}

interface ChangePasswordBody {
  newPassword: string;
}

interface PairingCreateBody {
  label?: string;
}

interface PairingRedeemBody {
  token: string;
  deviceLabel?: string;
}

interface LogoutAllBody {
  includeCurrent?: boolean;
}

export function getSessionCookiePath(basePath?: string): string {
  const normalized = (basePath ?? "").trim().replace(/\/+$/, "");
  if (!normalized || normalized === "/") return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function shouldUseSecureCookie(
  c: {
    req: { url: string; header: (name: string) => string | undefined };
  },
  trustProxy = false,
): boolean {
  // Actual HTTPS transport always requires Secure cookies (never allow a
  // header to downgrade a direct TLS connection unless explicitly trusted).
  try {
    if (new URL(c.req.url).protocol === "https:") {
      return true;
    }
  } catch {
    // Ignore malformed URLs
  }

  // Upgrade to Secure when reverse proxy reports HTTPS (Caddy / Nginx / CF).
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) {
    const protocol = forwardedProto.split(",")[0]?.trim().toLowerCase();
    if (protocol === "https") {
      return true;
    }
    if (trustProxy && protocol === "http") {
      return false;
    }
  }

  return false;
}

export function setSessionCookie(
  c: Context,
  sessionId: string,
  options: {
    basePath?: string;
    trustProxy?: boolean;
    maxAgeSec: number;
  },
): void {
  setCookie(c, SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: shouldUseSecureCookie(c, options.trustProxy),
    sameSite: "Lax",
    path: getSessionCookiePath(options.basePath),
    maxAge: options.maxAgeSec,
  });
}

function clearSessionCookies(c: Context, basePath?: string): void {
  const scopedPath = getSessionCookiePath(basePath);
  deleteCookie(c, SESSION_COOKIE_NAME, { path: scopedPath });
  // Also clear legacy root-scoped cookie if the app is mounted under a basePath
  if (scopedPath !== "/") {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  }
}

export function getClientRateLimitKey(c: Context, trustProxy = false): string {
  if (trustProxy) {
    const realIp = c.req.header("x-real-ip")?.trim();
    if (realIp) return realIp;
    const forwardedFor = c.req.header("x-forwarded-for");
    if (forwardedFor) {
      const first = forwardedFor.split(",")[0]?.trim();
      if (first) return first;
    }
  }

  const incoming = (
    c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  )?.incoming;
  return incoming?.socket?.remoteAddress ?? "direct";
}

export function createAuthRoutes(deps: AuthRoutesDeps): Hono {
  const app = new Hono();
  const {
    authService,
    authDisabled = false,
    desktopAuthToken,
    basePath,
    trustProxy = false,
  } = deps;
  const rateLimiter = deps.rateLimiter ?? new AuthRateLimiter();
  const pairingService = deps.pairingService ?? new PairingService();

  const requireSession = async (c: Context): Promise<string | null> => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (!sessionId) return null;
    const valid = await authService.validateSession(sessionId);
    return valid ? sessionId : null;
  };

  /**
   * Pick up credential changes written by another process (`--setup-auth`).
   * A lockout earned against the previous password must not outlive it, so
   * a changed credential also clears every rate-limit bucket.
   */
  const syncCredentialFromDisk = async (): Promise<void> => {
    try {
      const result = await authService.refreshAccountFromDisk();
      if (result.credentialChanged) {
        rateLimiter.reset();
        pairingService.clearAll();
      }
    } catch {
      // Keep serving with the in-memory account; refresh logs its own errors.
    }
  };

  const rateLimitedResponse = (c: Context, lockout: RateLimitLockout) => {
    c.header("Retry-After", String(lockout.retryAfterSec));
    return c.json(
      {
        error: `Too many failed attempts. Try again in ${lockout.retryAfterSec}s.`,
        retryAfterSec: lockout.retryAfterSec,
        lockoutSec: lockout.lockoutSec,
        tier: lockout.tier,
      },
      429,
    );
  };

  /**
   * GET /api/auth/status
   * Check authentication status.
   *
   * Security: never leak local filesystem `authFilePath` to unauthenticated
   * callers when auth is enabled.
   */
  app.get("/status", async (c) => {
    const isEnabled = authService.isEnabled();
    const isSecureTransport = shouldUseSecureCookie(c, trustProxy);
    const commonBase = {
      hasDesktopToken: !!desktopAuthToken,
      localhostOpen: authService.isLocalhostOpen(),
      pairingSupported: true,
      isSecureTransport,
    };

    // If auth is disabled by env var, it overrides settings
    if (authDisabled) {
      return c.json({
        ...commonBase,
        authFilePath: authService.getFilePath(),
        enabled: isEnabled,
        authenticated: true, // Bypass auth
        setupRequired: false,
        disabledByEnv: true,
      });
    }

    // If auth is not enabled in settings, no auth required
    if (!isEnabled) {
      return c.json({
        ...commonBase,
        authFilePath: authService.getFilePath(),
        enabled: false,
        authenticated: true, // No auth needed
        setupRequired: false,
        disabledByEnv: false,
      });
    }

    // Auth is enabled - check session
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const hasAccount = authService.hasAccount();

    if (!hasAccount) {
      return c.json({
        ...commonBase,
        enabled: true,
        authenticated: false,
        setupRequired: true,
        disabledByEnv: false,
      });
    }

    if (!sessionId) {
      return c.json({
        ...commonBase,
        enabled: true,
        authenticated: false,
        setupRequired: false,
        disabledByEnv: false,
      });
    }

    const validation = await authService.validateSessionWithRefresh(sessionId, {
      ip: getClientRateLimitKey(c, trustProxy),
    });
    if (
      validation.valid &&
      validation.shouldRefreshCookie &&
      validation.cookieMaxAgeSec
    ) {
      setSessionCookie(c, sessionId, {
        basePath,
        trustProxy,
        maxAgeSec: validation.cookieMaxAgeSec,
      });
    }

    return c.json({
      ...commonBase,
      ...(validation.valid ? { authFilePath: authService.getFilePath() } : {}),
      enabled: true,
      authenticated: validation.valid,
      setupRequired: false,
      disabledByEnv: false,
    });
  });

  /**
   * POST /api/auth/enable
   * Enable auth with a password.
   */
  app.post("/enable", async (c) => {
    const body = await c.req.json<SetupBody>();

    if (!body.password || typeof body.password !== "string") {
      return c.json({ error: "Password is required" }, 400);
    }

    if (body.password.length < 6) {
      return c.json({ error: "Password must be at least 6 characters" }, 400);
    }

    if (authService.isEnabled()) {
      return c.json(
        { error: "Authentication is already enabled. Use change-password." },
        409,
      );
    }

    const success = await authService.enableAuth(body.password);
    if (!success) {
      return c.json({ error: "Failed to enable auth" }, 500);
    }
    rateLimiter.reset();

    // Don't auto-login - require user to log in with their new password
    return c.json({ success: true });
  });

  /**
   * POST /api/auth/disable
   * Disable auth (requires authenticated session).
   */
  app.post("/disable", async (c) => {
    const sessionId = await requireSession(c);
    if (!sessionId) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    await authService.disableAuth();
    pairingService.clearAll();
    clearSessionCookies(c, basePath);

    return c.json({ success: true });
  });

  /**
   * POST /api/auth/setup
   * Create the initial account (only works when no account exists)
   * @deprecated Use /api/auth/enable instead
   */
  app.post("/setup", async (c) => {
    if (authService.hasAccount()) {
      return c.json({ error: "Account already exists" }, 400);
    }

    const body = await c.req.json<SetupBody>();

    if (!body.password || typeof body.password !== "string") {
      return c.json({ error: "Password is required" }, 400);
    }

    if (body.password.length < 6) {
      return c.json({ error: "Password must be at least 6 characters" }, 400);
    }

    const success = await authService.enableAuth(body.password);
    if (!success) {
      return c.json({ error: "Failed to create account" }, 500);
    }

    const userAgent = c.req.header("User-Agent");
    const sessionId = await authService.createSession(userAgent, {
      authMethod: "password",
      ip: getClientRateLimitKey(c, trustProxy),
    });

    setSessionCookie(c, sessionId, {
      basePath,
      trustProxy,
      maxAgeSec: authService.getSessionCookieMaxAgeSec(),
    });

    return c.json({ success: true });
  });

  /**
   * POST /api/auth/login
   * Login with password (protected by AuthRateLimiter).
   */
  app.post("/login", async (c) => {
    await syncCredentialFromDisk();
    if (!authService.hasAccount()) {
      c.header("X-Setup-Required", "true");
      return c.json(
        { error: "No account configured", setupRequired: true },
        401,
      );
    }

    const clientKey = getClientRateLimitKey(c, trustProxy);
    const limitCheck = rateLimiter.check(clientKey);
    if (!limitCheck.allowed) {
      return rateLimitedResponse(c, limitCheck);
    }

    const body = await c.req.json<LoginBody>();

    if (!body.password || typeof body.password !== "string") {
      return c.json({ error: "Password is required" }, 400);
    }

    const valid = await authService.verifyPassword(body.password);
    if (!valid) {
      const afterFail = rateLimiter.recordFailure(clientKey);
      if (!afterFail.allowed) {
        return rateLimitedResponse(c, afterFail);
      }
      const status = rateLimiter.describe(clientKey);
      return c.json(
        {
          error: "Invalid password",
          attemptsRemaining: status.attemptsRemaining,
          nextLockoutSec: status.nextLockoutSec,
          nextTier: status.nextTier,
        },
        401,
      );
    }

    rateLimiter.recordSuccess(clientKey);
    const userAgent = c.req.header("User-Agent");
    const sessionId = await authService.createSession(userAgent, {
      authMethod: "password",
      deviceLabel: body.deviceLabel,
      ip: clientKey,
    });

    setSessionCookie(c, sessionId, {
      basePath,
      trustProxy,
      maxAgeSec: authService.getSessionCookieMaxAgeSec(),
    });

    return c.json({ success: true });
  });

  /**
   * POST /api/auth/logout
   * Logout current session.
   */
  app.post("/logout", async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);

    if (sessionId) {
      await authService.invalidateSession(sessionId);
    }

    clearSessionCookies(c, basePath);

    return c.json({ success: true });
  });

  /**
   * POST /api/auth/change-password
   * Change password (requires authenticated session).
   * Revokes all other sessions and pending pairing tokens.
   */
  app.post("/change-password", async (c) => {
    const sessionId = await requireSession(c);
    if (!sessionId) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const body = await c.req.json<ChangePasswordBody>();

    if (!body.newPassword || typeof body.newPassword !== "string") {
      return c.json({ error: "New password is required" }, 400);
    }

    if (body.newPassword.length < 6) {
      return c.json(
        { error: "New password must be at least 6 characters" },
        400,
      );
    }

    const success = await authService.changePassword(
      body.newPassword,
      sessionId,
    );
    if (!success) {
      return c.json({ error: "Failed to change password" }, 500);
    }

    pairingService.clearAll();
    rateLimiter.reset();
    return c.json({ success: true });
  });

  /**
   * GET /api/auth/sessions
   * List active authenticated device sessions.
   */
  app.get("/sessions", async (c) => {
    const sessionId = await requireSession(c);
    if (!sessionId) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const sessions = await authService.listSessions(sessionId);
    return c.json({ sessions });
  });

  /**
   * DELETE /api/auth/sessions/:id
   * Revoke a specific device session by its safe public ID.
   */
  app.delete("/sessions/:id", async (c) => {
    const sessionId = await requireSession(c);
    if (!sessionId) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const publicId = c.req.param("id");
    const removed = await authService.revokeSessionByPublicId(publicId);
    if (!removed) {
      return c.json({ error: "Session not found" }, 404);
    }

    return c.json({ success: true });
  });

  /**
   * POST /api/auth/logout-all
   * Sign out all other devices (or every device when includeCurrent=true).
   */
  app.post("/logout-all", async (c) => {
    const sessionId = await requireSession(c);
    if (!sessionId) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const body = await c.req
      .json<LogoutAllBody>()
      .catch((): LogoutAllBody => ({}));
    pairingService.clearAll();

    if (body.includeCurrent) {
      await authService.invalidateAllSessions();
      clearSessionCookies(c, basePath);
      return c.json({ success: true, signedOutCurrent: true });
    }

    const revokedCount = await authService.invalidateOtherSessions(sessionId);
    return c.json({
      success: true,
      signedOutCurrent: false,
      revokedCount,
    });
  });

  /**
   * POST /api/auth/pairing/create
   * Mint a short-lived, single-use pairing token (QR / `#pair=` link) for
   * authorizing a phone browser or Android shell without typing a password.
   */
  app.post("/pairing/create", async (c) => {
    if (!authService.isEnabled() || !authService.hasAccount()) {
      return c.json({ error: "Authentication is not enabled" }, 400);
    }

    const sessionId = await requireSession(c);
    if (!sessionId) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const body = await c.req
      .json<PairingCreateBody>()
      .catch((): PairingCreateBody => ({}));
    const created = pairingService.createToken({
      createdBySessionId: sessionId,
      label: body.label,
    });

    const loginBase = `${getSessionCookiePath(basePath).replace(/\/$/, "")}/login`;
    return c.json({
      token: created.token,
      expiresAt: created.expiresAt,
      ttlSeconds: created.ttlSeconds,
      loginPath: `${loginBase}#pair=${created.token}`,
    });
  });

  /**
   * POST /api/auth/pairing/redeem
   * Redeem a single-use pairing token and issue a sliding HttpOnly session cookie.
   */
  app.post("/pairing/redeem", async (c) => {
    if (!authService.isEnabled() || !authService.hasAccount()) {
      return c.json({ error: "Authentication is not enabled" }, 400);
    }

    const clientKey = getClientRateLimitKey(c, trustProxy);
    const limitCheck = rateLimiter.check(clientKey);
    if (!limitCheck.allowed) {
      return rateLimitedResponse(c, limitCheck);
    }

    const body = await c.req
      .json<PairingRedeemBody>()
      .catch((): PairingRedeemBody => ({ token: "" }));

    if (!body.token || typeof body.token !== "string") {
      return c.json({ error: "Pairing token is required" }, 400);
    }

    const result = pairingService.redeemToken(body.token);
    if (!result.ok) {
      const afterFail = rateLimiter.recordFailure(clientKey);
      if (!afterFail.allowed) {
        return rateLimitedResponse(c, afterFail);
      }
      return c.json(
        {
          error:
            result.reason === "expired"
              ? "Pairing link has expired"
              : "Invalid or already used pairing link",
          reason: result.reason,
        },
        401,
      );
    }

    rateLimiter.recordSuccess(clientKey);
    const userAgent = c.req.header("User-Agent");
    const sessionId = await authService.createSession(userAgent, {
      authMethod: "pairing",
      deviceLabel: body.deviceLabel ?? result.label,
      ip: clientKey,
    });

    setSessionCookie(c, sessionId, {
      basePath,
      trustProxy,
      maxAgeSec: authService.getSessionCookieMaxAgeSec(),
    });

    return c.json({ success: true });
  });

  /**
   * POST /api/auth/localhost-access
   * Toggle unauthenticated localhost access (bypasses desktop token floor).
   */
  app.post("/localhost-access", async (c) => {
    let authorized = false;

    if (desktopAuthToken) {
      const headerToken = c.req.header("x-desktop-token");
      if (
        headerToken &&
        headerToken.length === desktopAuthToken.length &&
        crypto.timingSafeEqual(
          Buffer.from(headerToken),
          Buffer.from(desktopAuthToken),
        )
      ) {
        authorized = true;
      }
    }

    if (!authorized) {
      const sessionId = await requireSession(c);
      if (sessionId) {
        authorized = true;
      }
    }

    if (!authorized) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const body = await c.req.json<{ open: boolean }>();
    if (typeof body.open !== "boolean") {
      return c.json({ error: "open must be a boolean" }, 400);
    }

    await authService.setLocalhostOpen(body.open);
    return c.json({ success: true, localhostOpen: body.open });
  });

  return app;
}
