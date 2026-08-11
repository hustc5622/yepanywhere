import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_EVENT_RUNTIME_IDENTITY,
  CODEX_PROVIDER_RUNTIME_IDENTITY,
  CodexEventIngress,
  InMemoryCodexEventStore,
  JsonlCodexEventStore,
  codexEventRolloutConfigFromEnv,
  getCodexEventDiagnostics,
  redactCodexPayload,
  replayCodexSession,
  resolveCodexEventProjectionMode,
} from "../../src/codex-events/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex event ingress", () => {
  it("keeps the runtime identity aligned with the checked-in stable manifest", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL(
          "../../src/sdk/providers/codex-protocol/manifest.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      codex: { version: string };
      capabilityProfiles: {
        stable: { schemaHash: string };
        experimental: { schemaHash: string };
      };
    };
    expect(CODEX_EVENT_RUNTIME_IDENTITY).toMatchObject({
      codexVersion: manifest.codex.version,
      schemaHash: manifest.capabilityProfiles.stable.schemaHash,
      profile: "stable",
      experimentalApi: false,
    });
    expect(CODEX_PROVIDER_RUNTIME_IDENTITY).toMatchObject({
      codexVersion: manifest.codex.version,
      schemaHash: manifest.capabilityProfiles.experimental.schemaHash,
      profile: "experimental",
      experimentalApi: true,
    });
  });

  it("redacts secrets, binary data, stdin, and raw reasoning before persistence", () => {
    const ordinary = redactCodexPayload("item/started", {
      threadId: "thread-1",
      token: "very-secret-token",
      nested: {
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
        stdin: "hunter2",
        npm_token: "npm-keyed-secret",
        _authToken: "npm-auth-secret",
        image: "data:image/png;base64,AAAA",
      },
    });
    expect(ordinary.data).toEqual({
      threadId: "thread-1",
      token: "[REDACTED:secret]",
      nested: {
        authorization: "[REDACTED:secret]",
        stdin: "[REDACTED:secret]",
        npm_token: "[REDACTED:secret]",
        _authToken: "[REDACTED:secret]",
        image: expect.stringMatching(/^\[REDACTED:data-url:image\/png:/),
      },
    });
    expect(ordinary.redactionCount).toBe(6);

    const reasoning = redactCodexPayload("item/reasoning/textDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reasoning-1",
      delta: "private reasoning",
    });
    expect(reasoning.data).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reasoning-1",
      delta: expect.stringMatching(/^\[REDACTED:raw-reasoning:/),
    });
    const reasoningSnapshot = redactCodexPayload("item/completed", {
      item: {
        id: "reasoning-1",
        type: "reasoning",
        summary: ["safe summary"],
        content: ["private chain of thought"],
      },
    });
    expect(reasoningSnapshot.data).toEqual({
      item: {
        id: "reasoning-1",
        type: "reasoning",
        summary: ["safe summary"],
        content: [],
      },
    });

    const error = redactCodexPayload("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: {
        message: "Codex app-server exited: stderr contained api_key=secret",
      },
    });
    expect(error.data).toMatchObject({
      error: {
        category: "process_exit",
        message: "Codex app-server process exited",
        publicMessage:
          "The Codex process exited unexpectedly before the task completed.",
      },
    });
    expect(JSON.stringify(error.data)).not.toContain("api_key=secret");
  });

  it("persists before reducing and correlates a client request with its turn", async () => {
    let now = 1_000;
    const store = new InMemoryCodexEventStore({ now: () => now++ });
    const ingress = await CodexEventIngress.create({
      store,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-1",
      connectionId: "connection-1",
      now: () => now++,
    });

    const exchange = await ingress.ingestClientExchange({
      requestId: 7,
      method: "turn/start",
      params: { threadId: "thread-1", input: [{ type: "text", text: "hi" }] },
      result: {
        turn: { id: "turn-1", status: "inProgress", items: [] },
      },
      clientMessageId: "message-1",
    });
    await ingress.ingestServerRequest({
      requestId: 8,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "question-1",
      },
    });
    const notification = await ingress.ingestNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 8 },
      emittedAtMs: 900,
    });

    expect(exchange.request).toMatchObject({
      sequence: 1,
      direction: "client_request",
      requestId: 7,
      clientMessageId: "message-1",
    });
    expect(exchange.response).toMatchObject({
      sequence: 2,
      direction: "client_response",
      phase: "resolved",
      turnId: "turn-1",
    });
    expect(notification).toMatchObject({
      sequence: 4,
      requestId: 8,
      turnId: "turn-1",
      appServerEmittedAtMs: 900,
    });
    expect(ingress.getTurnForRequest(7)).toBe("turn-1");
    expect(ingress.getTurnForRequest(8, "server")).toBe("turn-1");
    expect(await store.latestSequence("thread-1")).toBe(4);
  });

  it("persists structured inputs and generated images without filesystem paths or raw bytes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-events-paths-"));
    tempDirs.push(directory);
    const filePath = join(directory, "events.jsonl");
    const store = new JsonlCodexEventStore({ filePath });
    const ingress = await CodexEventIngress.create({
      store,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-path-safe",
      connectionId: "connection-path-safe",
    });
    const skillPath = "/Users/private/.codex/skills/release/SKILL.md";
    const mentionPath = "/Users/private/project/AGENTS.md";
    const imagePath = "/Users/private/input.png";
    const audioPath = "C:\\Users\\private\\voice.wav";
    const generatedPath = "/Users/private/output/generated.png";
    const rawImageResult = Buffer.alloc(8_192, 0xab).toString("base64");
    const structuredInputs = [
      { type: "skill", name: "release-helper", path: skillPath },
      { type: "mention", name: "project-guide", path: mentionPath },
      { type: "localImage", detail: "high", path: imagePath },
      { type: "localAudio", path: audioPath },
    ];

    await ingress.ingestClientRequest({
      requestId: 1,
      method: "turn/start",
      params: {
        threadId: "thread-path-safe",
        input: structuredInputs,
        cwd: "/Users/private/project",
        runtimeWorkspaceRoots: ["/Users/private/project"],
      },
    });
    await ingress.ingestNotification({
      method: "item/completed",
      params: {
        threadId: "thread-path-safe",
        turnId: "turn-path-safe",
        item: {
          id: "user-path-safe",
          type: "userMessage",
          content: structuredInputs,
        },
      },
    });
    await ingress.ingestNotification({
      method: "item/completed",
      params: {
        threadId: "thread-path-safe",
        turnId: "turn-path-safe",
        item: {
          id: "image-path-safe",
          type: "imageGeneration",
          status: "completed",
          revisedPrompt: "Draw a safe blue square",
          result: rawImageResult,
          savedPath: generatedPath,
        },
      },
    });
    await ingress.ingestNotification({
      method: "item/completed",
      params: {
        threadId: "thread-path-safe",
        turnId: "turn-path-safe",
        item: {
          id: "command-path-safe",
          type: "commandExecution",
          status: "completed",
          command: "node /Users/private/project/scripts/build.js",
          cwd: "/Users/private/project",
          scriptPath: "/Users/private/project/scripts/build.js",
          workingDirectory: "/Users/private/project",
        },
      },
    });

    const onDisk = readFileSync(filePath, "utf8");
    for (const forbidden of [
      skillPath,
      mentionPath,
      imagePath,
      audioPath,
      generatedPath,
      rawImageResult,
      "/Users/private",
    ]) {
      expect(onDisk).not.toContain(forbidden);
    }
    expect(onDisk).toContain("release-helper");
    expect(onDisk).toContain("project-guide");
    expect(onDisk).toContain("pathFingerprint");
    expect(onDisk).toContain("resultSummary");
    expect(onDisk).toContain("encodedSha256");

    const reopened = new JsonlCodexEventStore({ filePath });
    const replayed = await reopened.replay({ sessionId: "thread-path-safe" });
    const serializedReplay = JSON.stringify(replayed);
    expect(serializedReplay).not.toContain("/Users/private");
    expect(serializedReplay).not.toContain(rawImageResult);
    expect(replayed[0]?.payload.data).toMatchObject({
      input: [
        {
          type: "skill",
          name: "release-helper",
          pathFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
        },
        {
          type: "mention",
          name: "project-guide",
          pathFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
        },
        {
          type: "localImage",
          detail: "high",
          pathFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
        },
        {
          type: "localAudio",
          pathFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
        },
      ],
      cwdFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
      runtimeWorkspaceRootFingerprints: [
        expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
      ],
    });
    expect(replayed[2]?.payload.data).toMatchObject({
      item: {
        id: "image-path-safe",
        type: "imageGeneration",
        resultSummary: {
          encoding: "base64",
          encodedLength: rawImageResult.length,
          encodedSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        savedPathFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
      },
    });
    expect(replayed[3]?.payload.data).toMatchObject({
      item: {
        id: "command-path-safe",
        type: "commandExecution",
        command: expect.stringContaining("[REDACTED:absolute-path:"),
        cwdFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
        scriptPathFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
        workingDirectoryFingerprint: expect.stringMatching(
          /^sha256:[a-f0-9]{16}$/,
        ),
      },
    });
  });

  it("summarizes TS-only raw image-generation response items before JSONL persistence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-events-raw-image-"));
    tempDirs.push(directory);
    const filePath = join(directory, "events.jsonl");
    const store = new JsonlCodexEventStore({ filePath });
    const ingress = await CodexEventIngress.create({
      store,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-raw-image",
      connectionId: "connection-raw-image",
    });
    const rawItemResult = "RAW_IMAGE_SENTINEL_MUST_NOT_SURVIVE";
    const nestedResult = Buffer.alloc(512, 0xcd).toString("base64");
    const localPath = "/Users/private/generated/raw-image.png";

    await ingress.ingestNotification({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-raw-image",
        turnId: "turn-raw-image",
        item: {
          id: "raw-image-item",
          type: "image_generation_call",
          status: "completed",
          result: rawItemResult,
          saved_path: localPath,
        },
      },
    });
    await ingress.ingestNotification({
      method: "rawResponse/completed",
      params: {
        threadId: "thread-raw-image",
        turnId: "turn-raw-image",
        response: {
          output: [
            {
              id: "nested-raw-image-item",
              type: "image_generation_call",
              status: "completed",
              result: nestedResult,
              path: localPath,
            },
          ],
        },
      },
    });

    const onDisk = readFileSync(filePath, "utf8");
    expect(onDisk).not.toContain(rawItemResult);
    expect(onDisk).not.toContain(nestedResult);
    expect(onDisk).not.toContain(localPath);
    expect(onDisk).toContain("resultSummary");
    expect(onDisk).toContain("encodedSha256");

    const reopened = new JsonlCodexEventStore({ filePath });
    const replayed = await reopened.replay({
      sessionId: "thread-raw-image",
    });
    expect(replayed).toHaveLength(2);
    expect(replayed[0]?.payload.data).toMatchObject({
      item: {
        id: "raw-image-item",
        type: "image_generation_call",
        resultSummary: {
          encoding: "opaque",
          encodedLength: rawItemResult.length,
          encodedSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        saved_pathFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
      },
    });
    expect(replayed[1]?.payload.data).toMatchObject({
      response: {
        output: [
          {
            id: "nested-raw-image-item",
            type: "image_generation_call",
            resultSummary: {
              encoding: "base64",
              encodedLength: nestedResult.length,
              encodedSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            },
            pathFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
          },
        ],
      },
    });
    expect(JSON.stringify(replayed)).not.toContain("RAW_IMAGE_SENTINEL");
  });

  it("deduplicates replayed lifecycle snapshots but never timestamp-dedupes deltas", async () => {
    const store = new InMemoryCodexEventStore();
    const ingress = await CodexEventIngress.create({
      store,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-1",
      connectionId: "connection-1",
    });
    const snapshot = {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "item-1", type: "agentMessage", text: "ok" },
      },
      emittedAtMs: 10,
    } as const;
    await ingress.ingestNotification(snapshot);
    await ingress.ingestNotification(snapshot);
    await ingress.ingestNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        delta: "x",
      },
      emittedAtMs: 11,
    });
    await ingress.ingestNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        delta: "x",
      },
      emittedAtMs: 11,
    });

    const events = await store.replay({ sessionId: "thread-1" });
    expect(events.map((event) => event.method)).toEqual([
      "item/completed",
      "item/agentMessage/delta",
      "item/agentMessage/delta",
    ]);
  });

  it("tracks shadow parity without retaining projected content", async () => {
    const ingress = await CodexEventIngress.create({
      store: new InMemoryCodexEventStore(),
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-1",
    });
    const event = await ingress.ingestNotification({
      method: "warning",
      params: { message: "safe" },
    });
    ingress.recordProjectionParity(
      event,
      [{ type: "system", timestamp: "one", content: "safe" }],
      [{ type: "system", timestamp: "two", content: "safe" }],
    );
    ingress.recordProjectionParity(
      event,
      [{ type: "system", content: "legacy secret" }],
      [{ type: "system", content: "canonical secret" }],
    );
    expect(ingress.getParityDiagnostics()).toMatchObject({
      compared: 2,
      matched: 1,
      mismatched: 1,
      lastMismatch: {
        method: "warning",
        legacyHash: expect.any(String),
        canonicalHash: expect.any(String),
      },
    });
    expect(JSON.stringify(ingress.getParityDiagnostics())).not.toContain(
      "secret",
    );
  });

  it("does not retain an unknown method name in parity diagnostics", async () => {
    const ingress = await CodexEventIngress.create({
      store: new InMemoryCodexEventStore(),
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-unknown-parity",
    });
    const event = await ingress.ingestNotification({
      method: "future/private-method-must-not-reach-diagnostics",
      params: {},
    });
    ingress.recordProjectionParity(event, [], [{ type: "system" }]);

    expect(ingress.getParityDiagnostics()).toMatchObject({
      lastMismatch: { method: "unknown" },
    });
    expect(JSON.stringify(ingress.getParityDiagnostics())).not.toContain(
      "private-method-must-not-reach-diagnostics",
    );
  });

  it("counts persisted unknown notifications and server requests without retaining their payloads", async () => {
    const before = getCodexEventDiagnostics();
    const ingress = await CodexEventIngress.create({
      store: new InMemoryCodexEventStore(),
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-unknown-metric",
    });

    await ingress.ingestNotification({
      method: "future/unknown-notification",
      params: { token: "notification-secret" },
    });
    await ingress.ingestServerRequest({
      requestId: "future-request-1",
      method: "future/unknown-request",
      params: { authorization: "request-secret" },
    });

    const after = getCodexEventDiagnostics();
    expect(after.unknownNotificationsTotal).toBe(
      before.unknownNotificationsTotal + 1,
    );
    expect(after.unknownServerRequestsTotal).toBe(
      before.unknownServerRequestsTotal + 1,
    );
    expect(after.buckets.length).toBeLessThanOrEqual(after.bucketLimit);
    expect(after.buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "server_notification",
          runtimeVersion: "0.147.0",
          schemaFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{20}$/),
        }),
        expect.objectContaining({
          direction: "server_request",
          runtimeVersion: "0.147.0",
          schemaFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{20}$/),
        }),
      ]),
    );
    const serialized = JSON.stringify(after);
    expect(serialized).not.toContain("future/unknown-notification");
    expect(serialized).not.toContain("future/unknown-request");
    expect(serialized).not.toContain("notification-secret");
    expect(serialized).not.toContain("request-secret");
  });
});

describe("Codex JSONL event store", () => {
  it("reports fixed corruption reasons without exposing JSONL contents", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-events-corrupt-"));
    tempDirs.push(directory);
    const filePath = join(directory, "events.jsonl");
    writeFileSync(
      filePath,
      [
        '{"authorization":"Bearer must-not-reach-logs"',
        JSON.stringify({
          authorization: "Bearer must-not-reach-logs",
          schema: { name: "not-an-event", version: 1 },
        }),
      ].join("\n"),
      "utf8",
    );
    const reports: Array<{ lineNumber: number; reason: string }> = [];
    const store = new JsonlCodexEventStore({
      filePath,
      onCorruptLine: (details) => reports.push(details),
    });

    expect(await store.latestSequence("thread-1")).toBe(0);
    expect(reports).toEqual([
      { lineNumber: 1, reason: "invalid_json" },
      { lineNumber: 2, reason: "invalid_envelope" },
    ]);
    expect(JSON.stringify(reports)).not.toContain("must-not-reach-logs");

    const ingress = await CodexEventIngress.create({
      store,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-after-corrupt-tail",
      connectionId: "connection-after-corrupt-tail",
    });
    await ingress.ingestNotification({
      method: "warning",
      params: { message: "safe recovery marker" },
    });
    const reopened = new JsonlCodexEventStore({ filePath });
    expect(await reopened.latestSequence("thread-after-corrupt-tail")).toBe(1);
    expect(readFileSync(filePath, "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("reopens, replays, deduplicates, and preserves monotonic session sequences", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-events-"));
    tempDirs.push(directory);
    const filePath = join(directory, "events.jsonl");
    let now = 2_000;
    const firstStore = new JsonlCodexEventStore({
      filePath,
      now: () => now++,
    });
    const firstIngress = await CodexEventIngress.create({
      store: firstStore,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-1",
      connectionId: "connection-1",
    });
    await Promise.all([
      firstIngress.ingestNotification({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "a",
        },
      }),
      firstIngress.ingestNotification({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "b",
        },
      }),
    ]);

    const reopened = new JsonlCodexEventStore({ filePath });
    expect(await reopened.latestSequence("thread-1")).toBe(2);
    const replayed = await replayCodexSession(reopened, "thread-1");
    expect(
      replayed.threads["thread-1"]?.turns["turn-1"]?.items["item-1"]?.stream
        .assistantText,
    ).toBe("ab");
    expect(readFileSync(filePath, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("refreshes external appends before assigning the next local sequence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-events-shared-"));
    tempDirs.push(directory);
    const filePath = join(directory, "events.jsonl");
    const firstStore = new JsonlCodexEventStore({ filePath });
    const secondStore = new JsonlCodexEventStore({ filePath });
    const firstIngress = await CodexEventIngress.create({
      store: firstStore,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-shared",
      connectionId: "connection-first",
    });
    const secondIngress = await CodexEventIngress.create({
      store: secondStore,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-shared",
      connectionId: "connection-second",
    });

    await firstIngress.ingestNotification({
      method: "warning",
      params: { message: "first" },
    });
    expect(await secondStore.latestSequence("thread-shared")).toBe(1);
    await firstIngress.ingestNotification({
      method: "warning",
      params: { message: "second" },
    });
    await secondIngress.ingestNotification({
      method: "warning",
      params: { message: "third" },
    });

    const replayed = await firstStore.replay({ sessionId: "thread-shared" });
    expect(replayed.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("replaces stale indexes after journal truncation, rotation, and deletion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-events-refresh-"));
    tempDirs.push(directory);
    const filePath = join(directory, "events.jsonl");
    const store = new JsonlCodexEventStore({ filePath });
    const originalIngress = await CodexEventIngress.create({
      store,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-refresh",
      connectionId: "connection-original",
    });
    await originalIngress.ingestNotification({
      method: "warning",
      params: { message: `old-${"x".repeat(2_000)}` },
    });
    expect(await store.replay({ sessionId: "thread-refresh" })).toHaveLength(1);

    const truncatedPath = join(directory, "truncated.jsonl");
    const truncatedIngress = await CodexEventIngress.create({
      store: new JsonlCodexEventStore({ filePath: truncatedPath }),
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-refresh",
      connectionId: "connection-truncated",
    });
    await truncatedIngress.ingestNotification({
      method: "warning",
      params: { message: "after-truncate" },
    });
    writeFileSync(filePath, readFileSync(truncatedPath));

    let replayed = await store.replay({ sessionId: "thread-refresh" });
    expect(replayed).toHaveLength(1);
    expect(JSON.stringify(replayed)).toContain("after-truncate");
    expect(JSON.stringify(replayed)).not.toContain("old-");

    const rotatedPath = join(directory, "rotated.jsonl");
    const rotatedIngress = await CodexEventIngress.create({
      store: new JsonlCodexEventStore({ filePath: rotatedPath }),
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-refresh",
      connectionId: "connection-rotated",
    });
    await rotatedIngress.ingestNotification({
      method: "warning",
      params: { message: `after-rotate-${"y".repeat(3_000)}` },
    });
    renameSync(rotatedPath, filePath);

    replayed = await store.replay({ sessionId: "thread-refresh" });
    expect(replayed).toHaveLength(1);
    expect(JSON.stringify(replayed)).toContain("after-rotate");
    expect(JSON.stringify(replayed)).not.toContain("after-truncate");

    rmSync(filePath);
    expect(await store.replay({ sessionId: "thread-refresh" })).toEqual([]);
  });

  it("redacts correlated secret defaults and answers before JSONL persistence, including after replay", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-events-secrets-"));
    tempDirs.push(directory);
    const filePath = join(directory, "events.jsonl");
    const firstIngress = await CodexEventIngress.create({
      store: new JsonlCodexEventStore({ filePath }),
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-secrets",
      connectionId: "connection-secrets",
    });

    await firstIngress.ingestServerRequest({
      requestId: "question-request",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-secrets",
        turnId: "turn-secrets",
        itemId: "question-item",
        isBlocking: true,
        questions: [
          {
            id: "credential-answer",
            header: "Credential",
            question: "Enter the credential",
            isOther: true,
            isSecret: true,
            options: null,
          },
          {
            id: "password",
            header: "Password",
            question: "Enter the password",
            isOther: true,
            isSecret: false,
            options: null,
          },
          {
            id: "display-name",
            header: "Name",
            question: "Enter a display name",
            isOther: true,
            isSecret: false,
            options: null,
          },
        ],
      },
    });
    await firstIngress.ingestServerRequest({
      requestId: "mcp-request",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-secrets",
        turnId: null,
        serverName: "secret-form",
        mode: "openai/form",
        message: "Complete the form",
        requestedSchema: {
          type: "object",
          properties: {
            apiCredential: {
              type: "string",
              writeOnly: true,
              default: "mcp-writeonly-default-private-11",
            },
            passcode: {
              type: "string",
              format: "password",
              default: "mcp-password-default-private-12",
            },
            secret: {
              type: "string",
              default: "mcp-named-default-private-13",
            },
            region: {
              type: "string",
              default: "visible-default-region",
            },
          },
        },
      },
    });

    const requestsOnDisk = readFileSync(filePath, "utf8");
    expect(requestsOnDisk).not.toContain("mcp-writeonly-default-private-11");
    expect(requestsOnDisk).not.toContain("mcp-password-default-private-12");
    expect(requestsOnDisk).not.toContain("mcp-named-default-private-13");
    expect(requestsOnDisk).toContain("visible-default-region");
    expect(requestsOnDisk).toContain("[REDACTED:secret-default]");

    const reopenedStore = new JsonlCodexEventStore({ filePath });
    const reopenedIngress = await CodexEventIngress.create({
      store: reopenedStore,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-secrets",
      connectionId: "connection-secrets",
    });
    await reopenedIngress.ingestServerRequestResolution({
      requestId: "question-request",
      method: "item/tool/requestUserInput",
      result: {
        answers: {
          "credential-answer": {
            answers: ["request-input-answer-private-21"],
          },
          password: { answers: ["request-password-answer-private-22"] },
          "display-name": { answers: ["visible-user-answer"] },
        },
      },
    });
    await reopenedIngress.ingestServerRequestResolution({
      requestId: "mcp-request",
      method: "mcpServer/elicitation/request",
      result: {
        action: "accept",
        content: {
          apiCredential: "mcp-writeonly-answer-private-23",
          passcode: "mcp-password-answer-private-24",
          secret: "mcp-named-answer-private-25",
          region: "visible-mcp-answer",
        },
      },
    });

    const jsonl = readFileSync(filePath, "utf8");
    for (const forbidden of [
      "request-input-answer-private-21",
      "request-password-answer-private-22",
      "mcp-writeonly-answer-private-23",
      "mcp-password-answer-private-24",
      "mcp-named-answer-private-25",
      "mcp-writeonly-default-private-11",
      "mcp-password-default-private-12",
      "mcp-named-default-private-13",
    ]) {
      expect(jsonl).not.toContain(forbidden);
    }
    expect(jsonl).toContain("visible-user-answer");
    expect(jsonl).toContain("visible-mcp-answer");
    expect(jsonl).toContain("[REDACTED:secret-answer]");

    const replayed = await reopenedStore.replay({
      sessionId: "thread-secrets",
    });
    const questionResolution = replayed.find(
      (event) =>
        event.direction === "client_response" &&
        event.requestId === "question-request",
    );
    const mcpResolution = replayed.find(
      (event) =>
        event.direction === "client_response" &&
        event.requestId === "mcp-request",
    );
    expect(questionResolution?.payload.data).toMatchObject({
      result: {
        answers: {
          "credential-answer": {
            answers: ["[REDACTED:secret-answer]"],
          },
          password: { answers: ["[REDACTED:secret-answer]"] },
          "display-name": { answers: ["visible-user-answer"] },
        },
      },
    });
    expect(mcpResolution?.payload.data).toMatchObject({
      result: {
        content: {
          apiCredential: "[REDACTED:secret-answer]",
          passcode: "[REDACTED:secret-answer]",
          secret: "[REDACTED:secret-answer]",
          region: "visible-mcp-answer",
        },
      },
    });
  });

  it("restores request-to-turn correlation and connection counters on replay", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-events-"));
    tempDirs.push(directory);
    const filePath = join(directory, "events.jsonl");
    const firstIngress = await CodexEventIngress.create({
      store: new JsonlCodexEventStore({ filePath }),
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-1",
      connectionId: "connection-1",
    });
    await firstIngress.ingestClientExchange({
      requestId: 4,
      method: "turn/start",
      params: { threadId: "thread-1" },
      result: { turn: { id: "turn-1" } },
    });
    await firstIngress.ingestServerRequest({
      requestId: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });

    const reopenedStore = new JsonlCodexEventStore({ filePath });
    const reopenedIngress = await CodexEventIngress.create({
      store: reopenedStore,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "thread-1",
      connectionId: "connection-1",
    });
    expect(reopenedIngress.getTurnForRequest(4)).toBe("turn-1");
    expect(reopenedIngress.getTurnForRequest("approval-1", "server")).toBe(
      "turn-1",
    );
    const resolved = await reopenedIngress.ingestNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "approval-1" },
    });
    expect(resolved).toMatchObject({
      eventId: "connection-1:4",
      sequence: 4,
      turnId: "turn-1",
    });
  });
});

describe("Codex event projection rollout", () => {
  it("supports account/session canaries and a legacy rollback override", () => {
    const config = codexEventRolloutConfigFromEnv({
      YEP_CODEX_EVENT_SPINE_MODE: "shadow",
      YEP_CODEX_EVENT_SPINE_PRIMARY_SESSIONS: "session-primary",
      YEP_CODEX_EVENT_SPINE_PRIMARY_ACCOUNTS: "account-primary",
      YEP_CODEX_EVENT_SPINE_LEGACY_SESSIONS: "session-rollback",
      YEP_CODEX_EVENT_SPINE_LEGACY_ACCOUNTS: "account-rollback",
    });
    expect(
      resolveCodexEventProjectionMode(
        { sessionId: "normal", accountId: "normal" },
        config,
      ),
    ).toBe("shadow");
    expect(
      resolveCodexEventProjectionMode({ sessionId: "session-primary" }, config),
    ).toBe("primary");
    expect(
      resolveCodexEventProjectionMode(
        { sessionId: "normal", accountId: "account-primary" },
        config,
      ),
    ).toBe("primary");
    expect(
      resolveCodexEventProjectionMode(
        { sessionId: "session-primary", accountId: "account-rollback" },
        config,
      ),
    ).toBe("legacy");
  });
});
