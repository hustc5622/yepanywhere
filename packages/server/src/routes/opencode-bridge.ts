import { Hono } from "hono";
import type { OpenCodeBridgeController } from "../opencode-bridge/types.js";

export interface OpenCodeBridgeRoutesDeps {
  opencodeBridgeService: OpenCodeBridgeController;
}

export function createOpenCodeBridgeRoutes(
  deps: OpenCodeBridgeRoutesDeps,
): Hono {
  const routes = new Hono();

  routes.get("/status", async (c) => {
    return c.json(await deps.opencodeBridgeService.getStatus());
  });

  routes.get("/sessions", async (c) => {
    return c.json({
      sessions: await deps.opencodeBridgeService.listSessions(),
    });
  });

  routes.get("/session-views", async (c) => {
    return c.json({
      sessions: await deps.opencodeBridgeService.listSessionViews(),
    });
  });

  routes.get("/sessions/:sessionId/view", async (c) => {
    const sessionId = c.req.param("sessionId");
    return c.json({
      sessionView: await deps.opencodeBridgeService.getSessionView(sessionId),
    });
  });

  routes.get("/sessions/:sessionId/active", async (c) => {
    const sessionId = c.req.param("sessionId");
    return c.json({
      active: await deps.opencodeBridgeService.isSessionActive(sessionId),
    });
  });

  routes.get("/sessions/:sessionId/pending-input", async (c) => {
    const sessionId = c.req.param("sessionId");
    return c.json({
      request:
        await deps.opencodeBridgeService.getPendingInputRequest(sessionId),
    });
  });

  return routes;
}
