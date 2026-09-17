import { Hono } from "hono";
import type { LlmGatewayKeysService } from "../llm-gateways/LlmGatewayKeysService.js";

export interface LlmGatewayKeysRoutesDeps {
  llmGatewayKeysService: LlmGatewayKeysService;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read/write access to the selectable gateway keys.
 *
 * `GET` stays cheap by default: the new-session picker only needs the key
 * list, while the settings card asks for `probe=1` to also report
 * reachability, model access and balance.
 */
export function createLlmGatewayKeysRoutes(
  deps: LlmGatewayKeysRoutesDeps,
): Hono {
  const routes = new Hono();
  const service = deps.llmGatewayKeysService;

  routes.get("/", async (c) => {
    try {
      const channels = await service.list({
        probe: c.req.query("probe") === "1",
        fresh: c.req.query("fresh") === "1",
      });
      return c.json({ channels, error: null });
    } catch (error) {
      return c.json({ channels: [], error: errorMessage(error) }, 500);
    }
  });

  routes.post("/", async (c) => {
    const body = await c.req
      .json<{ channelId?: string; apiKey?: string; label?: string | null }>()
      .catch(
        () =>
          ({}) as {
            channelId?: string;
            apiKey?: string;
            label?: string | null;
          },
      );
    if (!body.channelId || !body.apiKey) {
      return c.json({ error: "channelId and apiKey are required" }, 400);
    }
    try {
      return c.json({
        key: await service.addKey({
          channelId: body.channelId,
          apiKey: body.apiKey,
          label: body.label ?? null,
        }),
        error: null,
      });
    } catch (error) {
      return c.json({ key: null, error: errorMessage(error) }, 400);
    }
  });

  routes.patch("/:keyId", async (c) => {
    const body = await c.req
      .json<{ label?: string | null }>()
      .catch(() => ({}) as { label?: string | null });
    try {
      service.renameKey(c.req.param("keyId"), body.label ?? null);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  routes.delete("/:keyId", (c) => {
    try {
      service.removeKey(c.req.param("keyId"));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return routes;
}
