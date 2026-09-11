import { Hono } from "hono";
import type { FeishuChannelService } from "../channels/feishu/service.js";
import { FEISHU_MCP_TOOLS } from "../channels/feishu/user-auth/mcp-gateway.js";

/** Mounted under /api/auth: each endpoint verifies its own single-purpose credential. */
export function createFeishuUserAuthRoutes(service: FeishuChannelService) {
  const app = new Hono();
  app.get("/callback", async (c) => {
    try {
      await service.userAuth.complete(
        c.req.query("state") ?? "",
        c.req.query("code"),
        c.req.query("error"),
      );
      return c.redirect("./result?status=complete", 303);
    } catch (error) {
      return c.text(
        error instanceof Error ? error.message : "Authorization failed",
        400,
      );
    }
  });
  app.get("/result", (c) =>
    c.text(
      "飞书授权完成。请返回原会话继续任务。\nFeishu authorization completed. Return to the original conversation to continue.",
    ),
  );
  app.post("/mcp", async (c) => {
    const gateway = service.mcpGateway;
    if (!gateway) return c.json({ error: "feishu_mcp_unavailable" }, 503);
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
    try {
      await gateway.authenticate(token);
    } catch {
      return c.json({ error: "invalid_mcp_credential" }, 401);
    }
    let body: {
      method?: string;
      params?: { name?: string; arguments?: unknown };
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (body.method === "tools/list")
      return c.json({ tools: FEISHU_MCP_TOOLS });
    if (
      body.method !== "tools/call" ||
      typeof body.params?.name !== "string" ||
      (body.params.arguments !== undefined &&
        (!body.params.arguments ||
          typeof body.params.arguments !== "object" ||
          Array.isArray(body.params.arguments)))
    )
      return c.json({ error: "invalid_mcp_request" }, 400);
    return c.json(
      await gateway.call(
        token,
        body.params.name,
        (body.params.arguments as Record<string, unknown>) ?? {},
        c.req.raw.signal,
      ),
    );
  });
  return app;
}
