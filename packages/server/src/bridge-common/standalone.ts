import { type Config, loadConfig } from "../config.js";
import type { BridgeStatusBase, MaybePromise } from "./types.js";

interface SidecarBridge<TStatus extends BridgeStatusBase> {
  start(): Promise<void>;
  shutdown(): MaybePromise<void>;
  getStatus(): TStatus;
}

/**
 * Shared entrypoint skeleton for standalone bridge processes.
 * sidecar processes: load config, wire signal handlers, start the bridge and
 * verify it is listening.
 */
export async function runBridgeSidecar<
  TStatus extends BridgeStatusBase,
>(options: {
  name: string;
  create(config: Config): SidecarBridge<TStatus>;
  describe?(status: TStatus): string;
}): Promise<void> {
  const config = loadConfig();
  const bridge = options.create(config);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${options.name}] Received ${signal}, shutting down...`);
    await bridge.shutdown();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  await bridge.start();
  const status = bridge.getStatus();
  if (!status.listening) {
    console.error(
      `[${options.name}] Failed to start on ${status.url}: ${status.lastError ?? "unknown error"}`,
    );
    process.exit(1);
  }

  console.log(
    `[${options.name}] Standalone bridge running at ${
      options.describe?.(status) ?? status.url
    }`,
  );
}
