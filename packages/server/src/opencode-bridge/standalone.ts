import { runBridgeSidecar } from "../bridge-common/standalone.js";
import { OpenCodeBridgeService } from "./OpenCodeBridgeService.js";
import { resolveOpenCodeGatewayConfig } from "./gateway-config.js";

export async function runOpenCodeBridgeOnly(): Promise<void> {
  await runBridgeSidecar({
    name: "OpenCodeBridge",
    create: (config) =>
      new OpenCodeBridgeService({
        enabled: true,
        host: config.opencodeBridgeHost,
        port: config.opencodeBridgePort,
        serverUrl: config.opencodeBridgeServerUrl,
        opencodeServerUrl: config.opencodeServerUrl,
        opencodeStartPort: config.opencodeServerStartPort,
        desktopToken: config.desktopAuthToken,
        gatewayConfig: resolveOpenCodeGatewayConfig(process.env),
      }),
    describe: (status) =>
      `${status.url}, server=${status.serverUrl}, opencode=${status.opencodeServerUrl} mode=${status.opencodeServerMode}`,
  });
}
