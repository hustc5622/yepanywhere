import { describe, expect, it } from "vitest";
import {
  canonicalizePiToolName,
  normalizePiToolInput,
} from "../../src/sessions/pi-tools.js";

describe("Pi tool normalization", () => {
  it("maps native file/list fields onto Yep's rich renderer inputs", () => {
    expect(canonicalizePiToolName("ls")).toBe("Glob");
    expect(
      normalizePiToolInput("read", { path: "src/app.ts", offset: 3 }),
    ).toMatchObject({
      path: "src/app.ts",
      file_path: "src/app.ts",
      offset: 3,
    });
    expect(normalizePiToolInput("ls", { path: "src" })).toEqual({
      path: "src",
      pattern: "*",
    });
  });

  it("previews multi-edit calls and prefers Pi's completed native patch", () => {
    const input = {
      path: "src/app.ts",
      edits: [
        { oldText: "one", newText: "two" },
        { oldText: "three", newText: "four" },
      ],
    };
    expect(normalizePiToolInput("edit", input)).toMatchObject({
      file_path: "src/app.ts",
      old_string: "one",
      new_string: "two",
      _structuredPatch: [
        expect.objectContaining({ lines: ["-one", "+two"] }),
        expect.objectContaining({ lines: ["-three", "+four"] }),
      ],
    });

    expect(
      normalizePiToolInput("edit", input, {
        patch: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-one\n+two",
      }),
    ).toMatchObject({
      file_path: "src/app.ts",
      _rawPatch: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-one\n+two",
    });
  });
});
