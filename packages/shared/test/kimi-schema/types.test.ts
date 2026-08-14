import { describe, expect, it } from "vitest";
import {
  KIMI_ACP_SINGLE_QUESTION_REMINDER,
  KimiConfigUpdateRecordSchema,
  KimiGoalBudgetLimitsSchema,
  KimiGoalCreateRecordSchema,
  KimiInterruptionReminderRecordedRecordSchema,
  KimiPermissionApprovalResultRecordSchema,
  KimiPluginSessionStartRecordSchema,
  type KimiWireRecord,
  getKimiGoalTimeline,
  getKimiPromptImages,
  getKimiPromptText,
  getKimiSubagentType,
  inferKimiSubagentStatus,
  isKimiGoalCreateRecord,
  isKimiGoalUpdateRecord,
  isKimiInteractionRequestRecord,
  isKimiProfileBindRecord,
  isKimiTurnCancelRecord,
  isKimiTurnEndedRecord,
  parseKimiBlobRef,
  parseKimiSessionState,
  parseKimiWireJsonl,
} from "../../src/kimi-schema/types.js";

describe("parseKimiWireJsonl", () => {
  it("preserves terminal provider errors and raw filter reasons", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({
          type: "context.append_loop_event",
          event: {
            type: "step.end",
            finishReason: "filtered",
            providerFinishReason: "filtered",
            rawFinishReason: "content_filter",
          },
          time: 1,
        }),
        JSON.stringify({
          type: "turn.ended",
          turnId: 0,
          reason: "failed",
          error: {
            code: "provider.filtered",
            message: "Provider safety policy blocked the response.",
            name: "ProviderFilteredError",
            retryable: false,
          },
          time: 2,
        }),
      ].join("\n"),
    );

    expect(records[0]).toMatchObject({
      event: {
        finishReason: "filtered",
        providerFinishReason: "filtered",
        rawFinishReason: "content_filter",
      },
    });
    expect(isKimiTurnEndedRecord(records[1])).toBe(true);
    expect(records[1]).toMatchObject({
      type: "turn.ended",
      turnId: 0,
      reason: "failed",
      error: {
        code: "provider.filtered",
        message: "Provider safety policy blocked the response.",
        retryable: false,
      },
    });
  });
});

describe("parseKimiSessionState", () => {
  it("keeps the legacy workDir and ISO timestamp layout", () => {
    expect(
      parseKimiSessionState(
        JSON.stringify({
          workDir: "/tmp/legacy-project",
          createdAt: "2026-08-11T01:02:03.000Z",
          updatedAt: "2026-08-11T01:03:04.000Z",
          title: "Legacy session",
        }),
      ),
    ).toMatchObject({
      workDir: "/tmp/legacy-project",
      createdAt: "2026-08-11T01:02:03.000Z",
      updatedAt: "2026-08-11T01:03:04.000Z",
      title: "Legacy session",
    });
  });

  it("normalizes Kimi Code 0.34 state v2 cwd and epoch timestamps", () => {
    const createdAt = Date.UTC(2026, 7, 11, 1, 2, 3);
    const updatedAt = Date.UTC(2026, 7, 11, 1, 3, 4);

    expect(
      parseKimiSessionState(
        JSON.stringify({
          version: 2,
          cwd: "/tmp/v2-project",
          createdAt,
          updatedAt,
          title: "Version two session",
        }),
      ),
    ).toMatchObject({
      version: 2,
      cwd: "/tmp/v2-project",
      workDir: "/tmp/v2-project",
      createdAt: new Date(createdAt).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
      title: "Version two session",
    });
  });
});

describe("parseKimiBlobRef", () => {
  const hash = "a".repeat(64);

  it("parses a content-addressed blob reference", () => {
    expect(parseKimiBlobRef(`blobref:image/png;${hash}`)).toEqual({
      mimeType: "image/png",
      hash,
    });
  });

  it("returns null for non-blobref urls", () => {
    expect(parseKimiBlobRef("data:image/png;base64,AAAB")).toBeNull();
    expect(parseKimiBlobRef("file:///tmp/a.png")).toBeNull();
  });

  it("rejects hashes that are not a bare sha256", () => {
    // Guards against path traversal out of the blobs directory.
    expect(parseKimiBlobRef("blobref:image/png;../../etc/passwd")).toBeNull();
    expect(parseKimiBlobRef("blobref:image/png;short")).toBeNull();
    expect(parseKimiBlobRef(`blobref:;${hash}`)).toBeNull();
  });
});

describe("getKimiPromptText", () => {
  it("joins text parts and ignores images", () => {
    expect(
      getKimiPromptText([
        { type: "text", text: "first" },
        { type: "image_url", imageUrl: { url: "data:image/png;base64,A" } },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  it("drops the compression notice Kimi injects next to an image", () => {
    expect(
      getKimiPromptText([
        { type: "text", text: "describe this" },
        {
          type: "text",
          text: "<system>Image compressed to fit model limits: original 1290x2796 image/png (33 KB) -> sent 923x2000 image/png (30 KB).</system>",
        },
      ]),
    ).toBe("describe this");
  });

  it("hides Yep's exact ACP question compatibility reminder", () => {
    expect(
      getKimiPromptText([
        {
          type: "text",
          text: `${KIMI_ACP_SINGLE_QUESTION_REMINDER}\n\ninspect the project`,
        },
      ]),
    ).toBe("inspect the project");
    expect(
      getKimiPromptText([
        {
          type: "text",
          text: "[yep-anywhere:kimi-acp-single-question] is user prose",
        },
      ]),
    ).toBe("[yep-anywhere:kimi-acp-single-question] is user prose");
  });

  it("keeps user text that merely mentions a system tag", () => {
    expect(
      getKimiPromptText([
        { type: "text", text: "the <system> tag is not closed here" },
      ]),
    ).toBe("the <system> tag is not closed here");
  });

  it("preserves literal <system>...</system> user text that is not the compression notice", () => {
    // The narrow regex must only hide Kimi's own compression-injection text.
    // A user message that legitimately wraps content in <system> tags is
    // not dropped, otherwise transcripts, session titles and normalization
    // would silently lose real user input.
    expect(
      getKimiPromptText([
        { type: "text", text: "<system>show this literal user text</system>" },
      ]),
    ).toBe("<system>show this literal user text</system>");
    expect(
      getKimiPromptText([
        {
          type: "text",
          text: "<system>custom system instructions go here</system>",
        },
      ]),
    ).toBe("<system>custom system instructions go here</system>");
  });

  it("hides only the exact Kimi compression notice", () => {
    const notice =
      "<system>Image compressed to fit model limits: original 1290x2796 image/png (33 KB) -> sent 923x2000 image/png (30 KB).</system>";
    expect(getKimiPromptText([{ type: "text", text: notice }])).toBe("");
    // Even when surrounded by other text parts, only the notice is dropped.
    expect(
      getKimiPromptText([
        { type: "text", text: "before" },
        { type: "text", text: notice },
        { type: "text", text: "after" },
      ]),
    ).toBe("before\nafter");
  });
});

describe("getKimiPromptImages", () => {
  const hash = "f".repeat(64);

  it("resolves blobrefs and data urls in order", () => {
    expect(
      getKimiPromptImages([
        { type: "text", text: "x" },
        { type: "image_url", imageUrl: { url: `blobref:image/webp;${hash}` } },
        { type: "image_url", imageUrl: { url: "data:image/jpeg;base64,AAAB" } },
      ]),
    ).toEqual([
      {
        url: `blobref:image/webp;${hash}`,
        mimeType: "image/webp",
        blobHash: hash,
      },
      { url: "data:image/jpeg;base64,AAAB", mimeType: "image/jpeg" },
    ]);
  });

  it("returns nothing for a text-only turn", () => {
    expect(getKimiPromptImages([{ type: "text", text: "hi" }])).toEqual([]);
  });
});

describe("inferKimiSubagentStatus", () => {
  const completedRecords: KimiWireRecord[] = [
    {
      type: "context.append_loop_event",
      event: { type: "step.end", finishReason: "end_turn" },
      time: 2,
    },
  ];

  it("lets a background child converge to completed from its own wire", () => {
    expect(inferKimiSubagentStatus(completedRecords, "backgrounded")).toBe(
      "completed",
    );
  });

  it("keeps a non-terminal parent status until the child finishes", () => {
    expect(inferKimiSubagentStatus([], "backgrounded")).toBe("backgrounded");
  });

  it("keeps an authoritative terminal failure over a clean child end", () => {
    expect(inferKimiSubagentStatus(completedRecords, "failed")).toBe("failed");
  });
});

// =============================================================================
// New record type schemas (goal / profile.bind / swarm / task / interaction /
// turn.cancel / compaction). Shapes are derived from real session fixtures
// (references/kimi-code 0.36.0+) and the upstream Op schemas.
// =============================================================================

describe("goal.* record schemas", () => {
  it("parses goal.create with the full fixture shape", () => {
    const fixture = {
      type: "goal.create" as const,
      goalId: "659b854d-8d10-4df2-99a6-23a4d11440a1",
      objective: "看一下目前的 git status",
      completionCriterion: null,
      status: null,
      actor: null,
      budgetLimits: null,
      wallClockResumedAt: 1786590025429,
      time: 1786590025430,
    };
    expect(KimiGoalCreateRecordSchema.safeParse(fixture).success).toBe(true);
    const records = parseKimiWireJsonl(JSON.stringify(fixture));
    expect(records).toHaveLength(1);
    expect(isKimiGoalCreateRecord(records[0] ?? {})).toBe(true);
    expect(records[0]).toMatchObject({
      type: "goal.create",
      goalId: "659b854d-8d10-4df2-99a6-23a4d11440a1",
      objective: "看一下目前的 git status",
      wallClockResumedAt: 1786590025429,
    });
  });

  it("parses goal.update status transitions and partial counter updates", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({
          type: "goal.update",
          status: "blocked",
          actor: "model",
          wallClockMs: 10036792,
          time: 1786600062157,
        }),
        JSON.stringify({
          type: "goal.update",
          turnsUsed: 1,
          time: 1786590025540,
        }),
        JSON.stringify({
          type: "goal.update",
          status: "complete",
          reason: "done",
          actor: "model",
        }),
      ].join("\n"),
    );
    expect(records).toHaveLength(3);
    expect(isKimiGoalUpdateRecord(records[0] ?? {})).toBe(true);
    expect(records[0]).toMatchObject({
      type: "goal.update",
      status: "blocked",
      actor: "model",
    });
    // Partial counter update keeps only the provided field.
    expect(records[1]).toMatchObject({ type: "goal.update", turnsUsed: 1 });
    expect(records[1]).not.toHaveProperty("status");
    expect(records[2]).toMatchObject({
      type: "goal.update",
      status: "complete",
      reason: "done",
    });
  });

  it("parses goal.clear and forked as empty-payload records", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({ type: "goal.clear", time: 1786614145100 }),
        JSON.stringify({ type: "forked", time: 1786614145101 }),
      ].join("\n"),
    );
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ type: "goal.clear" });
    expect(records[1]).toMatchObject({ type: "forked" });
  });

  it("validates the four goal statuses from the upstream enum", () => {
    for (const status of ["active", "paused", "blocked", "complete"] as const) {
      const records = parseKimiWireJsonl(
        JSON.stringify({ type: "goal.update", status }),
      );
      expect(records[0]).toMatchObject({ type: "goal.update", status });
    }
  });

  it("rejects non-finite and negative budget limits", () => {
    expect(
      KimiGoalBudgetLimitsSchema.safeParse({ turnBudget: -1 }).success,
    ).toBe(false);
    expect(
      KimiGoalBudgetLimitsSchema.safeParse({
        tokenBudget: Number.POSITIVE_INFINITY,
      }).success,
    ).toBe(false);
  });
});

describe("profile.bind and config.update variant split", () => {
  it("validates a thinking-only partial config.update", () => {
    const fixture = {
      type: "config.update" as const,
      thinkingEffort: "max",
      time: 1,
    };
    expect(KimiConfigUpdateRecordSchema.safeParse(fixture).success).toBe(true);
    expect(parseKimiWireJsonl(JSON.stringify(fixture))[0]).toEqual(fixture);
  });

  it("routes profileName-only config.update to the profile variant", () => {
    const records = parseKimiWireJsonl(
      JSON.stringify({
        type: "config.update",
        profileName: "agent",
        environmentDisclosure: { cwd: "/tmp" },
        time: 1,
      }),
    );
    expect(records).toHaveLength(1);
    // The profile variant carries profileName, not modelAlias.
    expect(records[0]).toMatchObject({
      type: "config.update",
      profileName: "agent",
    });
    expect(records[0]).not.toHaveProperty("modelAlias");
  });

  it("routes modelAlias config.update to the model variant", () => {
    const records = parseKimiWireJsonl(
      JSON.stringify({
        type: "config.update",
        modelAlias: "custom-kimi/kimi-k3",
        thinkingEffort: "high",
        time: 1,
      }),
    );
    expect(records[0]).toMatchObject({
      type: "config.update",
      modelAlias: "custom-kimi/kimi-k3",
    });
    expect(records[0]).not.toHaveProperty("profileName");
  });

  it("preserves profile and model fields from a combined config.update", () => {
    const records = parseKimiWireJsonl(
      JSON.stringify({
        type: "config.update",
        modelAlias: "custom-kimi/kimi-k3",
        profileName: "explore",
        thinkingEffort: "high",
        time: 1,
      }),
    );
    expect(records[0]).toMatchObject({
      type: "config.update",
      modelAlias: "custom-kimi/kimi-k3",
      profileName: "explore",
      thinkingEffort: "high",
    });
    expect(getKimiSubagentType(records)).toBe("explore");
  });

  it("parses profile.bind with the authoritative profileName", () => {
    const records = parseKimiWireJsonl(
      JSON.stringify({
        type: "profile.bind",
        modelAlias: "custom-kimi/kimi-k3",
        profileName: "coder",
        thinkingEffort: "high",
        time: 1,
      }),
    );
    expect(isKimiProfileBindRecord(records[0] ?? {})).toBe(true);
    expect(records[0]).toMatchObject({
      type: "profile.bind",
      profileName: "coder",
    });
  });
});

describe("getKimiSubagentType profile.bind fallback", () => {
  it("prefers profile.bind.profileName when present", () => {
    const records: KimiWireRecord[] = [
      {
        type: "config.update",
        profileName: "agent",
        time: 1,
      } as KimiWireRecord,
      { type: "profile.bind", profileName: "coder", time: 2 } as KimiWireRecord,
    ];
    expect(getKimiSubagentType(records)).toBe("coder");
  });

  it("falls back to config.update.profileName for older sessions", () => {
    const records: KimiWireRecord[] = [
      {
        type: "config.update",
        profileName: "explore",
        time: 1,
      } as KimiWireRecord,
    ];
    expect(getKimiSubagentType(records)).toBe("explore");
  });

  it("ignores modelAlias config.update records", () => {
    const records: KimiWireRecord[] = [
      {
        type: "config.update",
        modelAlias: "kimi-k3",
        time: 1,
      } as KimiWireRecord,
    ];
    expect(getKimiSubagentType(records)).toBeUndefined();
  });
});

describe("swarm / task / interaction / turn.cancel / compaction records", () => {
  it("parses the remaining durable permission, plugin, and reminder records", () => {
    const approval = {
      type: "permission.record_approval_result" as const,
      turnId: 2,
      toolCallId: "call-1",
      toolName: "Bash",
      action: "Run tests",
      result: { decision: "approved", selectedLabel: "Approve once" },
      time: 1,
    };
    const plugin = {
      type: "plugin.session_start" as const,
      content: "Use the release workflow",
      time: 2,
    };
    const reminder = {
      type: "interruptionReminder.recorded" as const,
      turnId: 2,
      time: 3,
    };

    expect(
      KimiPermissionApprovalResultRecordSchema.safeParse(approval).success,
    ).toBe(true);
    expect(KimiPluginSessionStartRecordSchema.safeParse(plugin).success).toBe(
      true,
    );
    expect(
      KimiInterruptionReminderRecordedRecordSchema.safeParse(reminder).success,
    ).toBe(true);
    expect(
      parseKimiWireJsonl(
        [approval, plugin, reminder]
          .map((record) => JSON.stringify(record))
          .join("\n"),
      ),
    ).toEqual([approval, plugin, reminder]);
  });

  it("parses swarm_mode.enter/exit", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({ type: "swarm_mode.enter", trigger: "tool", time: 1 }),
        JSON.stringify({ type: "swarm_mode.exit", time: 2 }),
      ].join("\n"),
    );
    expect(records[0]).toMatchObject({
      type: "swarm_mode.enter",
      trigger: "tool",
    });
    expect(records[1]).toMatchObject({ type: "swarm_mode.exit" });
  });

  it("parses task.started/terminated with the info descriptor", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({
          type: "task.started",
          info: {
            taskId: "agent-bhj8vvqa",
            description: "调研可行性",
            status: "running",
            detached: true,
            kind: "agent",
            agentId: "agent-3",
            subagentType: "explore",
            model: "custom-kimi/kimi-k3",
          },
          time: 1,
        }),
        JSON.stringify({
          type: "task.terminated",
          info: {
            taskId: "agent-bhj8vvqa",
            status: "completed",
            agentId: "agent-3",
            subagentType: "explore",
          },
          outputTail: "done",
          time: 2,
        }),
      ].join("\n"),
    );
    expect(records[0]).toMatchObject({
      type: "task.started",
      info: { agentId: "agent-3", subagentType: "explore", status: "running" },
    });
    expect(records[1]).toMatchObject({
      type: "task.terminated",
      info: { status: "completed" },
      outputTail: "done",
    });
  });

  it("parses interaction.request with approval/question/user_tool kinds", () => {
    for (const kind of ["approval", "question", "user_tool"] as const) {
      const records = parseKimiWireJsonl(
        JSON.stringify({
          type: "interaction.request",
          id: "req-1",
          kind,
          toolCallId: "Agent_19",
          agentId: "main",
          request: { prompt: "approve?" },
        }),
      );
      expect(isKimiInteractionRequestRecord(records[0] ?? {})).toBe(true);
      expect(records[0]).toMatchObject({
        type: "interaction.request",
        kind,
        id: "req-1",
      });
    }
  });

  it("parses interaction.resolved", () => {
    const records = parseKimiWireJsonl(
      JSON.stringify({
        type: "interaction.resolved",
        id: "req-1",
        response: { decision: "allow" },
      }),
    );
    expect(records[0]).toMatchObject({
      type: "interaction.resolved",
      id: "req-1",
    });
  });

  it("parses turn.cancel (the record inferKimiSubagentStatus depends on)", () => {
    const records = parseKimiWireJsonl(
      JSON.stringify({
        type: "turn.cancel",
        turnId: 2,
        target: "active",
        reason: "user_cancelled",
      }),
    );
    expect(isKimiTurnCancelRecord(records[0] ?? {})).toBe(true);
    expect(records[0]).toMatchObject({
      type: "turn.cancel",
      turnId: 2,
      target: "active",
      reason: "user_cancelled",
    });
    // A turn.cancel record still drives inferKimiSubagentStatus → interrupted.
    expect(inferKimiSubagentStatus(records)).toBe("interrupted");
  });

  it("parses full_compaction.begin/cancel/complete and context.apply_compaction", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({
          type: "full_compaction.begin",
          source: "manual",
          instruction: "keep the deployment facts",
          time: 1,
        }),
        JSON.stringify({ type: "full_compaction.complete", time: 2 }),
        JSON.stringify({
          type: "context.apply_compaction",
          tokensBefore: 50000,
          tokensAfter: 8000,
          compactedCount: 10,
          summary: "compacted context",
          time: 2,
        }),
      ].join("\n"),
    );
    expect(records[0]).toMatchObject({
      type: "full_compaction.begin",
      source: "manual",
      instruction: "keep the deployment facts",
    });
    expect(records[1]).toMatchObject({ type: "full_compaction.complete" });
    expect(records[2]).toMatchObject({
      type: "context.apply_compaction",
      tokensBefore: 50000,
      compactedCount: 10,
    });
  });

  it("parses tools.update_store, llm.request, permission.set_mode", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({
          type: "tools.update_store",
          key: "todo",
          value: [],
          time: 1,
        }),
        JSON.stringify({
          type: "llm.request",
          model: "kimi-k3",
          modelAlias: "custom-kimi/kimi-k3",
          thinkingEffort: "high",
          messageCount: 5,
          time: 2,
        }),
        JSON.stringify({ type: "permission.set_mode", mode: "yolo", time: 3 }),
      ].join("\n"),
    );
    expect(records[0]).toMatchObject({
      type: "tools.update_store",
      key: "todo",
    });
    expect(records[1]).toMatchObject({ type: "llm.request", model: "kimi-k3" });
    expect(records[2]).toMatchObject({
      type: "permission.set_mode",
      mode: "yolo",
    });
  });
});

describe("unknown record passthrough", () => {
  it("still passes through unrecognized record types", () => {
    const records = parseKimiWireJsonl(
      JSON.stringify({ type: "future.unknown.op", payload: "x", time: 1 }),
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "future.unknown.op",
      payload: "x",
    });
  });
});

// =============================================================================
// getKimiGoalTimeline — replays goal.* / forked into snapshot timeline.
// =============================================================================

describe("getKimiGoalTimeline", () => {
  it("returns an empty array when the wire has no goal records", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({ type: "metadata", protocol_version: "1.5" }),
        JSON.stringify({ type: "turn.prompt", input: [], time: 1 }),
      ].join("\n"),
    );
    expect(getKimiGoalTimeline(records)).toEqual([]);
  });

  it("emits a created snapshot on goal.create, then progress on updates", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({
          type: "goal.create",
          goalId: "g1",
          objective: "build feature X",
          wallClockResumedAt: 1000,
          time: 100,
        }),
        JSON.stringify({ type: "goal.update", turnsUsed: 1, time: 110 }),
        JSON.stringify({
          type: "goal.update",
          turnsUsed: 2,
          tokensUsed: 500,
          time: 120,
        }),
      ].join("\n"),
    );
    const timeline = getKimiGoalTimeline(records);
    // created + 2 progress updates (no trailing snapshot).
    expect(timeline).toHaveLength(3);
    expect(timeline[0]).toMatchObject({
      goalId: "g1",
      objective: "build feature X",
      status: "active",
      turnsUsed: 0,
      change: "created",
      time: 100,
    });
    expect(timeline[1]).toMatchObject({
      goalId: "g1",
      status: "active",
      turnsUsed: 1,
      change: "progress",
    });
    expect(timeline[2]).toMatchObject({
      goalId: "g1",
      turnsUsed: 2,
      tokensUsed: 500,
      change: "progress",
    });
  });

  it("classifies status transitions as status changes", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({
          type: "goal.create",
          goalId: "g1",
          objective: "obj",
          time: 1,
        }),
        JSON.stringify({
          type: "goal.update",
          status: "blocked",
          reason: "rate limit",
          time: 2,
        }),
        JSON.stringify({ type: "goal.update", status: "active", time: 3 }),
        JSON.stringify({
          type: "goal.update",
          status: "complete",
          reason: "done",
          time: 4,
        }),
      ].join("\n"),
    );
    const timeline = getKimiGoalTimeline(records);
    expect(timeline[1]).toMatchObject({
      status: "blocked",
      reason: "rate limit",
      change: "status",
    });
    // Reactivation clears the terminal reason.
    expect(timeline[2]).toMatchObject({ status: "active", change: "status" });
    expect(timeline[2]).not.toHaveProperty("reason");
    expect(timeline[3]).toMatchObject({
      status: "complete",
      reason: "done",
      change: "status",
    });
  });

  it("emits a cleared snapshot on goal.clear", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({
          type: "goal.create",
          goalId: "g1",
          objective: "obj",
          time: 1,
        }),
        JSON.stringify({ type: "goal.update", turnsUsed: 5, time: 2 }),
        JSON.stringify({ type: "goal.clear", time: 3 }),
      ].join("\n"),
    );
    const timeline = getKimiGoalTimeline(records);
    expect(timeline).toHaveLength(3);
    expect(timeline[2]).toMatchObject({
      goalId: "g1",
      objective: "obj",
      status: "cleared",
      turnsUsed: 5,
      change: "cleared",
      time: 3,
    });
  });

  it("emits a cleared snapshot on forked", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({
          type: "goal.create",
          goalId: "g1",
          objective: "obj",
          time: 1,
        }),
        JSON.stringify({ type: "forked", time: 2 }),
      ].join("\n"),
    );
    const timeline = getKimiGoalTimeline(records);
    expect(timeline).toHaveLength(2);
    expect(timeline[1]).toMatchObject({ status: "cleared", change: "cleared" });
  });

  it("keeps the last status when the goal is never cleared", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({
          type: "goal.create",
          goalId: "g1",
          objective: "obj",
          time: 1,
        }),
        JSON.stringify({
          type: "goal.update",
          status: "blocked",
          reason: "x",
          time: 2,
        }),
      ].join("\n"),
    );
    const timeline = getKimiGoalTimeline(records);
    // created + the status change — no trailing snapshot.
    expect(timeline).toHaveLength(2);
    const last = timeline[timeline.length - 1] ?? {};
    expect(last).toMatchObject({
      status: "blocked",
      reason: "x",
      change: "status",
    });
  });

  it("initializes create budgets empty and applies later budget updates", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({
          type: "goal.create",
          goalId: "g1",
          objective: "obj",
          budgetLimits: { turnBudget: 10 },
          time: 1,
        }),
        JSON.stringify({
          type: "goal.update",
          budgetLimits: { turnBudget: 20, tokenBudget: 100000 },
          time: 2,
        }),
      ].join("\n"),
    );
    const timeline = getKimiGoalTimeline(records);
    expect(timeline[0]).toMatchObject({
      budgetLimits: {},
      change: "created",
    });
    expect(timeline[1]).toMatchObject({
      budgetLimits: { turnBudget: 20, tokenBudget: 100000 },
      change: "budget",
    });
  });

  it("does not emit snapshots for exact no-op updates or same-status reasons", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({
          type: "goal.create",
          goalId: "g1",
          objective: "obj",
          time: 1,
        }),
        JSON.stringify({ type: "goal.update", time: 2 }),
        JSON.stringify({
          type: "goal.update",
          status: "active",
          reason: "must be ignored",
          time: 3,
        }),
      ].join("\n"),
    );
    expect(getKimiGoalTimeline(records)).toHaveLength(1);
  });

  it("ignores malformed known goal records that were preserved as raw data", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({ type: "goal.create", goalId: "missing-objective" }),
        JSON.stringify({
          type: "goal.create",
          goalId: "g1",
          objective: "obj",
          time: 1,
        }),
        JSON.stringify({ type: "goal.update", turnsUsed: -1, time: 2 }),
      ].join("\n"),
    );

    expect(getKimiGoalTimeline(records)).toEqual([
      expect.objectContaining({
        goalId: "g1",
        objective: "obj",
        change: "created",
      }),
    ]);
  });
});
