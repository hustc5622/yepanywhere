import { join } from "node:path";
import { runBridgeSidecar } from "../bridge-common/standalone.js";
import { CodexBridgeService } from "./CodexBridgeService.js";

export async function runCodexBridgeOnly(): Promise<void> {
  await runBridgeSidecar({
    name: "CodexBridge",
    create: (config) =>
      new CodexBridgeService({
        enabled: true,
        host: config.codexBridgeHost,
        port: config.codexBridgePort,
        upstreamUrl: config.codexBridgeUpstreamUrl,
        upstreamStartPort: config.codexBridgeUpstreamStartPort,
        lightUpstreamArgs: config.codexBridgeLightUpstreamArgs,
        clearUpstreamArgs: config.codexBridgeClearUpstreamArgs,
        fullUpstreamArgs: config.codexBridgeFullUpstreamArgs,
        journalMode: config.codexBridgeJournalMode,
        authToken: config.desktopAuthToken,
        authTokenFile: config.runtimeTokenFile,
        statePath: join(config.dataDir, "codex-bridge", "sessions.json"),
      }),
  });
}
