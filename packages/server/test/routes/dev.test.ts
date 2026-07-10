import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDevRoutes } from "../../src/routes/dev.js";
import { EventBus } from "../../src/watcher/EventBus.js";

describe("dev runtime reload status", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("reports the persistent runtime dirty marker", async () => {
    const dataDir = path.join(tmpdir(), `runtime-dirty-${randomUUID()}`);
    dirs.push(dataDir);
    await mkdir(path.join(dataDir, "runtime"), { recursive: true });
    await writeFile(
      path.join(dataDir, "runtime", "dirty.json"),
      JSON.stringify({
        files: ["packages/server/src/sdk/providers/codex.ts"],
      }),
    );
    const routes = createDevRoutes({
      eventBus: new EventBus(),
      dataDir,
      runtimeMode: "external",
    });

    const response = await routes.request("/status");
    await expect(response.json()).resolves.toMatchObject({
      runtimeMode: "external",
      runtimeDirty: true,
      runtimeDirtyFiles: ["packages/server/src/sdk/providers/codex.ts"],
    });
  });
});
