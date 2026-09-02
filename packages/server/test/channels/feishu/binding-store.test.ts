import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeishuSessionBinding } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it } from "vitest";
import { FeishuBindingStore } from "../../../src/channels/feishu/binding-store.js";

describe("FeishuBindingStore", () => {
  const dataDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dataDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("persists protected scope-to-session bindings atomically", async () => {
    const dataDir = await createDataDir(dataDirs);
    const store = new FeishuBindingStore({ dataDir });
    await store.initialize();
    await store.upsert(makeBinding());

    const reloaded = new FeishuBindingStore({ dataDir });
    await reloaded.initialize();

    expect(reloaded.get("team-bot:group:oc_fixture")).toEqual(makeBinding());
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toMatchObject({
      version: 1,
      bindings: [{ sessionId: "session-temp" }],
    });
  });

  it("serializes concurrent updates and remaps temporary session IDs", async () => {
    const dataDir = await createDataDir(dataDirs);
    const store = new FeishuBindingStore({ dataDir });
    await store.initialize();
    await Promise.all([
      store.upsert(makeBinding()),
      store.upsert(
        makeBinding({
          scopeKey: "team-bot:p2p:oc_second",
          chatId: "oc_second",
        }),
      ),
    ]);

    expect(await store.remapSessionId("session-temp", "session-final")).toBe(2);
    expect(store.list().map((binding) => binding.sessionId)).toEqual([
      "session-final",
      "session-final",
    ]);
  });

  it("removes a binding only for the expected session owner", async () => {
    const dataDir = await createDataDir(dataDirs);
    const store = new FeishuBindingStore({ dataDir });
    await store.initialize();
    await store.upsert(makeBinding());

    await expect(
      store.removeIfSession("team-bot:group:oc_fixture", "session-stale-owner"),
    ).resolves.toBe(false);
    expect(store.get("team-bot:group:oc_fixture")?.sessionId).toBe(
      "session-temp",
    );

    await expect(
      store.removeIfSession("team-bot:group:oc_fixture", "session-temp"),
    ).resolves.toBe(true);
    expect(store.get("team-bot:group:oc_fixture")).toBeUndefined();
  });

  it("moves a binding to a fallback session only for its current owner", async () => {
    const dataDir = await createDataDir(dataDirs);
    const store = new FeishuBindingStore({ dataDir });
    await store.initialize();
    await store.upsert(makeBinding({ model: "gpt-5.6-sol" }));

    await expect(
      store.updateIfSession(
        "team-bot:group:oc_fixture",
        "session-stale",
        (binding) => ({ ...binding, sessionId: "must-not-win" }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      store.updateIfSession(
        "team-bot:group:oc_fixture",
        "session-temp",
        (binding) => ({
          ...binding,
          sessionId: "session-deepseek",
          model: "deepseek-v4-flash-vision-exp",
        }),
      ),
    ).resolves.toMatchObject({
      sessionId: "session-deepseek",
      model: "deepseek-v4-flash-vision-exp",
    });
  });

  it("rejects bypassPermissions and restores owner-only file permissions", async () => {
    const dataDir = await createDataDir(dataDirs);
    const store = new FeishuBindingStore({ dataDir });
    await store.initialize();
    await expect(
      store.upsert({
        ...makeBinding(),
        permissionMode: "bypassPermissions",
      } as unknown as FeishuSessionBinding),
    ).rejects.toThrow();

    await store.upsert(makeBinding());
    if (process.platform === "win32") return;
    await chmod(store.filePath, 0o644);
    const reader = new FeishuBindingStore({ dataDir });
    await reader.initialize();
    expect((await stat(reader.filePath)).mode & 0o777).toBe(0o600);
  });
});

function makeBinding(
  overrides: Partial<FeishuSessionBinding> = {},
): FeishuSessionBinding {
  return {
    version: 1,
    scopeKey: "team-bot:group:oc_fixture",
    accountId: "team-bot",
    chatId: "oc_fixture",
    projectId: "encoded-project",
    projectPath: "/workspace/project",
    sessionId: "session-temp",
    provider: "codex",
    permissionMode: "default",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

async function createDataDir(dataDirs: string[]): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-binding-"));
  dataDirs.push(dataDir);
  return dataDir;
}
