import { timingSafeEqual } from "node:crypto";
import { SideConversationRequestSchema } from "@yep-anywhere/shared";
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
  app.post("/sessions/:sessionId/side-conversation", async (c) => {
    const parsed = SideConversationRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: "Invalid side conversation request" }, 400);
    return c.json(
      (await controller.sideConversation?.(
        c.req.param("sessionId"),
        parsed.data,
      )) ?? { supported: false, reason: "unsupported" },
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
        displayProjection: c.req.query("displayProjection") === "true",
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
      let finished = false;
      let finishStream!: () => void;
      const closed = new Promise<void>((resolve) => {
        finishStream = () => {
          finished = true;
          resolve();
        };
      });
      stream.onAbort(finishStream);
      const enqueue = (write: () => Promise<unknown>) => {
        writeChain = writeChain
          .then(async () => {
            if (!finished) await write();
          })
          .catch(finishStream);
        return writeChain;
      };
      const writeEvent = (event: unknown) =>
        enqueue(() => stream.writeSSE({ data: JSON.stringify({ event }) }));
      // Activity can be silent for an entire long turn. Flush headers now and
      // keep the HTTP stream alive independently of session message traffic.
      const heartbeat = setInterval(() => {
        void enqueue(() => stream.write(": heartbeat\n\n"));
      }, 15_000);
      heartbeat.unref();
      try {
        await enqueue(() => stream.write(": connected\n\n"));
        if (c.req.query("reconcile") === "true") {
          // Subscribe before reading snapshots, then drain buffered changes so
          // a turn ending during reconciliation cannot disappear in the gap.
          const [processes, terminated, activity] = await Promise.all([
            controller.listProcessSnapshots(),
            controller.listRecentlyTerminatedProcesses(),
            controller.getWorkerActivity(),
          ]);
          const timestamp = new Date().toISOString();
          const liveIds = new Set(
            processes.map((process) => process.sessionId),
          );
          await writeEvent({
            type: "worker-activity-changed",
            ...activity,
            timestamp,
          });
          for (const process of processes) {
            await writeEvent({
              type: "session-status-changed",
              sessionId: process.sessionId,
              projectId: process.projectId,
              ownership: {
                owner: "self",
                processId: process.id,
                permissionMode: process.permissionMode,
                modeVersion: process.modeVersion,
              },
              activity: process.state,
              timestamp,
            });
            await writeEvent({
              type: "process-state-changed",
              sessionId: process.sessionId,
              projectId: process.projectId,
              activity: process.state,
              pendingInputType: process.pendingInputRequest
                ? process.pendingInputRequest.type === "tool-approval"
                  ? "tool-approval"
                  : "user-question"
                : undefined,
              retryStatus: process.retryStatus,
              timestamp,
            });
          }
          for (const process of terminated) {
            if (liveIds.has(process.sessionId)) continue;
            await writeEvent({
              type: "session-status-changed",
              sessionId: process.sessionId,
              projectId: process.projectId,
              ownership: { owner: "none" },
              timestamp,
            });
          }
          for (const process of processes) {
            await writeEvent({
              type: "session-updated",
              sessionId: process.sessionId,
              projectId: process.projectId,
              timestamp,
            });
          }
        }
        // Set the writer synchronously with draining the buffer: newly arriving
        // events are appended to the same write chain after buffered events.
        for (const event of buffered.splice(0)) void writeEvent(event);
        writer = writeEvent;
        await closed;
      } finally {
        clearInterval(heartbeat);
        writer = null;
        subscription.cleanup();
      }
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
