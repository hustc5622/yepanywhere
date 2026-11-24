import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../../src/auth/AuthService.js";
import {
  SESSION_COOKIE_NAME,
  createAuthRoutes,
} from "../../src/auth/routes.js";

describe("Auth routes - POST /enable", () => {
  let authService: AuthService;
  let testDir: string;
  let routes: ReturnType<typeof createAuthRoutes>;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-routes-test-"));
    authService = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-cookie-secret",
    });
    await authService.initialize();
    routes = createAuthRoutes({ authService });
  });

  afterEach(async () => {
    // Request validation saves in the background; let it land first.
    await authService.flush();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function postEnable(
    body: { password: string },
    cookie?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cookie) {
      headers.Cookie = cookie;
    }

    return routes.request("/enable", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  async function postLogin(password: string): Promise<Response> {
    return routes.request("/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password }),
    });
  }

  it("allows unauthenticated first-time setup", async () => {
    const res = await postEnable({ password: "initial-password" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(authService.hasAccount()).toBe(true);
    await expect(authService.verifyPassword("initial-password")).resolves.toBe(
      true,
    );
  });

  it("rejects enable when auth is already enabled", async () => {
    await authService.enableAuth("current-password");

    const res = await postEnable({ password: "next-password" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Authentication is already enabled. Use change-password.",
    });
  });

  it("allows fresh setup after disabling auth without requiring prior password", async () => {
    await authService.enableAuth("current-password");
    const loginRes = await postLogin("current-password");
    const cookie = loginRes.headers.get("set-cookie");
    expect(loginRes.status).toBe(200);
    expect(cookie).toBeTruthy();

    const disableRes = await routes.request("/disable", {
      method: "POST",
      headers: {
        Cookie: cookie ?? "",
      },
    });
    expect(disableRes.status).toBe(200);
    expect(authService.isEnabled()).toBe(false);
    expect(authService.hasAccount()).toBe(false);

    const res = await postEnable({ password: "next-password" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    await expect(authService.verifyPassword("next-password")).resolves.toBe(
      true,
    );
    await expect(authService.verifyPassword("current-password")).resolves.toBe(
      false,
    );
  });
});

describe("Auth routes - cookie secure flag", () => {
  let authService: AuthService;
  let testDir: string;
  let routes: ReturnType<typeof createAuthRoutes>;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-routes-test-"));
    authService = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-cookie-secret",
    });
    await authService.initialize();
    await authService.enableAuth("password123");
    routes = createAuthRoutes({ authService });
  });

  afterEach(async () => {
    // Request validation saves in the background; let it land first.
    await authService.flush();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("does not set Secure on HTTP login cookies", async () => {
    const res = await routes.request("http://192.168.1.139/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: "password123" }),
    });

    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).not.toContain("Secure");
  });

  it("sets Secure on HTTPS login cookies", async () => {
    const res = await routes.request("https://example.com/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: "password123" }),
    });

    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("Secure");
  });
});

describe("Auth routes - hardening, sliding sessions, device management & pairing", () => {
  let authService: AuthService;
  let testDir: string;
  let now: number;

  beforeEach(async () => {
    now = 1_700_000_000_000;
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-hardening-test-"));
    authService = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-cookie-secret",
      sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
      maxSessionTtlMs: 90 * 24 * 60 * 60 * 1000,
      now: () => now,
    });
    await authService.initialize();
    await authService.enableAuth("strong-password-123");
  });

  afterEach(async () => {
    // Request validation saves in the background; let it land first.
    await authService.flush();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("omits authFilePath from /status when unauthenticated and reveals it when authenticated", async () => {
    const routes = createAuthRoutes({ authService, basePath: "/yep" });

    const unauthRes = await routes.request("https://39.106.189.88/status");
    expect(unauthRes.status).toBe(200);
    const unauthBody = (await unauthRes.json()) as Record<string, unknown>;
    expect(unauthBody.authenticated).toBe(false);
    expect(unauthBody.authFilePath).toBeUndefined();
    expect(unauthBody.pairingSupported).toBe(true);
    expect(unauthBody.isSecureTransport).toBe(true);

    const loginRes = await routes.request("https://39.106.189.88/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "strong-password-123" }),
    });
    expect(loginRes.status).toBe(200);
    const setCookie = loginRes.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Path=/yep");
    expect(setCookie).toContain("Secure");

    const authRes = await routes.request("https://39.106.189.88/status", {
      headers: { Cookie: setCookie.split(";")[0] ?? "" },
    });
    const authBody = (await authRes.json()) as Record<string, unknown>;
    expect(authBody.authenticated).toBe(true);
    expect(authBody.authFilePath).toBe(authService.getFilePath());
  });

  it("rate-limits repeated failed password attempts with 429 and Retry-After", async () => {
    const routes = createAuthRoutes({ authService });

    for (let i = 0; i < 4; i++) {
      const res = await routes.request("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "wrong-password" }),
      });
      expect(res.status).toBe(401);
    }

    const fifth = await routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    expect(fifth.status).toBe(429);
    expect(Number(fifth.headers.get("retry-after"))).toBeGreaterThan(0);

    // Even a valid password is blocked during lockout
    const duringLockout = await routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "strong-password-123" }),
    });
    expect(duringLockout.status).toBe(429);
  });

  it("supports one-time pairing token creation, redemption, and device session management", async () => {
    const routes = createAuthRoutes({ authService, basePath: "/yep" });

    // Login as primary device
    const loginRes = await routes.request("https://39.106.189.88/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Macintosh Safari",
      },
      body: JSON.stringify({ password: "strong-password-123" }),
    });
    const primaryCookie = (loginRes.headers.get("set-cookie") ?? "").split(
      ";",
    )[0];

    // Create pairing token
    const createRes = await routes.request(
      "https://39.106.189.88/pairing/create",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: primaryCookie ?? "",
        },
        body: JSON.stringify({ label: "Android Phone" }),
      },
    );
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as {
      token: string;
      loginPath: string;
    };
    expect(created.loginPath).toBe(`/yep/login#pair=${created.token}`);

    // Redeem pairing token on phone
    const redeemRes = await routes.request(
      "https://39.106.189.88/pairing/redeem",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Android Mobile Chrome",
        },
        body: JSON.stringify({ token: created.token }),
      },
    );
    expect(redeemRes.status).toBe(200);
    const phoneCookie = (redeemRes.headers.get("set-cookie") ?? "").split(
      ";",
    )[0];
    expect(phoneCookie).toContain(`${SESSION_COOKIE_NAME}=`);

    // Second redemption of same token fails
    const replayRes = await routes.request(
      "https://39.106.189.88/pairing/redeem",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: created.token }),
      },
    );
    expect(replayRes.status).toBe(401);

    // List sessions shows both devices without leaking raw session IDs
    const listRes = await routes.request("https://39.106.189.88/sessions", {
      headers: { Cookie: primaryCookie ?? "" },
    });
    expect(listRes.status).toBe(200);
    const { sessions } = (await listRes.json()) as {
      sessions: Array<{
        id: string;
        isCurrent: boolean;
        authMethod: string;
        deviceLabel?: string;
      }>;
    };
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.isCurrent).toBe(true);
    const phoneSession = sessions.find((s) => !s.isCurrent);
    expect(phoneSession?.authMethod).toBe("pairing");
    expect(phoneSession?.deviceLabel).toBe("Android Phone");
    expect(phoneCookie).not.toContain(phoneSession?.id ?? "");

    // Revoke phone session
    const revokeRes = await routes.request(
      `https://39.106.189.88/sessions/${phoneSession?.id}`,
      {
        method: "DELETE",
        headers: { Cookie: primaryCookie ?? "" },
      },
    );
    expect(revokeRes.status).toBe(200);

    const phoneStatusRes = await routes.request(
      "https://39.106.189.88/status",
      {
        headers: { Cookie: phoneCookie ?? "" },
      },
    );
    const phoneStatus = (await phoneStatusRes.json()) as {
      authenticated: boolean;
    };
    expect(phoneStatus.authenticated).toBe(false);
  });

  it("extends sliding sessions across activity and revokes other sessions on password change", async () => {
    const routes = createAuthRoutes({ authService });
    const loginA = await routes.request("https://39.106.189.88/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "strong-password-123" }),
    });
    const cookieA = (loginA.headers.get("set-cookie") ?? "").split(";")[0];

    const loginB = await routes.request("https://39.106.189.88/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "strong-password-123" }),
    });
    const cookieB = (loginB.headers.get("set-cookie") ?? "").split(";")[0];

    // Advance 20 days -> session A slides forward by another 30 days
    now += 20 * 24 * 60 * 60 * 1000;
    const refreshRes = await routes.request("https://39.106.189.88/status", {
      headers: { Cookie: cookieA ?? "" },
    });
    expect(refreshRes.headers.get("set-cookie")).toContain(
      `${SESSION_COOKIE_NAME}=`,
    );

    // Advance 20 more days (40 days total > 30d initial window, still valid for A, expired for idle B)
    now += 20 * 24 * 60 * 60 * 1000;
    const statusA = (await (
      await routes.request("https://39.106.189.88/status", {
        headers: { Cookie: cookieA ?? "" },
      })
    ).json()) as { authenticated: boolean };
    const statusB = (await (
      await routes.request("https://39.106.189.88/status", {
        headers: { Cookie: cookieB ?? "" },
      })
    ).json()) as { authenticated: boolean };
    expect(statusA.authenticated).toBe(true);
    expect(statusB.authenticated).toBe(false);

    // Re-login B, then change password from A -> B is revoked, A stays valid
    const loginB2 = await routes.request("https://39.106.189.88/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "strong-password-123" }),
    });
    const cookieB2 = (loginB2.headers.get("set-cookie") ?? "").split(";")[0];

    const changeRes = await routes.request(
      "https://39.106.189.88/change-password",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieA ?? "",
        },
        body: JSON.stringify({ newPassword: "rotated-password-456" }),
      },
    );
    expect(changeRes.status).toBe(200);

    const statusAAfter = (await (
      await routes.request("https://39.106.189.88/status", {
        headers: { Cookie: cookieA ?? "" },
      })
    ).json()) as { authenticated: boolean };
    const statusBAfter = (await (
      await routes.request("https://39.106.189.88/status", {
        headers: { Cookie: cookieB2 ?? "" },
      })
    ).json()) as { authenticated: boolean };
    expect(statusAAfter.authenticated).toBe(true);
    expect(statusBAfter.authenticated).toBe(false);
  });
});

describe("Auth routes - token transport for cross-site frames", () => {
  let authService: AuthService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-token-test-"));
    authService = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-cookie-secret",
    });
    await authService.initialize();
    await authService.enableAuth("strong-password-123");
  });

  afterEach(async () => {
    // Request validation saves in the background; let it land first.
    await authService.flush();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function login(
    routes: ReturnType<typeof createAuthRoutes>,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "strong-password-123", ...body }),
    });
  }

  it("keeps the session token out of normal browser login responses", async () => {
    const routes = createAuthRoutes({ authService });
    const res = await login(routes, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it("returns a bearer token that authenticates status and logout", async () => {
    const routes = createAuthRoutes({ authService });
    const res = await login(routes, { tokenTransport: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionToken?: string };
    expect(body.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    const authorization = `Bearer ${body.sessionToken}`;

    const status = await routes.request("/status", {
      headers: { Authorization: authorization },
    });
    const statusBody = (await status.json()) as { authenticated: boolean };
    expect(statusBody.authenticated).toBe(true);
    // Token-authenticated requests never get a refreshed cookie.
    expect(status.headers.get("set-cookie")).toBeNull();

    const sessions = await routes.request("/sessions", {
      headers: { Authorization: authorization },
    });
    expect(sessions.status).toBe(200);

    const logout = await routes.request("/logout", {
      method: "POST",
      headers: { Authorization: authorization },
    });
    expect(logout.status).toBe(200);

    const after = await routes.request("/status", {
      headers: { Authorization: authorization },
    });
    expect(
      ((await after.json()) as { authenticated: boolean }).authenticated,
    ).toBe(false);
  });

  it("accepts the query token only on read requests", async () => {
    const routes = createAuthRoutes({ authService });
    const res = await login(routes, { tokenTransport: true });
    const { sessionToken } = (await res.json()) as { sessionToken: string };

    const read = await routes.request(
      `/sessions?yep_auth=${encodeURIComponent(sessionToken)}`,
    );
    expect(read.status).toBe(200);

    const write = await routes.request(
      `/logout-all?yep_auth=${encodeURIComponent(sessionToken)}`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
    );
    expect(write.status).toBe(401);
  });

  it("returns the token from pairing redemption when requested", async () => {
    const routes = createAuthRoutes({ authService });
    const loginRes = await login(routes, { tokenTransport: true });
    const { sessionToken } = (await loginRes.json()) as {
      sessionToken: string;
    };
    const created = await routes.request("/pairing/create", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const { token } = (await created.json()) as { token: string };

    const redeemed = await routes.request("/pairing/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, tokenTransport: true }),
    });
    expect(redeemed.status).toBe(200);
    const body = (await redeemed.json()) as { sessionToken?: string };
    expect(body.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(body.sessionToken).not.toBe(sessionToken);
  });
});
