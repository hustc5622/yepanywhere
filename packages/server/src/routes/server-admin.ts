import { Hono } from "hono";
import type { NotificationService } from "../notifications/index.js";
import type { RuntimeController } from "../runtime/types.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import { getDeploymentAvailability, startDeploymentJob } from "./deploy.js";

export interface ServerAdminDeps {
  supervisor: Supervisor;
  runtimeController?: RuntimeController;
  notificationService?: NotificationService;
  dataDir?: string;
}

/**
 * Administrative routes for server management.
 * Always mounted (not dev-mode-only), so remote clients can use them.
 */
export function createServerAdminRoutes(deps: ServerAdminDeps): Hono {
  const routes = new Hono();

  // POST /api/server/restart - Trigger graceful server restart
  routes.post("/restart", async (c) => {
    console.log("[ServerAdmin] Restart requested via API");

    await deps.notificationService?.flush();

    const deployAvailable = getDeploymentAvailability({
      dataDir: deps.dataDir,
    }).available;
    if (process.env.NODE_ENV === "production" && deployAvailable) {
      const response = c.json({
        ok: true,
        message: "Server restart deploy job starting...",
      });

      setTimeout(() => {
        void startDeploymentJob(
          { dataDir: deps.dataDir },
          { action: "server" },
        ).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[ServerAdmin] Failed to start restart job:", message);
        });
      }, 100);

      return response;
    }

    // Respond before restarting.
    // Send SIGTERM to self so the registered gracefulShutdown handler aborts
    // active sessions and cleans up before the process supervisor (scripts/dev.js,
    // systemd, pm2, launchd) restarts the process.
    const response = c.json({
      ok: true,
      message: "Server restarting...",
    });

    setTimeout(() => {
      process.kill(process.pid, "SIGTERM");
    }, 100);

    return response;
  });

  // POST /api/server/runtime/restart - Explicitly replace the dev sidecar.
  routes.post("/runtime/restart", async (c) => {
    const runtime = deps.runtimeController;
    if (
      !runtime ||
      runtime.mode !== "external" ||
      process.env.YEP_RUNTIME_MANAGED_BY_DEV !== "true" ||
      typeof process.send !== "function"
    ) {
      return c.json(
        { error: "Agent runtime reload is not managed by this dev server" },
        409,
      );
    }

    const body = await c.req
      .json<{ force?: boolean }>()
      .catch(() => ({ force: false }));
    const activity = await runtime.getWorkerActivity();
    if (activity.hasActiveWork && !body.force) {
      return c.json(
        {
          error: "Agent runtime has active work",
          activeWorkers: activity.activeWorkers,
          queueLength: activity.queueLength,
        },
        409,
      );
    }

    const response = c.json({
      ok: true,
      message: "Agent runtime reload starting...",
    });
    setTimeout(() => {
      void (async () => {
        await deps.notificationService?.flush();
        await runtime.shutdown({ abortActive: true });
        process.send?.({ type: "runtime-reload" });
      })().catch((error) => {
        console.error("[ServerAdmin] Agent runtime reload failed:", error);
      });
    }, 100);
    return response;
  });

  return routes;
}
