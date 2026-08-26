import { describe, expect, it } from "vitest";
import {
  codexFilePathFingerprint,
  hiddenCodexFilePath,
  isHiddenCodexFilePath,
  publicCodexFileChangePath,
  publicCodexFilePath,
  publicCodexTextPaths,
} from "../../src/codex/path-projection.js";

describe("Plaintext file paths", () => {
  it.each([
    "/repo/src/a.ts",
    "/var/folders/aa/private-user/T/run/api_request.py",
    "/Users/private-user/Downloads/my report.py",
    "C:\\Users\\private-user\\my report.py",
    "\\\\host\\share\\a.py",
    "../other/a.py",
    "file:///private/a.py",
    "/tmp/sk-12345678901234567890.py",
  ])("preserves the full original path: %s", (path) => {
    expect(publicCodexFileChangePath(path, { workspaceRoot: "/repo" })).toBe(
      path,
    );
    expect(publicCodexFilePath(path)).toBe(path);
    for (const text of [
      `A ${path}`,
      `Moved to: ${path}`,
      `location:${path}`,
      `File "${path}"`,
    ]) {
      expect(publicCodexTextPaths(text, { fileChangePaths: true })).toBe(text);
    }
  });
  it("keeps same-basename external files distinct", () => {
    expect(publicCodexFileChangePath("/tmp/one/我的 script.py")).not.toBe(
      publicCodexFileChangePath("/tmp/two/我的 script.py"),
    );
  });
  it("keeps only legacy hidden-path identities when the original is unavailable", () => {
    const hidden = hiddenCodexFilePath(codexFilePathFingerprint("/old/a.py"));
    expect(isHiddenCodexFilePath(hidden)).toBe(true);
    expect(publicCodexFileChangePath(hidden)).toBe(hidden);
  });
  it("keeps display path lengths bounded", () => {
    expect(publicCodexFileChangePath(`/${"a".repeat(3000)}`)).toHaveLength(
      2048,
    );
  });
});
