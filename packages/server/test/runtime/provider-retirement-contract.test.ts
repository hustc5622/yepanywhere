import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = (relativePath: string): Promise<string> =>
  readFile(
    fileURLToPath(new URL(`../../src/${relativePath}`, import.meta.url)),
    "utf-8",
  );
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const repoFile = (relativePath: string): Promise<string> =>
  readFile(join(repoRoot, relativePath), "utf-8");

describe("retired provider runtime contract", () => {
  it("keeps main startup and app construction free of OpenCode runtime wiring", async () => {
    const [app, index] = await Promise.all([
      source("app.ts"),
      source("index.ts"),
    ]);
    const startup = `${app}\n${index}`;

    expect(startup).not.toMatch(
      /OpenCodeSession(?:Scanner|Reader|ChangeMonitor)/,
    );
    expect(startup).not.toMatch(/OpenCodeBridgeHttpClient/);
    expect(startup).not.toMatch(/ensureOpenCodeDbIndexes|OPENCODE_DB_PATH/);
    expect(startup).not.toMatch(/opencode-bridge/);
  });

  it("keeps provider discovery and project scanning free of the live adapter", async () => {
    const [registry, scanner] = await Promise.all([
      source("sdk/providers/index.ts"),
      source("projects/scanner.ts"),
    ]);

    expect(registry).not.toMatch(/from "\.\/opencode\.js"/);
    expect(registry).not.toMatch(/opencodeProvider/);
    expect(scanner).not.toMatch(/OpenCodeSessionScanner|opencode-scanner/);
  });

  it("does not ship retired source trees or package entrypoints", () => {
    for (const relativePath of [
      "packages/server/src/opencode-bridge/OpenCodeBridgeService.ts",
      "packages/server/src/opencode-lifecycle/index.ts",
      "packages/server/src/opencode/attachments.ts",
      "packages/server/src/sdk/providers/opencode.ts",
      "packages/server/src/projects/opencode-scanner.ts",
      "packages/server/src/sessions/opencode-reader.ts",
      "packages/server/resources/opencode-plugin/yep-bridge.ts",
      "packages/shared/src/opencode-schema/index.ts",
      "scripts/install-opencode-yep-plugin.sh",
    ]) {
      expect(existsSync(join(repoRoot, relativePath)), relativePath).toBe(
        false,
      );
    }
  });

  it("keeps CLI, bundle and routine deployment channels free of the retired bridge", async () => {
    const [cli, config, wrapper, bundle, deploy, redeploy, launchagents, dev] =
      await Promise.all([
        source("cli.ts"),
        source("config.ts"),
        source("claude-wrapper.ts"),
        repoFile("scripts/build-bundle.ts"),
        repoFile("scripts/deploy.sh"),
        repoFile("scripts/redeploy-server.sh"),
        repoFile("scripts/install-launchagents.sh"),
        repoFile("scripts/dev-8022.js"),
      ]);

    expect(`${cli}\n${config}\n${wrapper}`).not.toMatch(/opencode|4520|4521/iu);
    expect(bundle).not.toMatch(/opencode|4520|4521/iu);
    expect(`${deploy}\n${redeploy}\n${dev}`).not.toMatch(
      /opencode|4520|4521/iu,
    );
    expect(launchagents).not.toMatch(
      /opencode-bridge|opencode-plugin|YEP_OPENCODE_BRIDGE|4520|4521/iu,
    );
  });
});
