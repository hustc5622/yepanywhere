import { describe, expect, it } from "vitest";
import {
  classifyFileActivityKind,
  extractShellWritePaths,
  extractToolFilePaths,
  normalizeSessionFilePath,
} from "../src/session-files.js";

describe("extractToolFilePaths", () => {
  it("reads common single-path keys", () => {
    expect(extractToolFilePaths({ file_path: "src/a.ts" })).toEqual([
      "src/a.ts",
    ]);
    expect(extractToolFilePaths({ notebookPath: "nb.ipynb" })).toEqual([
      "nb.ipynb",
    ]);
  });

  it("reads codex apply_patch multi-file changes", () => {
    expect(
      extractToolFilePaths({
        changes: [{ path: "a.ts" }, { path: "b.ts" }, { path: "a.ts" }],
      }),
    ).toEqual(["a.ts", "b.ts"]);
  });

  it("ignores command-like values reused under path keys", () => {
    expect(extractToolFilePaths({ path: "ls -la | grep foo" })).toEqual([]);
  });
});

describe("extractShellWritePaths", () => {
  it("detects redirects", () => {
    expect(extractShellWritePaths("echo hi > docs/out.md")).toEqual([
      "docs/out.md",
    ]);
    expect(extractShellWritePaths("cat x >> docs/out.md")).toEqual([
      "docs/out.md",
    ]);
  });

  it("detects in-place sed and tee", () => {
    expect(extractShellWritePaths("sed -i '' 's/a/b/' src/app.ts")).toContain(
      "src/app.ts",
    );
    expect(extractShellWritePaths("echo x | tee -a logs/run.log")).toContain(
      "logs/run.log",
    );
  });

  it("detects mv/cp/rm targets", () => {
    expect(extractShellWritePaths("mv old/a.ts new/a.ts")).toEqual([
      "new/a.ts",
      "old/a.ts",
    ]);
    expect(extractShellWritePaths("rm -rf dist/bundle.js")).toEqual([
      "dist/bundle.js",
    ]);
  });

  it("ignores read-only commands and /dev/null", () => {
    expect(extractShellWritePaths("pnpm test")).toEqual([]);
    expect(extractShellWritePaths("cmd 2> /dev/null")).toEqual([]);
  });
});

describe("normalizeSessionFilePath", () => {
  const root = "/repo";

  it("relativizes absolute paths inside the project", () => {
    expect(normalizeSessionFilePath("/repo/src/a.ts", root)).toEqual({
      path: "src/a.ts",
      outsideProject: false,
    });
  });

  it("keeps absolute paths outside the project", () => {
    expect(normalizeSessionFilePath("/tmp/a.ts", root)).toEqual({
      path: "/tmp/a.ts",
      outsideProject: true,
    });
  });

  it("collapses ./ and resolves .. segments", () => {
    expect(normalizeSessionFilePath("./src/./a.ts", root)?.path).toBe(
      "src/a.ts",
    );
    expect(normalizeSessionFilePath("src/lib/../a.ts", root)?.path).toBe(
      "src/a.ts",
    );
  });

  it("marks escaping relative paths as outside the project", () => {
    expect(normalizeSessionFilePath("../other/a.ts", root)).toEqual({
      path: "../other/a.ts",
      outsideProject: true,
    });
  });

  it("strips file:// prefixes", () => {
    expect(normalizeSessionFilePath("file:///repo/src/a.ts", root)?.path).toBe(
      "src/a.ts",
    );
  });
});

describe("classifyFileActivityKind", () => {
  it("maps provider tool spellings to a shared kind", () => {
    expect(classifyFileActivityKind("Edit")).toBe("modified");
    expect(classifyFileActivityKind("apply_patch")).toBe("modified");
    expect(classifyFileActivityKind("Read")).toBe("read");
    expect(classifyFileActivityKind("Grep")).toBe("searched");
    expect(classifyFileActivityKind("Bash")).toBe("other");
  });
});
