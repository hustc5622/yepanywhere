import { describe, expect, it } from "vitest";
import {
  buildCodexEditInput,
  formatCodexFileChangeResult,
  isCodexFileChangeError,
  normalizeCodexFileChangeStatus,
  normalizeCodexFileChanges,
} from "../../src/codex/file-change.js";

describe("Codex file change normalization", () => {
  it("projects rollout and app-server changes into one canonical shape", () => {
    const unifiedDiff = "@@ -1 +1 @@\n-old\n+new\n";
    const movedDiff = `${unifiedDiff}\n\nMoved to: /repo/src/c.ts`;
    const persisted = normalizeCodexFileChanges({
      "/repo/src/b.ts": {
        type: "update",
        unified_diff: unifiedDiff,
        move_path: "/repo/src/c.ts",
      },
      "/repo/src/a.ts": {
        type: "add",
        content: "export const value = 1;\n",
      },
    });
    const appServer = normalizeCodexFileChanges([
      {
        path: "/repo/src/b.ts",
        kind: { type: "update", move_path: "/repo/src/c.ts" },
        diff: movedDiff,
      },
      {
        path: "/repo/src/a.ts",
        kind: "add",
        diff: "export const value = 1;\n",
      },
    ]);

    expect(persisted).toEqual(appServer);
    expect(persisted).toEqual([
      {
        path: "/repo/src/a.ts",
        kind: "add",
        diff: "export const value = 1;\n",
      },
      {
        path: "/repo/src/b.ts",
        kind: "update",
        diff: movedDiff,
      },
    ]);
    expect(buildCodexEditInput(persisted)).toEqual({ changes: persisted });
  });

  it("normalizes completion status and error semantics", () => {
    expect(normalizeCodexFileChangeStatus("inProgress")).toBe("in_progress");
    expect(normalizeCodexFileChangeStatus("completed", false)).toBe(
      "completed",
    );
    expect(normalizeCodexFileChangeStatus(undefined, true)).toBe("completed");
    expect(normalizeCodexFileChangeStatus(undefined, false)).toBe("failed");
    expect(isCodexFileChangeError("declined")).toBe(true);
    expect(
      formatCodexFileChangeResult(
        [{ path: "src/a.ts", kind: "update" }],
        "failed",
      ),
    ).toBe("File changes failed:\nupdate: src/a.ts");
  });
});
