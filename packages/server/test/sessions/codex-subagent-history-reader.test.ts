import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeCodexInterAgentMessages } from "../../src/codex/inter-agent-message.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { invalidateCodexSessionManifest } from "../../src/sessions/codex-session-manifest.js";
import type { Message } from "../../src/supervisor/types.js";

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

function mailbox(
  ordinal: number,
  id: string,
  sender: string,
  recipient: string,
  kind: "NEW_TASK" | "MESSAGE" | "FINAL_ANSWER",
  text: string,
  encrypted = false,
) {
  return record("response_item", ordinal, {
    type: "agent_message",
    id,
    author: sender,
    recipient,
    internal_chat_message_metadata_passthrough: {
      turn_id: `turn-${recipient}`,
    },
    content: [
      {
        type: "input_text",
        text: `Message Type: ${kind}\nTask name: ${recipient}\nSender: ${sender}\nPayload:\n${encrypted ? "" : text}`,
      },
      ...(encrypted
        ? [{ type: "encrypted_content", encrypted_content: text }]
        : []),
    ],
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

  it("keeps inherited mailbox context separate from the child's own task and reads encrypted prompts safely", async () => {
    const mailbox = (ordinal: number, id: string, encrypted: boolean) =>
      record("response_item", ordinal, {
        type: "agent_message",
        id,
        author: "/root",
        recipient: "/root/review",
        internal_chat_message_metadata_passthrough: { turn_id: "child-turn" },
        content: [
          {
            type: "input_text",
            text: `Message Type: NEW_TASK\nTask name: /root/review\nSender: /root\nPayload:\n${encrypted ? "" : "Inherited task"}`,
          },
          ...(encrypted
            ? [{ type: "encrypted_content", encrypted_content: "never-public" }]
            : []),
        ],
      });
    await writeSession(childId, [
      metadata(childId, rootId, 10),
      mailbox(2, "inherited-task", false),
      mailbox(10, "own-task", true),
    ]);
    const result = await reader.getAgentSession(childId, rootId, {
      includeInheritedContext: true,
    });
    expect(result?.hasInheritedContext).toBe(true);
    expect(result?.messages.map((entry) => entry.codexThreadItemId)).toEqual([
      "own-task",
    ]);
    expect(
      result?.inheritedMessages?.map((entry) => entry.codexThreadItemId),
    ).toEqual(["inherited-task"]);
    expect(result?.messages[0]?.codexThreadItem).toMatchObject({
      kind: "task",
      encrypted: true,
    });
    expect(JSON.stringify(result)).not.toContain("never-public");
  });

  it("preserves mailbox rows in bounded root reads and supplements only the matching native turn", async () => {
    const resultEntry = (ordinal: number, id: string, turnId: string) =>
      record("response_item", ordinal, {
        type: "agent_message",
        id,
        author: "/root/review",
        recipient: "/root",
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
        content: [
          {
            type: "input_text",
            text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/review\nPayload:\nReview passed",
          },
        ],
      });
    const user = message(1, "Review and then commit", "user");
    Object.assign(user.payload, {
      id: "user-1",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
    });
    const final = message(3, "Committed");
    Object.assign(final.payload, {
      id: "final-1",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
    });
    const records = [
      metadata(rootId),
      user,
      resultEntry(2, "result-1", "turn-1"),
      final,
      resultEntry(4, "another-result", "another-turn"),
    ];
    await writeSession(rootId, records);
    const loaded = await reader.getSession(
      rootId,
      "project" as UrlProjectId,
      undefined,
      { maxMessages: 10 },
    );
    expect(
      loaded?.projectedMessages
        ?.filter((entry) => entry.subtype === "codex_native_item")
        .map((entry) => entry.codexThreadItemId),
    ).toEqual(["result-1", "another-result"]);
    const supplements = await reader.getInterAgentMessages(
      rootId,
      ["turn-1"],
      ["user-1", "final-1"],
    );
    expect(supplements).toHaveLength(1);
    expect(supplements[0]).toMatchObject({
      beforeItemId: "final-1",
      afterItemId: "user-1",
      message: { codexTurnId: "turn-1", codexThreadItemId: "result-1" },
    });
    const firstRevision = await reader.getInterAgentRevision(rootId);
    await writeSession(rootId, [
      ...records,
      resultEntry(5, "result-2", "turn-1"),
    ]);
    expect(await reader.getInterAgentRevision(rootId)).not.toBe(firstRevision);
    expect(
      (
        await reader.getInterAgentMessages(
          rootId,
          ["turn-1"],
          ["user-1", "final-1"],
        )
      ).map((row) => row.message.codexThreadItemId),
    ).toEqual(["result-1", "result-2"]);
  });

  it("keeps mailbox boundaries outside the requested page and emits each message on one page", async () => {
    const native = (ordinal: number, id: string, user = false) =>
      record("event_msg", ordinal, {
        type: "item_completed",
        turn_id: "turn-1",
        item: {
          type: user ? "UserMessage" : "AgentMessage",
          id,
          content: [{ type: user ? "text" : "Text", text: id }],
          ...(user ? {} : { phase: "commentary" }),
        },
      });
    const mail = (ordinal: number, id: string) => {
      const entry = mailbox(
        ordinal,
        id,
        "/root/review",
        "/root",
        "MESSAGE",
        id,
      );
      entry.payload.internal_chat_message_metadata_passthrough = {
        turn_id: "turn-1",
      };
      return entry;
    };
    await writeSession(rootId, [
      metadata(rootId),
      lifecycle(1, "task_started"),
      mail(2, "head-mail"),
      native(3, "user", true),
      native(4, "before"),
      mail(5, "boundary-mail"),
      // Raw response ids need not exist in the native history index.
      record("response_item", 6, {
        type: "message",
        id: "raw-only",
        role: "assistant",
        content: [{ type: "output_text", text: "Native item follows" }],
      }),
      native(7, "after"),
      native(8, "last"),
      mail(9, "tail-mail"),
    ]);

    const pages = [["user", "before"], ["after"], ["last"]];
    const merged: Message[][] = [];
    for (const ids of pages) {
      const supplements = await reader.getInterAgentMessages(
        rootId,
        ["turn-1"],
        ids,
      );
      expect(
        supplements.map(({ message, beforeItemId, afterItemId }) => [
          message.codexThreadItemId,
          beforeItemId,
          afterItemId,
        ]),
      ).toEqual([
        ["head-mail", "user", undefined],
        ["boundary-mail", "after", "before"],
        ["tail-mail", undefined, "last"],
      ]);
      merged.push(
        mergeCodexInterAgentMessages(
          ids.map((id) => ({
            uuid: id,
            type: id === "user" ? "user" : "assistant",
            codexTurnId: "turn-1",
            codexThreadItemId: id,
          })),
          supplements,
          false,
        ),
      );
    }
    expect(
      merged.map((page) => page.map((item) => item.codexThreadItemId)),
    ).toEqual([
      ["head-mail", "user", "before"],
      ["boundary-mail", "after"],
      ["last", "tail-mail"],
    ]);
  });

  it("recovers followup operation metadata missing from canonical subagent activity", async () => {
    await writeSession(rootId, [
      metadata(rootId),
      record("response_item", 1, {
        type: "function_call",
        name: "followup_task",
        namespace: "collaboration",
        call_id: "followup-1",
        arguments: '{"target":"/root/review","message":"Check once more"}',
      }),
      record("event_msg", 2, {
        type: "item_completed",
        turn_id: "turn-2",
        item: {
          type: "SubAgentActivity",
          id: "followup-1",
          kind: "interacted",
          agent_thread_id: childId,
          agent_path: "/root/review",
        },
      }),
    ]);
    const rows = await reader.getInterAgentMessages(
      rootId,
      ["turn-2"],
      ["followup-1"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      updateOnly: true,
      message: {
        codexTurnId: "turn-2",
        codexThreadItemId: "followup-1",
        codexThreadItem: { kind: "interacted", operation: "followup_task" },
      },
    });
  });

  it("shows the child's delivered parent and peer messages once, without parent prose or inherited copies", async () => {
    const peerId = randomUUID();
    const unrelatedRoot = randomUUID();
    const sender = `/root/${childId}`;
    const result = mailbox(
      3,
      "result",
      sender,
      "/root",
      "FINAL_ANSWER",
      "Review passed",
    );
    const parentRecords = [
      metadata(rootId),
      message(1, "Parent's own ordinary answer"),
      mailbox(
        2,
        "progress",
        sender,
        "/root",
        "MESSAGE",
        "secret-progress-cipher",
        true,
      ),
      result,
      { ...result, ordinal: 4 },
      mailbox(
        5,
        "other-agent",
        "/root/other",
        "/root",
        "MESSAGE",
        "Other agent's result",
      ),
    ];
    await writeSession(rootId, parentRecords);
    await writeSession(childId, [
      metadata(childId, rootId, 10),
      message(2, "Inherited parent context"),
      mailbox(
        10,
        "initial-task",
        "/root",
        sender,
        "NEW_TASK",
        "secret-task-cipher",
        true,
      ),
      message(11, "Child execution and own final"),
      lifecycle(12, "task_complete"),
    ]);
    await writeSession(peerId, [
      metadata(peerId, rootId, 10),
      mailbox(
        2,
        "inherited-peer-copy",
        sender,
        `/root/${peerId}`,
        "MESSAGE",
        "Do not include inherited peer copy",
      ),
      mailbox(
        10,
        "peer-delivery",
        sender,
        `/root/${peerId}`,
        "MESSAGE",
        "Check your parser too",
      ),
    ]);
    await writeSession(unrelatedRoot, [
      metadata(unrelatedRoot),
      mailbox(
        1,
        "unrelated-root",
        sender,
        "/root",
        "MESSAGE",
        "Unrelated root must stay private",
      ),
    ]);

    const session = await reader.getAgentSessionInTree(childId, rootId, {
      includeInheritedContext: true,
    });
    const communications = session?.messages.filter(
      (entry) => entry.subtype === "codex_native_item",
    );
    expect(communications?.map((entry) => entry.codexThreadItemId)).toEqual([
      "initial-task",
      "progress",
      "result",
      "peer-delivery",
    ]);
    expect(
      communications?.find((entry) => entry.codexThreadItemId === "result"),
    ).toMatchObject({
      codexThreadId: rootId,
      codexThreadItem: {
        sender,
        recipient: "/root",
        kind: "result",
        text: "Review passed",
      },
    });
    expect(
      communications?.find((entry) => entry.codexThreadItemId === "progress")
        ?.codexThreadItem,
    ).toMatchObject({ encrypted: true });
    const visible = JSON.stringify(session?.messages);
    for (const hidden of [
      "Parent's own ordinary answer",
      "Other agent's result",
      "Inherited parent context",
      "inherited-peer-copy",
      "Unrelated root",
      "secret-task-cipher",
      "secret-progress-cipher",
    ])
      expect(visible).not.toContain(hidden);
    expect(JSON.stringify(session?.inheritedMessages)).toContain(
      "Inherited parent context",
    );
    expect(session?.status).toBe("completed");

    await writeSession(rootId, [
      ...parentRecords,
      mailbox(
        6,
        "later-delivery",
        sender,
        "/root",
        "MESSAGE",
        "Another update",
      ),
    ]);
    const refreshed = await reader.getAgentSessionInTree(childId, rootId);
    expect(
      refreshed?.messages.filter(
        (entry) => entry.codexThreadItemId === "later-delivery",
      ),
    ).toHaveLength(1);
  });

  it("limits outgoing message collection to the authorized subtree for nested agents", async () => {
    const nestedId = randomUUID();
    const sender = `/root/${nestedId}`;
    await writeSession(childId, [
      metadata(childId, rootId),
      mailbox(
        1,
        "to-parent",
        sender,
        `/root/${childId}`,
        "MESSAGE",
        "Direct parent message",
      ),
    ]);
    await writeSession(nestedId, [
      metadata(nestedId, childId),
      mailbox(1, "task", `/root/${childId}`, sender, "NEW_TASK", "Nested task"),
    ]);
    await writeSession(rootId, [
      metadata(rootId),
      mailbox(1, "to-root", sender, "/root", "MESSAGE", "Root message"),
    ]);
    const fullTree = await reader.getAgentSessionInTree(nestedId, rootId);
    expect(fullTree?.messages.map((entry) => entry.codexThreadItemId)).toEqual([
      "task",
      "to-root",
      "to-parent",
    ]);
    const subtree = await reader.getAgentSessionInTree(nestedId, childId);
    expect(subtree?.messages.map((entry) => entry.codexThreadItemId)).toEqual([
      "task",
      "to-parent",
    ]);
    await expect(
      reader.getAgentSessionInTree(nestedId, randomUUID()),
    ).resolves.toBeNull();
  });

  it("does not attribute reused agent-path messages from earlier or later incarnations to this child", async () => {
    const laterId = randomUUID();
    const sender = `/root/${childId}`;
    const childMetadata = metadata(childId, rootId);
    childMetadata.payload.timestamp = "2026-10-04T06:10:00.000Z";
    const laterMetadata = metadata(laterId, rootId);
    laterMetadata.payload.timestamp = "2026-10-04T06:30:00.000Z";
    laterMetadata.payload.agent_path = sender;
    laterMetadata.payload.source = {
      subagent: {
        thread_spawn: {
          parent_thread_id: rootId,
          depth: 1,
          agent_path: sender,
        },
      },
    };
    await writeSession(childId, [childMetadata, message(1, "Own answer")]);
    await writeSession(laterId, [laterMetadata]);
    const prior = mailbox(
      1,
      "prior",
      sender,
      "/root",
      "FINAL_ANSWER",
      "Prior task",
    );
    const own = mailbox(
      2,
      "own",
      sender,
      "/root",
      "FINAL_ANSWER",
      "Current task",
    );
    own.timestamp = "2026-10-04T06:20:00.000Z";
    const later = mailbox(
      3,
      "later",
      sender,
      "/root",
      "FINAL_ANSWER",
      "Later task",
    );
    later.timestamp = "2026-10-04T06:40:00.000Z";
    await writeSession(rootId, [metadata(rootId), prior, own, later]);
    const session = await reader.getAgentSessionInTree(childId, rootId);
    expect(
      session?.messages
        .filter((entry) => entry.subtype === "codex_native_item")
        .map((entry) => entry.codexThreadItemId),
    ).toEqual(["own"]);
  });

  it("supplements canonical wait timing and outcome from the matching raw call", async () => {
    const call = record("response_item", 2, {
      type: "function_call",
      name: "wait_agent",
      namespace: "collaboration",
      call_id: "wait-1",
      arguments: '{"timeout_ms":120000}',
    });
    const finished = record("response_item", 3, {
      type: "function_call_output",
      call_id: "wait-1",
      output: '{"message":"Wait completed. Agent returned a result."}',
    });
    finished.timestamp = "2026-10-04T06:00:03.000Z";
    await writeSession(rootId, [
      metadata(rootId),
      lifecycle(1, "task_started"),
      call,
      finished,
    ]);
    const rows = await reader.getInterAgentMessages(
      rootId,
      ["turn-1"],
      ["wait-1"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      updateOnly: true,
      message: {
        codexThreadItem: {
          type: "agentWait",
          id: "wait-1",
          status: "completed",
          durationMs: 3000,
          outcome: "message",
        },
      },
    });
  });

  it("stops a canonical wait when its turn aborts without a tool output", async () => {
    await writeSession(rootId, [
      metadata(rootId),
      lifecycle(1, "task_started"),
      record("response_item", 2, {
        type: "function_call",
        name: "wait_agent",
        call_id: "interrupted-wait",
        arguments: '{"timeout_ms":120000}',
      }),
      record("event_msg", 3, { type: "turn_aborted", turn_id: "turn-1" }),
    ]);
    const rows = await reader.getInterAgentMessages(
      rootId,
      ["turn-1"],
      ["interrupted-wait"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      updateOnly: true,
      message: {
        codexThreadItemLifecycle: "completed",
        codexThreadItem: {
          type: "agentWait",
          id: "interrupted-wait",
          status: "interrupted",
        },
      },
    });
  });
});
