/**
 * ZCode bridge routes.
 *
 * Two audiences share one mount point:
 *   - The ZCode plugin hook (plugin → server): POST /hook, authenticated with
 *     the shared token from `~/.zcode/yep-bridge.json` in X-ZCode-Bridge-Token.
 *     This path is exempt from cookie auth (see middleware/auth.ts) so the
 *     hook works even when password auth is enabled; the shared token is the
 *     sole guard and is loopback-only by deployment.
 *   - The Yep client (client → server): GET sessions / pending-inputs and POST
 *     decisions, protected by the normal client auth middleware like every
 *     other /api route.
 */

import type { ZCodeBridgeDecision } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { ZCodeBridgeService } from "../zcode-bridge/ZCodeBridgeService.js";
import type { ZCodeBridgeHookPayload } from "../zcode-bridge/types.js";

export interface ZCodeBridgeRoutesDeps {
  bridge: ZCodeBridgeService;
}

const BRIDGE_TOKEN_HEADER = "x-zcode-bridge-token";

export function createZCodeBridgeRoutes(deps: ZCodeBridgeRoutesDeps): Hono {
  const routes = new Hono();

  // Plugin → server. Long-polls internally for PermissionRequest decisions;
  // every other event is fire-and-forget ({ok: true}).
  routes.post("/hook", async (c) => {
    if (!(await deps.bridge.isConfigured())) {
      return c.json(
        {
          error:
            "ZCode bridge is not installed (run scripts/install-zcode-yep-plugin.sh)",
        },
        503,
      );
    }
    const token = c.req.header(BRIDGE_TOKEN_HEADER);
    if (!(await deps.bridge.validateToken(token))) {
      return c.json({ error: "Invalid bridge token" }, 401);
    }

    let payload: ZCodeBridgeHookPayload;
    try {
      payload = (await c.req.json()) as ZCodeBridgeHookPayload;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof payload?.hook_event_name !== "string") {
      return c.json({ error: "hook_event_name is required" }, 400);
    }

    return c.json(await deps.bridge.handleHook(payload));
  });

  // Client → server: active external ZCode sessions observed via the plugin.
  routes.get("/sessions", async (c) => {
    return c.json({
      sessions: deps.bridge.listSessions(),
      installed: await deps.bridge.isConfigured(),
    });
  });

  routes.get("/pending-inputs", async (c) => {
    return c.json({ pendingInputs: deps.bridge.listPendingInputs() });
  });

  routes.post("/pending-inputs/:id/decision", async (c) => {
    const id = c.req.param("id");
    let body: Partial<ZCodeBridgeDecision> & { message?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (body.behavior !== "allow" && body.behavior !== "deny") {
      return c.json({ error: "behavior must be allow or deny" }, 400);
    }
    const decision: ZCodeBridgeDecision =
      body.behavior === "allow"
        ? {
            behavior: "allow",
            ...(body.updatedInput !== undefined
              ? { updatedInput: body.updatedInput }
              : {}),
          }
        : {
            behavior: "deny",
            ...(body.message !== undefined ? { message: body.message } : {}),
          };
    if (!deps.bridge.applyDecision(id, decision)) {
      return c.json(
        { error: "Pending input no longer exists (timed out or decided)" },
        404,
      );
    }
    return c.json({ accepted: true });
  });

  return routes;
}
