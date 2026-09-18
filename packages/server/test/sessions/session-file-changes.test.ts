import { describe, expect, it } from "vitest";
import {
  collectSessionFileEdits,
  reconstructSessionBaseline,
  summarizeFileEdits,
} from "../../src/sessions/session-file-changes.js";
import type { Message } from "../../src/supervisor/types.js";

const resolvePath = (raw: string) => raw.replace(/^\/repo\//, "");

function session(blocks: unknown[]): Message[] {
  return [
    {
      uuid: "user-0",
      type: "user",
      message: { role: "user", content: "go" },
    },
    {
      uuid: "assistant-0",
      type: "assistant",
      message: { role: "assistant", content: blocks },
    },
  ] as unknown as Message[];
}

function toolUse(name: string, input: unknown, id = "tool-1") {
  return { type: "tool_use", id, name, input };
}

function toolResult(toolUseId: string, content: unknown, isError = false) {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
    is_error: isError,
  };
}

describe("collectSessionFileEdits", () => {
  it("collects Claude Edit replacements with line deltas", () => {
    const edits = collectSessionFileEdits(
      session([
        toolUse("Edit", {
          file_path: "/repo/a.ts",
          old_string: "const a = 1;\n",
          new_string: "const a = 2;\nconst b = 3;\n",
        }),
      ]),
      { resolvePath },
    );

    expect(summarizeFileEdits(edits.get("a.ts") ?? [])).toEqual({
      additions: 2,
      deletions: 1,
      edits: 1,
    });
  });

  it("expands MultiEdit and Pi edits[] into one op per replacement", () => {
    const edits = collectSessionFileEdits(
      session([
        toolUse("MultiEdit", {
          file_path: "a.ts",
          edits: [
            { old_string: "x\n", new_string: "y\n" },
            { oldText: "p\n", newText: "q\n" },
          ],
        }),
      ]),
      { resolvePath },
    );
    expect(summarizeFileEdits(edits.get("a.ts") ?? [])).toEqual({
      additions: 2,
      deletions: 2,
      edits: 2,
    });
  });

  it("counts codex apply_patch changes per file", () => {
    const edits = collectSessionFileEdits(
      session([
        toolUse("Edit", {
          changes: [
            {
              path: "/repo/a.ts",
              kind: "update",
              diff: "@@\n-old line\n+new line\n+extra line\n",
            },
            { path: "/repo/gone.ts", kind: "delete" },
          ],
        }),
      ]),
      { resolvePath },
    );

    expect(summarizeFileEdits(edits.get("a.ts") ?? [])).toEqual({
      additions: 2,
      deletions: 1,
      edits: 1,
    });
    expect(edits.get("gone.ts")?.[0]?.kind).toBe("delete");
  });

  it("treats Write as whole-file addition, or a real diff when the tool reported the original", () => {
    const created = collectSessionFileEdits(
      session([toolUse("Write", { file_path: "new.ts", content: "a\nb\n" })]),
      { resolvePath },
    );
    expect(summarizeFileEdits(created.get("new.ts") ?? [])).toEqual({
      additions: 2,
      deletions: 0,
      edits: 1,
    });

    const overwritten = collectSessionFileEdits(
      session([
        toolUse("Write", { file_path: "old.ts", content: "a\nc\n" }, "w1"),
        toolResult("w1", [{ type: "text", originalFile: "a\nb\n" }]),
      ]),
      { resolvePath },
    );
    expect(summarizeFileEdits(overwritten.get("old.ts") ?? [])).toEqual({
      additions: 1,
      deletions: 1,
      edits: 1,
    });
  });

  it("ignores edits whose tool call failed", () => {
    const edits = collectSessionFileEdits(
      session([
        toolUse(
          "Edit",
          { file_path: "a.ts", old_string: "x", new_string: "y" },
          "e1",
        ),
        toolResult("e1", "String to replace not found", true),
      ]),
      { resolvePath },
    );
    expect(edits.size).toBe(0);
  });

  it("ignores non-mutating tools", () => {
    const edits = collectSessionFileEdits(
      session([
        toolUse("Read", { file_path: "a.ts" }),
        toolUse("Bash", { command: "pnpm test" }),
      ]),
      { resolvePath },
    );
    expect(edits.size).toBe(0);
  });
});

describe("reconstructSessionBaseline", () => {
  it("prefers the original file reported by the first edit", () => {
    const ops = collectSessionFileEdits(
      session([
        toolUse(
          "Edit",
          { file_path: "a.ts", old_string: "b\n", new_string: "B\n" },
          "e1",
        ),
        toolResult("e1", [{ type: "text", originalFile: "a\nb\nc\n" }]),
      ]),
      { resolvePath },
    ).get("a.ts");

    expect(reconstructSessionBaseline("a\nB\nc\n", ops ?? [])).toEqual({
      content: "a\nb\nc\n",
      exact: true,
    });
  });

  it("rewinds replacements backwards from the current content", () => {
    const ops = collectSessionFileEdits(
      [
        ...session([
          toolUse(
            "Edit",
            { file_path: "a.ts", old_string: "one", new_string: "ONE" },
            "e1",
          ),
        ]),
        ...session([
          toolUse(
            "Edit",
            { file_path: "a.ts", old_string: "two", new_string: "TWO" },
            "e2",
          ),
        ]),
      ],
      { resolvePath },
    ).get("a.ts");

    expect(reconstructSessionBaseline("ONE\nTWO\n", ops ?? [])).toEqual({
      content: "one\ntwo\n",
      exact: true,
    });
  });

  it("treats the earliest Write as file creation", () => {
    const ops = collectSessionFileEdits(
      session([toolUse("Write", { file_path: "new.ts", content: "a\nb\n" })]),
      { resolvePath },
    ).get("new.ts");

    expect(reconstructSessionBaseline("a\nb\n", ops ?? [])).toEqual({
      content: "",
      exact: true,
    });
  });

  it("reverses patch hunks by content, not by line number", () => {
    const ops = collectSessionFileEdits(
      session([
        toolUse("apply_patch", {
          file_path: "a.ts",
          _rawPatch: "@@\n-old line\n+new line\n",
        }),
      ]),
      { resolvePath },
    ).get("a.ts");

    expect(
      reconstructSessionBaseline("header\nnew line\nfooter\n", ops ?? []),
    ).toEqual({ content: "header\nold line\nfooter\n", exact: true });
  });

  it("reports a partial baseline when an op cannot be undone", () => {
    const ops = collectSessionFileEdits(
      session([
        toolUse("Edit", {
          file_path: "a.ts",
          old_string: "gone",
          new_string: "missing from worktree",
        }),
      ]),
      { resolvePath },
    ).get("a.ts");

    const result = reconstructSessionBaseline("unrelated content\n", ops ?? []);
    expect(result.exact).toBe(false);
    expect(result.content).toBe("unrelated content\n");
  });
});
