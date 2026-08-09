import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FeishuDurableOutbox } from "../../../src/channels/feishu/outbox.js";

describe("FeishuDurableOutbox", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("persists before claim and restores an interrupted attempt as pending", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-outbox-"));
    dirs.push(dataDir);
    const first = new FeishuDurableOutbox({ dataDir });
    await first.initialize(new Date("2026-08-08T00:00:00.000Z"));
    const queued = await first.enqueue({
      owner: "account-a",
      idempotencyKey: "card-1:content:1",
      kind: "card_content_update",
      payload: { cardId: "card-1", content: "hello", sequence: 1 },
      now: new Date("2026-08-08T00:00:00.000Z"),
    });
    await expect(
      first.claim(queued.id, new Date("2026-08-08T00:00:01.000Z")),
    ).resolves.toMatchObject({ status: "attempting", attempts: 1 });

    const restored = new FeishuDurableOutbox({ dataDir });
    await restored.initialize(new Date("2026-08-08T00:00:02.000Z"));
    expect(
      restored.listRecoverable(
        "account-a",
        new Date("2026-08-08T00:00:02.000Z"),
      ),
    ).toEqual([
      expect.objectContaining({
        id: queued.id,
        status: "pending",
        attempts: 1,
      }),
    ]);
  });

  it("deduplicates idempotency keys and schedules bounded retry state", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-outbox-"));
    dirs.push(dataDir);
    const outbox = new FeishuDurableOutbox({ dataDir });
    const now = new Date("2026-08-08T00:00:00.000Z");
    await outbox.initialize(now);
    const first = await outbox.enqueue({
      owner: "account-a",
      idempotencyKey: "message-1",
      kind: "message_send",
      payload: { text: "safe output" },
      now,
    });
    const duplicate = await outbox.enqueue({
      owner: "account-a",
      idempotencyKey: "message-1",
      kind: "message_send",
      payload: { text: "different" },
      now,
    });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.payload).toEqual({ text: "safe output" });

    await outbox.claim(first.id, now);
    await outbox.retry(first.id, {
      errorCode: "HTTP 503: private detail",
      delayMs: 1_000,
      now,
    });
    expect(outbox.get(first.id)).toMatchObject({
      status: "pending",
      nextAttemptAt: "2026-08-08T00:00:01.000Z",
      lastErrorCode: "HTTP_503__private_detail",
    });
    expect(outbox.listRecoverable("account-a", now)).toEqual([]);

    await outbox.claim(first.id, new Date("2026-08-08T00:00:01.000Z"));
    await outbox.complete(first.id, new Date("2026-08-08T00:00:02.000Z"));
    expect(outbox.get(first.id)).toMatchObject({ status: "delivered" });
  });

  it("redacts expanded secret syntax before durable persistence", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-outbox-"));
    dirs.push(dataDir);
    const outbox = new FeishuDurableOutbox({ dataDir });
    await outbox.initialize(new Date("2026-08-08T00:00:00.000Z"));
    const record = await outbox.enqueue({
      owner: "account-a",
      idempotencyKey: "secret-redaction",
      kind: "card_content_update",
      payload: {
       cardId: "card-1",
       content:
          "Cookie: session=must-not-leak\nAuthorization: Basic <fixture-basic-credential>\nNPM_TOKEN=npm-fixture-must-not-leak\nSLACK=xoxb-0000000000-fixture-do-not-leak",
        sequence: 1,
      },
      now: new Date("2026-08-08T00:00:00.000Z"),
    });

    expect(record.payload.content).toBe("[REDACTED:secret-value]");
    const persisted = await import("node:fs/promises").then(({ readFile }) =>
      readFile(outbox.filePath, "utf8"),
    );
    expect(persisted).not.toContain("must-not-leak");
    expect(persisted).not.toContain("fixture-basic-credential");
    expect(persisted).not.toContain("xoxb-");

    await outbox.claim(record.id, new Date("2026-08-08T00:00:00.000Z"));
    await outbox.retry(record.id, {
      errorCode: "token=error-sentinel-do-not-leak",
      delayMs: 1_000,
      now: new Date("2026-08-08T00:00:00.000Z"),
    });
    expect(outbox.get(record.id)?.lastErrorCode).toBe("REDACTED_ERROR");
  });

  it("re-projects legacy durable payloads and drops secret-bearing identities on load", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-outbox-"));
    dirs.push(dataDir);
    const outbox = new FeishuDurableOutbox({ dataDir });
    await mkdir(join(dataDir, "channels", "feishu"), { recursive: true });
    await writeFile(
      outbox.filePath,
      `${JSON.stringify({
        version: 1,
        records: [
          {
            version: 1,
            id: "a".repeat(64),
            owner: "account-a",
            idempotencyKey: "legacy-safe-record",
            kind: "input_card_update",
            payload: {
              cardId: "legacy-card",
              card: { prompt: "token=legacy-sentinel-do-not-leak" },
              sequence: 1,
            },
            status: "pending",
            attempts: 0,
            nextAttemptAt: "2026-08-08T00:00:00.000Z",
            createdAt: "2026-08-08T00:00:00.000Z",
            updatedAt: "2026-08-08T00:00:00.000Z",
            lastErrorCode: "NPM_TOKEN=legacy-error-do-not-leak",
          },
          {
            version: 1,
            id: "b".repeat(64),
            owner: "account-a",
            idempotencyKey: "token=identity-sentinel-do-not-leak",
            kind: "message_send",
            payload: { text: "safe" },
            status: "pending",
            attempts: 0,
            nextAttemptAt: "2026-08-08T00:00:00.000Z",
            createdAt: "2026-08-08T00:00:00.000Z",
            updatedAt: "2026-08-08T00:00:00.000Z",
          },
        ],
      })}\n`,
      "utf8",
    );

    await outbox.initialize(new Date("2026-08-08T00:00:01.000Z"));
    expect(outbox.get("a".repeat(64))).toMatchObject({
      payload: {
        card: { prompt: "[REDACTED:secret-value]" },
      },
      lastErrorCode: "REDACTED_ERROR",
    });
    expect(outbox.get("b".repeat(64))).toBeUndefined();
    const persisted = await readFile(outbox.filePath, "utf8");
    expect(persisted).not.toContain("legacy-sentinel-do-not-leak");
    expect(persisted).not.toContain("identity-sentinel-do-not-leak");
    expect(persisted).not.toContain("legacy-error-do-not-leak");
  });

  it("rejects oversized payloads and invalid delivery transitions", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-outbox-"));
    dirs.push(dataDir);
    const outbox = new FeishuDurableOutbox({ dataDir });
    const now = new Date("2026-08-08T00:00:00.000Z");
    await outbox.initialize(now);

    await expect(
      outbox.enqueue({
        owner: "account-a",
        idempotencyKey: "oversized",
        kind: "message_send",
        payload: { text: "x".repeat(256 * 1024) },
        now,
      }),
    ).rejects.toThrow("Invalid Feishu outbox payload");

    const record = await outbox.enqueue({
      owner: "account-a",
      idempotencyKey: "state-machine",
      kind: "message_send",
      payload: { text: "safe" },
      now,
    });
    await expect(outbox.complete(record.id, now)).rejects.toThrow(
      "state transition",
    );
    await outbox.claim(record.id, now);
    await outbox.retry(record.id, { errorCode: "TEMPORARY", delayMs: 0, now });
    await expect(
      outbox.retry(record.id, { errorCode: "TEMPORARY", delayMs: 0, now }),
    ).rejects.toThrow("state transition");
  });

  it("stays non-operational when durable state cannot be validated", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-outbox-"));
    dirs.push(dataDir);
    const outbox = new FeishuDurableOutbox({ dataDir });
    await mkdir(join(dataDir, "channels", "feishu"), { recursive: true });
    await writeFile(outbox.filePath, "{not-json", "utf8");

    await expect(outbox.initialize()).rejects.toThrow(
      "Invalid Feishu outbound outbox",
    );
    expect(outbox.isOperational()).toBe(false);
  });
});
