import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";

describe("ServerSettingsService", () => {
  const dataDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dataDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("removes retired Claude settings and legacy executor aliases during migration", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-settings-"));
    dataDirs.push(dataDir);
    const settingsPath = join(dataDir, "server-settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        version: 1,
        settings: {
          serviceWorkerEnabled: false,
          ollamaUrl: "http://127.0.0.1:11434",
          ollamaSystemPrompt: "legacy",
          ollamaUseFullSystemPrompt: true,
          remoteExecutors: ["devbox"],
        },
      }),
    );

    const service = new ServerSettingsService({ dataDir });
    await service.initialize();

    expect(service.getSettings()).toEqual(
      expect.objectContaining({ serviceWorkerEnabled: false }),
    );
    expect(service.getSettings()).not.toHaveProperty("ollamaUrl");
    expect(service.getSettings()).not.toHaveProperty("remoteExecutors");

    const persisted = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      version: number;
      settings: Record<string, unknown>;
    };
    expect(persisted.version).toBe(4);
    expect(persisted.settings).not.toHaveProperty("ollamaUrl");
    expect(persisted.settings).not.toHaveProperty("remoteExecutors");
  });

  it("preserves and normalizes mapped remote executors", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-settings-"));
    dataDirs.push(dataDir);
    const settingsPath = join(dataDir, "server-settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        version: 2,
        settings: {
          serviceWorkerEnabled: true,
          remoteExecutors: [
            {
              host: " 192.168.64.4 ",
              user: " yueyuan ",
              localRoot: "/Users/yueyuan/Desktop/file/UTM/",
              remoteRoot: "/mnt/utm/",
              claudePath: "/home/yueyuan/.local/bin/claude",
              sessionStorage: {
                mode: "shared",
                localProjectsDir:
                  "/Users/yueyuan/Desktop/file/UTM/claude/projects/",
                remoteProjectsDir: "/mnt/utm/claude/projects/",
              },
            },
          ],
        },
      }),
    );

    const service = new ServerSettingsService({ dataDir });
    await service.initialize();

    expect(service.getSetting("remoteExecutors")).toEqual([
      {
        host: "192.168.64.4",
        user: "yueyuan",
        localRoot: "/Users/yueyuan/Desktop/file/UTM",
        remoteRoot: "/mnt/utm",
        claudePath: "/home/yueyuan/.local/bin/claude",
        sessionStorage: {
          mode: "shared",
          localProjectsDir: "/Users/yueyuan/Desktop/file/UTM/claude/projects",
          remoteProjectsDir: "/mnt/utm/claude/projects",
        },
      },
    ]);

    const persisted = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      version: number;
    };
    expect(persisted.version).toBe(4);
  });
});
