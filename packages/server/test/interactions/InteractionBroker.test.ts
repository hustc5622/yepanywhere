import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputRequest } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractionBroker } from "../../src/interactions/InteractionBroker.js";

describe("InteractionBroker", () => {
  const dataDirs: string[] = [];
  const brokers: InteractionBroker[] = [];

  afterEach(async () => {
    for (const broker of brokers.splice(0)) broker.shutdown();
    await Promise.all(
      dataDirs
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("serializes competing claims and invokes the provider exactly once", async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider = vi.fn(async () => {
      await providerGate;
      return true;
    });
    const broker = track(brokers, new InteractionBroker());
    const request = makeRequest();
    const operation = await broker.register({
      request,
      owner: "process",
      provider: "codex",
      resolveProvider: provider,
    });

    const winner = broker.resolve({
      sessionId: request.sessionId,
      requestId: request.id,
      operationId: operation.operationId,
      expectedVersion: operation.version,
      response: "approve",
      actor: { id: "yep-user", channel: "yep" },
    });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    await expect(
      broker.resolve({
        sessionId: request.sessionId,
        requestId: request.id,
        operationId: operation.operationId,
        expectedVersion: operation.version,
        response: "deny",
        actor: { id: "channel-user", channel: "feishu" },
      }),
    ).resolves.toMatchObject({
      state: "already_resolved",
      operation: { state: "answering", version: 1 },
    });

    releaseProvider();
    await expect(winner).resolves.toMatchObject({
      state: "resolved",
      operation: {
        state: "resolved",
        version: 2,
        resolvedBy: { id: "yep-user", channel: "yep" },
      },
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("persists only durable CAS metadata with owner-only permissions", async () => {
    const dataDir = await createDataDir(dataDirs);
    const broker = track(brokers, new InteractionBroker({ dataDir }));
    await broker.initialize();
    const request = makeRequest({
      type: "question",
      prompt: "Authorization: Bearer SYNTHETIC_PROMPT_SECRET_123456",
      toolName: "AskUserQuestion",
      toolInput: {
        command:
          "curl -H 'Authorization: Bearer SYNTHETIC_COMMAND_SECRET_123456' https://example.test",
        cwd: "/private/SYNTHETIC_CWD",
        fileChanges: [{ path: "/private/SYNTHETIC_FILE" }],
        questions: [
          {
            id: "password",
            question: "Enter the synthetic secret",
            inputType: "password",
            defaultValue: "SYNTHETIC_DEFAULT_SECRET",
          },
        ],
        providerPrivateToken: "SYNTHETIC_PROVIDER_TOKEN",
      },
    });
    const operation = await broker.register({
      request,
      owner: "process",
      provider: "codex",
      resolveProvider: async () => true,
    });
    await broker.resolve({
      sessionId: request.sessionId,
      requestId: request.id,
      operationId: operation.operationId,
      expectedVersion: operation.version,
      response: "approve",
      answers: { password: "SYNTHETIC_ANSWER_SECRET" },
      feedback: "SYNTHETIC_FEEDBACK_SECRET",
      actor: {
        id: "synthetic-channel-actor",
        displayName: "Synthetic Display Name",
        channel: "feishu",
      },
    });

    const filePath = broker.filePath as string;
    const raw = await readFile(filePath, "utf8");
    for (const forbidden of [
      "SYNTHETIC_PROMPT_SECRET",
      "SYNTHETIC_COMMAND_SECRET",
      "SYNTHETIC_CWD",
      "SYNTHETIC_FILE",
      "SYNTHETIC_DEFAULT_SECRET",
      "SYNTHETIC_PROVIDER_TOKEN",
      "SYNTHETIC_ANSWER_SECRET",
      "SYNTHETIC_FEEDBACK_SECRET",
      "synthetic-channel-actor",
      "Synthetic Display Name",
      "toolInput",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    expect(raw).toContain('"prompt": "Input required"');
    expect(raw).toMatch(/"id": "sha256:[a-f0-9]{64}"/u);
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dataDir, "interactions"))).mode & 0o777).toBe(
        0o700,
      );
    }
  });

  it("fails open and answering operations closed during restart recovery", async () => {
    const dataDir = await createDataDir(dataDirs);
    const first = track(brokers, new InteractionBroker({ dataDir }));
    await first.initialize();
    const openRequest = makeRequest({ id: "request-open" });
    const openOperation = await first.register({
      request: openRequest,
      owner: "bridge",
      provider: "codex",
      resolveProvider: async () => true,
    });
    const answeringRequest = makeRequest({ id: "request-answering" });
    const answeringOperation = await first.register({
      request: answeringRequest,
      owner: "process",
      provider: "codex",
      resolveProvider: () => new Promise<boolean>(() => undefined),
    });
    void first.resolve({
      sessionId: answeringRequest.sessionId,
      requestId: answeringRequest.id,
      operationId: answeringOperation.operationId,
      expectedVersion: answeringOperation.version,
      response: "approve",
      actor: { id: "yep-user", channel: "yep" },
    });
    await vi.waitFor(() =>
      expect(first.get(answeringOperation.operationId)?.state).toBe(
        "answering",
      ),
    );
    first.shutdown();

    const restored = track(brokers, new InteractionBroker({ dataDir }));
    await restored.initialize();
    expect(restored.get(openOperation.operationId)).toMatchObject({
      state: "failed",
      version: 1,
      resolution: { decision: "restart_recovery" },
    });
    expect(restored.get(answeringOperation.operationId)).toMatchObject({
      state: "failed",
      version: 2,
      resolution: { decision: "restart_recovery" },
    });

    const reopened = await restored.register({
      request: openRequest,
      owner: "bridge",
      provider: "codex",
      resolveProvider: async () => true,
    });
    expect(reopened).toMatchObject({ state: "open", version: 0 });
    expect(reopened.operationId).not.toBe(openOperation.operationId);

    const unsafeRetry = vi.fn(async () => true);
    const claimedTombstone = await restored.register({
      request: answeringRequest,
      owner: "process",
      provider: "codex",
      resolveProvider: unsafeRetry,
    });
    expect(claimedTombstone).toMatchObject({
      operationId: answeringOperation.operationId,
      state: "failed",
    });
    expect(unsafeRetry).not.toHaveBeenCalled();
  });

  it("denies the provider once and expires an unanswered operation", async () => {
    const broker = track(brokers, new InteractionBroker({ expiresMs: 5 }));
    const provider = vi.fn(() => new Promise<boolean>(() => undefined));
    const request = makeRequest({ timestamp: new Date().toISOString() });
    const operation = await broker.register({
      request,
      owner: "process",
      provider: "codex",
      resolveProvider: provider,
    });

    await vi.waitFor(
      () => expect(broker.get(operation.operationId)?.state).toBe("expired"),
      { timeout: 1_000 },
    );
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({ response: "deny" }),
    );
  });

  it("settles a hung answering claim at its deadline without a second call", async () => {
    const broker = track(brokers, new InteractionBroker({ expiresMs: 10 }));
    const provider = vi.fn(() => new Promise<boolean>(() => undefined));
    const request = makeRequest({ timestamp: new Date().toISOString() });
    const operation = await broker.register({
      request,
      owner: "process",
      provider: "codex",
      resolveProvider: provider,
    });
    const resolution = broker.resolve({
      sessionId: request.sessionId,
      requestId: request.id,
      operationId: operation.operationId,
      expectedVersion: operation.version,
      response: "approve",
      actor: { id: "yep-user", channel: "yep" },
    });

    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    await vi.waitFor(
      () => expect(broker.get(operation.operationId)?.state).toBe("expired"),
      { timeout: 1_000 },
    );
    await expect(resolution).resolves.toMatchObject({
      state: "already_resolved",
      operation: { state: "expired" },
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("rejects a late approval and sends only the timeout denial", async () => {
    const broker = track(brokers, new InteractionBroker({ expiresMs: 60_000 }));
    const provider = vi.fn(async () => true);
    const openedAt = new Date("2026-08-08T00:00:00.000Z");
    const request = makeRequest({
      timestamp: openedAt.toISOString(),
      toolInput: { autoResolutionMs: 10 },
    });
    const operation = await broker.register({
      request,
      owner: "process",
      provider: "codex",
      resolveProvider: provider,
      now: openedAt,
    });

    await expect(
      broker.resolve({
        sessionId: request.sessionId,
        requestId: request.id,
        operationId: operation.operationId,
        expectedVersion: operation.version,
        response: "approve",
        actor: { id: "yep-user", channel: "yep" },
        now: new Date(openedAt.getTime() + 11),
      }),
    ).resolves.toMatchObject({
      state: "already_resolved",
      operation: { state: "expired", version: 1 },
    });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({
        response: "deny",
        operationVersion: operation.version + 1,
      }),
    );
  });

  it("converges process and bridge aliases on one native request", async () => {
    const broker = track(brokers, new InteractionBroker());
    const nativeId = "codex:number:73";
    const observedAt = new Date().toISOString();
    const processRequest = makeRequest({
      id: nativeId,
      providerRequestId: nativeId,
      providerRequestMethod: "item/tool/requestUserInput",
      type: "question",
      timestamp: observedAt,
      toolInput: {
        questions: [{ id: "q1", question: "Proceed?" }],
        turnId: "turn-1",
        itemId: "item-1",
      },
    });
    const bridgeRequest = makeRequest({
      id: "connection:8|number:73|item/tool/requestUserInput|session-1",
      providerRequestId: nativeId,
      providerRequestMethod: "item/tool/requestUserInput",
      type: "question",
      timestamp: observedAt,
      source: "codex-bridge",
      prompt: "A more complete native question",
      toolInput: {
        questions: [{ id: "q1", question: "Proceed?" }],
        turnId: "turn-1",
        itemId: "item-1",
      },
    });
    const processResolver = vi.fn(async () => true);
    const bridgeResolver = vi.fn(async () => true);
    const first = await broker.register({
      request: processRequest,
      owner: "process",
      provider: "codex",
      resolveProvider: processResolver,
    });
    const refreshed = await broker.register({
      request: bridgeRequest,
      owner: "bridge",
      provider: "codex",
      resolveProvider: bridgeResolver,
    });

    expect(refreshed).toMatchObject({
      operationId: first.operationId,
      state: "open",
      version: 1,
      publicPayload: { prompt: "A more complete native question" },
    });
    await expect(
      broker.resolve({
        sessionId: bridgeRequest.sessionId,
        requestId: bridgeRequest.id,
        operationId: refreshed.operationId,
        expectedVersion: refreshed.version,
        response: "approve",
        answers: { q1: "yes" },
        actor: { id: "channel-user", channel: "feishu" },
      }),
    ).resolves.toMatchObject({ state: "resolved" });
    expect(processResolver).not.toHaveBeenCalled();
    expect(bridgeResolver).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a reused RPC id by native turn and item coordinates", async () => {
    const broker = track(brokers, new InteractionBroker());
    const identity = {
      id: "codex:number:1",
      providerRequestId: "codex:number:1",
      providerRequestMethod: "item/tool/requestUserInput",
      type: "question" as const,
    };
    const firstRequest = makeRequest({
      ...identity,
      toolInput: { turnId: "turn-before", itemId: "item-before" },
    });
    const first = await broker.register({
      request: firstRequest,
      owner: "process",
      provider: "codex",
      resolveProvider: async () => true,
    });
    await broker.resolve({
      sessionId: firstRequest.sessionId,
      requestId: firstRequest.id,
      operationId: first.operationId,
      expectedVersion: first.version,
      response: "approve",
      actor: { id: "yep-user", channel: "yep" },
    });

    const second = await broker.register({
      request: makeRequest({
        ...identity,
        toolInput: { turnId: "turn-after", itemId: "item-after" },
      }),
      owner: "process",
      provider: "codex",
      resolveProvider: async () => true,
    });
    expect(second).toMatchObject({ state: "open", version: 0 });
    expect(second.operationId).not.toBe(first.operationId);
  });

  it("keeps a claimed coordinate-free tombstone across provider epochs", async () => {
    const dataDir = await createDataDir(dataDirs);
    const firstBroker = track(brokers, new InteractionBroker({ dataDir }));
    await firstBroker.initialize();
    const request = makeRequest({
      id: "codex:number:9",
      providerRequestId: "codex:number:9",
      providerRequestMethod: "mcpServer/elicitation/request",
      type: "question",
      toolInput: { questions: [] },
    });
    const first = await firstBroker.register({
      request,
      owner: "process",
      provider: "codex",
      resolveProvider: async () => true,
    });
    await firstBroker.resolve({
      sessionId: request.sessionId,
      requestId: request.id,
      operationId: first.operationId,
      expectedVersion: first.version,
      response: "approve",
      actor: { id: "yep-user", channel: "yep" },
    });
    await firstBroker.terminateSession(request.sessionId, "process_exit");
    firstBroker.shutdown();

    const restored = track(brokers, new InteractionBroker({ dataDir }));
    await restored.initialize();
    const duplicate = await restored.register({
      request: { ...request, timestamp: new Date().toISOString() },
      owner: "process",
      provider: "codex",
      resolveProvider: async () => true,
    });
    expect(duplicate).toMatchObject({
      operationId: first.operationId,
      state: "resolved",
    });
  });

  it("reopens an unclaimed coordinate-free id after a hard provider exit", async () => {
    const broker = track(brokers, new InteractionBroker());
    const request = makeRequest({
      id: "codex:number:10",
      providerRequestId: "codex:number:10",
      providerRequestMethod: "mcpServer/elicitation/request",
      type: "question",
      toolInput: { questions: [] },
    });
    const first = await broker.register({
      request,
      owner: "process",
      provider: "codex",
      resolveProvider: async () => true,
    });
    await broker.terminateSession(request.sessionId, "process_exit");
    const reopened = await broker.register({
      request: { ...request, timestamp: new Date().toISOString() },
      owner: "process",
      provider: "codex",
      resolveProvider: async () => true,
    });
    expect(reopened).toMatchObject({ state: "open", version: 0 });
    expect(reopened.operationId).not.toBe(first.operationId);
  });

  it("fails an in-flight claim closed on process exit", async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider = vi.fn(async () => {
      await providerGate;
      return true;
    });
    const broker = track(brokers, new InteractionBroker());
    const request = makeRequest();
    const operation = await broker.register({
      request,
      owner: "process",
      provider: "codex",
      resolveProvider: provider,
    });
    const resolution = broker.resolve({
      sessionId: request.sessionId,
      requestId: request.id,
      operationId: operation.operationId,
      expectedVersion: operation.version,
      response: "approve",
      actor: { id: "yep-user", channel: "yep" },
    });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

    await broker.terminateSession(request.sessionId, "process_exit");
    releaseProvider();
    await expect(resolution).resolves.toMatchObject({
      state: "already_resolved",
      operation: { state: "failed" },
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("does not let a routine missing-request signal cancel the CAS winner", async () => {
    const broker = track(brokers, new InteractionBroker());
    const request = makeRequest();
    const operation = await broker.register({
      request,
      owner: "process",
      provider: "codex",
      resolveProvider: async () => {
        await broker.terminateSession(request.sessionId, "request_missing");
        return true;
      },
    });

    await expect(
      broker.resolve({
        sessionId: request.sessionId,
        requestId: request.id,
        operationId: operation.operationId,
        expectedVersion: operation.version,
        response: "approve",
        actor: { id: "yep-user", channel: "yep" },
      }),
    ).resolves.toMatchObject({
      state: "resolved",
      operation: { state: "resolved", version: 2 },
    });
  });

  it("fails closed when the durable store is malformed", async () => {
    const dataDir = await createDataDir(dataDirs);
    const filePath = join(dataDir, "interactions", "operations.json");
    await mkdir(join(dataDir, "interactions"), { recursive: true });
    const secret = "Bearer SYNTHETIC_CORRUPT_STORE_SECRET_123456";
    await writeFile(filePath, `{"authorization":"${secret}"`);
    const broker = track(brokers, new InteractionBroker({ dataDir }));
    const error = await broker.initialize().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Invalid interaction broker store");
    expect((error as Error).cause).toBeUndefined();
    expect((error as Error).stack).not.toContain(secret);
  });
});

function makeRequest(overrides: Partial<InputRequest> = {}): InputRequest {
  return {
    id: "request-1",
    sessionId: "session-1",
    type: "tool-approval",
    prompt: "Allow this command?",
    toolName: "Bash",
    toolInput: { command: "pnpm test", cwd: "/repo/app" },
    timestamp: new Date(0).toISOString(),
    source: "process",
    ...overrides,
  };
}

function track(
  brokers: InteractionBroker[],
  broker: InteractionBroker,
): InteractionBroker {
  brokers.push(broker);
  return broker;
}

async function createDataDir(dataDirs: string[]): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-interaction-broker-"));
  dataDirs.push(dataDir);
  return dataDir;
}
