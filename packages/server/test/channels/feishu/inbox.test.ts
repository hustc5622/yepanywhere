import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FeishuDurableInbox } from "../../../src/channels/feishu/inbox.js";

describe("FeishuDurableInbox", () => {
  const dataDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dataDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("deduplicates the same event durably across restarts", async () => {
    const dataDir = await createDataDir(dataDirs);
    const inbox = new FeishuDurableInbox({ dataDir });
    await inbox.initialize();
    const first = await inbox.receive({
      accountId: "team-bot",
      eventId: "evt_fixture",
      eventType: "im.message.receive_v1",
      messageId: "om_fixture",
    });
    const concurrent = await Promise.all([
      inbox.receive({
        accountId: "team-bot",
        eventId: "evt_fixture",
        eventType: "im.message.receive_v1",
        messageId: "om_fixture",
      }),
      inbox.receive({
        accountId: "team-bot",
        eventId: "evt_fixture",
        eventType: "im.message.receive_v1",
        messageId: "om_fixture",
      }),
    ]);

    expect(first.duplicate).toBe(false);
    expect(concurrent.every((result) => result.duplicate)).toBe(true);
    expect(first.record.tempId).toMatch(/^feishu-[a-f0-9]{32}$/);

    const reloaded = new FeishuDurableInbox({ dataDir });
    await reloaded.initialize();
    const duplicate = await reloaded.receive({
      accountId: "team-bot",
      eventId: "evt_fixture",
      eventType: "im.message.receive_v1",
      messageId: "om_fixture",
    });
    expect(duplicate.duplicate).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(inbox.filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("persists dispatch state before execution and exposes restart recovery", async () => {
    const dataDir = await createDataDir(dataDirs);
    const inbox = new FeishuDurableInbox({ dataDir });
    await inbox.initialize();
    const { record } = await inbox.receive({
      accountId: "team-bot",
      messageId: "om_fixture",
      eventType: "im.message.receive_v1",
      scopeKey: "team-bot:group:oc_fixture",
      now: new Date("2026-08-07T00:00:00.000Z"),
    });
    const dispatching = await inbox.beginDispatch(record.key, {
      sessionId: "session-temp",
      now: new Date("2026-08-07T00:01:00.000Z"),
    });

    expect(dispatching).toMatchObject({
      status: "dispatching",
      attempts: 1,
      sessionId: "session-temp",
    });
    const reloaded = new FeishuDurableInbox({ dataDir });
    await reloaded.initialize();
    expect(reloaded.listRecoverable()).toEqual([
      expect.objectContaining({ key: record.key, status: "dispatching" }),
    ]);

    await reloaded.markDispatched(record.key);
    await expect(reloaded.beginDispatch(record.key)).rejects.toThrow(
      "Invalid Feishu inbox transition: dispatched -> dispatching",
    );
    await reloaded.complete(record.key);
    expect(reloaded.listRecoverable()).toEqual([]);
  });

  it("never stores message bodies or arbitrary error details", async () => {
    const dataDir = await createDataDir(dataDirs);
    const inbox = new FeishuDurableInbox({ dataDir });
    await inbox.initialize();
    const { record } = await inbox.receive({
      accountId: "team-bot",
      eventId: "evt_fixture",
      eventType: "im.message.receive_v1",
      messageId: "om_fixture",
    });
    await inbox.fail(record.key, "NORMALIZATION_FAILED");

    const content = await readFile(inbox.filePath, "utf8");
    expect(content).not.toContain("user prompt body");
    expect(content).not.toContain("appSecret");
    expect(content).toContain("NORMALIZATION_FAILED");
  });

  it("fails closed on a corrupt journal record", async () => {
    const dataDir = await createDataDir(dataDirs);
    const inbox = new FeishuDurableInbox({ dataDir });
    await inbox.initialize();
    await writeFile(inbox.filePath, "not-json\n", "utf8");

    const reloaded = new FeishuDurableInbox({ dataDir });
    await expect(reloaded.initialize()).rejects.toThrow(
      "Invalid Feishu inbox record at line 1",
    );
  });
});

async function createDataDir(dataDirs: string[]): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-inbox-"));
  dataDirs.push(dataDir);
  return dataDir;
}
