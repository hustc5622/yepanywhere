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
  codexFilePathFingerprint,
  hiddenCodexFilePath,
  publicCodexFileChangePath,
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

  it("publishes original workspace and external paths", () => {
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
        path: publicCodexFileChangePath("/private/outside.txt"),
        pathFingerprint: codexFilePathFingerprint("/private/outside.txt"),
        kind: "add",
        diff: "+safe\n",
      },
      {
        path: "/repo/src/a.ts",
        pathFingerprint: codexFilePathFingerprint("/repo/src/a.ts"),
        kind: "update",
        diff: "@@ -1 +1 @@\n-old\n+new\n",
      },
    ]);
    const projectChange = changes.find(
      (change) => change.path === "/repo/src/a.ts",
    );
    if (!projectChange) throw new Error("expected workspace-relative change");
    expect(buildCodexEditInput([projectChange])).toMatchObject({
      file_path: "/repo/src/a.ts",
    });
  });

  it("keeps labels and fingerprints stable through repeated public projection", () => {
    const changes = publicCodexFileChanges([
      { path: "/tmp/one/api_request.py", kind: "add", diff: "import json" },
      { path: "/tmp/two/api_request.py", kind: "add", diff: "import os" },
    ]);
    expect(new Set(changes.map((change) => change.path)).size).toBe(2);
    expect(publicCodexFileChanges(changes)).toEqual(changes);
  });

  it("preserves distinct identities for old fingerprint-only journal entries", () => {
    const fingerprint = codexFilePathFingerprint("/tmp/one/api_request.py");
    expect(
      publicCodexFileChanges([{ pathFingerprint: fingerprint, kind: "add" }]),
    ).toEqual([
      {
        path: hiddenCodexFilePath(fingerprint),
        pathFingerprint: fingerprint,
        kind: "add",
      },
    ]);
  });

  it("preserves secret-shaped filenames and patch content", () => {
    const changes = publicCodexFileChanges([
      {
        path: "/tmp/sk-12345678901234567890.py",
        kind: "add",
        diff: "+API_KEY=very-private-value",
      },
    ]);
    expect(changes[0]?.path).toBe("/tmp/sk-12345678901234567890.py");
    expect(changes[0]?.diff).toBe("+API_KEY=very-private-value");
    expect(JSON.stringify(changes)).toContain("12345678901234567890");
  });

  it("projects POSIX and Windows paths in public tool text", () => {
    expect(
      publicCodexTextPaths(
        "M /repo/src/a.ts\nM /private/outside.ts\nM C:\\repo\\src\\b.ts",
        { workspaceRoot: "/repo" },
      ),
    ).toBe("M /repo/src/a.ts\nM /private/outside.ts\nM C:\\repo\\src\\b.ts");
    expect(
      publicCodexFilePath("C:\\repo\\src\\b.ts", {
        workspaceRoot: "C:\\repo",
      }),
    ).toBe("C:\\repo\\src\\b.ts");
    expect(
      publicCodexFilePath("C:\\other\\secret.txt", {
        workspaceRoot: "C:\\repo",
      }),
    ).toBe("C:\\other\\secret.txt");
  });
});
