import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../../src/auth/AuthService.js";
import { createAuthMiddleware } from "../../src/middleware/auth.js";

describe("authentication middleware", () => {
  let testDir: string;
  let authService: AuthService;
  let app: Hono;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-middleware-test-"));
    authService = new AuthService({ dataDir: testDir });
    await authService.initialize();
    app = new Hono();
    app.use(
      "*",
      createAuthMiddleware({ authService, desktopAuthToken: "desktop-token" }),
    );
    app.all("*", (c) => c.json({ reached: c.req.path }));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it.each([
    "/api/auth/status",
    "/api/auth/login",
    "/api/auth/enable",
    "/api/auth/change-password",
    "/api/auth/disable",
    "/api/auth/logout",
  ])(
    "lets %s reach route-local authorization despite the desktop-token floor",
    async (routePath) => {
      const response = await app.request(routePath, { method: "POST" });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ reached: routePath });
    },
  );

  it("keeps the desktop-token floor for non-auth APIs unless localhostOpen is enabled", async () => {
    const blocked = await app.request("/api/projects");
    expect(blocked.status).toBe(401);

    await authService.setLocalhostOpen(true);
    const open = await app.request("/api/projects");
    expect(open.status).toBe(200);
    expect(await open.json()).toEqual({ reached: "/api/projects" });
  });

  it("keeps non-auth APIs session-protected when ordinary login is enabled", async () => {
    await authService.setLoginPassword("login-password");

    const authRoute = await app.request("/api/auth/disable", {
      method: "POST",
    });
    const nonAuthRoute = await app.request("/api/projects");

    expect(authRoute.status).toBe(200);
    expect(nonAuthRoute.status).toBe(401);
  });
});
