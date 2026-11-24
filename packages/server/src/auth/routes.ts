/**
 * Authentication API routes
 */

import * as crypto from "node:crypto";
import type { Socket } from "node:net";
import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getProxyProtocolClient } from "../network/proxy-protocol.js";
import type { AuthService } from "./AuthService.js";
import { PairingService } from "./PairingService.js";
import { AuthRateLimiter, type RateLimitLockout } from "./RateLimiter.js";

export const SESSION_COOKIE_NAME = "yep-anywhere-session";

/**
 * Root-scoped (`Path=/`) low-privilege gate cookie used by reverse-proxy
 * `forward_auth` (e.g. protecting a landing page at `/`) without widening
 * the main `yep-anywhere-session` cookie beyond `BASE_PATH`.
 */
export const GATE_COOKIE_NAME = "yep-gate-session";

/**
 * Query parameter carrying the session token for requests that cannot set
 * headers: WebSocket upgrades and media/download URLs (`<img>`, `<video>`,
 * DownloadManager). Only honored on GET/HEAD so it never authorizes writes.
 */
export const SESSION_TOKEN_QUERY_PARAM = "yep_auth";

const BEARER_PREFIX = /^Bearer\s+/i;

export type SessionCredentialSource = "cookie" | "header" | "query";

export interface SessionCredential {
  sessionId: string;
  source: SessionCredentialSource;
}

/**
 * Read the session credential from a request.
 *
 * Browsers carry it in the HttpOnly cookie. Clients embedded in a cross-site
 * iframe (the Android shell at `https://tauri.localhost` framing a plain-HTTP
 * server) never get that cookie back: `SameSite=Lax` is withheld from
 * cross-site frames and `SameSite=None` requires `Secure`, which plain HTTP
 * cannot set. Those clients receive the token in the login response instead
 * and present it as `Authorization: Bearer`, or as `?yep_auth=` where headers
 * are impossible.
 */
export function getRequestSessionCredential(
  c: Context,
): SessionCredential | null {
  const authorization = c.req.header("authorization");
  if (authorization && BEARER_PREFIX.test(authorization)) {
    const token = authorization.replace(BEARER_PREFIX, "").trim();
    if (token) return { sessionId: token, source: "header" };
  }

  const cookie = getCookie(c, SESSION_COOKIE_NAME);
  if (cookie) return { sessionId: cookie, source: "cookie" };

  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    const queryToken = c.req.query(SESSION_TOKEN_QUERY_PARAM)?.trim();
    if (queryToken) return { sessionId: queryToken, source: "query" };
  }

  return null;
}

function wantsTokenTransport(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { tokenTransport?: unknown }).tokenTransport === true
  );
}

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
  /** Also return the session token for clients that cannot keep the cookie. */
  tokenTransport?: boolean;
}

interface LoginBody {
  password: string;
  deviceLabel?: string;
  /** Also return the session token for clients that cannot keep the cookie. */
  tokenTransport?: boolean;
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
  /** Also return the session token for clients that cannot keep the cookie. */
  tokenTransport?: boolean;
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

export function setGateCookie(
  c: Context,
  gateToken: string,
  options: {
    trustProxy?: boolean;
    maxAgeSec: number;
  },
): void {
  setCookie(c, GATE_COOKIE_NAME, gateToken, {
    httpOnly: true,
    secure: shouldUseSecureCookie(c, options.trustProxy),
    sameSite: "Lax",
    path: "/",
    maxAge: options.maxAgeSec,
  });
}

function clearGateCookie(c: Context): void {
  deleteCookie(c, GATE_COOKIE_NAME, { path: "/" });
}

/**
 * Validate a same-origin redirect path for reverse-proxy site-gate handoffs.
 * Rejects protocol-relative URLs, backslashes, control characters, and
 * self-referential auth gate/login routes so redirects can never loop or
 * leave the current origin.
 */
export function sanitizeGateRedirect(
  raw: string | undefined,
  basePath?: string,
): string {
  if (!raw) return "/";
  const trimmed = raw.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    /[\p{Cc}\x7f]/u.test(trimmed)
  ) {
    return "/";
  }

  const pathname = trimmed.split(/[?#]/, 1)[0] ?? "/";
  const prefix = getSessionCookiePath(basePath).replace(/\/$/, "");
  const blocked = [
    `${prefix}/api/auth/gate-verify`,
    `${prefix}/api/auth/gate-bridge`,
    `${prefix}/login`,
  ];
  if (blocked.some((b) => pathname === b || pathname.startsWith(`${b}/`))) {
    return "/";
  }

  return trimmed;
}

function clearSessionCookies(c: Context, basePath?: string): void {
  const scopedPath = getSessionCookiePath(basePath);
  deleteCookie(c, SESSION_COOKIE_NAME, { path: scopedPath });
  // Also clear legacy root-scoped cookie if the app is mounted under a basePath
  if (scopedPath !== "/") {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  }
  clearGateCookie(c);
}

/**
 * Client address used for login rate limits and session `lastIp`.
 *
 * Order: a PROXY protocol header from a trusted local tunnel (frpc), then
 * `X-Real-IP` / `X-Forwarded-For` when `trustProxy` is on, then the TCP peer.
 * Without either, every frp-tunnelled client shares the tunnel's loopback
 * address and therefore one rate-limit bucket.
 */
export function getClientRateLimitKey(c: Context, trustProxy = false): string {
  const incoming = (
    c.env as
      | { incoming?: { socket?: Socket & { remoteAddress?: string } } }
      | undefined
  )?.incoming;
  const proxied = getProxyProtocolClient(incoming?.socket);
  if (proxied) return proxied.address;

  if (trustProxy) {
    const realIp = c.req.header("x-real-ip")?.trim();
    if (realIp) return realIp;
    const forwardedFor = c.req.header("x-forwarded-for");
    if (forwardedFor) {
      const first = forwardedFor.split(",")[0]?.trim();
      if (first) return first;
    }
  }

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

  const issueGateCookie = async (
    c: Context,
    sessionId: string,
  ): Promise<void> => {
    const gateToken = await authService.createGateToken(sessionId);
    if (!gateToken) return;
    setGateCookie(c, gateToken, {
      trustProxy,
      maxAgeSec: authService.getGateCookieMaxAgeSec(sessionId),
    });
  };

  const requireSession = async (c: Context): Promise<string | null> => {
    const sessionId = getRequestSessionCredential(c)?.sessionId;
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
    const credential = getRequestSessionCredential(c);
    const sessionId = credential?.sessionId;
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
    if (validation.valid && credential?.source === "cookie") {
      if (validation.shouldRefreshCookie && validation.cookieMaxAgeSec) {
        setSessionCookie(c, sessionId, {
          basePath,
          trustProxy,
          maxAgeSec: validation.cookieMaxAgeSec,
        });
      }
      const existingGate = getCookie(c, GATE_COOKIE_NAME);
      const expectedGate = await authService.createGateToken(sessionId);
      if (
        expectedGate &&
        (validation.shouldRefreshCookie || existingGate !== expectedGate)
      ) {
        setGateCookie(c, expectedGate, {
          trustProxy,
          maxAgeSec: authService.getGateCookieMaxAgeSec(sessionId),
        });
      }
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
    await issueGateCookie(c, sessionId);

    return c.json({
      success: true,
      ...(wantsTokenTransport(body) ? { sessionToken: sessionId } : {}),
    });
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
    await issueGateCookie(c, sessionId);

    return c.json({
      success: true,
      ...(wantsTokenTransport(body) ? { sessionToken: sessionId } : {}),
    });
  });

  /**
   * POST /api/auth/logout
   * Logout current session.
   */
  app.post("/logout", async (c) => {
    const sessionId = getRequestSessionCredential(c)?.sessionId;

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
    await issueGateCookie(c, sessionId);

    return c.json({
      success: true,
      ...(wantsTokenTransport(body) ? { sessionToken: sessionId } : {}),
    });
  });

  /**
   * GET /api/auth/gate-verify
   * Reverse-proxy `forward_auth` verification endpoint (e.g. Caddy protecting `/`).
   * Validates the root-scoped low-privilege `yep-gate-session` cookie against
   * live sessions. Returns 200 on success, or 302 to `/api/auth/gate-bridge`
   * so already-logged-in devices under `BASE_PATH` seamlessly mint a gate cookie
   * without re-entering a password.
   */
  app.get("/gate-verify", async (c) => {
    c.header("Cache-Control", "no-store");

    if (authDisabled || !authService.isEnabled()) {
      return c.body(null, 200);
    }

    const gateToken = getCookie(c, GATE_COOKIE_NAME);
    if (gateToken) {
      const valid = await authService.validateGateToken(gateToken, {
        ip: getClientRateLimitKey(c, trustProxy),
      });
      if (valid) {
        return c.body(null, 200);
      }
    }

    const basePrefix = getSessionCookiePath(basePath).replace(/\/$/, "");
    const target = sanitizeGateRedirect(
      c.req.header("x-forwarded-uri"),
      basePath,
    );
    const bridgeUrl = `${basePrefix}/api/auth/gate-bridge?redirect=${encodeURIComponent(target)}`;
    return c.redirect(bridgeUrl, 302);
  });

  /**
   * GET /api/auth/gate-bridge
   * Browser-facing handoff under `BASE_PATH`. If the browser already holds a
   * valid `yep-anywhere-session` cookie, mints `yep-gate-session` (`Path=/`)
   * and redirects straight back to the requested page. Otherwise redirects to
   * the Yep login page with `?redirect=...`.
   */
  app.get("/gate-bridge", async (c) => {
    c.header("Cache-Control", "no-store");
    const target = sanitizeGateRedirect(c.req.query("redirect"), basePath);

    if (authDisabled || !authService.isEnabled()) {
      return c.redirect(target, 302);
    }

    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (sessionId) {
      const validation = await authService.validateSessionWithRefresh(
        sessionId,
        {
          ip: getClientRateLimitKey(c, trustProxy),
        },
      );
      if (validation.valid) {
        if (validation.shouldRefreshCookie && validation.cookieMaxAgeSec) {
          setSessionCookie(c, sessionId, {
            basePath,
            trustProxy,
            maxAgeSec: validation.cookieMaxAgeSec,
          });
        }
        await issueGateCookie(c, sessionId);
        return c.redirect(target, 302);
      }
    }

    clearGateCookie(c);
    const basePrefix = getSessionCookiePath(basePath).replace(/\/$/, "");
    const loginUrl = `${basePrefix}/login?redirect=${encodeURIComponent(target)}`;
    return c.redirect(loginUrl, 302);
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
