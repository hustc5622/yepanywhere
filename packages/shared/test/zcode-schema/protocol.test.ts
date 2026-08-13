import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
} from "../../src/types.js";
import {
  YEP_TO_ZCODE_MODE_MAP,
  ZCODE_SELECTABLE_MODES,
  ZCodeForkTargetSchema,
  ZCodeMcpListParamsSchema,
  ZCodeMcpListResultSchema,
  ZCodeMcpServerStatusSchema,
  ZCodeModeSchema,
  ZCodeSessionCompactParamsSchema,
  ZCodeSessionCreateParamsSchema,
  ZCodeSessionForkParamsSchema,
  ZCodeSessionForkResultSchema,
  ZCodeSessionGoalParamsSchema,
  ZCodeSessionGoalResultSchema,
  ZCodeSessionResumeParamsSchema,
  ZCodeSessionSendParamsSchema,
  ZCodeSessionSetModeParamsSchema,
  ZCodeSessionSetModelParamsSchema,
  ZCodeSessionSetThoughtLevelParamsSchema,
  ZCodeSessionStopParamsSchema,
  ZCodeSessionSubscribeParamsSchema,
  ZCodeUpdateProviderRegistryParamsSchema,
  ZCodeWorkspaceReadStateParamsSchema,
} from "../../src/zcode-schema/protocol.js";

describe("ZCode execution modes", () => {
  it("keeps auto in the wire enum because the protocol still accepts it", () => {
    expect(ZCodeModeSchema.safeParse("auto").success).toBe(true);
  });

  it("excludes auto from the selectable modes", () => {
    // ZCode CLI 0.16.1 denies every tool call in native `auto`
    // (`mode.auto.unimplemented` — "Auto mode is reserved but not implemented
    // yet"), and its own mode picker offers only build/edit/plan/yolo.
    expect(ZCODE_SELECTABLE_MODES).toEqual(["build", "edit", "plan", "yolo"]);
    expect(ZCODE_SELECTABLE_MODES).not.toContain("auto");
  });

  it("never maps any Yep mode onto ZCode's non-functional auto", () => {
    for (const zcodeMode of Object.values(YEP_TO_ZCODE_MODE_MAP)) {
      expect(zcodeMode).not.toBe("auto");
    }
  });

  it("maps every Yep permission mode to a selectable ZCode mode", () => {
    for (const yepMode of ALL_PERMISSION_MODES) {
      const zcodeMode = YEP_TO_ZCODE_MODE_MAP[yepMode];
      // Total map: a lookup must never yield undefined, otherwise
      // session/setMode would send `mode: undefined` and fail its strict schema.
      expect(zcodeMode).toBeDefined();
      expect(ZCODE_SELECTABLE_MODES).toContain(zcodeMode);
    }
  });

  it("degrades Yep auto to the ask-before-changes mode", () => {
    // Yep's canonical default is `auto`, so a session persisted before `auto`
    // was withdrawn must land on the safest working mode rather than a mode
    // that blocks every tool.
    expect(DEFAULT_PERMISSION_MODE).toBe("auto");
    expect(YEP_TO_ZCODE_MODE_MAP.auto).toBe("build");
  });

  it("maps the remaining modes onto their native ZCode equivalents", () => {
    expect(YEP_TO_ZCODE_MODE_MAP.default).toBe("build");
    expect(YEP_TO_ZCODE_MODE_MAP.acceptEdits).toBe("edit");
    expect(YEP_TO_ZCODE_MODE_MAP.plan).toBe("plan");
    expect(YEP_TO_ZCODE_MODE_MAP.bypassPermissions).toBe("yolo");
  });
});

describe("ZCode strict params contracts (CLI 0.16.1)", () => {
  const workspace = { workspacePath: "/tmp/ws", workspaceKey: "/tmp/ws" };
  const model = { providerId: "provider-1", modelId: "model-1" };

  it("rejects unknown top-level keys for every request schema Yep uses", () => {
    const cases = [
      [ZCodeWorkspaceReadStateParamsSchema, { workspace }],
      [
        ZCodeUpdateProviderRegistryParamsSchema,
        {
          workspace,
          registry: {
            revision: "rev-1",
            generatedAt: 1,
            providers: [
              {
                providerId: "provider-1",
                kind: "anthropic",
                models: [{ modelId: "model-1" }],
              },
            ],
          },
        },
      ],
      [ZCodeSessionCreateParamsSchema, { workspace, model }],
      [ZCodeSessionResumeParamsSchema, { sessionId: "session-1", workspace }],
      [ZCodeSessionSendParamsSchema, { sessionId: "session-1", content: "hi" }],
      [ZCodeSessionSetModelParamsSchema, { sessionId: "session-1", model }],
      [
        ZCodeSessionSetModeParamsSchema,
        { sessionId: "session-1", mode: "build" },
      ],
      [
        ZCodeSessionSetThoughtLevelParamsSchema,
        { sessionId: "session-1", thoughtLevel: "enabled" },
      ],
      [ZCodeSessionStopParamsSchema, { sessionId: "session-1" }],
      [ZCodeSessionCompactParamsSchema, { sessionId: "session-1" }],
      [
        ZCodeSessionSubscribeParamsSchema,
        {
          sessionId: "session-1",
          deliveryKind: "web-remote-replayable",
        },
      ],
    ] as const;

    for (const [schema, valid] of cases) {
      expect(schema.safeParse(valid).success).toBe(true);
      expect(schema.safeParse({ ...valid, unexpected: true }).success).toBe(
        false,
      );
    }
  });

  it("rejects unknown keys inside nested workspace/model/registry records", () => {
    expect(
      ZCodeSessionCreateParamsSchema.safeParse({
        workspace: { ...workspace, unexpected: true },
      }).success,
    ).toBe(false);
    expect(
      ZCodeSessionSetModelParamsSchema.safeParse({
        sessionId: "session-1",
        model: { ...model, unexpected: true },
      }).success,
    ).toBe(false);
    expect(
      ZCodeUpdateProviderRegistryParamsSchema.safeParse({
        workspace,
        registry: {
          revision: "rev-1",
          generatedAt: 1,
          providers: [
            {
              providerId: "provider-1",
              kind: "anthropic",
              models: [{ modelId: "model-1", name: "rejected" }],
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});

describe("ZCode session/fork contract (CLI 0.16.1)", () => {
  it("accepts every documented target kind", () => {
    for (const target of [
      { kind: "turn", turnIndex: 2 },
      { kind: "message", messageId: "msg-1" },
      { kind: "checkpoint", checkpointId: "cp-1" },
      { kind: "latestCheckpoint" },
    ] as const) {
      expect(ZCodeForkTargetSchema.safeParse(target).success).toBe(true);
    }
  });

  it("rejects unknown target kinds and extra keys (strict schema)", () => {
    expect(
      ZCodeForkTargetSchema.safeParse({ kind: "message", id: "msg-1" }).success,
    ).toBe(false);
    expect(
      ZCodeForkTargetSchema.safeParse({
        kind: "message",
        messageId: "msg-1",
        mode: "edit",
      }).success,
    ).toBe(false);
    // Top-level `messageId` / `mode` are NOT accepted by session/fork params.
    expect(
      ZCodeSessionForkParamsSchema.safeParse({
        sessionId: "ses-1",
        messageId: "msg-1",
      }).success,
    ).toBe(false);
    expect(
      ZCodeSessionForkParamsSchema.safeParse({
        sessionId: "ses-1",
        target: { kind: "message", messageId: "msg-1" },
      }).success,
    ).toBe(true);
  });

  it("parses the documented result shape", () => {
    const result = ZCodeSessionForkResultSchema.safeParse({
      forkedSessionId: "fork-1",
      parentSessionId: "src-1",
      targetMessageId: "msg-0",
      response: "forked",
      snapshot: {
        session: { sessionId: "fork-1" },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("ZCode mcp/list contract (CLI 0.16.1)", () => {
  const workspace = { workspacePath: "/tmp/ws", workspaceKey: "/tmp/ws" };

  it("accepts a read-only status query with workspace identity", () => {
    expect(
      ZCodeMcpListParamsSchema.safeParse({ workspace, mode: "status" }).success,
    ).toBe(true);
  });

  it("rejects missing workspace and unknown keys (strict schema)", () => {
    // Real CLI: mcp/list {} → "workspace: expected object, received undefined".
    expect(ZCodeMcpListParamsSchema.safeParse({}).success).toBe(false);
    expect(
      ZCodeMcpListParamsSchema.safeParse({
        workspace,
        mode: "status",
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("rejects modes other than connect/status", () => {
    expect(
      ZCodeMcpListParamsSchema.safeParse({ workspace, mode: "probe" }).success,
    ).toBe(false);
  });

  it("parses the documented statuses map and tolerates extra fields", () => {
    const result = ZCodeMcpListResultSchema.safeParse({
      statuses: {
        context7: {
          status: "connected",
          transport: "http",
          toolCount: 4,
          updatedAt: "2026-08-13T00:00:00Z",
          protocolEra: "modern",
          authorization: { state: "granted" },
        },
        flaky: {
          status: "failed",
          transport: "stdio",
          toolCount: 0,
          updatedAt: "2026-08-13T00:01:00Z",
          error: "spawn ENOENT",
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.statuses.flaky?.error).toBe("spawn ENOENT");
    }
  });

  it("rejects unknown status enum values", () => {
    expect(
      ZCodeMcpServerStatusSchema.safeParse({
        status: "online",
        transport: "stdio",
        toolCount: 0,
        updatedAt: "2026-08-13T00:00:00Z",
      }).success,
    ).toBe(false);
  });
});

describe("ZCode session/goal contract (CLI 0.16.1)", () => {
  it("accepts every documented goal action with strict params", () => {
    for (const action of [
      "show",
      "set",
      "replace",
      "pause",
      "resume",
      "clear",
    ] as const) {
      expect(
        ZCodeSessionGoalParamsSchema.safeParse({
          sessionId: "ses-1",
          action,
        }).success,
      ).toBe(true);
    }
    expect(
      ZCodeSessionGoalParamsSchema.safeParse({
        sessionId: "ses-1",
        action: "set",
        objective: "do the thing",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown actions and extra keys (strict schema)", () => {
    expect(
      ZCodeSessionGoalParamsSchema.safeParse({
        sessionId: "ses-1",
        action: "explode",
      }).success,
    ).toBe(false);
    expect(
      ZCodeSessionGoalParamsSchema.safeParse({
        sessionId: "ses-1",
        action: "show",
        text: "not an allowed key",
      }).success,
    ).toBe(false);
  });

  it("parses the documented result shape", () => {
    expect(
      ZCodeSessionGoalResultSchema.safeParse({
        response: "goal status: active",
        startedTurn: false,
        snapshot: {},
      }).success,
    ).toBe(true);
    expect(ZCodeSessionGoalResultSchema.safeParse({}).success).toBe(false);
  });
});
