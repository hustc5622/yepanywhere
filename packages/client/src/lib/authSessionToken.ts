/**
 * Session token transport for clients that cannot keep the auth cookie.
 *
 * The Android shell frames the app from `https://tauri.localhost`, so the app
 * runs in a cross-site iframe. Browsers withhold `SameSite=Lax` cookies from
 * cross-site frames, and `SameSite=None` needs `Secure`, which a plain-HTTP
 * server cannot set — the login succeeds but the cookie never comes back.
 *
 * Framed clients therefore ask the server to return the session token in the
 * login response, keep it in localStorage (partitioned per top-level site), and
 * present it as `Authorization: Bearer` on fetches, or as `?yep_auth=` where a
 * header is impossible: WebSocket upgrades and media/download URLs.
 */
import { API_BASE } from "./apiPath";

const STORAGE_KEY = "yep-anywhere-auth-session-token";

/** Must match `SESSION_TOKEN_QUERY_PARAM` on the server. */
export const AUTH_SESSION_QUERY_PARAM = "yep_auth";

/** Posted to the Android shell so native watchers can authenticate too. */
export const MOBILE_SHELL_SESSION_TOKEN_MESSAGE =
  "yep-anywhere:mobile-shell-session-token";

/** Origins the Tauri shell can run under (Android, then iOS/desktop). */
const MOBILE_SHELL_ORIGINS = ["https://tauri.localhost", "tauri://localhost"];

let cachedToken: string | null | undefined;

function readStoredToken(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value?.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Whether this document should request the token transport. Any cross-site
 * frame loses the cookie, so the check is "am I framed" rather than a specific
 * shell marker.
 */
export function shouldUseTokenTransport(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    // Accessing window.top across origins can throw: still framed.
    return true;
  }
}

export function getAuthSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  if (cachedToken === undefined) {
    cachedToken = readStoredToken();
  }
  return cachedToken;
}

function notifyMobileShell(token: string | null): void {
  try {
    if (window.parent === window) return;
    if (document.documentElement.dataset.mobileShell !== "true") return;
    for (const origin of MOBILE_SHELL_ORIGINS) {
      window.parent.postMessage(
        { type: MOBILE_SHELL_SESSION_TOKEN_MESSAGE, token },
        origin,
      );
    }
  } catch {
    // Native watchers fall back to cookies; never block auth on the shell.
  }
}

export function setAuthSessionToken(token: string | null | undefined): void {
  const next = token?.trim() ? token.trim() : null;
  cachedToken = next;
  try {
    if (next) {
      window.localStorage.setItem(STORAGE_KEY, next);
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage may be blocked; the in-memory copy still covers this page load.
  }
  notifyMobileShell(next);
}

/** Re-announce the stored token, e.g. after the shell reloads the frame. */
export function announceAuthSessionTokenToShell(): void {
  const token = getAuthSessionToken();
  if (token) notifyMobileShell(token);
}

/** Headers to merge into authenticated fetches. Empty when no token is held. */
export function authSessionHeaders(): Record<string, string> {
  const token = getAuthSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function isApiPath(pathname: string): boolean {
  return pathname === API_BASE || pathname.startsWith(`${API_BASE}/`);
}

/**
 * Append the session token to a same-origin API URL that the browser loads by
 * itself (`<img>`, `<video>`, `<iframe>`, `<a href>`, WebSocket). Other URLs,
 * and every URL while no token is held, pass through unchanged.
 */
export function withAuthSessionQuery(url: string): string;
export function withAuthSessionQuery(
  url: string | null | undefined,
): string | null | undefined;
export function withAuthSessionQuery(
  url: string | null | undefined,
): string | null | undefined {
  if (!url) return url;
  const token = getAuthSessionToken();
  if (!token || typeof window === "undefined") return url;
  if (/^(data|blob|javascript|mailto):/i.test(url)) return url;

  let parsed: URL;
  try {
    parsed = new URL(url, window.location.href);
  } catch {
    return url;
  }

  const isWebSocket = parsed.protocol === "ws:" || parsed.protocol === "wss:";
  if (!isWebSocket && parsed.origin !== window.location.origin) return url;
  if (isWebSocket && parsed.host !== window.location.host) return url;
  if (!isApiPath(parsed.pathname)) return url;
  if (parsed.searchParams.has(AUTH_SESSION_QUERY_PARAM)) return url;

  parsed.searchParams.set(AUTH_SESSION_QUERY_PARAM, token);
  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
  return isAbsolute
    ? parsed.toString()
    : `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** Hide the session token before a URL reaches logs. */
export function redactAuthSessionQuery(url: string): string {
  return url.replace(
    new RegExp(`([?&]${AUTH_SESSION_QUERY_PARAM}=)[^&#]*`, "g"),
    "$1[redacted]",
  );
}
