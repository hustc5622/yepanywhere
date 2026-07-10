import { Hono } from "hono";
import type { CodexBridgeController } from "../codex-bridge/types.js";

export interface CodexBridgeRoutesDeps {
  codexBridgeService: CodexBridgeController;
}

export function createCodexBridgeRoutes(deps: CodexBridgeRoutesDeps): Hono {
  const routes = new Hono();

  routes.get("/status", async (c) => {
    return c.json(await deps.codexBridgeService.getStatus());
  });

  routes.get("/usage", async (c) => {
    const usage = deps.codexBridgeService.getUsage
      ? await deps.codexBridgeService.getUsage({
          fresh: c.req.query("fresh") === "1",
        })
      : { usage: null, error: "Codex usage is unavailable" };
    return c.json(usage);
  });

  routes.get("/sessions", async (c) => {
    return c.json({ sessions: await deps.codexBridgeService.listSessions() });
  });

  routes.get("/sessions/:sessionId/pending-input", async (c) => {
    const sessionId = c.req.param("sessionId");
    return c.json({
      request: await deps.codexBridgeService.getPendingInputRequest(sessionId),
    });
  });

  return routes;
}
