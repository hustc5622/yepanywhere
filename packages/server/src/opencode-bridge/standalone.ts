import { loadConfig } from "../config.js";
import { OpenCodeBridgeService } from "./OpenCodeBridgeService.js";

export async function runOpenCodeBridgeOnly(): Promise<void> {
  const config = loadConfig();
  const bridge = new OpenCodeBridgeService({
    enabled: true,
    host: config.opencodeBridgeHost,
    port: config.opencodeBridgePort,
    serverUrl: config.opencodeBridgeServerUrl,
    desktopToken: config.desktopAuthToken,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[OpenCodeBridge] Received ${signal}, shutting down...`);
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
      `[OpenCodeBridge] Failed to start on ${status.url}: ${status.lastError ?? "unknown error"}`,
    );
    process.exit(1);
  }

  console.log(
    `[OpenCodeBridge] Standalone bridge running at ${status.url}, server=${status.serverUrl}`,
  );
}
