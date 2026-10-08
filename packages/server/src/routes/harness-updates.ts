import type { HarnessId } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { isProviderEnabled } from "../sdk/providers/policy.js";
import type { HarnessUpdateService } from "../services/HarnessUpdateService.js";

export function createHarnessUpdateRoutes(options: {
  service: HarnessUpdateService;
  enabledProviders?: string[];
}): Hono {
  const routes = new Hono();
  const ids: HarnessId[] = ["codex", "pi"];
  const enabled = (id: HarnessId) =>
    isProviderEnabled(id, options.enabledProviders) ||
    (id === "codex" &&
      isProviderEnabled("codex-oss", options.enabledProviders));

  routes.get("/", async (c) => {
    return c.json({
      harnesses: await Promise.all(
        ids.filter(enabled).map((id) => options.service.getInfo(id)),
      ),
    });
  });

  routes.post("/:id/:action", async (c) => {
    const id = c.req.param("id") as HarnessId;
    const action = c.req.param("action");
    if (
      !ids.includes(id) ||
      !enabled(id) ||
      !["check", "update"].includes(action)
    ) {
      return c.json({ error: "Harness update action not found" }, 404);
    }
    if (action === "check")
      return c.json({ harness: await options.service.check(id) });
    const job = options.service.start(id);
    if (!job)
      return c.json({ error: "Another CLI update is already running" }, 409);
    return c.json({ job }, 202);
  });
  return routes;
}
