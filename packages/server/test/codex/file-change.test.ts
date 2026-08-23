import { describe, expect, it } from "vitest";
import {
  buildCodexEditInput,
  formatCodexFileChangeResult,
  isCodexFileChangeError,
  normalizeCodexFileChangeStatus,
  normalizeCodexFileChanges,
  publicCodexFileChanges,
} from "../../src/codex/file-change.js";
import {
  publicCodexFilePath,
  publicCodexTextPaths,
} from "../../src/codex/path-projection.js";

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

  it("publishes workspace files as relative paths and hides escaped paths", () => {
    const changes = publicCodexFileChanges(
      [
        {
          path: "/repo/src/a.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-old\n+new\n",
        },
        {
          path: "/private/outside.txt",
          kind: "add",
          diff: "+safe\n",
        },
      ],
      { workspaceRoot: "/repo" },
    );

    expect(changes).toEqual([
      {
        path: "[path hidden]",
        kind: "add",
        diff: "+safe\n",
      },
      {
        path: "src/a.ts",
        kind: "update",
        diff: "@@ -1 +1 @@\n-old\n+new\n",
      },
    ]);
    const projectChange = changes.find((change) => change.path === "src/a.ts");
    if (!projectChange) throw new Error("expected workspace-relative change");
    expect(buildCodexEditInput([projectChange])).toMatchObject({
      file_path: "src/a.ts",
    });
  });

  it("projects POSIX and Windows paths in public tool text", () => {
    expect(
      publicCodexTextPaths(
        "M /repo/src/a.ts\nM /private/outside.ts\nM C:\\repo\\src\\b.ts",
        { workspaceRoot: "/repo" },
      ),
    ).toBe("M src/a.ts\nM [path hidden]\nM [path hidden]");
    expect(
      publicCodexFilePath("C:\\repo\\src\\b.ts", {
        workspaceRoot: "C:\\repo",
      }),
    ).toBe("src/b.ts");
    expect(
      publicCodexFilePath("C:\\other\\secret.txt", {
        workspaceRoot: "C:\\repo",
      }),
    ).toBe("[path hidden]");
  });
});
