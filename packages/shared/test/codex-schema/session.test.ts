import { describe, expect, it } from "vitest";
import {
  CodexSessionEntrySchema,
  parseCodexSessionEntry,
} from "../../src/codex-schema/session.js";

describe("Codex patch lifecycle session schema", () => {
  it("parses the persisted patch_apply_end shape emitted by Codex CLI", () => {
    const raw = {
      timestamp: "2026-08-03T07:18:18.102Z",
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        call_id: "exec-patch-1",
        turn_id: "turn-1",
        stdout: "Success. Updated the following files:\nM /repo/src/a.ts\n",
        stderr: "",
        success: true,
        changes: {
          "/repo/src/a.ts": {
            type: "update",
            unified_diff: "@@ -1 +1 @@\n-old\n+new\n",
            move_path: null,
          },
        },
        status: "completed",
      },
    };

    const parsed = CodexSessionEntrySchema.parse(raw);

    expect(parsed).toEqual(raw);
    expect(parseCodexSessionEntry(JSON.stringify(raw))).toEqual(raw);
  });

  it("keeps partially written completion records readable", () => {
    const parsed = CodexSessionEntrySchema.parse({
      timestamp: "2026-08-03T07:18:18.102Z",
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        call_id: "exec-patch-interrupted",
        success: true,
        changes: {},
      },
    });

    expect(parsed).toMatchObject({
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        call_id: "exec-patch-interrupted",
        success: true,
      },
    });
  });
});

describe("Codex collaboration session schema", () => {
  it("parses stable spawn and sub-agent activity events", () => {
    const events = [
      {
        timestamp: "2026-08-08T01:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "collab_agent_spawn_begin",
          call_id: "call-1",
          sender_thread_id: "parent",
          prompt: "internal child prompt",
          model: "gpt-5.6",
          reasoning_effort: "high",
        },
      },
      {
        timestamp: "2026-08-08T01:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "collab_agent_spawn_end",
          call_id: "call-1",
          sender_thread_id: "parent",
          new_thread_id: "child",
          new_agent_nickname: "Scout",
          new_agent_role: "explorer",
          prompt: "internal child prompt",
          model: "gpt-5.6",
          reasoning_effort: "high",
          status: { completed: null },
        },
      },
      {
        timestamp: "2026-08-08T01:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "sub_agent_activity",
          event_id: "activity-1",
          agent_thread_id: "child",
          agent_path: "/test-fixtures/codex/agents/scout",
          kind: "started",
        },
      },
    ] as const;

    for (const event of events) {
      expect(CodexSessionEntrySchema.parse(event)).toEqual(event);
      expect(parseCodexSessionEntry(JSON.stringify(event))).toEqual(event);
    }
  });
});

describe("Codex local media session schema", () => {
  it("retains pinned input_audio rollout blocks for public normalization", () => {
    const raw = {
      timestamp: "2026-08-08T01:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: '<audio name=[Audio #1] path="/test/private/voice.wav">',
          },
          {
            type: "input_audio",
            audio_url: "data:audio/wav;base64,YXVkaW8=",
          },
          { type: "input_text", text: "</audio>" },
        ],
      },
    } as const;

    expect(CodexSessionEntrySchema.parse(raw)).toEqual(raw);
    expect(parseCodexSessionEntry(JSON.stringify(raw))).toEqual(raw);
  });
});
