import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../../src/auth/AuthService.js";
import { AuthRateLimiter } from "../../src/auth/RateLimiter.js";
import { createAuthRoutes } from "../../src/auth/routes.js";
import { setupAuth } from "../../src/cli-setup.js";

describe("Auth login rate limit feedback", () => {
  let authService: AuthService;
  let testDir: string;
  let routes: ReturnType<typeof createAuthRoutes>;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-limit-test-"));
    authService = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-cookie-secret",
    });
    await authService.initialize();
    await authService.enableAuth("strong-password-123");
    routes = createAuthRoutes({
      authService,
      rateLimiter: new AuthRateLimiter({
        softThreshold: 3,
        softLockoutMs: 60_000,
        hardThreshold: 5,
        hardLockoutMs: 900_000,
        windowMs: 900_000,
        globalThreshold: 1000,
      }),
    });
  });

  afterEach(async () => {
    await authService.flush();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function postLogin(password: string): Promise<Response> {
    return routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
  }

  it("says how many attempts are left before the lockout", async () => {
    const first = await postLogin("wrong-password");
    expect(first.status).toBe(401);
    const body = (await first.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      attemptsRemaining: 2,
      nextLockoutSec: 60,
      nextTier: "soft",
    });
  });

  it("reports the lockout tier and duration when locked out", async () => {
    for (let i = 0; i < 2; i++) {
      expect((await postLogin("wrong-password")).status).toBe(401);
    }

    const soft = await postLogin("wrong-password");
    expect(soft.status).toBe(429);
    expect(Number(soft.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await soft.json()).toMatchObject({
      retryAfterSec: 60,
      lockoutSec: 60,
      tier: "soft",
    });
  });

  it("clears the lockout after `--setup-auth` rewrites the password", async () => {
    for (let i = 0; i < 3; i++) await postLogin("wrong-password");
    expect((await postLogin("wrong-password")).status).toBe(429);

    // What the CLI does: a separate short-lived process rewrites auth.json.
    await setupAuth({ password: "reset-password-456", dataDir: testDir });

    const afterReset = await postLogin("reset-password-456");
    expect(afterReset.status).toBe(200);
  });

  it("clears the lockout when the password is changed through the API", async () => {
    const login = await postLogin("strong-password-123");
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    for (let i = 0; i < 3; i++) await postLogin("wrong-password");
    expect((await postLogin("wrong-password")).status).toBe(429);

    const changed = await routes.request("/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ newPassword: "another-password-789" }),
    });
    expect(changed.status).toBe(200);

    expect((await postLogin("another-password-789")).status).toBe(200);
  });
});
