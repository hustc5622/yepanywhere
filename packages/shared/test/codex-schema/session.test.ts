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

describe("Codex user-message identity schema", () => {
  it("retains the client id echoed by the persisted legacy event", () => {
    const raw = {
      timestamp: "2026-08-27T09:31:11.198Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        client_id: "client-message-1",
        message: "Inspect the screenshot",
        images: [],
      },
    } as const;

    expect(CodexSessionEntrySchema.parse(raw)).toEqual(raw);
    expect(parseCodexSessionEntry(JSON.stringify(raw))).toEqual(raw);
  });
});

describe("Codex terminal turn session schema", () => {
  it("preserves task_complete error details for status derivation", () => {
    const raw = {
      timestamp: "2026-08-13T01:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-failed",
        last_agent_message: null,
        error: { message: "provider failed", codexErrorInfo: "rateLimit" },
      },
    } as const;

    expect(CodexSessionEntrySchema.parse(raw)).toEqual(raw);
    expect(parseCodexSessionEntry(JSON.stringify(raw))).toEqual(raw);
  });
});
