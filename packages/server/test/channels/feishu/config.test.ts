import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FeishuAccountConfig,
  FeishuAccountConfigSchema,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it } from "vitest";
import { FeishuAccountConfigStore } from "../../../src/channels/feishu/config.js";

describe("FeishuAccountConfigStore", () => {
  const dataDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dataDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("persists versioned non-secret account configuration atomically", async () => {
    const dataDir = await createDataDir(dataDirs);
    const store = new FeishuAccountConfigStore({ dataDir });
    await store.initialize();

    await store.upsert({
      ...makeAccount(),
      appSecret: "must-not-be-persisted",
    } as FeishuAccountConfig & { appSecret: string });

    const content = await readFile(store.filePath, "utf8");
    expect(JSON.parse(content)).toMatchObject({
      version: 1,
      accounts: [{ id: "team-bot", appId: "cli_0123456789abcdef" }],
    });
    expect(content).not.toContain("must-not-be-persisted");
    if (process.platform !== "win32") {
      expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("serializes concurrent account updates without losing either account", async () => {
    const dataDir = await createDataDir(dataDirs);
    const store = new FeishuAccountConfigStore({ dataDir });
    await store.initialize();

    await Promise.all([
      store.upsert(makeAccount()),
      store.upsert(
        makeAccount({
          id: "second-bot",
          name: "Second",
          appId: "cli_fedcba9876543210",
        }),
      ),
    ]);

    expect(store.list().map((account) => account.id)).toEqual([
      "team-bot",
      "second-bot",
    ]);
  });

  it("rejects bypassPermissions and restores owner-only file permissions", async () => {
    expect(() =>
      FeishuAccountConfigSchema.parse({
        ...makeAccount(),
        defaultPermissionMode: "bypassPermissions",
      }),
    ).toThrow();

    if (process.platform === "win32") return;
    const dataDir = await createDataDir(dataDirs);
    const writer = new FeishuAccountConfigStore({ dataDir });
    await writer.initialize();
    await writer.upsert(makeAccount());
    await chmod(writer.filePath, 0o644);

    const reader = new FeishuAccountConfigStore({ dataDir });
    await reader.initialize();
    expect((await stat(reader.filePath)).mode & 0o777).toBe(0o600);
  });

  it("defaults proxy policy and validates account-level overrides", () => {
    expect(makeAccount().proxyMode).toBe("auto");
    expect(makeAccount({ proxyMode: "direct" }).proxyMode).toBe("direct");
    expect(makeAccount({ proxyMode: "environment" }).proxyMode).toBe(
      "environment",
    );
    expect(() =>
      FeishuAccountConfigSchema.parse({
        ...makeAccount(),
        proxyMode: "invalid",
      }),
    ).toThrow();
  });

  it("fails closed without replacing a malformed existing file", async () => {
    const dataDir = await createDataDir(dataDirs);
    const filePath = join(dataDir, "channels", "feishu", "accounts.json");
    await writeFile(filePath, "not-json", "utf8").catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const bootstrap = new FeishuAccountConfigStore({ dataDir });
      await bootstrap.initialize();
      await bootstrap.upsert(makeAccount());
      await writeFile(filePath, "not-json", "utf8");
    });

    const store = new FeishuAccountConfigStore({ dataDir });
    await expect(store.initialize()).rejects.toThrow(
      "Invalid Feishu account configuration",
    );
    expect(await readFile(filePath, "utf8")).toBe("not-json");
  });
});

function makeAccount(
  overrides: Partial<FeishuAccountConfig> = {},
): FeishuAccountConfig {
  return FeishuAccountConfigSchema.parse({
    id: "team-bot",
    name: "Team Bot",
    enabled: true,
    appId: "cli_0123456789abcdef",
    secretRef: "store:team-bot",
    allowedUsers: ["ou_user"],
    ...overrides,
  });
}

async function createDataDir(dataDirs: string[]): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-config-"));
  dataDirs.push(dataDir);
  return dataDir;
}
