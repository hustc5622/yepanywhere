import {
  type UrlProjectId,
  getSessionDisplayTitle,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { SessionIndexService } from "../indexes/index.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { EmbeddedRuntimeController } from "../runtime/EmbeddedRuntimeController.js";
import type { RuntimeController } from "../runtime/types.js";
import type { ISessionReader } from "../sessions/types.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { ProcessInfo, Project } from "../supervisor/types.js";

export interface ProcessesDeps {
  runtimeController?: RuntimeController;
  supervisor: Supervisor;
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  processSessionSourceFactory?: (
    process: ProcessInfo,
    project: Project,
  ) => { reader: ISessionReader; sessionDir: string };
  sessionIndexService?: SessionIndexService;
  sessionMetadataService?: SessionMetadataService;
}

/**
 * Enrich process info with session title, model, and context usage.
 * Uses cache when available. Checks custom title from metadata service first.
 */
async function enrichProcessInfo(
  process: ProcessInfo,
  deps: ProcessesDeps,
): Promise<ProcessInfo> {
  try {
    const project = await deps.scanner.getProject(
      process.projectId as UrlProjectId,
    );
    if (!project) return process;

    const sessionSource = deps.processSessionSourceFactory?.(process, project);
    const reader = sessionSource?.reader ?? deps.readerFactory(project);
    const sessionDir = sessionSource?.sessionDir ?? project.sessionDir;

    // Always get the session summary for model and contextUsage
    const summary = await reader.getSessionSummary(
      process.sessionId,
      process.projectId as UrlProjectId,
    );

    // Prefer cached titles, but fall back to the live summary when the cache
    // misses. This matters for providers like Codex whose session files are
    // not stored in project.sessionDir.
    let title = summary?.title ?? null;
    if (deps.sessionIndexService) {
      const cachedTitle = await deps.sessionIndexService.getSessionTitle(
        sessionDir,
        process.projectId as UrlProjectId,
        process.sessionId,
        reader,
      );
      title = cachedTitle ?? title;
    }

    // Get custom title and provider from persisted metadata if available.
    // This lets the agents view recover when a stale in-memory process
    // provider disagrees with the durable session provider.
    const metadata = deps.sessionMetadataService?.getMetadata(
      process.sessionId,
    );

    // Use getSessionDisplayTitle to compute final title (customTitle > aiTitle > title > "Untitled")
    const displayTitle = getSessionDisplayTitle({
      customTitle: metadata?.customTitle,
      aiTitle: metadata?.aiTitle ?? summary?.aiTitle,
      title,
    });

    const enriched = { ...process };

    // Only set sessionTitle if we have something meaningful (not "Untitled")
    if (displayTitle !== "Untitled") {
      enriched.sessionTitle = displayTitle;
    }

    // Add model if available
    if (summary?.model) {
      enriched.model = summary.model;
    }

    // Prefer the durable session provider over the process provider when available.
    // This fixes stale terminated-process rows that were started with the wrong
    // provider but whose session metadata and on-disk transcript are correct.
    enriched.provider =
      summary?.provider ?? metadata?.provider ?? process.provider;

    // Add context usage if available
    if (summary?.contextUsage) {
      enriched.contextUsage = summary.contextUsage;
    }

    return enriched;
  } catch {
    // Ignore errors - just return process without enrichment
  }
  return process;
}

export function createProcessesRoutes(deps: ProcessesDeps): Hono {
  const routes = new Hono();
  const runtimeController =
    deps.runtimeController ?? new EmbeddedRuntimeController(deps.supervisor);

  // GET /api/processes - List all active processes
  // Query params:
  //   - includeTerminated: if "true", also includes recently terminated processes
  routes.get("/", async (c) => {
    const includeTerminated = c.req.query("includeTerminated") === "true";
    const processes = await runtimeController.listProcesses();

    // Enrich all processes with session titles and model info
    const enrichedProcesses = await Promise.all(
      processes.map((p) => enrichProcessInfo(p, deps)),
    );

    if (includeTerminated) {
      const terminatedProcesses =
        await runtimeController.listRecentlyTerminatedProcesses();
      // Also enrich terminated processes
      const enrichedTerminated = await Promise.all(
        terminatedProcesses.map((p) => enrichProcessInfo(p, deps)),
      );
      return c.json({
        processes: enrichedProcesses,
        terminatedProcesses: enrichedTerminated,
      });
    }

    return c.json({ processes: enrichedProcesses });
  });

  // POST /api/processes/:processId/abort - Kill a process
  routes.post("/:processId/abort", async (c) => {
    const processId = c.req.param("processId");

    const { aborted } = await runtimeController.abortProcess(processId);
    if (!aborted) {
      return c.json({ error: "Process not found" }, 404);
    }

    return c.json({ aborted: true });
  });

  // POST /api/processes/:processId/interrupt - Interrupt current turn gracefully
  // Unlike abort, this stops the current turn but keeps the process alive.
  routes.post("/:processId/interrupt", async (c) => {
    const processId = c.req.param("processId");

    const result = await runtimeController.interruptProcess(processId);
    if (!result.success && !result.supported) {
      // Process not found or doesn't support interrupt
      if (
        !(await runtimeController.listProcesses()).some(
          (p) => p.id === processId,
        )
      ) {
        return c.json({ error: "Process not found" }, 404);
      }
      // Process exists but doesn't support interrupt
      return c.json({ error: "Interrupt not supported for this process" }, 400);
    }

    return c.json({ interrupted: result.success, supported: result.supported });
  });

  // GET /api/processes/:processId/models - Get available models from SDK
  // Returns the list of models available for this session (dynamically from SDK).
  routes.get("/:processId/models", async (c) => {
    const processId = c.req.param("processId");

    const process = await runtimeController.getProcess(processId);
    if (!process) {
      return c.json({ error: "Process not found" }, 404);
    }

    const models = await runtimeController.getSupportedModels(processId);
    if (models === null) {
      // Process doesn't support dynamic model listing
      return c.json(
        { error: "Dynamic model listing not supported for this process" },
        400,
      );
    }

    return c.json({ models });
  });

  // GET /api/processes/:processId/commands - Get available slash commands from SDK
  // Returns the list of slash commands (skills) available for this session.
  routes.get("/:processId/commands", async (c) => {
    const processId = c.req.param("processId");

    const process = await runtimeController.getProcess(processId);
    if (!process) {
      return c.json({ error: "Process not found" }, 404);
    }

    const commands = await runtimeController.getSupportedCommands(processId);
    if (commands === null) {
      // Process doesn't support dynamic command listing
      return c.json(
        { error: "Dynamic command listing not supported for this process" },
        400,
      );
    }

    return c.json({ commands });
  });

  // POST /api/processes/:processId/model - Change model mid-session
  // Body: { model?: string } - model to switch to, or undefined for default
  routes.post("/:processId/model", async (c) => {
    const processId = c.req.param("processId");

    const process = await runtimeController.getProcess(processId);
    if (!process) {
      return c.json({ error: "Process not found" }, 404);
    }

    const body = await c.req.json<{ model?: string }>();
    const { success } = await runtimeController.setModel(processId, body.model);

    if (!success) {
      return c.json(
        { error: "Model switching not supported for this process" },
        400,
      );
    }

    return c.json({ success: true, model: body.model });
  });

  return routes;
}
