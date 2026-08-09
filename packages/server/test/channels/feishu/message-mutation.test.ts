import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FeishuMessageMutationStore } from "../../../src/channels/feishu/message-mutation-store.js";
import {
  FEISHU_MESSAGE_MUTATION_CAPABILITIES,
  normalizeFeishuMessageMutation,
  observeFeishuMessageRevision,
} from "../../../src/channels/feishu/message-mutation.js";

describe("Feishu message mutations", () => {
  const dataDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dataDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("does not materialize mutation state before the first official event", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-mutations-"));
    dataDirs.push(dataDir);
    const store = new FeishuMessageMutationStore({ dataDir });
    await store.initialize();

    await expect(access(store.filePath)).rejects.toThrow();
    await store.apply("account-fixture", {
      version: 1,
      eventId: "event-fixture",
      eventType: "im.message.recalled_v1",
      messageId: "message-fixture",
      kind: "recalled",
      occurredAtMs: 1_786_063_200_000,
      source: "event",
      recallType: "message_owner",
    });
    await expect(access(store.filePath)).resolves.toBeUndefined();
  });

  it("documents edit as a read observation and parses official recall events", () => {
    expect(FEISHU_MESSAGE_MUTATION_CAPABILITIES.edit).toMatchObject({
      support: "opportunistic_read_observation",
      eventType: null,
      observationTrigger: "message_receive_or_recovery_payload",
      scheduledPolling: false,
    });
    expect(
      observeFeishuMessageRevision({
        event_id: "receive-event-is-not-used-as-mutation-id",
        sender: { sender_id: { open_id: "ou_actor" } },
        message: {
          message_id: "om_message",
          create_time: "1000",
          update_time: "2000",
          is_updated: true,
        },
      }),
    ).toMatchObject({
      eventType: "im.message.edit_observed_v1",
      messageId: "om_message",
      kind: "edited",
      occurredAtMs: 2000,
      source: "message_read_observation",
      actor: { id: "ou_actor" },
    });

    expect(
      normalizeFeishuMessageMutation("im.message.recalled_v1", {
        event_id: "evt_recall",
        message_id: "om_message",
        recall_time: "3000",
        recall_type: "message_owner",
      }),
    ).toEqual({
      version: 1,
      eventId: "evt_recall",
      eventType: "im.message.recalled_v1",
      messageId: "om_message",
      kind: "recalled",
      occurredAtMs: 3000,
      source: "event",
      recallType: "message_owner",
    });
  });

  it("reduces reaction add/remove, recall and duplicate replay durably", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-mutations-"));
    dataDirs.push(dataDir);
    const store = new FeishuMessageMutationStore({ dataDir });
    await store.initialize();
    const added = normalizeFeishuMessageMutation(
      "im.message.reaction.created_v1",
      {
        event_id: "evt_reaction_add",
        message_id: "om_message",
        reaction_type: { emoji_type: "THUMBSUP" },
        operator_type: "user",
        user_id: { open_id: "ou_actor" },
        action_time: "2100",
      },
    );
    if (!added) throw new Error("reaction fixture did not normalize");

    expect(await store.apply("mini", added)).toMatchObject({
      applied: true,
      state: {
        revision: 1,
        reactions: [{ emojiType: "THUMBSUP", actorId: "ou_actor" }],
      },
    });
    expect(await store.apply("mini", added)).toMatchObject({
      applied: false,
      state: { revision: 1 },
    });
    expect(await store.apply("second-bot", added)).toMatchObject({
      applied: true,
      state: { accountId: "second-bot", revision: 1 },
    });

    const removed = normalizeFeishuMessageMutation(
      "im.message.reaction.deleted_v1",
      {
        event_id: "evt_reaction_remove",
        message_id: "om_message",
        reaction_type: { emoji_type: "THUMBSUP" },
        operator_type: "user",
        user_id: { open_id: "ou_actor" },
        action_time: "2200",
      },
    );
    if (!removed) throw new Error("reaction fixture did not normalize");
    await store.apply("mini", removed);
    await store.apply("mini", {
      version: 1,
      eventId: "evt_recall",
      eventType: "im.message.recalled_v1",
      messageId: "om_message",
      kind: "recalled",
      occurredAtMs: 2300,
      source: "event",
      recallType: "message_owner",
    });

    const reopened = new FeishuMessageMutationStore({ dataDir });
    await reopened.initialize();
    expect(reopened.getState("mini", "om_message")).toMatchObject({
      revision: 3,
      recalledAtMs: 2300,
      recallType: "message_owner",
      reactions: [],
    });
    expect(JSON.stringify(reopened.listEvents())).not.toContain("token");
    if (process.platform !== "win32") {
      expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("fails closed for malformed or unrelated mutation payloads", () => {
    expect(
      normalizeFeishuMessageMutation("im.message.recalled_v1", {
        message_id: "om_message",
        recall_time: "not-a-time",
      }),
    ).toBeUndefined();
    expect(
      normalizeFeishuMessageMutation("im.message.edited_v1", {
        message_id: "om_message",
      }),
    ).toBeUndefined();
    expect(
      observeFeishuMessageRevision({
        message: {
          message_id: "om_message",
          create_time: "2000",
          update_time: "2000",
        },
      }),
    ).toBeUndefined();
  });
});
