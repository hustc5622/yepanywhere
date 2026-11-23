import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AuthService } from "../../src/auth/AuthService.js";
import { createAuthMiddleware } from "../../src/middleware/auth.js";

function appWithAuth(basePath?: string) {
  const authService = {
    isEnabled: () => true,
    hasAccount: () => true,
    isLocalhostOpen: () => false,
    validateSession: async () => false,
  } as unknown as AuthService;
  const root = new Hono();
  const app = basePath ? root.basePath(basePath) : root;
  app.use("/api/*", createAuthMiddleware({ authService, basePath }));
  app.get("/api/auth/status", (c) => c.text("auth"));
  app.get("/api/public/session-shares/:token", (c) => c.text("public"));
  app.get("/api/projects", (c) => c.text("private"));
  return app;
}

describe("auth middleware path exemptions", () => {
  it.each([undefined, "/yep"])(
    "matches exemptions after the base path (%s)",
    async (basePath) => {
      const app = appWithAuth(basePath);
      const prefix = basePath ?? "";
      const get = (path: string) => app.request(`${prefix}${path}`, {}, {});

      expect((await get("/api/auth/status")).status).toBe(200);
      expect((await get("/api/public/session-shares/abc")).status).toBe(200);
      expect((await get("/api/projects")).status).toBe(401);
    },
  );

  it("does not treat a lookalike prefix as the base path", async () => {
    const app = appWithAuth("/yep");
    // `/yepx/...` never reaches the base-pathed routes at all.
    const res = await app.request(
      "/yepx/api/public/session-shares/abc",
      {},
      {},
    );
    expect(res.status).toBe(404);
  });
});

describe("auth middleware session credentials", () => {
  const VALID = "a".repeat(64);

  function appWithSession() {
    const authService = {
      isEnabled: () => true,
      hasAccount: () => true,
      isLocalhostOpen: () => false,
      validateSessionWithRefresh: async (sessionId: string) => ({
        valid: sessionId === VALID,
        shouldRefreshCookie: true,
        cookieMaxAgeSec: 3600,
      }),
    } as unknown as AuthService;
    const app = new Hono();
    app.use("/api/*", createAuthMiddleware({ authService }));
    app.get("/api/projects", (c) => c.text("private"));
    app.post("/api/projects", (c) => c.text("written"));
    return app;
  }

  it("accepts a bearer token without refreshing a cookie", async () => {
    const res = await appWithSession().request(
      "/api/projects",
      { headers: { Authorization: `Bearer ${VALID}` } },
      {},
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("still refreshes cookie-based sessions", async () => {
    const res = await appWithSession().request(
      "/api/projects",
      { headers: { Cookie: `yep-anywhere-session=${VALID}` } },
      {},
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("yep-anywhere-session=");
  });

  it("accepts the query token for GET (media, WebSocket upgrade)", async () => {
    const res = await appWithSession().request(
      `/api/projects?yep_auth=${VALID}`,
      {},
      {},
    );
    expect(res.status).toBe(200);
  });

  it("rejects the query token for writes", async () => {
    const res = await appWithSession().request(
      `/api/projects?yep_auth=${VALID}`,
      { method: "POST" },
      {},
    );
    expect(res.status).toBe(401);
  });

  it("rejects an invalid bearer token", async () => {
    const res = await appWithSession().request(
      "/api/projects",
      { headers: { Authorization: "Bearer nope" } },
      {},
    );
    expect(res.status).toBe(401);
  });
});
