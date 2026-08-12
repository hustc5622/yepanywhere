import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminPasswordService } from "../../src/auth/AdminPasswordService.js";
import { AuthService } from "../../src/auth/AuthService.js";
import { AUTH_ERROR_CODES } from "../../src/auth/authErrors.js";
import {
  SESSION_COOKIE_NAME,
  createAuthRoutes,
} from "../../src/auth/routes.js";

describe("authentication API", () => {
  let testDir: string;
  let authService: AuthService;
  let adminPasswordService: AdminPasswordService;
  let remoteAddress: string;
  let routes: ReturnType<typeof createAuthRoutes>;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-routes-test-"));
    authService = new AuthService({
      dataDir: path.join(testDir, "profile"),
      cookieSecret: "test-cookie-secret",
    });
    adminPasswordService = new AdminPasswordService({
      filePath: path.join(testDir, "global", "admin.json"),
    });
    await authService.initialize();
    remoteAddress = "127.0.0.1";
    routes = createAuthRoutes({
      authService,
      adminPasswordService,
      desktopAuthToken: "desktop-token",
      getRemoteAddress: () => remoteAddress,
    });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function request(
    routePath: string,
    options: {
      method?: string;
      body?: unknown;
      cookie?: string;
      origin?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (options.cookie) {
      headers.Cookie = options.cookie;
    }
    return routes.request(
      `${options.origin ?? "http://localhost:8022"}${routePath}`,
      {
        method: options.method ?? "GET",
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      },
    );
  }

  async function login(
    password: string,
    options: { origin?: string; address?: string } = {},
  ): Promise<Response> {
    if (options.address) remoteAddress = options.address;
    return request("/login", {
      method: "POST",
      origin: options.origin,
      body: { password },
    });
  }

  it("returns only the approved status fields", async () => {
    const response = await request("/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabled: false,
      authenticated: true,
      hasDesktopToken: true,
      localhostOpen: false,
      localManagementAllowed: true,
    });
  });

  it("allows remote login only with the ordinary login password", async () => {
    await adminPasswordService.setPassword("admin-password");
    await authService.setLoginPassword("login-password");

    const adminResponse = await login("admin-password", {
      origin: "https://example.test",
      address: "192.168.1.20",
    });
    const loginResponse = await login("login-password", {
      origin: "https://example.test",
      address: "192.168.1.20",
    });

    expect(adminResponse.status).toBe(401);
    expect(await adminResponse.json()).toEqual({
      error: expect.any(String),
      code: AUTH_ERROR_CODES.loginInvalid,
    });
    expect(loginResponse.status).toBe(200);
    expect(loginResponse.headers.get("set-cookie")).toContain("Secure");
  });

  it("creates the same session shape for local ordinary and administrator login", async () => {
    await adminPasswordService.setPassword("admin-password");
    await authService.setLoginPassword("login-password");

    const ordinaryResponse = await login("login-password");
    expect(ordinaryResponse.status).toBe(200);
    const afterOrdinary = JSON.parse(
      await fs.readFile(path.join(testDir, "profile", "auth.json"), "utf8"),
    );
    const ordinarySession = Object.values(afterOrdinary.sessions)[0] as object;

    const adminResponse = await login("admin-password");
    expect(adminResponse.status).toBe(200);
    const afterAdmin = JSON.parse(
      await fs.readFile(path.join(testDir, "profile", "auth.json"), "utf8"),
    );
    const sessions = Object.values(afterAdmin.sessions) as object[];

    expect(Object.keys(ordinarySession).sort()).toEqual([
      "createdAt",
      "lastActiveAt",
    ]);
    expect(Object.keys(sessions[1] ?? {}).sort()).toEqual(
      Object.keys(ordinarySession).sort(),
    );
  });

  it("keeps missing administrator configuration indistinguishable during local login", async () => {
    await authService.setLoginPassword("login-password");

    const response = await login("not-the-login-password");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: expect.any(String),
      code: AUTH_ERROR_CODES.loginInvalid,
    });
  });

  it("reports malformed administrator configuration safely during local fallback", async () => {
    await authService.setLoginPassword("login-password");
    await fs.mkdir(path.dirname(adminPasswordService.getFilePath()), {
      recursive: true,
    });
    await fs.writeFile(adminPasswordService.getFilePath(), "not-json", "utf8");

    const response = await login("not-the-login-password");
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      error: expect.any(String),
      code: AUTH_ERROR_CODES.configError,
    });
    expect(body).not.toContain("not-json");
  });

  it.each([
    [
      "/enable",
      { adminPassword: "admin-password", newPassword: "new-password" },
    ],
    [
      "/change-password",
      { adminPassword: "admin-password", newPassword: "new-password" },
    ],
    ["/disable", { adminPassword: "admin-password" }],
  ])(
    "rejects remote management at %s despite HTTPS and forged forwarding headers",
    async (routePath, body) => {
      await adminPasswordService.setPassword("admin-password");
      remoteAddress = "192.168.1.20";

      const response = await request(routePath, {
        method: "POST",
        origin: "https://example.test",
        headers: {
          "X-Forwarded-For": "127.0.0.1",
          "X-Forwarded-Proto": "http",
        },
        body,
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: expect.any(String),
        code: AUTH_ERROR_CODES.localRequired,
      });
    },
  );

  it("maps missing admin, wrong admin, and invalid new password to stable errors", async () => {
    const missing = await request("/enable", {
      method: "POST",
      body: { adminPassword: "admin-password", newPassword: "login-password" },
    });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({
      code: AUTH_ERROR_CODES.adminNotConfigured,
    });

    await adminPasswordService.setPassword("admin-password");
    const wrong = await request("/change-password", {
      method: "POST",
      body: { adminPassword: "wrong-admin", newPassword: "login-password" },
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({
      code: AUTH_ERROR_CODES.adminInvalid,
    });

    const invalid = await request("/enable", {
      method: "POST",
      body: { adminPassword: "admin-password", newPassword: "short" },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      code: AUTH_ERROR_CODES.passwordInvalid,
    });
  });

  it("enable, change, and disable each clear sessions and the current Cookie", async () => {
    await adminPasswordService.setPassword("admin-password");
    await authService.setLoginPassword("first-password");

    for (const [routePath, body, expectedPassword, enabled] of [
      [
        "/enable",
        { adminPassword: "admin-password", newPassword: "enabled-password" },
        "enabled-password",
        true,
      ],
      [
        "/change-password",
        { adminPassword: "admin-password", newPassword: "changed-password" },
        "changed-password",
        true,
      ],
      ["/disable", { adminPassword: "admin-password" }, undefined, false],
    ] as const) {
      const oldSession = await authService.createSession("test-agent");
      const response = await request(routePath, {
        method: "POST",
        cookie: `${SESSION_COOKIE_NAME}=${oldSession}`,
        body,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain(
        `${SESSION_COOKIE_NAME}=`,
      );
      await expect(authService.validateSession(oldSession)).resolves.toBe(
        false,
      );
      expect(authService.isEnabled()).toBe(enabled);
      if (expectedPassword) {
        await expect(
          authService.verifyPassword(expectedPassword),
        ).resolves.toBe(true);
      }
    }
  });

  it("never treats an authenticated Cookie as administrator verification", async () => {
    await adminPasswordService.setPassword("admin-password");
    await authService.setLoginPassword("login-password");
    const sessionId = await authService.createSession();
    const supplied = "wrong-administrator-secret";

    const response = await request("/change-password", {
      method: "POST",
      cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
      body: { adminPassword: supplied, newPassword: "next-password" },
    });
    const responseBody = await response.text();

    expect(response.status).toBe(401);
    expect(JSON.parse(responseBody)).toMatchObject({
      code: AUTH_ERROR_CODES.adminInvalid,
    });
    expect(responseBody).not.toContain(supplied);
    expect(responseBody).not.toContain("$2b$");
  });

  it("does not expose the removed setup route", async () => {
    const response = await request("/setup", {
      method: "POST",
      body: { password: "unapproved-password" },
    });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("unapproved-password");
  });

  it("retains the HTTP and HTTPS login Cookie behavior", async () => {
    await authService.setLoginPassword("login-password");

    const httpResponse = await login("login-password", {
      origin: "http://192.168.1.10",
      address: "192.168.1.20",
    });
    const httpsResponse = await login("login-password", {
      origin: "https://example.test",
      address: "192.168.1.20",
    });

    expect(httpResponse.headers.get("set-cookie")).not.toContain("Secure");
    expect(httpsResponse.headers.get("set-cookie")).toContain("Secure");
  });
});
