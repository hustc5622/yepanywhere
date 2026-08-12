import * as crypto from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AdminPasswordService } from "./AdminPasswordService.js";
import type { AuthService } from "./AuthService.js";
import {
  AUTH_ERROR_CODES,
  AuthError,
  type AuthErrorCode,
} from "./authErrors.js";
import { isLocalManagementRequest } from "./localManagement.js";

export const SESSION_COOKIE_NAME = "yep-anywhere-session";

const AUTH_HTTP_STATUS: Record<AuthErrorCode, ContentfulStatusCode> = {
  AUTH_ADMIN_NOT_CONFIGURED: 409,
  AUTH_ADMIN_INVALID: 401,
  AUTH_LOGIN_INVALID: 401,
  AUTH_LOCAL_REQUIRED: 403,
  AUTH_PASSWORD_INVALID: 400,
  AUTH_CONFIG_ERROR: 500,
};

export interface AuthRoutesDeps {
  authService: AuthService;
  adminPasswordService: AdminPasswordService;
  desktopAuthToken?: string;
  getRemoteAddress?: (context: Context) => string | undefined;
}

type EnableBody = { adminPassword: string; newPassword: string };
type ChangePasswordBody = { adminPassword: string; newPassword: string };
type DisableBody = { adminPassword: string };
type LoginBody = { password: string };

function shouldUseSecureCookie(c: {
  req: { url: string; header: (name: string) => string | undefined };
}): boolean {
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) {
    const protocol = forwardedProto.split(",")[0]?.trim().toLowerCase();
    if (protocol === "https") return true;
    if (protocol === "http") return false;
  }

  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

function asAuthError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  return new AuthError(
    AUTH_ERROR_CODES.configError,
    "Authentication configuration could not be read or saved safely",
    { cause: error },
  );
}

function authErrorResponse(c: Context, error: unknown): Response {
  const authError = asAuthError(error);
  return c.json(
    { error: authError.message, code: authError.code },
    AUTH_HTTP_STATUS[authError.code],
  );
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("Invalid body");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    throw new AuthError(
      AUTH_ERROR_CODES.passwordInvalid,
      "Required password fields are invalid",
      { cause: error },
    );
  }
}

function requirePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 6) {
    throw new AuthError(
      AUTH_ERROR_CODES.passwordInvalid,
      "Passwords must contain at least 6 characters",
    );
  }
  return value;
}

function requireLocalManagement(allowed: boolean): void {
  if (!allowed) {
    throw new AuthError(
      AUTH_ERROR_CODES.localRequired,
      "This operation is available only from localhost",
    );
  }
}

export function createAuthRoutes(deps: AuthRoutesDeps): Hono {
  const app = new Hono();
  const { authService, adminPasswordService, desktopAuthToken } = deps;
  const getRemoteAddress =
    deps.getRemoteAddress ?? ((c: Context) => getConnInfo(c).remote.address);
  const localManagementAllowed = (c: Context): boolean =>
    isLocalManagementRequest(new URL(c.req.url), getRemoteAddress(c));

  const verifyAdministrator = async (adminPassword: unknown): Promise<void> => {
    if (!(await adminPasswordService.isConfigured())) {
      throw new AuthError(
        AUTH_ERROR_CODES.adminNotConfigured,
        "Administrator password is not configured",
      );
    }
    if (typeof adminPassword !== "string") {
      throw new AuthError(
        AUTH_ERROR_CODES.passwordInvalid,
        "Administrator password is required",
      );
    }
    if (!(await adminPasswordService.verifyPassword(adminPassword))) {
      throw new AuthError(
        AUTH_ERROR_CODES.adminInvalid,
        "Administrator password is incorrect",
      );
    }
  };

  const handlePasswordMutation = async <T extends object>(
    c: Context,
    mutate: (body: T) => Promise<void>,
  ): Promise<Response> => {
    try {
      requireLocalManagement(localManagementAllowed(c));
      const body = (await readJsonBody(c)) as T & Record<string, unknown>;
      await verifyAdministrator(body.adminPassword);
      await mutate(body);
      deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
      return c.json({ success: true });
    } catch (error) {
      return authErrorResponse(c, error);
    }
  };

  app.get("/status", async (c) => {
    const enabled = authService.isEnabled();
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const authenticated =
      !enabled ||
      Boolean(sessionId && (await authService.validateSession(sessionId)));
    return c.json({
      enabled,
      authenticated,
      hasDesktopToken: Boolean(desktopAuthToken),
      localhostOpen: authService.isLocalhostOpen(),
      localManagementAllowed: localManagementAllowed(c),
    });
  });

  app.post("/enable", (c) =>
    handlePasswordMutation(c, async (body: EnableBody) => {
      await authService.setLoginPassword(requirePassword(body.newPassword));
    }),
  );

  app.post("/change-password", (c) =>
    handlePasswordMutation(c, async (body: ChangePasswordBody) => {
      await authService.setLoginPassword(requirePassword(body.newPassword));
    }),
  );

  app.post("/disable", (c) =>
    handlePasswordMutation(c, async (_body: DisableBody) => {
      await authService.disableAuth();
    }),
  );

  app.post("/login", async (c) => {
    try {
      const body = await readJsonBody(c);
      const password = requirePassword((body as LoginBody).password);
      const userAgent = c.req.header("User-Agent");
      let sessionId = await authService.createSessionForPassword(
        password,
        userAgent,
      );
      if (
        !sessionId &&
        localManagementAllowed(c) &&
        (await adminPasswordService.verifyPassword(password))
      ) {
        sessionId = await authService.createSession(userAgent);
      }
      if (!sessionId) {
        throw new AuthError(
          AUTH_ERROR_CODES.loginInvalid,
          "Login password is incorrect",
        );
      }
      setCookie(c, SESSION_COOKIE_NAME, sessionId, {
        httpOnly: true,
        secure: shouldUseSecureCookie(c),
        sameSite: "Lax",
        path: "/",
        maxAge: 30 * 24 * 60 * 60,
      });
      return c.json({ success: true });
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });

  app.post("/logout", async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (sessionId) await authService.invalidateSession(sessionId);
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    return c.json({ success: true });
  });

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
      const sessionId = getCookie(c, SESSION_COOKIE_NAME);
      if (sessionId && (await authService.validateSession(sessionId))) {
        authorized = true;
      }
    }
    if (!authorized) return c.json({ error: "Not authenticated" }, 401);

    const body = await c.req.json<{ open: boolean }>();
    if (typeof body.open !== "boolean") {
      return c.json({ error: "open must be a boolean" }, 400);
    }
    await authService.setLocalhostOpen(body.open);
    return c.json({ success: true, localhostOpen: body.open });
  });

  return app;
}
