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
