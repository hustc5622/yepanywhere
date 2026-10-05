import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { invalidateCodexSessionManifest } from "../../src/sessions/codex-session-manifest.js";

const timestamp = "2026-10-04T06:00:00.000Z";
const projectPath = "/test/subagent-history";

interface RawRecord {
  type: string;
  timestamp: string;
  ordinal?: number;
  payload: Record<string, unknown>;
}

function record(
  type: string,
  ordinal: number | undefined,
  payload: Record<string, unknown>,
): RawRecord {
  return {
    type,
    timestamp,
    ...(ordinal === undefined ? {} : { ordinal }),
    payload,
  };
}

function metadata(
  id: string,
  parentId?: string,
  boundary?: number,
  ordinal: number | undefined = 0,
): RawRecord {
  return record("session_meta", ordinal, {
    id,
    cwd: projectPath,
    timestamp,
    model_provider: "openai",
    history_mode: "paginated",
    ...(boundary === undefined
      ? {}
      : { subagent_history_start_ordinal: boundary }),
    ...(parentId
      ? {
          session_id: parentId,
          parent_thread_id: parentId,
          thread_source: "subagent",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: parentId,
                depth: 1,
                agent_path: `/root/${id}`,
              },
            },
          },
        }
      : { source: "cli" }),
  });
}

function message(
  ordinal: number | undefined,
  text: string,
  role: "user" | "assistant" = "assistant",
  phase: "commentary" | "final_answer" = "final_answer",
) {
  return record("response_item", ordinal, {
    type: "message",
    role,
    ...(role === "assistant" ? { phase } : {}),
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  });
}

function lifecycle(
  ordinal: number | undefined,
  type: "task_started" | "task_complete",
) {
  return record("event_msg", ordinal, { type, turn_id: "turn-1" });
}

function spawn(ordinal: number, agentId: string, callId: string) {
  return record("event_msg", ordinal, {
    type: "item_completed",
    turn_id: "turn-1",
    item: {
      type: "SubAgentActivity",
      id: callId,
      kind: "started",
      agent_thread_id: agentId,
      agent_path: `/root/child/${agentId}`,
    },
  });
}

describe("Codex subagent own-history boundary", () => {
  let sessionsDir: string;
  let reader: CodexSessionReader;
  let rootId: string;
  let childId: string;

  async function writeSession(id: string, records: RawRecord[]) {
    await writeFile(
      join(sessionsDir, `${id}.jsonl`),
      `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
  }

  beforeEach(async () => {
    sessionsDir = join(tmpdir(), `codex-subagent-own-history-${randomUUID()}`);
    await mkdir(sessionsDir, { recursive: true });
    rootId = randomUUID();
    childId = randomUUID();
    reader = new CodexSessionReader({ sessionsDir, projectPath });
    await writeSession(rootId, [
      metadata(rootId),
      message(1, "Root prompt", "user"),
    ]);
  });

  afterEach(async () => {
    invalidateCodexSessionManifest(sessionsDir);
    await rm(sessionsDir, { recursive: true, force: true });
  });

  it.each(["direct", "tree"])(
    "%s reads exclude copied parent prompts, final replies and nested records",
    async (endpoint) => {
      const inheritedAgent = randomUUID();
      const ownAgent = randomUUID();
      await writeSession(childId, [
        metadata(childId, rootId, 34),
        // The later metadata is copied context; its different boundary must
        // never replace the canonical first child's boundary.
        metadata(rootId, undefined, 2, 1),
        message(2, "Inherited parent prompt", "user"),
        message(3, "Inherited parent final answer"),
        lifecycle(4, "task_complete"),
        spawn(5, inheritedAgent, "inherited-parent-spawn"),
        lifecycle(34, "task_started"),
        message(35, "Own child prompt", "user"),
        message(36, "Own child progress", "assistant", "commentary"),
        spawn(40, ownAgent, "own-child-spawn"),
        message(41, "Own child final answer"),
        lifecycle(42, "task_complete"),
      ]);

      const result =
        endpoint === "direct"
          ? await reader.getAgentSession(childId, rootId)
          : await reader.getAgentSessionInTree(childId, rootId);

      expect(result).not.toBeNull();
      const transcript = JSON.stringify(result?.messages);
      for (const text of [
        "Own child prompt",
        "Own child progress",
        "Own child final answer",
      ]) {
        expect(transcript).toContain(text);
      }
      for (const text of [
        "Inherited parent prompt",
        "Inherited parent final answer",
        "inherited-parent-spawn",
        inheritedAgent,
      ]) {
        expect(transcript).not.toContain(text);
      }
      expect(
        result?.messages.filter(
          (entry) => entry.subtype === "codex_native_item",
        ),
      ).toEqual([
        expect.objectContaining({
          codexThreadItem: expect.objectContaining({
            id: "own-child-spawn",
            agentThreadId: ownAgent,
          }),
        }),
      ]);
      expect(result?.status).toBe("completed");
      expect(result?.descriptor?.parentAgentId).toBe(rootId);
      expect(result?.hasInheritedContext).toBe(true);
      expect(result).not.toHaveProperty("inheritedMessages");

      // Context is the snapshot copied into the child, not the parent's
      // current transcript, which may have continued since the fork.
      await writeSession(rootId, [
        metadata(rootId),
        message(1, "Current parent changed after the child fork", "user"),
      ]);
      const expanded =
        endpoint === "direct"
          ? await reader.getAgentSession(childId, rootId, {
              includeInheritedContext: true,
            })
          : await reader.getAgentSessionInTree(childId, rootId, {
              includeInheritedContext: true,
            });
      expect(expanded?.messages).toEqual(result?.messages);
      expect(expanded?.status).toBe(result?.status);
      expect(expanded?.descriptor).toEqual(result?.descriptor);
      expect(expanded?.hasInheritedContext).toBe(true);
      const inheritedTranscript = JSON.stringify(expanded?.inheritedMessages);
      expect(inheritedTranscript).toContain("Inherited parent prompt");
      expect(inheritedTranscript).toContain("Inherited parent final answer");
      expect(inheritedTranscript).toContain("inherited-parent-spawn");
      expect(inheritedTranscript).not.toContain("Own child");
      expect(inheritedTranscript).not.toContain("Current parent changed");
    },
  );

  it("does not inherit the parent's completed status or final answer before the child starts", async () => {
    await writeSession(childId, [
      metadata(childId, rootId, 34),
      metadata(rootId, undefined, 1, 1),
      message(2, "Parent task", "user"),
      message(32, "Parent is done"),
      lifecycle(33, "task_complete"),
    ]);

    for (const result of [
      await reader.getAgentSession(childId, rootId),
      await reader.getAgentSessionInTree(childId, rootId),
    ]) {
      expect(result).toMatchObject({
        messages: [],
        status: "running",
        descriptor: { status: "running" },
      });
    }
  });

  it("uses raw ordinals across gaps and unknown records, not parsed array positions or timestamps", async () => {
    await writeSession(childId, [
      metadata(childId, rootId, 34),
      metadata(rootId, undefined, 90, 1),
      message(10, "Copied parent text must stay hidden"),
      record("future_rollout_record", 20, { unknown: "inherited" }),
      record("future_rollout_record", 33, { unknown: "last inherited record" }),
      record("future_rollout_record", 34, { unknown: "first own record" }),
      lifecycle(39, "task_started"),
      message(48, "Own reply survives skipped raw records"),
      lifecycle(71, "task_complete"),
    ]);

    const result = await reader.getAgentSessionInTree(childId, rootId);
    expect(result).not.toBeNull();
    expect(JSON.stringify(result?.messages)).toContain(
      "Own reply survives skipped raw records",
    );
    expect(JSON.stringify(result?.messages)).not.toContain(
      "Copied parent text must stay hidden",
    );
    expect(result?.messages).toHaveLength(1);
    expect(result?.status).toBe("completed");
  });

  it("preserves legacy history without a canonical boundary even if copied metadata has one", async () => {
    const legacyMetadata = metadata(childId, rootId);
    Reflect.deleteProperty(legacyMetadata, "ordinal");
    legacyMetadata.payload.history_mode = "legacy";
    await writeSession(childId, [
      legacyMetadata,
      metadata(rootId, undefined, 90, 1),
      message(undefined, "Legacy child prompt", "user"),
      message(undefined, "Legacy child answer"),
      lifecycle(undefined, "task_complete"),
    ]);

    const result = await reader.getAgentSession(childId, rootId);
    expect(result).not.toBeNull();
    expect(JSON.stringify(result?.messages)).toContain("Legacy child prompt");
    expect(JSON.stringify(result?.messages)).toContain("Legacy child answer");
    expect(result?.status).toBe("completed");
    expect(result?.hasInheritedContext).toBe(false);
    expect(result).not.toHaveProperty("inheritedMessages");
    const expanded = await reader.getAgentSession(childId, rootId, {
      includeInheritedContext: true,
    });
    expect(expanded?.messages).toEqual(result?.messages);
    expect(expanded?.inheritedMessages).toEqual([]);
    expect(expanded?.hasInheritedContext).toBe(false);
  });

  it("does not advertise inherited context made only of metadata and empty content", async () => {
    await writeSession(childId, [
      metadata(childId, rootId, 8),
      metadata(rootId, undefined, undefined, 1),
      record("turn_context", 2, { cwd: projectPath, approval_policy: "never" }),
      record("response_item", 3, {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Internal setup" }],
      }),
      message(4, "   ", "user"),
      record("response_item", 5, { type: "reasoning", summary: [] }),
      record("event_msg", 6, { type: "token_count" }),
      lifecycle(8, "task_started"),
      message(9, "Own reply"),
    ]);
    const collapsed = await reader.getAgentSessionInTree(childId, rootId);
    expect(collapsed?.hasInheritedContext).toBe(false);
    expect(collapsed).not.toHaveProperty("inheritedMessages");
    const expanded = await reader.getAgentSessionInTree(childId, rootId, {
      includeInheritedContext: true,
    });
    expect(expanded?.inheritedMessages).toEqual([]);
    expect(expanded?.messages).toEqual(collapsed?.messages);
    expect(expanded?.status).toBe("running");
  });

  it("ignores inherited spawn mappings even when their targets are valid manifest children", async () => {
    const inheritedOnlyId = randomUUID();
    const ownGrandchildId = randomUUID();
    await writeSession(inheritedOnlyId, [metadata(inheritedOnlyId, childId)]);
    await writeSession(ownGrandchildId, [metadata(ownGrandchildId, childId)]);
    await writeSession(childId, [
      metadata(childId, rootId, 34),
      metadata(rootId, undefined, 1, 1),
      spawn(12, inheritedOnlyId, "inherited-spawn-call"),
      spawn(34, ownGrandchildId, "own-spawn-call"),
    ]);

    await expect(reader.getAgentMappings(childId)).resolves.toEqual([
      { toolUseId: "own-spawn-call", agentId: ownGrandchildId },
    ]);
    const inheritedOnly = await reader.getAgentSession(
      inheritedOnlyId,
      childId,
    );
    expect(inheritedOnly).not.toBeNull();
    expect(inheritedOnly?.descriptor?.parentToolUseId).toBeUndefined();
    expect(
      (await reader.getAgentSession(ownGrandchildId, childId))?.descriptor
        ?.parentToolUseId,
    ).toBe("own-spawn-call");
  });

  it("refuses boundary-bearing history with a missing ordinal instead of showing inherited data", async () => {
    const grandchildId = randomUUID();
    await writeSession(grandchildId, [metadata(grandchildId, childId)]);
    await writeSession(childId, [
      metadata(childId, rootId, 34),
      metadata(rootId, undefined, 1, 1),
      message(undefined, "Parent text with an unknown position"),
      spawn(35, grandchildId, "spawn-after-invalid-record"),
      message(36, "Own child answer"),
    ]);

    await expect(reader.getAgentSession(childId, rootId)).resolves.toBeNull();
    await expect(
      reader.getAgentSessionInTree(childId, rootId),
    ).resolves.toBeNull();
    await expect(reader.getAgentMappings(childId)).resolves.toEqual([]);
  });
});
