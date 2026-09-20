import { Hono } from "hono";
import type {
  CodexAccountsService,
  CodexLoginMode,
} from "../codex-bridge/CodexAccountsService.js";

export interface CodexAccountsRoutesDeps {
  codexAccountsService: CodexAccountsService;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCodexAccountsRoutes(deps: CodexAccountsRoutesDeps): Hono {
  const routes = new Hono();
  const service = deps.codexAccountsService;

  routes.get("/", async (c) => {
    try {
      const accounts = await service.list({
        fresh: c.req.query("fresh") === "1",
      });
      return c.json({ accounts, error: null });
    } catch (error) {
      return c.json({ accounts: [], error: errorMessage(error) }, 500);
    }
  });

  routes.post("/", async (c) => {
    const body = await c.req
      .json<{ label?: string }>()
      .catch(() => ({}) as { label?: string });
    try {
      return c.json({ account: service.addAccount(body.label) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  routes.patch("/:accountId", async (c) => {
    const body = await c.req
      .json<{ label?: string | null }>()
      .catch(() => ({}) as { label?: string | null });
    try {
      service.renameAccount(c.req.param("accountId"), body.label ?? null);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  routes.delete("/:accountId", (c) => {
    try {
      service.removeAccount(c.req.param("accountId"));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  routes.post("/:accountId/login", async (c) => {
    const body = await c.req
      .json<{ mode?: CodexLoginMode }>()
      .catch(() => ({}) as { mode?: CodexLoginMode });
    const mode: CodexLoginMode =
      body.mode === "browser" ? "browser" : "deviceCode";
    try {
      return c.json({
        login: await service.startLogin(c.req.param("accountId"), mode),
        error: null,
      });
    } catch (error) {
      return c.json({ login: null, error: errorMessage(error) }, 400);
    }
  });

  routes.get("/:accountId/login", (c) =>
    c.json({ login: service.getLoginState(c.req.param("accountId")) }),
  );

  routes.delete("/:accountId/login", async (c) => {
    await service.cancelLogin(c.req.param("accountId"));
    return c.json({ ok: true });
  });

  routes.post("/:accountId/logout", async (c) => {
    try {
      await service.logout(c.req.param("accountId"));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  routes.post("/:accountId/usage/reset", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      body.confirmed !== true ||
      typeof body.idempotencyKey !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        body.idempotencyKey,
      ) ||
      (body.creditId !== undefined &&
        (typeof body.creditId !== "string" || !body.creditId.trim()))
    ) {
      return c.json(
        { error: "A confirmed reset and a UUID idempotencyKey are required" },
        400,
      );
    }
    try {
      return c.json(
        await service.resetUsage(c.req.param("accountId"), {
          idempotencyKey: body.idempotencyKey,
          ...(body.creditId !== undefined ? { creditId: body.creditId } : {}),
        }),
      );
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  routes.post("/:accountId/activate", async (c) => {
    try {
      await service.activate(c.req.param("accountId"));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return routes;
}
