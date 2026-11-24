import type { HarnessId } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { isProviderEnabled } from "../sdk/providers/policy.js";
import type { HarnessUpdateService } from "../services/HarnessUpdateService.js";

const ALL_HARNESS_IDS: readonly HarnessId[] = [
  "codex",
  "pi",
  "cursor",
  "mcode",
  "agy",
  "dsh",
];

export function createHarnessUpdateRoutes(options: {
  service: HarnessUpdateService;
  enabledProviders?: string[];
  dshEnabled?: boolean;
}): Hono {
  const routes = new Hono();
  const enabled = (id: HarnessId) =>
    (id === "dsh"
      ? options.dshEnabled === true
      : isProviderEnabled(id, options.enabledProviders)) ||
    (id === "codex" &&
      isProviderEnabled("codex-oss", options.enabledProviders));

  const enabledIds = () => ALL_HARNESS_IDS.filter(enabled);

  routes.get("/", async (c) => {
    return c.json({
      harnesses: await Promise.all(
        enabledIds().map((id) => options.service.getInfo(id)),
      ),
    });
  });

  routes.post("/check-all", async (c) => {
    return c.json({
      harnesses: await options.service.checkAll(enabledIds()),
    });
  });

  routes.post("/update-all", async (c) => {
    const result = await options.service.startBatch(enabledIds());
    if (!result) {
      return c.json({ error: "Another CLI update is already running" }, 409);
    }
    return c.json(result, 202);
  });

  routes.post("/:id/:action", async (c) => {
    const id = c.req.param("id") as HarnessId;
    const action = c.req.param("action");
    if (
      !ALL_HARNESS_IDS.includes(id) ||
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
