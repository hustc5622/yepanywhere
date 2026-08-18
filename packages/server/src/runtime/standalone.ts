import path from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { loadConfig } from "../config.js";
import {
  codexProvider,
  configureClaudeRemoteExecutors,
  configureClaudeSessionFileObserver,
  getProvider,
} from "../sdk/providers/index.js";
import { ServerSettingsService } from "../services/ServerSettingsService.js";
import { Supervisor } from "../supervisor/Supervisor.js";
import { EventBus } from "../watcher/index.js";
import { EmbeddedRuntimeController } from "./EmbeddedRuntimeController.js";
import { RuntimeEventStore } from "./RuntimeEventStore.js";
import { createRuntimeControlApp } from "./control-server.js";
import { ensureRuntimeToken } from "./token.js";
import type { RuntimeController } from "./types.js";

export interface AgentRuntimeStandaloneOptions {
  controller?: RuntimeController;
  host?: string;
  port?: number;
  dataDir?: string;
  tokenFile?: string;
  token?: string;
  installSignalHandlers?: boolean;
}

export interface AgentRuntimeStandaloneHandle {
  controller: RuntimeController;
  host: string;
  port: number;
  tokenFile: string;
  shutdown(options?: { abortActive?: boolean }): Promise<void>;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function defaultRuntimePort(serverPort: number): number {
  return serverPort + 3;
}

/** Start the long-lived agent runtime without the web/API shell. */
export async function runAgentRuntimeOnly(
  options: AgentRuntimeStandaloneOptions = {},
): Promise<AgentRuntimeStandaloneHandle> {
  const config = loadConfig();
  codexProvider.configureBridgeExecution({
    mode: config.codexBridgeMode,
    controlUrl: config.codexBridgeControlUrl,
    authToken: config.desktopAuthToken,
    authTokenFile: config.runtimeTokenFile,
  });
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(`Agent runtime must bind to loopback, received: ${host}`);
  }

  const configuredPort = Number.parseInt(
    process.env.YEP_RUNTIME_PORT ?? "",
    10,
  );
  const port =
    options.port ??
    (Number.isFinite(configuredPort)
      ? configuredPort
      : defaultRuntimePort(config.port));
  const dataDir = options.dataDir ?? config.dataDir;
  const tokenFile =
    options.tokenFile ??
    process.env.YEP_RUNTIME_TOKEN_FILE ??
    path.join(dataDir, "runtime", "token");
  const token = options.token ?? (await ensureRuntimeToken(tokenFile));

  let controller = options.controller;
  if (!controller) {
    const settingsService = new ServerSettingsService({ dataDir });
    await settingsService.initialize();
    configureClaudeRemoteExecutors(
      settingsService.getSetting("remoteExecutors") ?? [],
    );

    const eventBus = new EventBus();
    configureClaudeSessionFileObserver((update) => {
      eventBus.emit({
        type: "file-change",
        provider: "claude",
        path: update.localPath,
        relativePath: path.relative(update.projectsDir, update.localPath),
        changeType: "modify",
        timestamp: new Date().toISOString(),
        fileType: "session",
      });
    });
    const supervisor = new Supervisor({
      provider: getProvider("codex") ?? undefined,
      idleTimeoutMs: config.idleTimeoutMs,
      defaultPermissionMode: config.defaultPermissionMode,
      eventBus,
      maxWorkers: config.maxWorkers,
      idlePreemptThresholdMs: config.idlePreemptThresholdMs,
      maxQueueSize: config.maxQueueSize,
      enabledProviders: config.enabledProviders,
    });
    const eventStore =
      process.env.YEP_RUNTIME_EVENT_JOURNAL === "0"
        ? undefined
        : new RuntimeEventStore({
            eventsDir: path.join(dataDir, "runtime", "events"),
          });
    controller = new EmbeddedRuntimeController(
      supervisor,
      eventBus,
      eventStore,
    );
  }

  await controller.start();

  let server!: ReturnType<typeof serve>;
  let closed = false;
  const closeServer = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };
  const app = createRuntimeControlApp({
    controller,
    token,
    onShutdown: closeServer,
  });

  await new Promise<void>((resolve, reject) => {
    server = serve({ fetch: app.fetch, hostname: host, port }, () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  const actualPort =
    address && typeof address === "object" ? address.port : port;
  console.log(
    `[AgentRuntime] Listening on http://${host}:${actualPort} (token: ${tokenFile})`,
  );

  const shutdown = async (
    shutdownOptions: { abortActive?: boolean } = {},
  ): Promise<void> => {
    await controller.shutdown(shutdownOptions);
    await closeServer();
  };

  if (options.installSignalHandlers !== false) {
    let signalHandled = false;
    const onSignal = () => {
      if (signalHandled) return;
      signalHandled = true;
      void shutdown({ abortActive: true }).catch((error) => {
        console.error("[AgentRuntime] Shutdown failed:", error);
        process.exitCode = 1;
      });
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  }

  return {
    controller,
    host,
    port: actualPort,
    tokenFile,
    shutdown,
  };
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  await runAgentRuntimeOnly().catch((error) => {
    console.error("[AgentRuntime] Failed to start:", error);
    process.exitCode = 1;
  });
}
