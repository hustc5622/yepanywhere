import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FeishuSecretStore } from "../../../src/channels/feishu/secret-store.js";

describe("FeishuSecretStore", () => {
  const dataDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dataDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("stores App Secrets only in a 0600 file and exposes a masked status", async () => {
    const dataDir = await createDataDir(dataDirs);
    const store = new FeishuSecretStore({ dataDir, env: {} });
    await store.initialize();

    const ref = await store.set("team-bot", "very-secret-value");

    expect(ref).toBe("store:team-bot");
    expect(store.resolve(ref)).toBe("very-secret-value");
    expect(store.describe(ref)).toEqual({
      configured: true,
      source: "store",
      masked: "****alue",
    });
    expect(await readFile(store.filePath, "utf8")).toContain(
      "very-secret-value",
    );
    if (process.platform !== "win32") {
      expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("resolves environment references without persisting their value", async () => {
    const dataDir = await createDataDir(dataDirs);
    const store = new FeishuSecretStore({
      dataDir,
      env: { FEISHU_TEAM_SECRET: "environment-secret" },
    });
    await store.initialize();

    expect(store.describe("env:FEISHU_TEAM_SECRET")).toEqual({
      configured: true,
      source: "env",
      masked: "****cret",
    });
    await expect(readFile(store.filePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores restrictive permissions when loading an existing store", async () => {
    if (process.platform === "win32") return;
    const dataDir = await createDataDir(dataDirs);
    const writer = new FeishuSecretStore({ dataDir });
    await writer.initialize();
    await writer.set("team-bot", "secret-value");
    await chmod(writer.filePath, 0o644);

    const reader = new FeishuSecretStore({ dataDir });
    await reader.initialize();

    expect((await stat(reader.filePath)).mode & 0o777).toBe(0o600);
    expect(reader.resolve("store:team-bot")).toBe("secret-value");
  });

  it("serializes concurrent secret updates", async () => {
    const dataDir = await createDataDir(dataDirs);
    const store = new FeishuSecretStore({ dataDir });
    await store.initialize();

    await Promise.all([
      store.set("team-bot", "secret-one"),
      store.set("second-bot", "secret-two"),
    ]);

    expect(store.resolve("store:team-bot")).toBe("secret-one");
    expect(store.resolve("store:second-bot")).toBe("secret-two");
  });
});

async function createDataDir(dataDirs: string[]): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-secret-"));
  dataDirs.push(dataDir);
  return dataDir;
}
