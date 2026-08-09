import { timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type {
  CreateRuntimeSessionRequest,
  QueueRuntimeMessageRequest,
  ResumeRuntimeSessionRequest,
  RuntimeCodexControlRequest,
  RuntimeController,
  RuntimeHoldProcessRequest,
  RuntimeInputResponseRequest,
  RuntimePermissionModeRequest,
  RuntimeProviderSettings,
  StartRuntimeSessionRequest,
} from "./types.js";

export interface RuntimeControlServerOptions {
  controller: RuntimeController;
  token: string;
  onShutdown?: () => void | Promise<void>;
}

function tokensMatch(actual: string | undefined, expected: string): boolean {
  const prefix = "Bearer ";
  if (!actual?.startsWith(prefix)) return false;
  const supplied = Buffer.from(actual.slice(prefix.length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

export function createRuntimeControlApp(
  options: RuntimeControlServerOptions,
): Hono {
  const app = new Hono();
  const { controller } = options;

  app.use("*", async (c, next) => {
    if (!tokensMatch(c.req.header("authorization"), options.token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.onError((error, c) => {
    console.error("[AgentRuntime] Control request failed:", error);
    return c.json({ error: "Internal runtime error" }, 500);
  });

  app.get("/status", async (c) => c.json(await controller.getStatus()));
  app.get("/workers", async (c) =>
    c.json(await controller.getWorkerActivity()),
  );
  app.put("/provider-settings", async (c) => {
    const body = await c.req.json<RuntimeProviderSettings>();
    await controller.updateProviderSettings(body);
    return c.json({ ok: true });
  });
  app.get("/processes", async (c) =>
    c.json({ processes: await controller.listProcesses() }),
  );
  app.get("/process-snapshots", async (c) =>
    c.json({ processes: await controller.listProcessSnapshots() }),
  );
  app.get("/processes/recently-terminated", async (c) =>
    c.json({
      processes: await controller.listRecentlyTerminatedProcesses(),
    }),
  );
  app.get("/processes/:processId", async (c) =>
    c.json({ process: await controller.getProcess(c.req.param("processId")) }),
  );
  app.post("/processes/:processId/cancel", async (c) =>
    c.json(await controller.abortProcess(c.req.param("processId"))),
  );
  app.post("/processes/:processId/interrupt", async (c) =>
    c.json(await controller.interruptProcess(c.req.param("processId"))),
  );
  app.get("/processes/:processId/models", async (c) =>
    c.json({
      models: await controller.getSupportedModels(c.req.param("processId")),
    }),
  );
  app.get("/processes/:processId/commands", async (c) =>
    c.json({
      commands: await controller.getSupportedCommands(c.req.param("processId")),
    }),
  );
  app.post("/processes/:processId/model", async (c) => {
    const body = await c.req.json<{ model?: string }>();
    return c.json(
      await controller.setModel(c.req.param("processId"), body.model),
    );
  });

  app.post("/sessions", async (c) => {
    const body = await c.req.json<
      StartRuntimeSessionRequest | CreateRuntimeSessionRequest
    >();
    return c.json(
      "message" in body
        ? await controller.startSession(body)
        : await controller.createSession(body),
    );
  });
  app.post("/sessions/:sessionId/resume", async (c) => {
    const body =
      await c.req.json<Omit<ResumeRuntimeSessionRequest, "sessionId">>();
    return c.json(
      await controller.resumeSession({
        ...body,
        sessionId: c.req.param("sessionId"),
      }),
    );
  });
  app.post("/sessions/:sessionId/messages", async (c) => {
    const body =
      await c.req.json<Omit<QueueRuntimeMessageRequest, "sessionId">>();
    return c.json(
      await controller.queueMessage({
        ...body,
        sessionId: c.req.param("sessionId"),
      }),
    );
  });
  app.get("/sessions/:sessionId/process", async (c) =>
    c.json({
      process: await controller.getProcessForSession(c.req.param("sessionId")),
    }),
  );
  app.get("/sessions/:sessionId/snapshot", async (c) =>
    c.json({
      process: await controller.getProcessSnapshotForSession(
        c.req.param("sessionId"),
      ),
    }),
  );
  app.get("/sessions/:sessionId/ownership-history", async (c) =>
    c.json({
      wasEverOwned: await controller.wasEverOwned(c.req.param("sessionId")),
    }),
  );
  app.get("/sessions/:sessionId/pending-input", async (c) =>
    c.json({
      request: await controller.getPendingInputRequest(
        c.req.param("sessionId"),
      ),
    }),
  );
  app.post("/sessions/:sessionId/input", async (c) => {
    const body =
      await c.req.json<Omit<RuntimeInputResponseRequest, "sessionId">>();
    return c.json(
      await controller.respondToInput({
        ...body,
        sessionId: c.req.param("sessionId"),
      }),
    );
  });
  app.put("/sessions/:sessionId/mode", async (c) => {
    const body =
      await c.req.json<Omit<RuntimePermissionModeRequest, "sessionId">>();
    return c.json(
      await controller.setPermissionMode({
        ...body,
        sessionId: c.req.param("sessionId"),
      }),
    );
  });
  app.post("/sessions/:sessionId/codex-control", async (c) => {
    const body =
      await c.req.json<Omit<RuntimeCodexControlRequest, "sessionId">>();
    return c.json(
      await controller.executeCodexControl({
        ...body,
        sessionId: c.req.param("sessionId"),
      }),
    );
  });
  app.put("/sessions/:sessionId/hold", async (c) => {
    const body =
      await c.req.json<Omit<RuntimeHoldProcessRequest, "sessionId">>();
    return c.json(
      await controller.setHold({
        ...body,
        sessionId: c.req.param("sessionId"),
      }),
    );
  });
  app.post("/sessions/:sessionId/deferred", async (c) => {
    const body = await c.req.json<{
      message: QueueRuntimeMessageRequest["message"];
    }>();
    return c.json(
      await controller.deferMessage(c.req.param("sessionId"), body.message),
    );
  });
  app.delete("/sessions/:sessionId/deferred/:tempId", async (c) =>
    c.json(
      await controller.cancelDeferredMessage(
        c.req.param("sessionId"),
        c.req.param("tempId"),
      ),
    ),
  );
  app.get("/sessions/:sessionId/context-usage", async (c) =>
    c.json({
      contextUsage: await controller.getContextUsage(c.req.param("sessionId")),
    }),
  );
  app.post("/sessions/:sessionId/initialization-result", async (c) =>
    c.json({
      result: await controller.probeInitializationResult(
        c.req.param("sessionId"),
      ),
    }),
  );

  app.get("/queue", async (c) => c.json(await controller.getQueueStatus()));
  app.get("/queue/:queueId", async (c) =>
    c.json({
      position: await controller.getQueuePosition(c.req.param("queueId")),
    }),
  );
  app.delete("/queue/:queueId", async (c) =>
    c.json(await controller.cancelQueuedRequest(c.req.param("queueId"))),
  );

  const eventsHandler = async (c: Context) => {
    const sessionId = c.req.query("sessionId");
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    type BufferedEvent = { eventType: string; data: unknown };
    const buffered: BufferedEvent[] = [];
    let writer: ((event: BufferedEvent) => Promise<void>) | null = null;
    let finished = false;
    let finishStream: (() => void) | null = null;

    const subscription = await controller.subscribeSession(
      sessionId,
      (eventType, data) => {
        const event = { eventType, data };
        if (writer) {
          void writer(event).finally(() => {
            if (eventType === "complete") finishStream?.();
          });
        } else {
          buffered.push(event);
        }
        if (eventType === "complete") finished = true;
      },
      {
        replayAfterMessageId: c.req.query("lastMessageId"),
        afterSeq: c.req.query("afterSeq")
          ? Number.parseInt(c.req.query("afterSeq") as string, 10)
          : undefined,
        signal: c.req.raw.signal,
      },
    );

    if (!subscription) {
      return c.json({ error: "No active process for session" }, 404);
    }

    return streamSSE(c, async (stream) => {
      let writeChain = Promise.resolve();
      writer = (event) => {
        writeChain = writeChain.then(() =>
          stream.writeSSE({ data: JSON.stringify(event) }),
        );
        return writeChain;
      };

      for (const event of buffered.splice(0)) {
        await writer(event);
      }

      if (finished) {
        subscription.cleanup();
        return;
      }

      await new Promise<void>((resolve) => {
        finishStream = resolve;
        stream.onAbort(resolve);
      });
      await writeChain.catch(() => {});
      subscription.cleanup();
    });
  };

  app.get("/events", eventsHandler);

  app.get("/replay", async (c) => {
    const afterSeq = c.req.query("afterSeq");
    return c.json({
      events: await controller.replay({
        processId: c.req.query("processId"),
        sessionId: c.req.query("sessionId"),
        afterSeq: afterSeq ? Number.parseInt(afterSeq, 10) : undefined,
      }),
    });
  });

  app.get("/activity-events", async (c) => {
    const buffered: unknown[] = [];
    let writer: ((event: unknown) => Promise<void>) | null = null;
    const subscription = await controller.subscribeActivity((event) => {
      if (writer) void writer(event);
      else buffered.push(event);
    });
    if (!subscription) {
      return c.json({ error: "Runtime activity stream unavailable" }, 503);
    }

    return streamSSE(c, async (stream) => {
      let writeChain = Promise.resolve();
      writer = (event) => {
        writeChain = writeChain.then(() =>
          stream.writeSSE({ data: JSON.stringify({ event }) }),
        );
        return writeChain;
      };
      for (const event of buffered.splice(0)) await writer(event);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      await writeChain.catch(() => {});
      subscription.cleanup();
    });
  });

  app.post("/shutdown", async (c) => {
    let body: { abortActive?: boolean } = {};
    try {
      body = await c.req.json<{ abortActive?: boolean }>();
    } catch {
      // Empty body means detach/stop without aborting active work.
    }
    await controller.shutdown({ abortActive: body.abortActive === true });
    if (options.onShutdown) {
      setTimeout(() => void options.onShutdown?.(), 25);
    }
    return c.json({ shuttingDown: true });
  });

  return app;
}
