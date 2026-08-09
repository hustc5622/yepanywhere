import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractionOperation } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it } from "vitest";
import { FeishuOperationStore } from "../../../src/channels/feishu/operation-store.js";

describe("FeishuOperationStore", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("persists only presentation metadata from the central broker", async () => {
    const dataDir = await temporaryDataDir(dirs);
    const store = new FeishuOperationStore({ dataDir });
    const now = new Date("2026-08-08T00:00:00.000Z");
    await store.initialize(now);

    const record = await store.upsert({
      operation: makeOperation(1, {
        publicPayload: {
          prompt: "token=fixture-prompt-must-not-persist",
          command: "print fixture-command-must-not-persist",
        },
      }),
      ...projectionInput(),
      now,
    });

    expect(record).toMatchObject({
      brokerState: "open",
      brokerVersion: 0,
      cardSequence: 0,
    });
    const persisted = await readFile(store.filePath, "utf8");
    expect(persisted).not.toContain("fixture-prompt-must-not-persist");
    expect(persisted).not.toContain("fixture-command-must-not-persist");
    expect(persisted).not.toContain("publicPayload");

    const restored = new FeishuOperationStore({ dataDir });
    await restored.initialize(now);
    expect(restored.get(record.projectionId)).toEqual(record);
  });

  it("rebinds a recovered broker operation while retaining one card", async () => {
    const dataDir = await temporaryDataDir(dirs);
    const store = new FeishuOperationStore({ dataDir });
    await store.initialize();
    const first = await store.upsert({
      operation: makeOperation(1),
      ...projectionInput(),
    });
    await store.attachCard(first.projectionId, {
      cardId: "card-fixture",
      cardMessageId: "message-fixture",
    });
    await store.markCardProjected(
      first.projectionId,
      first.brokerOperationId,
      first.brokerVersion,
    );

    const secondOperation = makeOperation(2, { requestId: "request-rebound" });
    const rebound = await store.upsert({
      operation: secondOperation,
      ...projectionInput({ requestId: "request-rebound" }),
    });

    expect(rebound.projectionId).toBe(first.projectionId);
    expect(rebound.brokerOperationId).toBe(secondOperation.operationId);
    expect(rebound.cardId).toBe("card-fixture");
    expect(rebound.cardMessageId).toBe("message-fixture");
    expect(rebound.cardProjectedBrokerVersion).toBeUndefined();
    expect(
      store.findByBrokerOperation("account-fixture", first.brokerOperationId),
    ).toBeUndefined();
  });

  it("authorizes channel context without claiming or resolving the operation", async () => {
    const dataDir = await temporaryDataDir(dirs);
    const store = new FeishuOperationStore({ dataDir });
    await store.initialize();
    const record = await store.upsert({
      operation: makeOperation(1),
      ...projectionInput(),
    });
    await store.attachCard(record.projectionId, {
      cardId: "card-fixture",
      cardMessageId: "message-fixture",
    });

    const action = {
      accountId: "account-fixture",
      brokerOperationId: record.brokerOperationId,
      chatId: "chat-fixture",
      cardMessageId: "message-fixture",
      operatorOpenId: "requester-fixture",
    };
    expect(store.authorizeAction(action).state).toBe("authorized");
    expect(store.authorizeAction(action).state).toBe("authorized");
    expect(
      store.authorizeAction({
        ...action,
        operatorOpenId: "untrusted-fixture",
      }).state,
    ).toBe("forbidden");
    expect(
      store.authorizeAction({ ...action, chatId: "other-chat-fixture" }).state,
    ).toBe("forbidden");
    expect(store.get(record.projectionId)).toMatchObject({
      brokerState: "open",
      brokerVersion: 0,
    });
  });

  it("projects terminal broker state without accepting stale regressions", async () => {
    const dataDir = await temporaryDataDir(dirs);
    const store = new FeishuOperationStore({ dataDir });
    await store.initialize();
    const record = await store.upsert({
      operation: makeOperation(1),
      ...projectionInput(),
    });
    await store.attachCard(record.projectionId, {
      cardId: "card-fixture",
      cardMessageId: "message-fixture",
    });

    const terminal = makeOperation(1, {
      version: 2,
      state: "resolved",
      resolution: {
        decision: "approve_always",
        resolvedAt: Date.parse("2026-08-08T00:00:02.000Z"),
      },
    });
    const synced = await store.syncBrokerOperation(
      "account-fixture",
      terminal,
      {
        result: "approve_always",
        nativeDecision: { kind: "acceptForSession", scope: "session" },
      },
    );
    expect(synced).toMatchObject({
      brokerState: "resolved",
      brokerVersion: 2,
      displayResult: "approve_always",
    });
    expect(synced?.terminalReason).toBeUndefined();
    expect(store.listOpen()).toEqual([]);
    expect(store.listTerminalAwaitingCardProjection()).toHaveLength(1);

    const stale = await store.syncBrokerOperation(
      "account-fixture",
      makeOperation(1, { version: 1, state: "open" }),
    );
    expect(stale).toMatchObject({ brokerState: "resolved", brokerVersion: 2 });
    await expect(
      store.markCardProjected(record.projectionId, terminal.operationId, 1),
    ).resolves.toBe(false);
    await expect(
      store.markCardProjected(record.projectionId, terminal.operationId, 2),
    ).resolves.toBe(true);
    expect(store.listTerminalAwaitingCardProjection()).toEqual([]);
  });

  it("fails closed on corrupt durable state", async () => {
    const dataDir = await temporaryDataDir(dirs);
    const store = new FeishuOperationStore({ dataDir });
    await mkdir(join(dataDir, "channels", "feishu"), { recursive: true });
    await writeFile(store.filePath, "{not-json", "utf8");

    await expect(store.initialize()).rejects.toThrow(
      "Invalid Feishu operation projection store",
    );
    expect(store.isOperational()).toBe(false);
  });

  it("never evicts an open broker projection to make room", async () => {
    const dataDir = await temporaryDataDir(dirs);
    const store = new FeishuOperationStore({ dataDir, maxRecords: 1 });
    await store.initialize();
    const first = await store.upsert({
      operation: makeOperation(1),
      ...projectionInput(),
    });

    await expect(
      store.upsert({
        operation: makeOperation(2, {
          sessionId: "session-other",
          requestId: "request-other",
        }),
        ...projectionInput({
          sessionId: "session-other",
          requestId: "request-other",
          providerRequestId: "provider-request-other",
        }),
      }),
    ).rejects.toThrow("capacity exhausted");
    expect(store.list()).toEqual([first]);

    await store.syncBrokerOperation(
      "account-fixture",
      makeOperation(1, {
        version: 1,
        state: "failed",
        resolution: {
          decision: "deny",
          summary: "provider_rejected",
          resolvedAt: Date.parse("2026-08-08T00:00:01.000Z"),
        },
      }),
    );
    const second = await store.upsert({
      operation: makeOperation(2, {
        sessionId: "session-other",
        requestId: "request-other",
      }),
      ...projectionInput({
        sessionId: "session-other",
        requestId: "request-other",
        providerRequestId: "provider-request-other",
      }),
    });
    expect(store.list()).toEqual([second]);
  });
});

function projectionInput(
  overrides: Partial<{
    sessionId: string;
    requestId: string;
    providerRequestId: string;
  }> = {},
) {
  return {
    accountId: "account-fixture",
    chatId: "chat-fixture",
    replyToMessageId: "message-inbound-fixture",
    sessionId: overrides.sessionId ?? "session-fixture",
    requestId: overrides.requestId ?? "request-fixture",
    providerRequestId:
      overrides.providerRequestId ?? "provider-request-fixture",
    requestType: "tool-approval" as const,
    requesterOpenId: "requester-fixture",
    allowedOperatorOpenIds: ["admin-fixture"],
  };
}

function makeOperation(
  seed: number,
  overrides: Partial<InteractionOperation> = {},
): InteractionOperation {
  const suffix = String(seed).padStart(12, "0");
  return {
    operationId: `int_00000000-0000-4000-8000-${suffix}`,
    provider: "codex",
    requestId: "request-fixture",
    requestMethod: "item/commandExecution/requestApproval",
    sessionId: "session-fixture",
    kind: "command_approval",
    state: "open",
    publicPayload: { prompt: "Allow the fixture command?" },
    allowedActors: { mode: "any_member" },
    allowedDecisions: [{ id: "approve", scope: "once" }, { id: "deny" }],
    createdAt: Date.parse("2026-08-08T00:00:00.000Z"),
    expiresAt: Date.parse("2026-08-08T00:30:00.000Z"),
    version: 0,
    ...overrides,
  };
}

async function temporaryDataDir(dirs: string[]): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-projection-"));
  dirs.push(dataDir);
  return dataDir;
}
